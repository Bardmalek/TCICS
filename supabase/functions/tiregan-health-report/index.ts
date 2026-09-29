import {
  corsHeaders,
  json,
  logOpsEvent,
  sendOpsAlert,
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
    const shouldEmail = body.email !== false;

    const { data: bookings, error: bookingsError } = await supabase
      .from("tiregan_booths")
      .select("id,booth_id,status,payment_status,expected_amount_cad,paypal_order_id,paypal_capture_id,paid_at,receipt_sent_at,receipt_error,created_at")
      .order("created_at", { ascending: false });
    if (bookingsError) throw bookingsError;

    const rows = bookings || [];
    const sold = rows.filter((row) => row.status === "sold");
    const pending = rows.filter((row) => row.status === "pending");
    const paypalPending = rows.filter((row) => row.status === "paypal_pending");
    const receiptErrors = rows.filter((row) => row.receipt_error);
    const paidPrimaryRows = sold.filter((row) => Number(row.expected_amount_cad || 0) > 0);
    const soldMissingReceipt = paidPrimaryRows.filter((row) => !row.receipt_sent_at);
    const soldMissingCapture = paidPrimaryRows.filter((row) => !row.paypal_capture_id);
    const stalePending = pending.filter((row) => Date.now() - new Date(row.created_at).getTime() > 10 * 60 * 1000);
    const gross = sold.reduce((sum, row) => sum + Number(row.expected_amount_cad || 0), 0);

    const issues = [
      ...receiptErrors.map((row) => ({ type: "receipt_error", booth_id: row.booth_id, message: row.receipt_error })),
      ...soldMissingReceipt.map((row) => ({ type: "sold_missing_receipt", booth_id: row.booth_id, message: "Sold booking has no receipt_sent_at" })),
      ...soldMissingCapture.map((row) => ({ type: "sold_missing_capture", booth_id: row.booth_id, message: "Sold booking has no PayPal capture id" })),
      ...stalePending.map((row) => ({ type: "stale_pending", booth_id: row.booth_id, message: "Pending hold is older than 10 minutes" })),
    ].slice(0, 50);

    const summary = {
      checked_at: new Date().toISOString(),
      total_bookings: rows.length,
      sold_count: sold.length,
      pending_count: pending.length,
      paypal_pending_count: paypalPending.length,
      receipt_error_count: receiptErrors.length,
      sold_missing_receipt_count: soldMissingReceipt.length,
      sold_missing_capture_count: soldMissingCapture.length,
      stale_pending_count: stalePending.length,
      gross_amount_cad: Number(gross.toFixed(2)),
      issues,
    };

    await supabase.from("tiregan_daily_health_snapshots").insert({
      total_bookings: summary.total_bookings,
      sold_count: summary.sold_count,
      pending_count: summary.pending_count,
      paypal_pending_count: summary.paypal_pending_count,
      receipt_error_count: summary.receipt_error_count,
      gross_amount_cad: summary.gross_amount_cad,
      payload: summary,
    });

    await logOpsEvent(supabase, {
      severity: issues.length ? "warning" : "info",
      source: "tiregan-health-report",
      event_type: "health_check_completed",
      message: issues.length ? `Health check found ${issues.length} issue(s)` : "Health check passed",
      payload: summary,
      alert: shouldEmail && issues.length > 0,
    });

    if (shouldEmail && issues.length === 0) {
      await sendOpsAlert({
        severity: "info",
        source: "tiregan-health-report",
        event_type: "health_check_passed",
        message: `Tiregan health check passed. Sold: ${sold.length}, PayPal pending: ${paypalPending.length}, receipts failing: 0.`,
        payload: summary,
      });
    }

    return json({ status: issues.length ? "needs_review" : "healthy", summary });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Health check failed" }, 400);
  }
});
