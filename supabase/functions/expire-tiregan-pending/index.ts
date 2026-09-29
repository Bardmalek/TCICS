import { json, logOpsEvent, serviceClient } from "../_shared/tiregan-paypal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabase = serviceClient();
  const now = new Date().toISOString();

  try {
    const { data, error } = await supabase
      .from("tiregan_booths")
      .delete()
      .eq("status", "pending")
      .not("expires_at", "is", null)
      .lt("expires_at", now)
      .is("paypal_order_id", null)
      .select("id, booth_id, contact_email, paypal_order_id, created_at, expires_at");

    if (error) throw error;

    const expired = data || [];
    if (expired.length > 0) {
      await logOpsEvent(supabase, {
        severity: "info",
        source: "expire-tiregan-pending",
        event_type: "pending_holds_expired",
        message: `Expired ${expired.length} abandoned checkout hold${expired.length === 1 ? "" : "s"}.`,
        payload: {
          count: expired.length,
          booths: expired.map((row) => row.booth_id),
          expired_at: now,
        },
      });
    }

    return json({ ok: true, expired_count: expired.length, expired });
  } catch (error) {
    console.error("expire-tiregan-pending failed", error);
    await logOpsEvent(supabase, {
      severity: "error",
      source: "expire-tiregan-pending",
      event_type: "cleanup_failed",
      message: error instanceof Error ? error.message : "Cleanup failed",
      payload: { expired_at: now },
      alert: true,
    });
    return json({ error: "Cleanup failed" }, 500);
  }
});
