create extension if not exists pgcrypto;

alter table public.tiregan_booths
  add column if not exists ops_alert_sent_at timestamptz;

create table if not exists public.tiregan_ops_events (
  id uuid primary key default gen_random_uuid(),
  severity text not null check (severity in ('info', 'warning', 'error', 'critical')),
  source text not null,
  event_type text not null,
  booth_id text,
  reservation_id uuid,
  paypal_order_id text,
  paypal_capture_id text,
  message text not null,
  payload jsonb not null default '{}'::jsonb,
  alert_sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists tiregan_ops_events_created_at_idx
  on public.tiregan_ops_events (created_at desc);

create index if not exists tiregan_ops_events_severity_idx
  on public.tiregan_ops_events (severity, created_at desc);

create table if not exists public.tiregan_booth_audit (
  id uuid primary key default gen_random_uuid(),
  booth_row_id uuid,
  booth_id text,
  action text not null,
  actor_id uuid,
  actor_role text,
  old_data jsonb,
  new_data jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tiregan_booth_audit_created_at_idx
  on public.tiregan_booth_audit (created_at desc);

create table if not exists public.tiregan_daily_health_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null default current_date,
  total_bookings integer not null default 0,
  sold_count integer not null default 0,
  pending_count integer not null default 0,
  paypal_pending_count integer not null default 0,
  receipt_error_count integer not null default 0,
  gross_amount_cad numeric(12,2) not null default 0,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists tiregan_daily_health_snapshots_created_at_idx
  on public.tiregan_daily_health_snapshots (created_at desc);

create or replace function public.log_tiregan_booth_audit()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.tiregan_booth_audit (
    booth_row_id,
    booth_id,
    action,
    actor_id,
    actor_role,
    old_data,
    new_data
  ) values (
    coalesce(new.id, old.id),
    coalesce(new.booth_id, old.booth_id),
    tg_op,
    auth.uid(),
    auth.jwt() -> 'app_metadata' ->> 'role',
    case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) else null end,
    case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) else null end
  );
  return coalesce(new, old);
end;
$$;

drop trigger if exists tiregan_booth_audit_trigger on public.tiregan_booths;
create trigger tiregan_booth_audit_trigger
  after insert or update or delete on public.tiregan_booths
  for each row execute function public.log_tiregan_booth_audit();

alter table public.tiregan_ops_events enable row level security;
alter table public.tiregan_booth_audit enable row level security;
alter table public.tiregan_daily_health_snapshots enable row level security;

drop policy if exists "tiregan admins can read ops events" on public.tiregan_ops_events;
create policy "tiregan admins can read ops events"
  on public.tiregan_ops_events
  for select
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'tiregan_admin');

drop policy if exists "tiregan admins can read booth audit" on public.tiregan_booth_audit;
create policy "tiregan admins can read booth audit"
  on public.tiregan_booth_audit
  for select
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'tiregan_admin');

drop policy if exists "tiregan admins can read health snapshots" on public.tiregan_daily_health_snapshots;
create policy "tiregan admins can read health snapshots"
  on public.tiregan_daily_health_snapshots
  for select
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'tiregan_admin');

grant select on public.tiregan_ops_events to authenticated;
grant select on public.tiregan_booth_audit to authenticated;
grant select on public.tiregan_daily_health_snapshots to authenticated;
