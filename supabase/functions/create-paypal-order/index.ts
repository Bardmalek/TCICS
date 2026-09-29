import {
  boothType,
  cleanEmail,
  cleanText,
  corsHeaders,
  CURRENCY,
  EVENT_NAME,
  boothInfo,
  errorMessage,
  json,
  logOpsEvent,
  packageBoothIds,
  paypalAccessToken,
  paypalBaseUrl,
  serviceClient,
  validateBoothId,
} from "../_shared/tiregan-paypal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const body = await req.json();
    const boothId = validateBoothId(body.booth_id);
    const pricing = boothInfo(boothId);
    const reservedBoothIds = packageBoothIds(boothId);

    const firstName = cleanText(body.first_name, 50, true);
    const lastName = cleanText(body.last_name, 50);
    const contactName = `${firstName} ${lastName}`.trim();
    const contactEmail = cleanEmail(body.contact_email);
    const businessName = cleanText(body.business_name, 100, true);
    const businessType = cleanText(body.business_type, 50);
    const phone = cleanText(body.phone, 30);

    const supabase = serviceClient();

    await supabase
      .from("tiregan_booths")
      .delete()
      .in("booth_id", reservedBoothIds)
      .eq("status", "pending")
      .is("paypal_order_id", null)
      .lt("expires_at", new Date().toISOString());

    const { data: existing, error: existingError } = await supabase
      .from("tiregan_booths")
      .select("id,status,contact_email")
      .in("booth_id", reservedBoothIds)
      .in("status", ["sold", "pending", "paypal_pending"])
      .limit(reservedBoothIds.length);

    if (existingError) throw existingError;
    const existingReservations = existing || [];
    const canRestartHold = existingReservations.length > 0 && existingReservations.every((row) =>
      row.status === "pending" && row.contact_email === contactEmail
    );
    if (canRestartHold) {
      const { error: retryDeleteError } = await supabase
        .from("tiregan_booths")
        .delete()
        .in("id", existingReservations.map((row) => row.id))
        .eq("status", "pending");
      if (retryDeleteError) throw retryDeleteError;
      await logOpsEvent(supabase, {
        severity: "info",
        source: "create-paypal-order",
        event_type: "booking_hold_restarted",
        message: `Pending hold restarted for booth ${pricing.boothLabel || boothId}`,
        booth_id: boothId,
        reservation_id: existingReservations[0]?.id,
        payload: { contact_email: contactEmail },
      });
    } else if (existingReservations.length > 0) {
      return json({ error: "Booth is no longer available" }, 409);
    }

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const reservationRows = reservedBoothIds.map((reservedBoothId) => ({
      booth_id: reservedBoothId,
      status: "pending",
      contact_name: contactName,
      contact_email: contactEmail,
      business_name: businessName,
      business_type: businessType,
      phone,
      event_name: EVENT_NAME,
      booth_type: boothType(reservedBoothId),
      expected_amount_cad: reservedBoothId === boothId ? pricing.value : "0.00",
      payment_status: reservedBoothId === boothId ? "paypal_order_created" : "package_hold",
      expires_at: expiresAt,
      notes: reservedBoothIds.length > 1 ? `Package reservation: booths ${reservedBoothIds.join(" + ")}` : null,
    }));

    const { data: reservations, error: insertError } = await supabase
      .from("tiregan_booths")
      .insert(reservationRows)
      .select("id,booth_id");

    if (insertError) throw insertError;
    const reservation = reservations?.find((row) => row.booth_id === boothId) || reservations?.[0];
    if (!reservation) throw new Error("Reservation was not created");
    await logOpsEvent(supabase, {
      severity: "info",
      source: "create-paypal-order",
      event_type: "booking_hold_created",
      message: `Hold created for booth ${pricing.boothLabel || boothId}`,
      booth_id: boothId,
      reservation_id: reservation.id,
      payload: { contact_email: contactEmail, amount: pricing.value, reserved_booths: reservedBoothIds },
    });

    const requestOrigin = req.headers.get("origin") || "";
    const configuredOrigin = Deno.env.get("SITE_ORIGIN") || "https://tcicsbooking.com";
    const allowedReturnOrigins = new Set([
      "https://tcicsbooking.com",
      "https://www.tcicsbooking.com",
      configuredOrigin,
    ]);
    const siteOrigin = allowedReturnOrigins.has(requestOrigin) ? requestOrigin : configuredOrigin;

    let order;
    try {
      const accessToken = await paypalAccessToken();
      const paypalResponse = await fetch(`${paypalBaseUrl()}/v2/checkout/orders`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": `tiregan-${reservation.id}`,
        },
        body: JSON.stringify({
          intent: "CAPTURE",
          purchase_units: [{
            reference_id: boothId,
            custom_id: reservation.id,
            description: `${EVENT_NAME} - Booth ${pricing.boothLabel || boothId} (${pricing.name})`,
            amount: {
              currency_code: CURRENCY,
              value: pricing.value,
              breakdown: {
                item_total: { currency_code: CURRENCY, value: pricing.value },
              },
            },
            items: [{
              name: `${pricing.name} - Booth ${pricing.boothLabel || boothId}`,
              quantity: "1",
              unit_amount: { currency_code: CURRENCY, value: pricing.value },
            }],
          }],
          application_context: {
            brand_name: "TCICS",
            landing_page: "BILLING",
            user_action: "PAY_NOW",
            return_url: `${siteOrigin}/tiregan-success.html?reservation_id=${reservation.id}`,
            cancel_url: `${siteOrigin}/tiregan.html?payment=cancelled&booth=${encodeURIComponent(boothId)}`,
          },
        }),
      });

      order = await paypalResponse.json();
      if (!paypalResponse.ok) {
        console.error("PayPal order creation failed", JSON.stringify(order));
        await logOpsEvent(supabase, {
          severity: "error",
          source: "create-paypal-order",
          event_type: "paypal_order_create_failed",
          message: order?.details?.[0]?.description || order?.message || "PayPal order creation failed",
          booth_id: boothId,
          reservation_id: reservation.id,
          payload: { paypal_status: paypalResponse.status },
        });
        throw new Error(order?.details?.[0]?.description || order?.message || "PayPal order creation failed");
      }
    } catch (paypalError) {
      await supabase
        .from("tiregan_booths")
        .delete()
        .in("id", reservations?.map((row) => row.id) || [reservation.id]);
      throw paypalError;
    }

    const approveUrl = order.links?.find((link: { rel: string }) => link.rel === "approve")?.href;
    if (!approveUrl) throw new Error("PayPal approval URL missing");

    await supabase
      .from("tiregan_booths")
      .update({ paypal_order_id: order.id })
      .eq("id", reservation.id);
    await logOpsEvent(supabase, {
      severity: "info",
      source: "create-paypal-order",
      event_type: "paypal_order_created",
      message: `PayPal order created for booth ${pricing.boothLabel || boothId}`,
      booth_id: boothId,
      reservation_id: reservation.id,
      paypal_order_id: order.id,
      payload: { amount: pricing.value, reserved_booths: reservedBoothIds },
    });

    return json({ approve_url: approveUrl, order_id: order.id, reservation_id: reservation.id, booth_label: pricing.boothLabel || boothId });
  } catch (error) {
    console.error(error);
    try {
      await logOpsEvent(serviceClient(), {
        severity: "error",
        source: "create-paypal-order",
        event_type: "function_error",
        message: errorMessage(error, "Unable to create PayPal order"),
        payload: { error },
      });
    } catch (_) {
      // Best-effort ops logging should never mask the customer-facing error.
    }
    return json({ error: errorMessage(error, "Unable to create PayPal order") }, 400);
  }
});
