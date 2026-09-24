-- ============================================================================================
-- Migration 42: Guild Events — the second real revenue source the Guild Treasury's generic
-- distribute_guild_revenue() engine (see the Guild Revenue Distribution migration) was always
-- built to support via its reserved kind='event_revenue'/source='event_sale' vocabulary. Two
-- funding shapes, both landing in the same place once verified:
--   - host = 'guild': the guild itself hosts a competition with a real entry fee. Anyone signed
--     in can pay to enter (guild_event_entries, a small purchases-shaped table with its own
--     Paystack reference and the exact same pending -> success/failed webhook lifecycle
--     `purchases` already has). Inkroot's platform fee (PLATFORM_FEE_BPS, same constant and same
--     formula as an ordinary book sale) is applied per entry as it's paid, not at settlement, so
--     a later fee-schedule change never reclassifies an already-paid entry.
--   - host = 'inkroot': Inkroot itself funds a cash prize for a guild's members directly — no
--     entry fee, no reader payment, so no platform fee applies (Inkroot isn't taking a cut of its
--     own money). Only ever created and settled by Inkroot directly (there's no admin role or
--     admin UI in this app to gate it behind, so this is enforced the only way that's actually
--     true today: create_guild_event()/settle_guild_event() both refuse to act on a host='inkroot'
--     row for any caller with a real auth.uid() — i.e. any signed-in app user — leaving only a
--     direct service-role/SQL action, run by Inkroot outside the app, able to do it).
--
-- Either way, "settling" an event is the one moment real money moves: the guild owner (or,
-- for an Inkroot-hosted prize, Inkroot itself) declares winner shares among that guild's own
-- members, and settle_guild_event() computes the verified pool (summed successful entry fees,
-- net of the platform fee already applied per entry; or the fixed cash prize) and hands it to
-- distribute_guild_revenue() — the exact same engine, same rounding, same permanent-ledger
-- guarantee an Anthology sale already goes through. "Credit each member's earnings" + "credit
-- the guild's share" + "record every transaction in the ledger" all happen inside that one
-- shared function, not duplicated here.
--
-- Duplicate-processing protection, layered the same way the Anthology wiring documents it:
--   a. guild_events.status only ever moves open -> closed -> settled (or open -> settled), and
--      settle_guild_event() re-checks that status under an advisory lock keyed to the event
--      before doing anything, so two concurrent settle calls can't both pass.
--   b. distribute_guild_revenue() itself (modified below to accept an event, not just a
--      purchase, as its dedup key) independently checks whether any ledger row already
--      references this event before writing anything — belt-and-suspenders even if (a) were
--      ever bypassed.
--   c. Each entry fee payment has its own paystack_reference-scoped, `.eq('status','pending')`
--      webhook update, same as a purchases row — a retried Paystack webhook event can't mark
--      (or pay for) the same entry twice.
--   d. A person can enter a given guild-hosted event at most once (unique (event_id,
--      entrant_id)) — a deliberate scope choice (one ticket per person), not a technical
--      limitation of the underlying tables.
--
-- Winners must be real members of the guild whose event this is — settle_guild_event() checks
-- every declared contributor_id against player_guild_members before distributing anything,
-- same "never trust a client-supplied id" posture as everywhere else in this ledger.

-- ============================================================================================
-- 1. guild_events — one row per competition, either kind.
-- ============================================================================================

create table if not exists guild_events (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  host text not null check (host in ('inkroot', 'guild')),
  title text not null check (char_length(title) <= 200),
  -- Exactly one funding amount is set, matching which host this is: a guild-hosted event's pot
  -- is whatever verified entry fees actually come in (not fixed up front), while an
  -- Inkroot-hosted prize is a fixed amount Inkroot is granting outright.
  entry_fee_kobo bigint check (entry_fee_kobo > 0),
  cash_prize_kobo bigint check (cash_prize_kobo > 0),
  check (
    (host = 'guild' and entry_fee_kobo is not null and cash_prize_kobo is null) or
    (host = 'inkroot' and cash_prize_kobo is not null and entry_fee_kobo is null)
  ),
  status text not null default 'open' check (status in ('open', 'closed', 'settled')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

alter table guild_events enable row level security;

-- Same "publicly browsable" posture as published_books — anyone signed in can see an event
-- (including non-members, since a guild-hosted event's entry fee is open to any reader, exactly
-- like an anthology's book is open to any buyer) and decide whether to enter.
create policy "anyone can read guild events" on guild_events
  for select using (true);
-- No client insert/update policy: every write goes through create_guild_event()/
-- close_guild_event()/settle_guild_event() below, which re-check ownership and host server-side.

create index if not exists guild_events_guild_id_idx on guild_events (guild_id, created_at desc);
create index if not exists guild_events_status_idx on guild_events (status) where status = 'open';

-- ============================================================================================
-- 2. guild_event_entries — one row per paid (or attempted) entry into a host='guild' event.
-- Same shape and lifecycle as `purchases`: created pending by paystack-init-event-entry, only
-- ever flipped to success/failed by paystack-webhook once Paystack itself confirms the charge.
-- ============================================================================================

create table if not exists guild_event_entries (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  entrant_id uuid not null references auth.users(id) on delete cascade,
  paystack_reference text not null unique,
  amount_kobo bigint not null check (amount_kobo > 0),      -- what the entrant paid
  net_kobo bigint not null check (net_kobo >= 0),            -- after Inkroot's platform fee — this is what counts toward the event's pool at settlement
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  unique (event_id, entrant_id)
);

alter table guild_event_entries enable row level security;

create policy "entrant reads their own event entries" on guild_event_entries
  for select using (auth.uid() = entrant_id);
create policy "guild owner reads entries for their own events" on guild_event_entries
  for select using (
    exists (
      select 1 from guild_events e join player_guilds g on g.id = e.guild_id
      where e.id = guild_event_entries.event_id and g.owner_id = auth.uid()
    )
  );
-- No client insert/update policy — see purchases' own comment; the same reasoning applies here:
-- only paystack-init-event-entry (pending) and paystack-webhook (success/failed), both
-- service_role, ever write this table.

create index if not exists guild_event_entries_event_id_status_idx
  on guild_event_entries (event_id, status);

-- ============================================================================================
-- 3. project_event_id finally gets its foreign key — see its original comment in
-- guild_treasury_transactions ("no FK yet ... add one once they do"). Safe to add now: no caller
-- anywhere in the app has ever passed a real value for it (contribute_to_guild_treasury/
-- spend_from_guild_treasury's own p_project_event_id has always defaulted to null in every
-- existing call site), so there is no existing row this constraint could possibly reject.
-- ============================================================================================

alter table guild_treasury_transactions
  add constraint guild_treasury_transactions_project_event_id_fkey
  foreign key (project_event_id) references guild_events(id) on delete set null;

-- ============================================================================================
-- 4. distribute_guild_revenue — extended to accept an event, not just a purchase, as its dedup
-- key. p_source_purchase_id becomes optional; exactly one of it or p_project_event_id must be
-- given (whichever the caller actually has). Every existing call site (the Anthology trigger)
-- still passes p_source_purchase_id and is completely unaffected — this only adds a second,
-- equally-enforced path for a source that was never a single purchase to begin with.
-- ============================================================================================

create or replace function distribute_guild_revenue(
  p_guild_id uuid,
  p_gross_amount_kobo bigint,
  p_shares jsonb,
  p_kind text,
  p_source text,
  p_source_purchase_id uuid default null,
  p_anthology_id uuid default null,
  p_project_event_id uuid default null,
  p_title text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_dedup_key text;
  v_already_processed boolean;
  v_shares_sum integer;
  v_member_credited bigint;
  v_guild_share bigint;
begin
  if p_gross_amount_kobo is null or p_gross_amount_kobo <= 0 then
    return; -- nothing to distribute
  end if;
  if p_source_purchase_id is null and p_project_event_id is null then
    raise exception 'A source purchase or a guild event id is required — every distribution must trace back to one verified source.';
  end if;

  -- Locked to this specific source (one purchase, or one event's settlement), not the whole
  -- guild, so unrelated distributions for the same guild never block on each other.
  v_dedup_key := coalesce(p_source_purchase_id::text, p_project_event_id::text);
  perform pg_advisory_xact_lock(hashtext('guild_revenue_distribution:' || v_dedup_key));

  if p_source_purchase_id is not null then
    select exists(
      select 1 from guild_treasury_transactions where source_purchase_id = p_source_purchase_id
    ) into v_already_processed;
  else
    select exists(
      select 1 from guild_treasury_transactions where project_event_id = p_project_event_id
    ) into v_already_processed;
  end if;
  if v_already_processed then
    return; -- this exact source has already been distributed — never pay it out twice
  end if;

  select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
  from jsonb_array_elements(p_shares) s;
  if v_shares_sum < 0 or v_shares_sum > 10000 then
    raise exception 'Contributor shares must add up to no more than 100%% of the sale.';
  end if;

  -- Largest-remainder distribution, same method propose_anthology_revenue_agreement's
  -- 'contribution' split already uses: floor everyone first, then hand the leftover kobo (at
  -- most one per contributor) to whoever was closest to rounding up. Guarantees every member
  -- credit plus the guild's own share sums to exactly p_gross_amount_kobo — no kobo invented or
  -- lost to rounding.
  with shares as (
    select (s->>'contributor_id')::uuid as contributor_id, (s->>'share_bps')::integer as share_bps
    from jsonb_array_elements(p_shares) s
    where (s->>'share_bps')::integer > 0
  ),
  amounts as (
    select contributor_id, share_bps,
      floor(p_gross_amount_kobo * share_bps::numeric / 10000)::bigint as base,
      (p_gross_amount_kobo * share_bps::numeric / 10000) - floor(p_gross_amount_kobo * share_bps::numeric / 10000) as frac
    from shares
  ),
  total_base as (
    select coalesce(sum(base), 0)::bigint as sum_base from amounts
  ),
  ranked as (
    select a.contributor_id, a.base, a.frac,
           row_number() over (order by a.frac desc, a.contributor_id) as rn,
           (p_gross_amount_kobo - t.sum_base) as leftover
    from amounts a cross join total_base t
  ),
  -- Capturing exactly what this statement just inserted (via RETURNING), rather than a second,
  -- separate SELECT keyed off source_purchase_id/project_event_id, sidesteps ever having to
  -- write a WHERE clause that means "whichever dedup key this call used" twice in one function —
  -- one place to get right instead of two that could drift apart.
  inserted as (
    insert into guild_treasury_transactions
      (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
       project_event_id, status, title, source_purchase_id, anthology_id)
    select p_guild_id, 'member', contributor_id, 'credit', p_kind,
           base + case when rn <= leftover then 1 else 0 end, 'NGN', p_source, 'member_earnings_held',
           p_project_event_id, 'success', p_title, p_source_purchase_id, p_anthology_id
    from ranked
    where base + case when rn <= leftover then 1 else 0 end > 0
    returning amount_kobo
  )
  select coalesce(sum(amount_kobo), 0) into v_member_credited from inserted;

  v_guild_share := p_gross_amount_kobo - v_member_credited;
  if v_guild_share > 0 then
    insert into guild_treasury_transactions
      (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
       project_event_id, status, title, source_purchase_id, anthology_id)
    values
      (p_guild_id, 'guild', null, 'credit', p_kind, v_guild_share, 'NGN', p_source, 'guild_treasury',
       p_project_event_id, 'success', p_title, p_source_purchase_id, p_anthology_id);
  end if;
end;
$$;

revoke all on function distribute_guild_revenue(uuid, bigint, jsonb, text, text, uuid, uuid, uuid, text) from public;

-- ============================================================================================
-- 5. create_guild_event / close_guild_event — guild-owner tools for the host='guild' path only.
-- An Inkroot-hosted row is never created through this (or any) authenticated-callable function —
-- see the migration header above.
-- ============================================================================================

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if p_host is distinct from 'guild' then
    raise exception 'Inkroot-hosted events are created by Inkroot directly.';
  end if;
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can host a guild event.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_cash_prize_kobo is not null then
    raise exception 'A guild-hosted event funds its own prize from entry fees — it has no separate cash prize.';
  end if;

  insert into guild_events (guild_id, host, title, entry_fee_kobo, created_by)
  values (p_guild_id, 'guild', trim(p_title), p_entry_fee_kobo, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function close_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can close entries for this event.';
  end if;
  update guild_events set status = 'closed'
  where id = p_event_id and guild_id = p_guild_id and status = 'open'
  returning * into v_row;
  if not found then
    raise exception 'Event not found, not yours, or not open.';
  end if;
  return v_row;
end;
$$;

revoke all on function create_guild_event(uuid, text, text, bigint, bigint) from public;
revoke all on function close_guild_event(uuid, uuid) from public;
grant execute on function create_guild_event(uuid, text, text, bigint, bigint) to authenticated;
grant execute on function close_guild_event(uuid, uuid) to authenticated;

-- ============================================================================================
-- 6. settle_guild_event — the one moment real money moves for either host. See the migration
-- header for the full authorization/dedup story.
-- ============================================================================================

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_gross bigint;
  v_bad_contributor uuid;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if v_event.host = 'guild' then
    if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
      raise exception 'Only the guild owner can settle this event.';
    end if;
  else -- 'inkroot'
    if auth.uid() is not null then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  -- One settlement per event, ever — locked to the event itself so two concurrent settle
  -- attempts can't both pass the status check below.
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  -- Every declared winner must be an actual member of this guild — never trust a
  -- client-supplied id, same posture as every other write in this ledger.
  select (s->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_shares) s
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  if v_event.host = 'guild' then
    -- The verified pool: every successfully-paid entry's already-fee-applied net amount. Never
    -- amount_kobo (that's what the entrant paid, before Inkroot's cut).
    select coalesce(sum(net_kobo), 0) into v_gross
    from guild_event_entries where event_id = p_event_id and status = 'success';
  else
    v_gross := v_event.cash_prize_kobo; -- fixed, no fee — see migration header
  end if;

  perform distribute_guild_revenue(
    p_guild_id := p_guild_id,
    p_gross_amount_kobo := v_gross,
    p_shares := p_shares,
    p_kind := 'event_revenue',
    p_source := 'event_sale',
    p_source_purchase_id := null,
    p_anthology_id := null,
    p_project_event_id := p_event_id,
    p_title := 'Guild event \u2014 ' || v_event.title
  );

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;

-- Safe to run anytime: every new table starts empty, the FK on project_event_id has nothing
-- existing to reject (see its own comment above), and distribute_guild_revenue's extended
-- dedup logic is exercised identically to before for every existing (purchase-sourced) caller.
