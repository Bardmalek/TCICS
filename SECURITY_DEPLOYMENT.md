# Tiregan 2026 Payment Security Deployment

This site is only payment-integrity safe after these server-side pieces are deployed.

## Required Supabase secrets

Set these in Supabase Edge Functions:

```bash
supabase secrets set PAYPAL_ENV=live
supabase secrets set PAYPAL_CLIENT_ID=your-live-client-id
supabase secrets set PAYPAL_CLIENT_SECRET=your-live-client-secret
supabase secrets set PAYPAL_WEBHOOK_ID=your-live-webhook-id
supabase secrets set SITE_ORIGIN=https://tcicsbooking.com
supabase secrets set MAILGUN_API_KEY=your-mailgun-api-key
supabase secrets set MAILGUN_DOMAIN=mg.tcics.com
supabase secrets set RECEIPT_FROM_EMAIL=sponsor@tcics.com
supabase secrets set RECEIPT_FROM_NAME="TCICS - Tri-City Iranian Cultural Society"
```

Use `PAYPAL_ENV=sandbox` and a sandbox `SITE_ORIGIN` while testing.

## Deploy

```bash
supabase db push
supabase functions deploy create-paypal-order
supabase functions deploy capture-paypal-order
supabase functions deploy paypal-webhook --no-verify-jwt
```

Register this PayPal webhook URL in the PayPal Developer Dashboard:

```text
https://your-project-ref.supabase.co/functions/v1/paypal-webhook
```

Subscribe at minimum to:

```text
PAYMENT.CAPTURE.COMPLETED
```

## Security expectations

- The browser never decides that a booth is paid.
- PayPal order creation happens server-side with the real booth price.
- PayPal capture happens server-side after buyer approval.
- PayPal webhooks are verified with PayPal's webhook signature endpoint.
- Receipt emails are sent only after PayPal capture verification.
- Supabase anonymous users can only read booth availability, not buyer PII.
- Supabase anonymous users cannot insert, update, or delete bookings.

## Admin

The admin page now uses Supabase Auth. Create the admin user in Supabase, disable public signups, and set this app metadata on the admin user:

```json
{ "role": "tiregan_admin" }
```

The RLS policy only allows authenticated users with that app metadata role to read or manage full booking records.

For defense in depth, also put `tiregan_admin.html` behind Cloudflare Access, Netlify/Vercel password protection, or another host-level access control.
