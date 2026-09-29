import { corsHeaders, json, sendReceiptEmail } from "../_shared/tiregan-paypal.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const testToken = Deno.env.get("TEST_RECEIPT_TOKEN");
    const auth = req.headers.get("authorization") || "";
    if (!testToken || auth !== `Bearer ${testToken}`) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({}));
    const toEmail = typeof body.to_email === "string" ? body.to_email.trim() : "";
    const toName = typeof body.to_name === "string" ? body.to_name.trim() : "TCICS Test";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(toEmail)) {
      return json({ error: "Valid to_email is required" }, 400);
    }

    const result = await sendReceiptEmail({
      booth_id: "TEST1",
      contact_name: toName,
      contact_email: toEmail,
      business_name: "Mailgun Receipt Test",
      expected_amount_cad: "1.00",
      paypal_capture_id: "TEST-CAPTURE-NOT-A-PAYMENT",
      paid_at: new Date().toISOString(),
    });

    return json({ sent: true, mailgun: result });
  } catch (error) {
    console.error(error);
    return json({ error: error instanceof Error ? error.message : "Test receipt failed" }, 400);
  }
});
