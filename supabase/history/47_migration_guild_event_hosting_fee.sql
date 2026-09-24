-- ============================================================================================
-- Migration 47: Guild Event hosting fee — a guild must pay Inkroot's hosting fee for an event
-- before publish_guild_event() will move it approved -> published (see
-- 45_migration_guild_event_creation_workflow.sql for the rest of that pipeline). This is a
-- second, separate charge from the per-entry platform fee (PLATFORM_FEE_BPS, deducted from each
-- reader's entry fee as it's paid — see 42_migration_guild_events.sql) — this one is what the
-- guild itself pays Inkroot, once, for the right to run the event at all.
--
-- Configurable pricing, not a constant: guild_event_hosting_fee_rates is an append-only table of
-- (fee_kobo, effective_from) rows, same "change it in one place, past rows keep whatever was
-- true when they happened" posture PLATFORM_FEE_BPS's own comment already documents for that
-- constant — except this one lives in the database (via set_guild_event_hosting_fee(), Inkroot-
-- admin-only) rather than a source constant, specifically so Inkroot can change it without a
-- deploy. current_guild_event_hosting_fee_kobo() always resolves "whatever the most recent row
-- with effective_from <= now() says", and every payment snapshots the rate_id/fee_kobo it was
-- actually charged at, so a rate change later never reclassifies a fee a guild already paid —
-- same reasoning guild_event_entries.net_kobo already relies on for the per-entry fee.
--
-- guild_event_hosting_fee_payments is one row per event (a hosting fee is paid once, not per
-- entrant) with the exact same pending -> success/failed, service-role-only-write,
-- paystack_reference-keyed lifecycle `purchases`/`guild_event_entries` already have — see their
-- own comments for why. A configured fee of exactly 0 kobo is the one case nothing is ever
-- charged for: the paystack-init-hosting-fee edge function records a 'success' row with no
-- Paystack reference at all rather than routing a zero-kobo charge through Paystack.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. Configurable pricing.
-- ----------------------------------------------------------------------------------------------

create table if not exists guild_event_hosting_fee_rates (
  id uuid primary key default gen_random_uuid(),
  fee_kobo bigint not null check (fee_kobo >= 0),
  note text check (char_length(note) <= 500),
  effective_from timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table guild_event_hosting_fee_rates enable row level security;

-- Readable by anyone signed in — a guild owner needs to see the current fee (and, ideally, that
-- it's a real configured number rather than something the client made up) before they ever get
-- to the approved stage of an event. Never client-writable: only set_guild_event_hosting_fee()
-- below, which is is_inkroot_admin()-gated, ever inserts a row, and there is deliberately no
-- update/delete policy at all (or RPC) — a rate change is always a new row, never an edit to an
-- old one, so anything already charged against an old rate stays truthfully attributable to it.
create policy "anyone signed in can read hosting fee rates" on guild_event_hosting_fee_rates
  for select using (auth.uid() is not null);

create index if not exists guild_event_hosting_fee_rates_effective_idx
  on guild_event_hosting_fee_rates (effective_from desc);

create or replace function current_guild_event_hosting_fee_kobo()
returns bigint
language sql stable as $$
  select fee_kobo from guild_event_hosting_fee_rates
  where effective_from <= now()
  order by effective_from desc
  limit 1;
$$;

-- The rate a caller can act on right now, id and amount together — small enough not to warrant
-- a second RPC of its own, but returning both in one call means initiating a payment and
-- displaying "what am I about to pay" can never read two different rates a race let slip between.
create or replace function current_guild_event_hosting_fee()
returns table (rate_id uuid, fee_kobo bigint)
language sql stable as $$
  select id, fee_kobo from guild_event_hosting_fee_rates
  where effective_from <= now()
  order by effective_from desc
  limit 1;
$$;

create or replace function set_guild_event_hosting_fee(p_fee_kobo bigint, p_note text default null)
returns guild_event_hosting_fee_rates
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_event_hosting_fee_rates;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can set the guild event hosting fee.';
  end if;
  if p_fee_kobo is null or p_fee_kobo < 0 then
    raise exception 'The hosting fee cannot be negative.';
  end if;

  insert into guild_event_hosting_fee_rates (fee_kobo, note, created_by)
  values (p_fee_kobo, nullif(trim(coalesce(p_note, '')), ''), auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

-- Every rate ever set, newest first — the admin screen's own history/audit view. Same
-- is_inkroot_admin() gate as everything else admin-only, even though the table's own select
-- policy already lets any signed-in user read it one row at a time via
-- current_guild_event_hosting_fee(); this is the only way to see the *history*.
create or replace function admin_list_guild_event_hosting_fee_rates()
returns setof guild_event_hosting_fee_rates
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can view the hosting fee rate history.';
  end if;
  return query select * from guild_event_hosting_fee_rates order by effective_from desc;
end;
$$;

-- An initial rate so current_guild_event_hosting_fee_kobo() is never null for an event created
-- the moment this migration runs. ₦5,000 is only a starting point — change it any time via
-- set_guild_event_hosting_fee(), from the admin screen.
insert into guild_event_hosting_fee_rates (fee_kobo, note)
select 500000, 'Initial hosting fee'
where not exists (select 1 from guild_event_hosting_fee_rates);

-- ----------------------------------------------------------------------------------------------
-- 2. guild_event_hosting_fee_payments — one row per event, same lifecycle/RLS shape as
-- guild_event_entries (see its own comment in 42_migration_guild_events.sql for why: created
-- pending by the paystack-init-hosting-fee edge function, only ever flipped to success/failed by
-- paystack-webhook once Paystack confirms the charge — except a 0-kobo fee, recorded 'success'
-- immediately with no reference, since there is nothing for Paystack to confirm).
-- ----------------------------------------------------------------------------------------------

create table if not exists guild_event_hosting_fee_payments (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  guild_id uuid not null references player_guilds(id) on delete cascade,
  rate_id uuid references guild_event_hosting_fee_rates(id) on delete set null,
  fee_kobo bigint not null check (fee_kobo >= 0),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  paystack_reference text unique,
  paid_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (event_id)
);

alter table guild_event_hosting_fee_payments enable row level security;

create policy "guild owner reads their own event hosting fee payments" on guild_event_hosting_fee_payments
  for select using (
    exists (select 1 from player_guilds g where g.id = guild_event_hosting_fee_payments.guild_id and g.owner_id = auth.uid())
  );
create policy "inkroot admin reads all hosting fee payments" on guild_event_hosting_fee_payments
  for select using (is_inkroot_admin());
-- No client insert/update policy, same reasoning as guild_event_entries: only
-- paystack-init-hosting-fee (pending, or 'success' outright for a 0-kobo fee) and
-- paystack-webhook (success/failed), both service_role, ever write this table.

create index if not exists guild_event_hosting_fee_payments_event_idx
  on guild_event_hosting_fee_payments (event_id);

-- ----------------------------------------------------------------------------------------------
-- 3. publish_guild_event — redefined only to add the hosting-fee gate. Every existing check
-- (owner-only, must be 'approved') is unchanged from 45_migration_guild_event_creation_workflow.sql.
-- ----------------------------------------------------------------------------------------------

create or replace function publish_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can publish this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'approved' then
    raise exception 'This event needs Inkroot approval before it can be published.';
  end if;
  -- "an approved paid event" — every host='guild' event has a positive entry_fee_kobo by
  -- construction (create_guild_event_draft/update_guild_event_draft both require it), so this
  -- is effectively every guild event; written as an entry_fee_kobo check rather than
  -- unconditionally so a future free-to-enter event type wouldn't need this gate touched.
  if v_event.entry_fee_kobo is not null and not exists (
    select 1 from guild_event_hosting_fee_payments p
    where p.event_id = v_event.id and p.status = 'success'
  ) then
    raise exception 'Pay Inkroot''s hosting fee for this event before publishing it.';
  end if;

  update guild_events set approval_status = 'published', published_at = now()
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 4. Grants.
-- ----------------------------------------------------------------------------------------------

revoke all on function set_guild_event_hosting_fee(bigint, text) from public;
revoke all on function admin_list_guild_event_hosting_fee_rates() from public;

grant execute on function current_guild_event_hosting_fee_kobo() to authenticated;
grant execute on function current_guild_event_hosting_fee() to authenticated;
grant execute on function set_guild_event_hosting_fee(bigint, text) to authenticated;
grant execute on function admin_list_guild_event_hosting_fee_rates() to authenticated;

-- Safe to run anytime: every new table/column is additive, publish_guild_event's redefinition
-- only tightens an already-owner-and-approval-status-gated function, and the seed rate only
-- inserts when the rates table is empty.
