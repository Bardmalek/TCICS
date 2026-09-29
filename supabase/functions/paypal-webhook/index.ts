import {
  assertAmount,
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
    const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID");
    if (!webhookId) throw new Error("PAYPAL_WEBHOOK_ID is not configured");

    const webhookEvent = await req.json();
    const accessToken = await paypalAccessToken();
    const verifyResponse = await fetch(`${paypalBaseUrl()}/v1/notifications/verify-webhook-signature`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        auth_algo: req.headers.get("paypal-auth-algo"),
        cert_url: req.headers.get("paypal-cert-url"),
        transmission_id: req.headers.get("paypal-transmission-id"),
        transmission_sig: req.headers.get("paypal-transmission-sig"),
        transmission_time: req.headers.get("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: webhookEvent,
      }),
    });

    const verification = await verifyResponse.json();
    if (!verifyResponse.ok || verification.verification_status !== "SUCCESS") {
      return json({ error: "Webhook signature verification failed" }, 401);
    }

    if (webhookEvent.event_type !== "PAYMENT.CAPTURE.COMPLETED" && webhookEvent.event_type !== "PAYMENT.CAPTURE.PENDING") {
      return json({ received: true, ignored: webhookEvent.event_type });
    }

    const resource = webhookEvent.resource;
    const orderId = resource?.supplementary_data?.related_ids?.order_id;
    if (!orderId) return json({ received: true, ignored: "missing_order_id" });

    const supabase = serviceClient();

    const { data: reservation, error: reservationError } = await supabase
      .from("tiregan_booths")
      .select("id,booth_id,expected_amount_cad,receipt_sent_at,contact_email")
      .eq("paypal_order_id", orderId)
      .single();

    if (reservationError || !reservation) {
      await logOpsEvent(supabase, {
        severity: "warning",
        source: "paypal-webhook",
        event_type: "reservation_not_found",
        message: `Webhook could not find reservation for PayPal order ${orderId}`,
        paypal_order_id: orderId,
        payload: { paypal_event_id: webhookEvent.id, event_type: webhookEvent.event_type },
        alert: true,
      });
      return json({ received: true, ignored: "reservation_not_found" });
    }
    if (resource.amount?.currency_code !== CURRENCY) throw new Error("Payment currency mismatch");
    assertAmount(resource.amount?.value, reservation.expected_amount_cad);

    if (webhookEvent.event_type === "PAYMENT.CAPTURE.PENDING") {
      const packageIds = packageBoothIds(reservation.booth_id);
      const { error: pendingUpdateError } = await supabase
        .from("tiregan_booths")
        .update({
          status: "paypal_pending",
          payment_status: resource.status || "PENDING",
          expires_at: null,
          notes: `PayPal order: ${orderId}; capture pending: ${resource.id || "unknown"}`,
        })
        .eq("id", reservation.id);
      if (pendingUpdateError) throw pendingUpdateError;
      if (packageIds.length > 1) {
        const { error: packagePendingError } = await supabase
          .from("tiregan_booths")
          .update({
            status: "paypal_pending",
            payment_status: "PACKAGE_PENDING",
            expires_at: null,
            notes: `Included in package payment for booth ${reservation.booth_id}; PayPal order: ${orderId}; capture pending: ${resource.id || "unknown"}`,
          })
          .in("booth_id", packageIds.filter((id) => id !== reservation.booth_id))
          .eq("contact_email", reservation.contact_email)
          .in("status", ["pending", "paypal_pending"]);
        if (packagePendingError) throw packagePendingError;
      }
      await logOpsEvent(supabase, {
        severity: "warning",
        source: "paypal-webhook",
        event_type: "paypal_capture_pending",
        message: `Webhook marked booth ${reservation.booth_id} as PayPal pending`,
        booth_id: reservation.booth_id,
        reservation_id: reservation.id,
        paypal_order_id: orderId,
        paypal_capture_id: resource.id || null,
        payload: { paypal_event_id: webhookEvent.id, payment_status: resource.status || "PENDING" },
        alert: true,
      });
      return json({ received: true, status: "paypal_pending" });
    }

    const paidAt = resource.create_time || new Date().toISOString();
    const notes = `PayPal order: ${orderId}; capture: ${resource.id}`;
    const packageIds = packageBoothIds(reservation.booth_id);
    const { error: updateError } = await supabase
      .from("tiregan_booths")
      .update({
        status: "sold",
        payment_status: resource.status || "COMPLETED",
        paypal_capture_id: resource.id,
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
          notes: `Included in package payment for booth ${reservation.booth_id}; PayPal order: ${orderId}; capture: ${resource.id}`,
        })
        .in("booth_id", packageIds.filter((id) => id !== reservation.booth_id))
        .eq("contact_email", reservation.contact_email)
        .in("status", ["pending", "paypal_pending", "sold"]);
      if (packageUpdateError) throw packageUpdateError;
    }
    await logOpsEvent(supabase, {
      severity: "info",
      source: "paypal-webhook",
      event_type: "paypal_capture_completed",
      message: `Webhook confirmed payment for booth ${reservation.booth_id}`,
      booth_id: reservation.booth_id,
      reservation_id: reservation.id,
      paypal_order_id: orderId,
      paypal_capture_id: resource.id,
      payload: { paypal_event_id: webhookEvent.id, payment_status: resource.status || "COMPLETED" },
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
          source: "paypal-webhook",
          event_type: "receipt_sent",
          message: `Receipt sent for booth ${reservation.booth_id}`,
          booth_id: reservation.booth_id,
          reservation_id: reservation.id,
          paypal_order_id: orderId,
          paypal_capture_id: resource.id,
          payload: { paypal_event_id: webhookEvent.id },
        });
      } catch (receiptError) {
        await supabase
          .from("tiregan_booths")
          .update({ receipt_error: receiptError instanceof Error ? receiptError.message.slice(0, 1000) : "Receipt failed" })
          .eq("id", reservation.id);
        await logOpsEvent(supabase, {
          severity: "error",
          source: "paypal-webhook",
          event_type: "receipt_failed",
          message: receiptError instanceof Error ? receiptError.message : "Receipt failed",
          booth_id: reservation.booth_id,
          reservation_id: reservation.id,
          paypal_order_id: orderId,
          paypal_capture_id: resource.id,
          payload: { paypal_event_id: webhookEvent.id },
          alert: true,
        });
      }
    }

    return json({ received: true });
  } catch (error) {
    console.error(error);
    try {
      await logOpsEvent(serviceClient(), {
        severity: "error",
        source: "paypal-webhook",
        event_type: "function_error",
        message: errorMessage(error, "Webhook handling failed"),
        payload: { error },
        alert: true,
      });
    } catch (_) {
      // Best-effort ops logging should never mask webhook response handling.
    }
    return json({ error: errorMessage(error, "Webhook handling failed") }, 400);
  }
});
