-- ============================================================================================
-- Migration 48: Guild Event financial agreement — turns "prize_structure" and "guild_share_bps"
-- on guild_events (45_migration_guild_event_creation_workflow.sql) from planning-only numbers
-- nobody enforces into a real, locked commitment that:
--   1. Any signed-in person can read before they ever pay to enter (guild_event_financial_
--      agreements has the same broad "anyone signed in" read policy guild_events itself does —
--      see that migration's own comment on why a guild-hosted event is open to any reader, not
--      just guild members).
--   2. The guild owner can only set or change while the event is still 'draft'/'rejected' — the
--      exact same editable window update_guild_event_draft already enforces on the event's other
--      fields, so the two can never drift out of sync (an owner who wants to change the money
--      split after submitting has to edit the whole event back to draft, which already resets
--      the review trail — see that migration's header).
--   3. Gets permanently locked (locked = true) the moment activate_guild_event() actually opens
--      the event for entries — the first moment any money can move, same "lock at the moment
--      revenue can begin" reasoning publish_guild_anthology already uses for
--      guild_anthology_revenue_agreements (36_migration_guild_anthology_revenue_agreements.sql).
--   4. Is what settle_guild_event() itself now checks, not just what the create form once
--      showed: declared winner shares must add up to EXACTLY the locked prize_pool_bps, no more
--      and no less. Since distribute_guild_revenue already hands the guild everything the
--      winners weren't credited (v_gross - v_member_credited — see 42_migration_guild_events.sql),
--      pinning the winners' total to an exact, pre-committed number is what pins the guild's own
--      take to an exact, pre-committed number too — an organizer can no longer quietly shrink
--      what winners get and keep the difference, because "quietly" is no longer possible: the
--      number participants were shown before paying is the only number the database will settle
--      against.
--
-- What this migration deliberately does NOT change: entry_fee_kobo is still what an entrant
-- actually pays, and Inkroot's own per-entry cut (PLATFORM_FEE_BPS, applied the instant an entry
-- is charged — see paystack-init-event-entry) is still computed exactly as it always was and
-- still lands in guild_event_entries.net_kobo before this agreement ever sees a kobo. This
-- agreement only governs how that already-net pool is split between "goes to declared winners"
-- (prize_pool_bps) and "goes straight to the guild's own treasury" (guild_share_bps + every named
-- other_allocations line, e.g. a judges' honorarium or a charity cut the guild committed to
-- carving out of its own share — those still land in the guild's treasury balance as one
-- credit, same as guild_share_bps always has; a guild owner who actually wants to pay a named
-- allocation out to someone outside the app still does that via the guild's own existing
-- spend_from_guild_treasury/propose_guild_treasury_spend flow — this migration's guarantee
-- is that the *percentage* promised for that purpose is locked and visible, not that this
-- migration invents a new payment rail). platform_fee_bps on the agreement itself is a display
-- snapshot only — it records what the client (via the existing platform-fee-info function)
-- reported as Inkroot's live per-entry cut at the moment the agreement was proposed, purely so
-- the breakdown shown to a participant stays internally consistent even if Inkroot's own
-- PLATFORM_FEE_BPS constant changes later. It is never itself used to compute a charge; nothing
-- about how paystack-init-event-entry actually charges an entrant changes here.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. guild_event_financial_agreements — one per event. share_bps values are basis points
-- (10000 = 100%), same convention every other split in this schema already uses.
-- ----------------------------------------------------------------------------------------------

create or replace function guild_event_other_allocations_bps(p jsonb)
returns integer
language sql
immutable
as $$
  select coalesce(sum(coalesce((elem->>'bps')::integer, 0)), 0)::integer
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) elem;
$$;

create table if not exists guild_event_financial_agreements (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references guild_events(id) on delete cascade,
  guild_id uuid not null references player_guilds(id) on delete cascade,
  -- Display snapshot only — see migration header. Never used to compute an actual charge.
  platform_fee_bps integer not null check (platform_fee_bps >= 0 and platform_fee_bps <= 10000),
  -- Share of the NET pool (post-platform-fee, i.e. the same figure guild_event_entries.net_kobo
  -- already sums at settlement) that must go to declared winners — enforced exactly, see
  -- settle_guild_event below.
  prize_pool_bps integer not null check (prize_pool_bps > 0 and prize_pool_bps <= 10000),
  -- Share of the net pool that goes straight to the guild's own treasury balance, with no named
  -- purpose attached — the organizer's own discretionary cut.
  guild_share_bps integer not null check (guild_share_bps >= 0 and guild_share_bps <= 10000),
  -- Named carve-outs of the guild's own take, e.g. [{"label": "Judges' honorarium", "bps": 500}].
  -- These still land in the guild treasury as part of the same single credit guild_share_bps
  -- always produced (see migration header) — what's locked here is the promise of how much
  -- of that credit was earmarked for what, so participants (and the guild's own members
  -- reviewing the treasury ledger) can hold the organizer to it.
  other_allocations jsonb not null default '[]'::jsonb,
  check (prize_pool_bps + guild_share_bps + guild_event_other_allocations_bps(other_allocations) = 10000),
  revision integer not null default 1,
  locked boolean not null default false,
  locked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table guild_event_financial_agreements enable row level security;

-- Same broad "anyone signed in" read as guild_events itself — the whole point is that a
-- prospective entrant can see exactly where their money would go before they ever pay (see
-- fetchGuildEventFinancialAgreement / the EventCard breakdown in guild-events-panel.jsx).
create policy "anyone signed in can read event financial agreements" on guild_event_financial_agreements
  for select using (auth.uid() is not null);

-- Deliberately no insert/update/delete policy — only propose_guild_event_financial_
-- agreement() (owner-only, draft/rejected-only) and activate_guild_event() (lock only) below,
-- both security definer, ever write this table. Same posture as every other locked-agreement
-- table in this schema (guild_anthology_revenue_agreements, guild_event_hosting_fee_payments).

create index if not exists guild_event_financial_agreements_guild_idx
  on guild_event_financial_agreements (guild_id);

-- ----------------------------------------------------------------------------------------------
-- 2. propose_guild_event_financial_agreement — the only way to set or change this
-- agreement. Owner-only, host='guild' only, and only while the event itself is still editable
-- (draft/rejected) — the identical window update_guild_event_draft already enforces, so
-- "can I still change the money split" is never a different question from "can I still change
-- the rest of the form."
-- ----------------------------------------------------------------------------------------------

create or replace function propose_guild_event_financial_agreement(
  p_guild_id uuid,
  p_event_id uuid,
  p_prize_pool_bps integer,
  p_guild_share_bps integer,
  p_other_allocations jsonb default '[]'::jsonb,
  p_platform_fee_bps integer default null
)
returns guild_event_financial_agreements
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_financial_agreements%rowtype;
  v_found boolean;
  v_other_sum integer;
  v_row guild_event_financial_agreements;
  v_elem jsonb;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can set this event''s financial structure.';
  end if;

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id for update;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'An Inkroot-hosted prize has no entry fees to divide up — there''s nothing to set here.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'This event''s financial structure can no longer be changed here — edit the event (which resets it to draft for re-review) to change it.';
  end if;

  if p_platform_fee_bps is null or p_platform_fee_bps < 0 or p_platform_fee_bps > 10000 then
    raise exception 'A valid current platform fee is required to record this agreement.';
  end if;
  if p_prize_pool_bps is null or p_prize_pool_bps <= 0 or p_prize_pool_bps > 10000 then
    raise exception 'The prize pool must be a positive share of the pool — participants are paying to compete for something.';
  end if;
  if p_guild_share_bps is null or p_guild_share_bps < 0 or p_guild_share_bps > 10000 then
    raise exception 'The guild share must be between 0%% and 100%%.';
  end if;

  for v_elem in select * from jsonb_array_elements(coalesce(p_other_allocations, '[]'::jsonb)) loop
    if coalesce(trim(v_elem->>'label'), '') = '' then
      raise exception 'Every other allocation needs a label — who or what it''s for.';
    end if;
    if char_length(v_elem->>'label') > 200 then
      raise exception 'An allocation label is too long.';
    end if;
    if (v_elem->>'bps') is null or (v_elem->>'bps')::integer < 0 or (v_elem->>'bps')::integer > 10000 then
      raise exception 'Every other allocation needs a share between 0%% and 100%%.';
    end if;
  end loop;

  v_other_sum := guild_event_other_allocations_bps(p_other_allocations);
  if p_prize_pool_bps + p_guild_share_bps + v_other_sum <> 10000 then
    raise exception 'The prize pool, guild share, and every other allocation must add up to exactly 100%% of the pool — they currently add up to % basis points.', (p_prize_pool_bps + p_guild_share_bps + v_other_sum);
  end if;

  select * into v_existing from guild_event_financial_agreements where event_id = p_event_id for update;
  v_found := found;
  if v_found and v_existing.locked then
    raise exception 'This event''s financial agreement is locked and can no longer be changed.';
  end if;

  if v_found then
    update guild_event_financial_agreements set
      platform_fee_bps = p_platform_fee_bps,
      prize_pool_bps = p_prize_pool_bps,
      guild_share_bps = p_guild_share_bps,
      other_allocations = coalesce(p_other_allocations, '[]'::jsonb),
      revision = v_existing.revision + 1,
      updated_at = now()
    where id = v_existing.id
    returning * into v_row;
  else
    insert into guild_event_financial_agreements
      (event_id, guild_id, platform_fee_bps, prize_pool_bps, guild_share_bps, other_allocations, created_by)
    values
      (p_event_id, p_guild_id, p_platform_fee_bps, p_prize_pool_bps, p_guild_share_bps,
       coalesce(p_other_allocations, '[]'::jsonb), auth.uid())
    returning * into v_row;
  end if;

  return v_row;
end;
$$;

revoke all on function propose_guild_event_financial_agreement(uuid, uuid, integer, integer, jsonb, integer) from public;
grant execute on function propose_guild_event_financial_agreement(uuid, uuid, integer, integer, jsonb, integer) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 3. submit_guild_event_for_approval — redefined only to also require a financial agreement
-- on file before a host='guild' event can even reach Inkroot's review queue, so the numbers
-- Inkroot approves are always the real, complete numbers — not a submission that still has
-- no committed money split.
-- ----------------------------------------------------------------------------------------------

create or replace function submit_guild_event_for_approval(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can submit this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'This event has already been submitted.';
  end if;
  if v_event.title is null or length(trim(v_event.title)) = 0
     or v_event.entry_fee_kobo is null or v_event.start_date is null or v_event.end_date is null then
    raise exception 'Fill in the title, entry fee, and start/end dates before submitting.';
  end if;
  if v_event.host = 'guild' and not exists (
    select 1 from guild_event_financial_agreements a where a.event_id = p_event_id
  ) then
    raise exception 'Set how entry fees will be divided — prize pool, guild share, and any other allocations — before submitting.';
  end if;

  update guild_events set approval_status = 'pending_approval', submitted_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 4. activate_guild_event — redefined only to lock the financial agreement in the same
-- breath it opens the event for entries. See migration header for why this is the right moment:
-- it's the first moment any money can actually move.
-- ----------------------------------------------------------------------------------------------

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can activate this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'published' then
    raise exception 'Publish this event before opening it for entries.';
  end if;

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 5. settle_guild_event — redefined only to enforce the locked agreement for host='guild'
-- events. host='inkroot' settlement (no entry fees, no agreement, Inkroot-only caller) is
-- completely unchanged — see migration 42's own header on why that path has always been
-- fully Inkroot-controlled already.
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
    if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
      raise exception 'Only the guild owner can settle this event.';
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
    -- The locked agreement is what participants were shown before they ever paid to enter (see
    -- migration header) — winner shares must add up to EXACTLY that prize pool percentage,
    -- not merely "no more than," so the guild's own take (whatever distribute_guild_revenue
    -- doesn't credit to a winner) is always exactly the locked remainder. This is the actual
    -- enforcement: an organizer cannot under-declare winners' shares to quietly keep more for
    -- the guild than what participants agreed to before paying.
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;

    select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
    from jsonb_array_elements(p_shares) s;
    if v_shares_sum <> v_agreement.prize_pool_bps then
      raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
    end if;

    -- The verified pool: every successfully-paid entry's already-fee-applied net amount. Never
    -- amount_kobo (that's what the entrant paid, before Inkroot's cut).
    select coalesce(sum(net_kobo), 0) into v_gross
    from guild_event_entries where event_id = p_event_id and status = 'success';
  else
    v_gross := v_event.cash_prize_kobo; -- fixed, no fee — see migration 42's own header
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

revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 6. admin_list_pending_guild_events — return type extended (drop + recreate, since
-- CREATE OR REPLACE can't change a set-returning function's output columns) so Inkroot's review
-- queue shows the real, committed financial agreement alongside everything else it already
-- reviewed — not just the old planning-only prize_structure/guild_share_bps fields.
-- ----------------------------------------------------------------------------------------------

drop function if exists admin_list_pending_guild_events();

create function admin_list_pending_guild_events()
returns table (
  id uuid, guild_id uuid, guild_name text, title text, description text, rules text,
  event_type text, entry_fee_kobo bigint, participant_limit integer, prize_structure jsonb,
  guild_share_bps integer, start_date timestamptz, end_date timestamptz,
  organizer_id uuid, cover_image_url text, submitted_at timestamptz, created_by uuid,
  financial_platform_fee_bps integer, financial_prize_pool_bps integer,
  financial_guild_share_bps integer, financial_other_allocations jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can review guild event submissions.';
  end if;
  return query
    select e.id, e.guild_id, g.name, e.title, e.description, e.rules,
           e.event_type, e.entry_fee_kobo, e.participant_limit, e.prize_structure,
           e.guild_share_bps, e.start_date, e.end_date,
           e.organizer_id, e.cover_image_url, e.submitted_at, e.created_by,
           a.platform_fee_bps, a.prize_pool_bps, a.guild_share_bps, a.other_allocations
    from guild_events e
    join player_guilds g on g.id = e.guild_id
    left join guild_event_financial_agreements a on a.event_id = e.id
    where e.approval_status = 'pending_approval'
    order by e.submitted_at asc nulls last;
end;
$$;

revoke all on function admin_list_pending_guild_events() from public;
grant execute on function admin_list_pending_guild_events() to authenticated;

-- Safe to run anytime: the new table starts empty and only ever written by the two functions
-- above; every redefined function (submit_guild_event_for_approval, activate_guild_event,
-- settle_guild_event) keeps its exact prior signature and grants, and only tightens behavior for
-- host='guild' events that now must go through this migration's new agreement — any event
-- already sitting in 'active' or beyond from before this migration ran has no agreement row and
-- will correctly be refused at settlement until its owner is treated as needing one (in practice,
-- run this before any such event reaches settlement, or backfill an agreement for it directly).
