alter table public.tiregan_booths
  add column if not exists booth_type text,
  add column if not exists expected_amount_cad numeric(10,2),
  add column if not exists payment_status text,
  add column if not exists paypal_order_id text,
  add column if not exists paypal_capture_id text,
  add column if not exists paypal_payer_id text,
  add column if not exists paid_at timestamptz,
  add column if not exists expires_at timestamptz,
  add column if not exists receipt_sent_at timestamptz,
  add column if not exists receipt_error text;

alter table public.tiregan_booths
  drop constraint if exists tiregan_booths_status_check;

alter table public.tiregan_booths
  add constraint tiregan_booths_status_check
  check (status in ('pending', 'paypal_pending', 'sold'));

create unique index if not exists tiregan_booths_one_active_per_booth
  on public.tiregan_booths (booth_id)
  where status in ('pending', 'paypal_pending', 'sold');

create unique index if not exists tiregan_booths_paypal_order_id_unique
  on public.tiregan_booths (paypal_order_id)
  where paypal_order_id is not null;

create unique index if not exists tiregan_booths_paypal_capture_id_unique
  on public.tiregan_booths (paypal_capture_id)
  where paypal_capture_id is not null;

alter table public.tiregan_booths enable row level security;

drop policy if exists "public can read booth availability" on public.tiregan_booths;
drop policy if exists "public can insert bookings" on public.tiregan_booths;
drop policy if exists "public can update bookings" on public.tiregan_booths;
drop policy if exists "public can delete bookings" on public.tiregan_booths;

create policy "public can read booth availability"
  on public.tiregan_booths
  for select
  to anon
  using (status in ('pending', 'paypal_pending', 'sold'));

create policy "authenticated admins can manage bookings"
  on public.tiregan_booths
  for all
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'tiregan_admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'tiregan_admin');

revoke all on public.tiregan_booths from anon;
grant select (booth_id, status, expires_at) on public.tiregan_booths to anon;
grant select, insert, update, delete on public.tiregan_booths to authenticated;

-- All writes must happen through Supabase Edge Functions with SUPABASE_SERVICE_ROLE_KEY.
-- Do not grant anon insert/update/delete on this table.
