import {
  assertAmount,
  boothInfo,
  corsHeaders,
  CURRENCY,
  errorMessage,
  json,
  logOpsEvent,
  packageBoothIds,
  paypalAccessToken,
  paypalBaseUrl,
  sendReceiptEmail,
  serviceClient,
} from "../_shared/tiregan-paypal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const { order_id, reservation_id } = await req.json();
    if (typeof order_id !== "string" || !/^[A-Z0-9]+$/.test(order_id)) throw new Error("Invalid PayPal order");
    if (typeof reservation_id !== "string") throw new Error("Invalid reservation");

    const supabase = serviceClient();

    const { data: reservation, error: reservationError } = await supabase
      .from("tiregan_booths")
      .select("id,booth_id,status,paypal_order_id,expected_amount_cad,contact_email")
      .eq("id", reservation_id)
      .single();

    if (reservationError || !reservation) throw new Error("Reservation not found");
    const finalOrderId = order_id || reservation.paypal_order_id;
    if (!finalOrderId) throw new Error("Missing PayPal order");
    if (reservation.paypal_order_id !== finalOrderId) throw new Error("PayPal order does not match reservation");
    const boothLabel = boothInfo(reservation.booth_id).boothLabel || reservation.booth_id;
    if (reservation.status === "sold") return json({ status: "sold", booth_id: reservation.booth_id, booth_label: boothLabel });
    if (reservation.status === "paypal_pending") return json({ status: "paypal_pending", booth_id: reservation.booth_id, booth_label: boothLabel });
    if (reservation.status !== "pending") throw new Error("Reservation is not payable");

    const accessToken = await paypalAccessToken();
    const captureResponse = await fetch(`${paypalBaseUrl()}/v2/checkout/orders/${finalOrderId}/capture`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": `capture-${reservation.id}`,
      },
    });
    let capture = await captureResponse.json();
    if (!captureResponse.ok) {
      const orderResponse = await fetch(`${paypalBaseUrl()}/v2/checkout/orders/${finalOrderId}`, {
        headers: {
          "Authorization": `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      });
      const orderDetails = await orderResponse.json();
      const existingCapture = orderDetails.purchase_units?.[0]?.payments?.captures?.[0];
      if (!orderResponse.ok || !existingCapture) {
        throw new Error(capture?.details?.[0]?.description || capture?.message || "PayPal capture failed");
      }
      capture = orderDetails;
    }

    const unit = capture.purchase_units?.[0];
    const paid = unit?.payments?.captures?.[0];
    if (!paid) throw new Error("PayPal capture details missing");
    if (paid?.amount?.currency_code !== CURRENCY) throw new Error("Payment currency mismatch");
    assertAmount(paid?.amount?.value, reservation.expected_amount_cad);
    if (unit?.custom_id && unit.custom_id !== reservation.id) throw new Error("Payment reservation mismatch");

    if (paid.status !== "COMPLETED") {
      const packageIds = packageBoothIds(reservation.booth_id);
      const { error: primaryPendingError } = await supabase
        .from("tiregan_booths")
        .update({
          status: "paypal_pending",
          payment_status: paid.status || capture.status || "PENDING",
          paypal_capture_id: paid.id || null,
          expires_at: null,
          notes: `PayPal order: ${finalOrderId}; capture: ${paid.id || "pending"}; status: ${paid.status || capture.status || "PENDING"}`,
        })
        .eq("id", reservation.id);
      if (primaryPendingError) throw primaryPendingError;

      if (packageIds.length > 1) {
        const { error: packagePendingError } = await supabase
          .from("tiregan_booths")
          .update({
            status: "paypal_pending",
            payment_status: "PACKAGE_PENDING",
            expires_at: null,
            notes: `Included in package payment for booth ${reservation.booth_id}; PayPal order: ${finalOrderId}; status: ${paid.status || capture.status || "PENDING"}`,
          })
          .in("booth_id", packageIds.filter((id) => id !== reservation.booth_id))
          .eq("contact_email", reservation.contact_email)
          .in("status", ["pending", "paypal_pending"]);
        if (packagePendingError) throw packagePendingError;
      }
      await logOpsEvent(supabase, {
        severity: "warning",
        source: "capture-paypal-order",
        event_type: "paypal_capture_pending",
        message: `PayPal capture is pending for booth ${reservation.booth_id}`,
        booth_id: reservation.booth_id,
        reservation_id: reservation.id,
        paypal_order_id: finalOrderId,
        paypal_capture_id: paid.id || null,
        payload: { payment_status: paid.status || capture.status || "PENDING" },
        alert: true,
      });
      return json({ status: "paypal_pending", booth_id: reservation.booth_id, booth_label: boothLabel });
    }

    const paidAt = new Date().toISOString();
    const notes = `PayPal order: ${finalOrderId}; capture: ${paid.id}`;
    const packageIds = packageBoothIds(reservation.booth_id);
    const { error: updateError } = await supabase
      .from("tiregan_booths")
      .update({
        status: "sold",
        payment_status: paid.status || "COMPLETED",
        paypal_capture_id: paid.id,
        paypal_payer_id: capture.payer?.payer_id || null,
        paid_at: paidAt,
        expires_at: null,
        notes,
      })
      .eq("id", reservation.id);

    if (updateError) throw updateError;
    if (packageIds.length > 1) {
      const { error: packageUpdateError } = await supabase
        .from("tiregan_booths")
        .update({
          status: "sold",
          payment_status: "COMPLETED_PACKAGE",
          paid_at: paidAt,
          expires_at: null,
          notes: `Included in package payment for booth ${reservation.booth_id}; PayPal order: ${finalOrderId}; capture: ${paid.id}`,
        })
        .in("booth_id", packageIds.filter((id) => id !== reservation.booth_id))
        .eq("contact_email", reservation.contact_email)
        .in("status", ["pending", "paypal_pending", "sold"]);
      if (packageUpdateError) throw packageUpdateError;
    }
    await logOpsEvent(supabase, {
      severity: "info",
      source: "capture-paypal-order",
      event_type: "paypal_capture_completed",
      message: `Payment captured for booth ${reservation.booth_id}`,
      booth_id: reservation.booth_id,
      reservation_id: reservation.id,
      paypal_order_id: finalOrderId,
      paypal_capture_id: paid.id,
      payload: { payment_status: paid.status || "COMPLETED" },
    });

    const { data: updatedBooking } = await supabase
      .from("tiregan_booths")
      .select("*")
      .eq("id", reservation.id)
      .single();

    if (updatedBooking && !updatedBooking.receipt_sent_at) {
      try {
        await sendReceiptEmail(updatedBooking);
        await supabase
          .from("tiregan_booths")
          .update({ receipt_sent_at: new Date().toISOString(), receipt_error: null })
          .eq("id", reservation.id);
        await logOpsEvent(supabase, {
          severity: "info",
          source: "capture-paypal-order",
          event_type: "receipt_sent",
          message: `Receipt sent for booth ${reservation.booth_id}`,
          booth_id: reservation.booth_id,
          reservation_id: reservation.id,
          paypal_order_id: finalOrderId,
          paypal_capture_id: paid.id,
        });
      } catch (receiptError) {
        await supabase
          .from("tiregan_booths")
          .update({ receipt_error: receiptError instanceof Error ? receiptError.message.slice(0, 1000) : "Receipt failed" })
          .eq("id", reservation.id);
        await logOpsEvent(supabase, {
          severity: "error",
          source: "capture-paypal-order",
          event_type: "receipt_failed",
          message: receiptError instanceof Error ? receiptError.message : "Receipt failed",
          booth_id: reservation.booth_id,
          reservation_id: reservation.id,
          paypal_order_id: finalOrderId,
          paypal_capture_id: paid.id,
          alert: true,
        });
      }
    }

    return json({ status: "sold", booth_id: reservation.booth_id, booth_label: boothLabel });
  } catch (error) {
    console.error(error);
    try {
      await logOpsEvent(serviceClient(), {
        severity: "error",
        source: "capture-paypal-order",
        event_type: "function_error",
        message: errorMessage(error, "Unable to capture PayPal order"),
        payload: { error },
      });
    } catch (_) {
      // Best-effort ops logging should never mask the customer-facing error.
    }
    return json({ error: errorMessage(error, "Unable to capture PayPal order") }, 400);
  }
});
