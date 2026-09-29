import {
  corsHeaders,
  json,
  logOpsEvent,
  sendReceiptEmail,
  serviceClient,
} from "../_shared/tiregan-paypal.ts";

async function requireAdmin(req: Request, supabase: ReturnType<typeof serviceClient>) {
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Authentication required");
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new Error("Authentication required");
  if (data.user.app_metadata?.role !== "tiregan_admin") throw new Error("Not authorized");
  return data.user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = serviceClient();
  try {
    await requireAdmin(req, supabase);
    const body = await req.json().catch(() => ({}));
    const reservationId = typeof body.reservation_id === "string" ? body.reservation_id.trim() : "";
    const boothId = typeof body.booth_id === "string" ? body.booth_id.trim().toUpperCase() : "";
    const force = body.force === true;
    if (!reservationId && !boothId) throw new Error("reservation_id or booth_id is required");

    let query = supabase.from("tiregan_booths").select("*");
    if (reservationId) {
      query = query.eq("id", reservationId);
    } else {
      query = query.eq("booth_id", boothId).order("created_at", { ascending: false }).limit(1);
    }
    const { data: booking, error } = await query.single();
    if (error || !booking) throw new Error("Booking not found");
    if (booking.status !== "sold") throw new Error("Receipt can only be sent for sold bookings");
    if (booking.receipt_sent_at && !force) {
      return json({ status: "already_sent", receipt_sent_at: booking.receipt_sent_at });
    }

    await sendReceiptEmail(booking);
    const sentAt = new Date().toISOString();
    await supabase
      .from("tiregan_booths")
      .update({ receipt_sent_at: sentAt, receipt_error: null, ops_alert_sent_at: null })
      .eq("id", booking.id);

    await logOpsEvent(supabase, {
      severity: "info",
      source: "tiregan-retry-receipt",
      event_type: "receipt_retry_sent",
      message: `Receipt retry sent for booth ${booking.booth_id}`,
      booth_id: booking.booth_id,
      reservation_id: booking.id,
      paypal_order_id: booking.paypal_order_id || null,
      paypal_capture_id: booking.paypal_capture_id || null,
      payload: { force },
    });

    return json({ status: "sent", receipt_sent_at: sentAt, booth_id: booking.booth_id });
  } catch (error) {
    console.error(error);
    try {
      await logOpsEvent(supabase, {
        severity: "error",
        source: "tiregan-retry-receipt",
        event_type: "receipt_retry_failed",
        message: error instanceof Error ? error.message : "Receipt retry failed",
        alert: true,
      });
    } catch (_) {
      // Best-effort ops logging should never mask the admin-facing error.
    }
    return json({ error: error instanceof Error ? error.message : "Receipt retry failed" }, 400);
  }
});
