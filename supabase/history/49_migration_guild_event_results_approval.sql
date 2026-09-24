-- ============================================================================================
-- Migration 49: Guild Event results — organizer submission + required approval, on top of the
-- settlement engine 42_migration_guild_events.sql already built (settle_guild_event() /
-- distribute_guild_revenue() already create payout records, credit winners, credit the guild's
-- own share, and record everything in guild_treasury_transactions — nothing about how money
-- actually moves changes here).
--
-- Before this migration, only the guild owner could settle an event, and only by declaring
-- winners and paying them out in the same action (guild-events-panel.jsx's "Declare winners"
-- form calling settle_guild_event() directly). That's left fully working — a guild owner who
-- wants to settle an event themselves still can. This migration adds a second, delegated path:
--
--   1. submit_guild_event_results() — the event's own organizer (guild_events.organizer_id,
--      from 45_migration_guild_event_creation_workflow.sql) proposes winner placements once the
--      event is marked 'completed'. Nothing is paid out yet — this only records a proposal
--      (guild_event_results, status='pending_approval').
--   2. approve_guild_event_results() — a guild authority (Leader/Treasurer/Officer — same
--      is_guild_treasury_authorized() role check 44_migration_guild_treasury_roles_and_approvals
--      .sql already uses for guild-owned-fund spends) reviews the proposal and, if it approves,
--      this is the one call that actually settles the event: it hands the organizer's declared
--      placements to the existing settle_guild_event() unchanged, which creates the payout
--      records, credits winners, credits the guild's own remainder, and writes the ledger rows —
--      exactly as it always has for a direct owner settle.
--   3. reject_guild_event_results() — sends a proposal back with a reason; the organizer can
--      revise and resubmit (submit_guild_event_results upserts the same row rather than piling
--      up duplicates).
--
-- Four-eyes, not rubber-stamped: the same person who submitted a proposal can never also approve
-- or reject it (checked explicitly in both functions below), so results can't become final on
-- one person's say-so alone.
--
-- Duplicate-payout protection is layered exactly the way 42's own header describes, plus one
-- more layer specific to this workflow:
--   a. guild_event_results.status only ever moves pending_approval -> approved (terminal) or
--      pending_approval -> rejected (resubmittable back to pending_approval) — approve_guild_
--      event_results() re-checks status = 'pending_approval' under a row lock before doing
--      anything, so two concurrent approvals of the same proposal can't both go through.
--   b. The actual settlement still goes through settle_guild_event(), whose own advisory lock
--      and guild_events.status = 'settled' check (unchanged) is what makes it impossible to pay
--      the same event out twice regardless of which path (direct owner settle, or this
--      submit-then-approve path) got there first.
--   c. distribute_guild_revenue()'s own project_event_id dedup (unchanged) is the final,
--      independent backstop even if (a) and (b) were ever bypassed.
--   d. unique(event_id) on guild_event_results means there is only ever one results row per
--      event — a resubmission after rejection overwrites it in place rather than creating a
--      second competing proposal.
--
-- settle_guild_event() itself is widened here from "guild owner only" to any authorized guild
-- role (Leader/Treasurer/Officer) — the same broadening 44_migration_guild_treasury_roles_and_
-- approvals.sql already did for spend_from_guild_treasury, so a Treasurer or Officer approving
-- results can actually settle the event and not just record an approval that then fails. The
-- guild owner (always 'leader') still qualifies, so a solo-owner guild loses nothing — but see
-- the four-eyes rule above: the owner still can't approve their own submission if they're also
-- the event's organizer.
--
-- Safe to run anytime: guild_event_results is a brand-new table (starts empty), and settle_
-- guild_event() keeps its exact prior signature and every prior check (locked financial
-- agreement, exact prize-pool-bps match, member-only winners) — only its authorization check
-- widens, which can never turn a previously-allowed caller into a refused one.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. guild_event_results — one row per event's (current) results proposal.
-- ----------------------------------------------------------------------------------------------

create table if not exists guild_event_results (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  event_id uuid not null references guild_events(id) on delete cascade,
  -- [{"contributor_id": "...", "place": 1, "share_bps": 5000}, ...] — the organizer's proposed
  -- payout. Mirrors settle_guild_event()'s own p_shares shape (contributor_id/share_bps) plus
  -- `place`, which is informational (mirrors prize_structure's own "informational, never
  -- enforced" posture from 45_migration_guild_event_creation_workflow.sql) — approval hands
  -- contributor_id/share_bps straight to settle_guild_event(), which re-validates all of it
  -- server-side exactly as it always has.
  placements jsonb not null,
  status text not null default 'pending_approval' check (status in ('pending_approval', 'approved', 'rejected')),
  submitted_by uuid references auth.users(id) on delete set null,
  submitted_at timestamptz not null default now(),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  rejection_reason text check (char_length(rejection_reason) <= 2000),
  settled_at timestamptz,
  unique (event_id)
);

alter table guild_event_results enable row level security;

-- The organizer who submitted a proposal can always read it back (to see rejection reasons,
-- track its status, etc).
create policy "organizer reads their own submitted results" on guild_event_results
  for select using (auth.uid() = submitted_by);
-- Same authority that can approve/reject can also just browse the queue.
create policy "guild treasury authority reads event results" on guild_event_results
  for select using (is_guild_treasury_authorized(guild_id));
-- No client insert/update policy — every write goes through the three functions below, which
-- re-check organizer/authority server-side exactly like every other write in this ledger.

create index if not exists guild_event_results_pending_idx
  on guild_event_results (guild_id) where status = 'pending_approval';

-- ----------------------------------------------------------------------------------------------
-- 2. submit_guild_event_results — organizer-only, and only once the event is 'completed'.
-- Upserts the single row for this event: a first submission inserts, a resubmission after
-- rejection overwrites it in place and resets it to 'pending_approval'. Refuses outright once a
-- prior submission has already been approved (and therefore already paid out).
-- ----------------------------------------------------------------------------------------------

create or replace function submit_guild_event_results(p_guild_id uuid, p_event_id uuid, p_placements jsonb)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_row guild_event_results%rowtype;
  v_bad_contributor uuid;
  v_shares_sum integer;
  v_dup_place boolean;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;
  if v_event.organizer_id is null or auth.uid() <> v_event.organizer_id then
    raise exception 'Only this event''s organizer can submit its results.';
  end if;
  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before submitting results.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  if p_placements is null or jsonb_array_length(p_placements) = 0 then
    raise exception 'Add at least one winner.';
  end if;

  select (p->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_placements) p
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (p->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  select exists (
    select 1 from jsonb_array_elements(p_placements) p
    group by (p->>'place')
    having count(*) > 1
  ) into v_dup_place;
  if v_dup_place then
    raise exception 'Each place (1st, 2nd, ...) can only be used once.';
  end if;

  -- Fail fast with the same check settle_guild_event() enforces at approval time (exact match
  -- to the locked prize pool share), rather than letting an organizer submit something an
  -- approver can never actually approve.
  select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
  if not found or not v_agreement.locked then
    raise exception 'This event has no locked financial agreement — it cannot be settled.';
  end if;
  select coalesce(sum((p->>'share_bps')::integer), 0) into v_shares_sum
  from jsonb_array_elements(p_placements) p;
  if v_shares_sum <> v_agreement.prize_pool_bps then
    raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (p_guild_id, p_event_id, p_placements, 'pending_approval', auth.uid(), now())
  on conflict (event_id) do update set
    placements = excluded.placements,
    status = 'pending_approval',
    submitted_by = excluded.submitted_by,
    submitted_at = excluded.submitted_at,
    reviewed_by = null,
    reviewed_at = null,
    rejection_reason = null,
    settled_at = null
  returning * into v_row;
  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 3. approve_guild_event_results — the moment a proposal becomes final. Requires an authorized
-- guild role, distinct from whoever submitted it, and a still-pending proposal. Delegates the
-- actual money movement entirely to the existing settle_guild_event() — see this migration's
-- header for why nothing about payout creation/crediting/ledgering is duplicated here.
-- ----------------------------------------------------------------------------------------------

create or replace function approve_guild_event_results(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
  v_event guild_events%rowtype;
  v_shares jsonb;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been submitted for this event yet.';
  end if;
  if v_results.status = 'approved' then
    raise exception 'These results have already been approved.';
  end if;
  if v_results.status <> 'pending_approval' then
    raise exception 'These results were rejected — the organizer must resubmit before they can be approved.';
  end if;

  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can approve event results.';
  end if;
  if auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also approve them.';
  end if;

  select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
  into v_shares
  from jsonb_array_elements(v_results.placements) p;

  -- The one call that actually moves money — every check settle_guild_event() has always made
  -- (locked-agreement exact match, member-only winners, dedup lock, one-settlement-ever) still
  -- applies in full; this function adds the submit/approve workflow around it, not a second way
  -- to move money.
  v_event := settle_guild_event(v_results.guild_id, p_event_id, v_shares);

  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 4. reject_guild_event_results — sends a pending proposal back with a reason. The organizer can
-- then call submit_guild_event_results() again, which overwrites this same row.
-- ----------------------------------------------------------------------------------------------

create or replace function reject_guild_event_results(p_event_id uuid, p_reason text)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been submitted for this event yet.';
  end if;
  if v_results.status <> 'pending_approval' then
    raise exception 'These results have already been decided.';
  end if;
  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can reject event results.';
  end if;
  if auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also reject them.';
  end if;

  update guild_event_results
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = p_reason
  where event_id = p_event_id
  returning * into v_results;
  return v_results;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 5. settle_guild_event — redefined only to widen its host='guild' authorization check from
-- "guild owner only" to any authorized guild role (Leader/Treasurer/Officer), matching 44_
-- migration_guild_treasury_roles_and_approvals.sql's own broadening of guild-owned-fund
-- authority. Every other check (locked agreement, exact prize-pool-bps match, member-only
-- winners, advisory lock, one-settlement-ever) is byte-for-byte identical to the version in
-- 48_migration_guild_event_financial_agreement.sql. host='inkroot' settlement is untouched.
-- ----------------------------------------------------------------------------------------------

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_gross bigint;
  v_bad_contributor uuid;
  v_agreement guild_event_financial_agreements%rowtype;
  v_shares_sum integer;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if v_event.host = 'guild' then
    if not is_guild_treasury_authorized(p_guild_id) then
      raise exception 'Only the guild leader, a treasurer, or an officer can settle this event.';
    end if;
  else -- 'inkroot'
    if auth.uid() is not null then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

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
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;

    select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
    from jsonb_array_elements(p_shares) s;
    if v_shares_sum <> v_agreement.prize_pool_bps then
      raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
    end if;

    select coalesce(sum(net_kobo), 0) into v_gross
    from guild_event_entries where event_id = p_event_id and status = 'success';
  else
    v_gross := v_event.cash_prize_kobo;
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
    p_title := 'Guild event — ' || v_event.title
  );

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 6. Grants.
-- ----------------------------------------------------------------------------------------------

revoke all on function submit_guild_event_results(uuid, uuid, jsonb) from public;
revoke all on function approve_guild_event_results(uuid) from public;
revoke all on function reject_guild_event_results(uuid, text) from public;
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;

grant execute on function submit_guild_event_results(uuid, uuid, jsonb) to authenticated;
grant execute on function approve_guild_event_results(uuid) to authenticated;
grant execute on function reject_guild_event_results(uuid, text) to authenticated;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;

-- Safe to run anytime — see this migration's header.
