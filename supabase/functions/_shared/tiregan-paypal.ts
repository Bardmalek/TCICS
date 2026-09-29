import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

export const corsHeaders = {
  // Public checkout functions are protected by server-side validation and RLS,
  // not by browser origin. Allowing all origins prevents www/non-www and
  // in-app browser origin mismatches from blocking PayPal checkout with
  // "Failed to fetch" before the server can respond.
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, paypal-auth-algo, paypal-cert-url, paypal-transmission-id, paypal-transmission-sig, paypal-transmission-time",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export const EVENT_NAME = "Tiregan 2026";
export const CURRENCY = "CAD";

export const PRICING: Record<string, { name: string; value: string }> = {
  TEST: { name: "Payment Test Booth", value: "1.00" },
  R: { name: "Regular Booth", value: "690.00" },
  E: { name: "Elite VIP Booth", value: "1500.00" },
  A: { name: "Handicraft Table", value: "290.00" },
  FK: { name: "Kebab Booth", value: "2500.00" },
  FT: { name: "Food Truck", value: "1500.00" },
  F: { name: "Food Booth", value: "1000.00" },
};

const SPECIAL_PRICING: Record<string, { name: string; value: string; boothLabel?: string; packageBoothIds?: string[] }> = {
  "34": { name: "Discounted Regular Booth", value: "600.00" },
  "31": { name: "Discounted Regular Booth Package", value: "750.00", boothLabel: "31 + 32", packageBoothIds: ["31", "32"] },
  "32": { name: "Discounted Regular Booth Package", value: "750.00", boothLabel: "31 + 32", packageBoothIds: ["31", "32"] },
  F3: { name: "Discounted Food Booth", value: "700.00" },
};

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function serviceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false } },
  );
}

export function validateBoothId(boothId: unknown): string {
  if (typeof boothId !== "string") throw new Error("Invalid booth");
  const cleaned = boothId.trim().toUpperCase();
  if (cleaned === "TEST1") return cleaned;
  if (/^FK[12]$/.test(cleaned)) return cleaned;
  if (/^FT[12]$/.test(cleaned)) return cleaned;
  if (/^F([1-9]|1[0-6])$/.test(cleaned)) return cleaned;
  if (/^A([1-9]|1[01])$/.test(cleaned)) return cleaned;
  if (/^E[12]$/.test(cleaned)) return cleaned;
  if (/^([1-9]|[1-4][0-9]|5[0-6])$/.test(cleaned)) return cleaned;
  throw new Error("Invalid booth");
}

export function boothType(boothId: string): string {
  if (boothId === "TEST1") return "TEST";
  if (boothId.startsWith("FK")) return "FK";
  if (boothId.startsWith("FT")) return "FT";
  if (boothId.startsWith("F")) return "F";
  if (boothId.startsWith("A")) return "A";
  if (boothId.startsWith("E")) return "E";
  return "R";
}

export function packageBoothIds(boothId: string): string[] {
  return SPECIAL_PRICING[boothId]?.packageBoothIds || [boothId];
}

export function cleanText(value: unknown, maxLen: number, required = false): string {
  if (typeof value !== "string") {
    if (required) throw new Error("Missing required field");
    return "";
  }
  const cleaned = value.replace(/<[^>]*>/g, "").trim().slice(0, maxLen);
  if (required && !cleaned) throw new Error("Missing required field");
  return cleaned;
}

export function cleanEmail(value: unknown): string {
  const email = cleanText(value, 254, true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new Error("Invalid email");
  return email;
}

export function paypalBaseUrl() {
  return Deno.env.get("PAYPAL_ENV") === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export async function paypalAccessToken() {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) throw new Error("PayPal credentials are not configured");

  const auth = btoa(`${clientId}:${clientSecret}`);
  const response = await fetch(`${paypalBaseUrl()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  if (!response.ok) throw new Error(`PayPal auth failed: ${response.status}`);
  const data = await response.json();
  return data.access_token as string;
}

export async function logOpsEvent(
  supabase: ReturnType<typeof serviceClient>,
  input: {
    severity: "info" | "warning" | "error" | "critical";
    source: string;
    event_type: string;
    message: string;
    booth_id?: string | null;
    reservation_id?: string | null;
    paypal_order_id?: string | null;
    paypal_capture_id?: string | null;
    payload?: Record<string, unknown>;
    alert?: boolean;
  },
) {
  try {
    const { data } = await supabase
      .from("tiregan_ops_events")
      .insert({
        severity: input.severity,
        source: input.source,
        event_type: input.event_type,
        message: input.message,
        booth_id: input.booth_id || null,
        reservation_id: input.reservation_id || null,
        paypal_order_id: input.paypal_order_id || null,
        paypal_capture_id: input.paypal_capture_id || null,
        payload: input.payload || {},
      })
      .select("id,created_at")
      .single();

    if (input.alert || ["error", "critical"].includes(input.severity)) {
      try {
        await sendOpsAlert({ ...input, ops_event_id: data?.id || null });
        if (data?.id) {
          await supabase
            .from("tiregan_ops_events")
            .update({ alert_sent_at: new Date().toISOString() })
            .eq("id", data.id);
        }
      } catch (alertError) {
        console.error("Ops alert failed", alertError);
      }
    }
  } catch (opsError) {
    console.error("Ops event logging failed", opsError);
  }
}

export async function sendOpsAlert(input: {
  severity: string;
  source: string;
  event_type: string;
  message: string;
  booth_id?: string | null;
  reservation_id?: string | null;
  paypal_order_id?: string | null;
  paypal_capture_id?: string | null;
  payload?: Record<string, unknown>;
  ops_event_id?: string | null;
}) {
  const apiKey = Deno.env.get("MAILGUN_API_KEY");
  const domain = Deno.env.get("MAILGUN_DOMAIN");
  const fromEmail = Deno.env.get("RECEIPT_FROM_EMAIL") || "sponsor@tcics.com";
  const fromName = Deno.env.get("RECEIPT_FROM_NAME") || "TCICS - Tri-City Iranian Cultural Society";
  const alertEmail = Deno.env.get("OPS_ALERT_EMAIL") || Deno.env.get("RECEIPT_ADMIN_EMAIL") || "admin@example.com";
  if (!apiKey || !domain || !alertEmail) return;

  const text = `Tiregan ops alert

Severity: ${input.severity}
Source: ${input.source}
Event: ${input.event_type}
Message: ${input.message}
Booth: ${input.booth_id || "-"}
Reservation: ${input.reservation_id || "-"}
PayPal order: ${input.paypal_order_id || "-"}
PayPal capture: ${input.paypal_capture_id || "-"}
Ops event: ${input.ops_event_id || "-"}

Payload:
${JSON.stringify(input.payload || {}, null, 2)}`;

  const form = new FormData();
  form.append("from", `${fromName} <${fromEmail}>`);
  form.append("to", alertEmail);
  form.append("subject", `[Tiregan ${input.severity.toUpperCase()}] ${input.event_type}`);
  form.append("text", text);

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { "Authorization": `Basic ${btoa(`api:${apiKey}`)}` },
    body: form,
  });
  if (!response.ok) {
    const result = await response.text();
    throw new Error(`Mailgun ops alert failed: ${result}`);
  }
}

export function assertAmount(actual: string | undefined, expected: string) {
  if (Number(actual || 0).toFixed(2) !== Number(expected).toFixed(2)) {
    throw new Error("Payment amount mismatch");
  }
}

export function errorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    const message = (error as { message?: unknown })?.message;
    if (typeof message === "string" && message.trim()) return message;
    return JSON.stringify(error);
  } catch (_) {
    return fallback;
  }
}

export function boothInfo(boothId: string) {
  const type = boothType(boothId);
  const pricing = SPECIAL_PRICING[boothId] || PRICING[type];
  const sizes: Record<string, string> = {
    TEST: "Payment test",
    R: "3m x 3m",
    E: "6m x 3m",
    A: "180cm x 75cm",
    FK: "Varies",
    FT: "Varies",
    F: "Varies",
  };
  return {
    type,
    name: pricing.name,
    value: pricing.value,
    size: SPECIAL_PRICING[boothId]?.packageBoothIds ? "Two 3m x 3m booths" : sizes[type] || "Varies",
    boothLabel: SPECIAL_PRICING[boothId]?.boothLabel || boothId,
  };
}

function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export async function sendReceiptEmail(booking: Record<string, unknown>) {
  const apiKey = Deno.env.get("MAILGUN_API_KEY");
  const domain = Deno.env.get("MAILGUN_DOMAIN");
  const fromEmail = Deno.env.get("RECEIPT_FROM_EMAIL") || "sponsor@tcics.com";
  const fromName = Deno.env.get("RECEIPT_FROM_NAME") || "TCICS - Tri-City Iranian Cultural Society";
  const adminCopyEmail = Deno.env.get("RECEIPT_ADMIN_EMAIL") || "admin@example.com";
  if (!apiKey || !domain) throw new Error("Mailgun is not configured");

  const boothId = String(booking.booth_id || "");
  const info = boothInfo(boothId);
  const toEmail = String(booking.contact_email || "");
  const toName = String(booking.contact_name || "Vendor");
  if (!toEmail) throw new Error("Booking has no receipt email");

  const boothLabel = info.boothLabel || boothId;
  const receiptNo = `R-TRG-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${boothLabel.replace(/\s+/g, "")}`;
  const amount = Number(booking.expected_amount_cad || info.value).toLocaleString("en-CA", {
    style: "currency",
    currency: CURRENCY,
  });
  const paidAt = booking.paid_at ? new Date(String(booking.paid_at)).toLocaleString("en-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "long",
    timeStyle: "short",
  }) : new Date().toLocaleString("en-CA", {
    timeZone: "America/Vancouver",
    dateStyle: "long",
    timeStyle: "short",
  });

  const text = `Dear ${toName},

Thank you for your booth rental payment for Tiregan 2026.

Receipt #: ${receiptNo}
Payment status: Paid
Paid at: ${paidAt}

Event: Tiregan 2026
Date: Saturday, July 11, 2026
Hours: 10:00 AM - 10:00 PM
Venue: Lafarge Lake Park, Coquitlam, BC

Booth ID: ${boothLabel}
Booth Type: ${info.name}
Size: ${info.size}
Amount Paid: ${amount}
Business: ${booking.business_name || "-"}
PayPal Capture ID: ${booking.paypal_capture_id || "-"}

Your booth is confirmed. Please keep this receipt for your records and bring it to event check-in.

For questions contact sponsor@tcics.com or call (604) 849-6580.

TCICS Team
Tri-City Iranian Cultural Society`;

  const html = `
    <div style="font-family:Arial,sans-serif;color:#1a1916;line-height:1.6;max-width:640px">
      <h1 style="color:#1a6b3c">Payment Receipt</h1>
      <p>Dear ${escapeHtml(toName)},</p>
      <p>Thank you for your booth rental payment for <strong>Tiregan 2026</strong>.</p>
      <table style="border-collapse:collapse;width:100%;margin:18px 0">
        <tr><td style="border:1px solid #ddd;padding:8px">Receipt #</td><td style="border:1px solid #ddd;padding:8px"><strong>${escapeHtml(receiptNo)}</strong></td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Payment status</td><td style="border:1px solid #ddd;padding:8px">Paid</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Paid at</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(paidAt)}</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Event</td><td style="border:1px solid #ddd;padding:8px">Tiregan 2026</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Date</td><td style="border:1px solid #ddd;padding:8px">Saturday, July 11, 2026</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Venue</td><td style="border:1px solid #ddd;padding:8px">Lafarge Lake Park, Coquitlam, BC</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Booth</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(boothLabel)}</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Booth type</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(info.name)}</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Size</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(info.size)}</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Amount paid</td><td style="border:1px solid #ddd;padding:8px"><strong>${escapeHtml(amount)}</strong></td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">Business</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(booking.business_name || "-")}</td></tr>
        <tr><td style="border:1px solid #ddd;padding:8px">PayPal Capture ID</td><td style="border:1px solid #ddd;padding:8px">${escapeHtml(booking.paypal_capture_id || "-")}</td></tr>
      </table>
      <p>Your booth is confirmed. Please keep this receipt for your records and bring it to event check-in.</p>
      <p>For questions contact <a href="mailto:sponsor@tcics.com">sponsor@tcics.com</a> or call (604) 849-6580.</p>
      <p>TCICS Team<br>Tri-City Iranian Cultural Society</p>
    </div>`;

  const form = new FormData();
  form.append("from", `${fromName} <${fromEmail}>`);
  form.append("to", `${toName} <${toEmail}>`);
  if (adminCopyEmail && adminCopyEmail.toLowerCase() !== toEmail.toLowerCase()) {
    form.append("bcc", adminCopyEmail);
  }
  form.append("subject", `Payment Receipt - Tiregan 2026 - Booth ${boothLabel}`);
  form.append("text", text);
  form.append("html", html);

  const response = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: "POST",
    headers: { "Authorization": `Basic ${btoa(`api:${apiKey}`)}` },
    body: form,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Mailgun receipt failed: ${JSON.stringify(result)}`);
  return result;
}
