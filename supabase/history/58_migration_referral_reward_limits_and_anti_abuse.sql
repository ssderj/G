-- Migration 58: Referral Reward limits and anti-abuse — closes the fraud vectors an unmoderated
-- referral-reward system always has to close eventually, and moves every threshold that was
-- still a hardcoded literal (the three eligibility floors from migration 56, and the fee-share
-- percentage from migration 57) into one moderator-configurable table. No new wallet, no new
-- payout pipeline, no change to referral_grants' shape or to referral_reward_progress()'s
-- contract — src/lib/referrals.js and every screen that ever calls it needs zero changes.
--
-- Run this after 57_migration_referral_reward_platform_fee_funding.sql. Safe to run anytime: the
-- new config table seeds itself with the exact values 56/57 already hardcoded (so behavior is
-- byte-for-byte identical until a moderator actually changes a setting), the new reversals table
-- is additive, and the redeclared functions keep every existing signature.
--
-- ================================================================================================
-- THREAT-BY-THREAT: what this migration does about each thing asked for
-- ================================================================================================
--
--   Self-referrals — ALREADY CLOSED, unchanged here. `check (referrer_id <> referee_id)` on
--     `referrals` itself, plus an explicit check inside redeem_referral_code() (migration 55).
--     Structural, not a threshold, so there's nothing to make configurable.
--
--   Duplicate accounts — NEW: referral_devices_linked() below reuses device_signals (migration
--     30's soft ban-evasion signal — the same "a plain, easily-cleared random id recorded per
--     sign-in" table src/shared-utils/device-signal.js already documents at length) to check
--     whether a referrer and their referee have ever signed in on the same browser. That table's
--     own comment is explicit that the signal "never auto-blocks anything on its own" for
--     moderation purposes — worth being honest that this migration treats it differently, and
--     why: moderation there means banning an account or restricting content, a real and
--     hard-to-reverse cost against a signal that's trivial to spoof by clearing storage. Here it
--     only ever withholds a NOT-yet-paid reward — the account, its content, and its ability to
--     keep using Inkroot are completely untouched, redemption/tracking (migration 55) still
--     happens normally, and it's fully reversible (a moderator can always grant manually via
--     SQL, the same escape hatch every other edge case in this schema already relies on). That
--     asymmetry — cheap to apply, cheap to reverse, blocks money rather than speech or access —
--     is why grant_referral_reward() below is allowed to gate on it directly instead of only
--     surfacing it to a human.
--
--   Repeated purchases designed to farm rewards — ALREADY MOSTLY CLOSED (unique(referral_id,
--     kind) in migration 56 means a given referral can pay out `reader_purchase` at most once,
--     ever, no matter how many purchases the referee goes on to make), TIGHTENED here by the new
--     eligibility holding period (see below) so a purchase can't fund a reward until it's had
--     time to prove it will actually stick.
--
--   Refund abuse — NEW, two parts. (a) Every eligibility signal and every reward-amount function
--     below now also requires the qualifying purchase(s)/distribution(s) to be older than the
--     new configurable `eligibility_holding_period_days` — a purchase that gets refunded or
--     disputed inside that window (see migration 50's `refunded` status and its webhook handler)
--     simply never reaches `status = 'success'` for long enough to fund anything in the first
--     place. (b) For the rarer case where a reward was already granted before a refund/dispute
--     landed, reconcile_referral_grants() below re-derives eligibility for every past grant and
--     permanently reverses (via the new append-only referral_grant_reversals ledger — grants
--     themselves are still never updated or deleted, same permanence as achievement_grants and
--     guild_treasury_transactions) any grant whose underlying activity no longer qualifies.
--     author_balance_kobo() nets reversals out; referral_reward_progress() still shows the
--     original grant as history, same "ledger is history, balance is the net" split this schema
--     already uses for withdrawals and guild treasury. A grant, once reversed, can never be
--     re-granted (unique(referral_id, kind) still holds) — closing the "buy, get paid, refund,
--     rebuy" loop for good on that specific (referral, kind) pair.
--
--   Fake activity — ALREADY MOSTLY CLOSED (every signal re-derives eligibility from a real,
--     externally-verified row: a Paystack-confirmed `purchases.status = 'success'`, a real
--     30k-word `published_books`/`guild_published_books` row, a real `guild_treasury_
--     transactions` distribution — never anything the client reports about itself), TIGHTENED by
--     the same holding period and reconciliation as refund abuse above, since "fake" activity
--     that gets reversed shortly after is now caught the same way refunded activity is.
--
--   Referral chains designed to generate unlimited rewards — ALREADY STRUCTURALLY BOUNDED
--     (a referrer is only ever paid for their OWN direct referees' activity; migration 55's
--     `unique(referee_id)` means an account can be referred exactly once ever, and nothing in
--     this schema gives a referrer credit for who their referee goes on to refer — there is no
--     multi-level attribution to chain in the first place), now given a hard ceiling regardless:
--     the new `max_lifetime_referral_earnings_kobo` caps one referrer's total referral income no
--     matter how many accounts (real or fabricated) end up crediting them, and
--     referral_devices_linked() closes the specific "one operator, many sockpuppet referees"
--     version of this that a lifetime cap alone wouldn't catch quickly.
--
-- ================================================================================================
-- CONFIGURABLE LIMITS ADDED (all four asked for, all in one moderator-managed row):
--   - reward per referral      -> max_reward_per_referral_kobo (hard ceiling on any single
--                                  (referral, kind) grant, on top of the existing fee-share math)
--   - lifetime referral earnings -> max_lifetime_referral_earnings_kobo (hard ceiling on one
--                                  referrer's total referral income, ever)
--   - qualifying transaction amount -> reader_min_purchase_kobo / writer_min_earnings_kobo /
--                                  guild_min_revenue_kobo (were literal 50000/500000/500000 in
--                                  migration 56 — same values, now moderator-editable)
--   - reward eligibility period -> eligibility_holding_period_days (new: how long a qualifying
--                                  purchase/distribution must sit unrefunded before it can fund
--                                  a reward at all)
--   - fee_share_bps is also moved in alongside these (was migration 57's hardcoded
--     referral_fee_share_bps() literal 2000) since it's exactly the same kind of value and
--     belongs in the same one place.
-- ================================================================================================

-- ============================================================================================
-- referral_reward_config — singleton config row, same shape/trust-tier as rising_star_config
-- (migration 38) and guilds_on_rise_config: moderator read/update only, nothing here is
-- client-writable, and it seeds itself with migration 56/57's exact original values so nothing
-- changes behaviorally until a moderator actually edits a setting.
-- ============================================================================================

create table if not exists referral_reward_config (
  id boolean primary key default true check (id),
  reader_min_purchase_kobo bigint not null default 50000 check (reader_min_purchase_kobo >= 0),
  writer_min_earnings_kobo bigint not null default 500000 check (writer_min_earnings_kobo >= 0),
  guild_min_revenue_kobo bigint not null default 500000 check (guild_min_revenue_kobo >= 0),
  fee_share_bps integer not null default 2000 check (fee_share_bps between 0 and 10000),
  max_reward_per_referral_kobo bigint not null default 500000 check (max_reward_per_referral_kobo > 0),
  max_lifetime_referral_earnings_kobo bigint not null default 5000000 check (max_lifetime_referral_earnings_kobo > 0),
  eligibility_holding_period_days integer not null default 7 check (eligibility_holding_period_days between 0 and 90),
  updated_at timestamptz not null default now()
);

insert into referral_reward_config (id) values (true) on conflict (id) do nothing;

alter table referral_reward_config enable row level security;

-- Not publicly readable, same reasoning as rising_star_config: the exact floors/caps are part of
-- what makes this hard to game, and there's no legitimate reader-facing reason to expose them.
create policy "moderators read referral reward config" on referral_reward_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update referral reward config" on referral_reward_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- referral_devices_linked — the duplicate-account signal, scoped to exactly one question: has
-- this referrer and this referee ever signed in on the same browser. Security definer so it can
-- read device_signals (moderator-only by RLS otherwise) while returning only a boolean, same
-- narrow-result shape referral_reader_signal/etc. already use.
-- ============================================================================================

create or replace function referral_devices_linked(p_referrer_id uuid, p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from device_signals a
    join device_signals b on b.device_id = a.device_id
    where a.user_id = p_referrer_id and b.user_id = p_referee_id
  );
$$;

revoke all on function referral_devices_linked(uuid, uuid) from public;
grant execute on function referral_devices_linked(uuid, uuid) to authenticated;

-- ============================================================================================
-- referral_fee_share_bps — redeclared to read from referral_reward_config instead of a hardcoded
-- literal. Same name, same zero-argument signature, so referral_reader_reward_kobo/writer/guild
-- below (migration 57) keep calling it exactly as before with no changes of their own needed to
-- this function's callers. No longer `immutable` (it now reads a table) — `stable` instead, which
-- is what every other config-reading function in this schema already uses.
-- ============================================================================================

create or replace function referral_fee_share_bps()
returns integer
language sql stable as $$
  select fee_share_bps from referral_reward_config;
$$;

-- ============================================================================================
-- referral_reader_signal / referral_writer_signal / referral_guild_signal — redeclared: same
-- signatures, same eligibility QUESTIONS as migration 56, but the floors now come from
-- referral_reward_config instead of a literal, and every qualifying row must additionally be
-- older than eligibility_holding_period_days (make_interval(days => 0) — the config's own
-- minimum — collapses back to "no waiting period", so this is opt-in strictness, not a forced
-- delay). A purchase that's since flipped to 'refunded' (migration 50) was never going to pass
-- `status = 'success'` here regardless of age — the holding period's real job is making sure a
-- purchase has SAT at 'success' long enough for a refund/dispute to have had a real chance to
-- land before it can fund anything.
-- ============================================================================================

create or replace function referral_reader_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from purchases p
    where p.buyer_id = p_referee_id
      and p.status = 'success'
      and p.amount_kobo >= (select reader_min_purchase_kobo from referral_reward_config)
      and coalesce(p.paid_at, p.created_at)
            <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config))
  );
$$;

revoke all on function referral_reader_signal(uuid) from public;
grant execute on function referral_reader_signal(uuid) to authenticated;

create or replace function referral_writer_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (
      select 1 from published_books where author_id = p_referee_id and word_count >= 30000
      union all
      select 1 from guild_published_books where author_id = p_referee_id and word_count >= 30000
    )
    and
    coalesce((
      select sum(p.author_amount_kobo) from purchases p
      where p.author_id = p_referee_id and p.status = 'success'
        and coalesce(p.paid_at, p.created_at)
              <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config))
    ), 0) >= (select writer_min_earnings_kobo from referral_reward_config);
$$;

revoke all on function referral_writer_signal(uuid) from public;
grant execute on function referral_writer_signal(uuid) to authenticated;

create or replace function referral_guild_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(sum(t.amount_kobo), 0) >= (select guild_min_revenue_kobo from referral_reward_config)
  from guild_treasury_transactions t
  join player_guilds g on g.id = t.guild_id
  where g.owner_id = p_referee_id
    and t.kind in ('anthology_share', 'event_revenue')
    and t.status = 'success'
    and t.created_at <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config));
$$;

revoke all on function referral_guild_signal(uuid) from public;
grant execute on function referral_guild_signal(uuid) to authenticated;

-- ============================================================================================
-- referral_reader_reward_kobo / referral_writer_reward_kobo / referral_guild_reward_kobo —
-- redeclared: same fee-share math as migration 57 (still 20% of Inkroot's own already-collected
-- platform fee, never anything above it), but the floor and the aging requirement now match the
-- signal functions above exactly — same population of rows, same config-driven values, so what
-- gets counted as eligible and what gets counted as fundable can never drift apart from each
-- other.
-- ============================================================================================

create or replace function referral_reader_reward_kobo(p_referee_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select round((p.amount_kobo - p.author_amount_kobo) * referral_fee_share_bps() / 10000.0)::bigint
  from purchases p
  where p.buyer_id = p_referee_id
    and p.status = 'success'
    and p.amount_kobo >= (select reader_min_purchase_kobo from referral_reward_config)
    and coalesce(p.paid_at, p.created_at)
          <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config))
  order by coalesce(p.paid_at, p.created_at) asc
  limit 1;
$$;

revoke all on function referral_reader_reward_kobo(uuid) from public;
grant execute on function referral_reader_reward_kobo(uuid) to authenticated;

create or replace function referral_writer_reward_kobo(p_referee_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(p.amount_kobo - p.author_amount_kobo), 0) * referral_fee_share_bps() / 10000.0)::bigint
  from purchases p
  where p.author_id = p_referee_id
    and p.status = 'success'
    and coalesce(p.paid_at, p.created_at)
          <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config));
$$;

revoke all on function referral_writer_reward_kobo(uuid) from public;
grant execute on function referral_writer_reward_kobo(uuid) to authenticated;

create or replace function referral_guild_reward_kobo(p_referee_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  with owned_guild_ids as (
    select id from player_guilds where owner_id = p_referee_id
  ),
  anthology_sources as (
    select distinct t.source_purchase_id
    from guild_treasury_transactions t
    where t.guild_id in (select id from owned_guild_ids)
      and t.kind = 'anthology_share' and t.status = 'success' and t.source_purchase_id is not null
      and t.created_at <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config))
  ),
  anthology_fee as (
    select coalesce(sum(p.amount_kobo - p.author_amount_kobo), 0) as fee_kobo
    from anthology_sources s
    join purchases p on p.id = s.source_purchase_id
  ),
  event_sources as (
    select distinct t.project_event_id
    from guild_treasury_transactions t
    where t.guild_id in (select id from owned_guild_ids)
      and t.kind = 'event_revenue' and t.status = 'success' and t.project_event_id is not null
      and t.created_at <= now() - make_interval(days => (select eligibility_holding_period_days from referral_reward_config))
  ),
  event_fee as (
    select coalesce(sum(e.amount_kobo - e.net_kobo), 0) as fee_kobo
    from event_sources s
    join guild_event_entries e on e.event_id = s.project_event_id and e.status = 'success'
  )
  select round(
    (coalesce((select fee_kobo from anthology_fee), 0) + coalesce((select fee_kobo from event_fee), 0))
    * referral_fee_share_bps() / 10000.0
  )::bigint;
$$;

revoke all on function referral_guild_reward_kobo(uuid) from public;
grant execute on function referral_guild_reward_kobo(uuid) to authenticated;

-- ============================================================================================
-- grant_referral_reward — redeclared: same signature, same idempotent/locking shape as
-- migrations 56/57, with three new gates layered in before a grant can ever be inserted:
--   1. device correlation (referral_devices_linked) — blocks the whole (referral, kind) attempt
--      outright, before any kind-specific eligibility is even checked.
--   2. per-grant ceiling (max_reward_per_referral_kobo) — clamps the computed amount down, never
--      up; the fee-share math can only ever produce LESS than this ceiling.
--   3. lifetime ceiling (max_lifetime_referral_earnings_kobo) — clamps further based on what this
--      referrer has already earned (net of any reversals), down to whatever headroom remains;
--      raises instead of silently granting ₦0 once headroom is fully used up.
-- Locked on TWO keys, not one: the existing per-(referral, kind) key (unchanged from migration
-- 56/57 — still what makes a retry of the exact same grant idempotent) AND a new
-- per-REFERRER key, so two concurrent grants for the same referrer (different referrals, or
-- different kinds of the same referral) can't both read the same pre-grant lifetime total and
-- both slip under the cap.
-- ============================================================================================

create or replace function grant_referral_reward(p_referral_id uuid, p_kind text)
returns referral_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral referrals%rowtype;
  v_row referral_grants;
  v_reward_kobo bigint;
  v_eligible boolean;
  v_config referral_reward_config%rowtype;
  v_lifetime_granted_kobo bigint;
  v_lifetime_reversed_kobo bigint;
  v_remaining_headroom_kobo bigint;
begin
  select * into v_referral from referrals where id = p_referral_id;
  if not found then
    raise exception 'No such referral.';
  end if;

  if v_referral.referrer_id <> auth.uid() then
    raise exception 'Not your referral.';
  end if;

  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row; -- already granted (or already granted-then-reversed) — idempotent either way;
                   -- a reversed (referral, kind) never re-grants, by design (see this migration's
                   -- header, "refund abuse" section).
  end if;

  if p_kind not in ('reader_purchase', 'writer_earnings', 'guild_activity') then
    raise exception 'Unknown referral reward kind.';
  end if;

  -- Duplicate-account gate — checked before any lock or kind-specific work, since it's the same
  -- answer regardless of kind and should short-circuit as cheaply as possible.
  if referral_devices_linked(v_referral.referrer_id, v_referral.referee_id) then
    raise exception 'This referral is not eligible for a reward.';
  end if;

  -- Locked per (referral, kind) — same shape as migrations 56/57 — AND per-referrer, so a
  -- concurrent grant attempt for a different (referral, kind) pair belonging to the SAME
  -- referrer can't race the lifetime-cap check below.
  perform pg_advisory_xact_lock(hashtext('referral_reward:' || p_referral_id::text || ':' || p_kind));
  perform pg_advisory_xact_lock(hashtext('referral_lifetime_cap:' || v_referral.referrer_id::text));

  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row;
  end if;

  case p_kind
    when 'reader_purchase' then v_eligible := referral_reader_signal(v_referral.referee_id);
    when 'writer_earnings' then v_eligible := referral_writer_signal(v_referral.referee_id);
    when 'guild_activity'  then v_eligible := referral_guild_signal(v_referral.referee_id);
  end case;

  if not coalesce(v_eligible, false) then
    raise exception 'This referral has not produced qualifying activity yet.';
  end if;

  case p_kind
    when 'reader_purchase' then v_reward_kobo := referral_reader_reward_kobo(v_referral.referee_id);
    when 'writer_earnings' then v_reward_kobo := referral_writer_reward_kobo(v_referral.referee_id);
    when 'guild_activity'  then v_reward_kobo := referral_guild_reward_kobo(v_referral.referee_id);
  end case;

  select * into v_config from referral_reward_config;

  -- Gate 2: per-grant ceiling.
  if coalesce(v_reward_kobo, 0) > v_config.max_reward_per_referral_kobo then
    v_reward_kobo := v_config.max_reward_per_referral_kobo;
  end if;

  -- Gate 3: lifetime ceiling, net of any past reversals on this referrer's other grants.
  select coalesce(sum(g.naira_reward_kobo), 0) into v_lifetime_granted_kobo
  from referral_grants g join referrals r on r.id = g.referral_id
  where r.referrer_id = v_referral.referrer_id;

  select coalesce(sum(x.kobo_reversed), 0) into v_lifetime_reversed_kobo
  from referral_grant_reversals x
  join referral_grants g on g.id = x.referral_grant_id
  join referrals r on r.id = g.referral_id
  where r.referrer_id = v_referral.referrer_id;

  v_remaining_headroom_kobo := v_config.max_lifetime_referral_earnings_kobo
                                - (v_lifetime_granted_kobo - v_lifetime_reversed_kobo);

  if v_remaining_headroom_kobo <= 0 then
    raise exception 'This referrer has reached the lifetime referral earnings limit.';
  end if;

  if v_reward_kobo > v_remaining_headroom_kobo then
    v_reward_kobo := v_remaining_headroom_kobo;
  end if;

  if coalesce(v_reward_kobo, 0) <= 0 then
    raise exception 'No platform fee available yet to fund this referral reward.';
  end if;

  insert into referral_grants (referral_id, kind, naira_reward_kobo)
  values (p_referral_id, p_kind, v_reward_kobo)
  returning * into v_row;

  update referrals set status = 'rewarded' where id = p_referral_id and status = 'pending';

  return v_row;
end;
$$;

revoke all on function grant_referral_reward(uuid, text) from public;
grant execute on function grant_referral_reward(uuid, text) to authenticated;

-- ============================================================================================
-- referral_grant_reversals — one permanent row per (referral_grants row that turned out not to
-- qualify anymore). Mirrors referral_grants' own permanence: never updated or deleted. A grant
-- can be reversed at most once, ever (unique below) — there's nothing to reverse twice, and a
-- reversed (referral, kind) can never be re-granted (grant_referral_reward's own idempotent
-- lookup returns the original, still-reversed row forever).
-- ============================================================================================

create table if not exists referral_grant_reversals (
  id uuid primary key default gen_random_uuid(),
  referral_grant_id uuid not null references referral_grants(id) on delete cascade,
  kobo_reversed bigint not null check (kobo_reversed > 0),
  reason text not null check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  unique (referral_grant_id)
);

alter table referral_grant_reversals enable row level security;

-- Readable by the referrer it affects, same join-back shape referral_grants' own select policy
-- already uses.
create policy "a referrer reads their own referral grant reversals" on referral_grant_reversals
  for select using (
    exists (
      select 1 from referral_grants g join referrals r on r.id = g.referral_id
      where g.id = referral_grant_reversals.referral_grant_id and r.referrer_id = auth.uid()
    )
  );
-- No client insert/update/delete policy at all — every row is created only by
-- reverse_referral_grant() below, which only service_role or a moderator can call.

create index if not exists referral_grant_reversals_grant_id_idx on referral_grant_reversals (referral_grant_id);

-- ============================================================================================
-- reverse_referral_grant — the one place a referral_grant_reversals row is ever created.
-- Idempotent (a retry against an already-reversed grant returns the existing reversal rather
-- than raising), same contract as every other grant/redeem function in this file.
-- ============================================================================================

create or replace function reverse_referral_grant(
  p_grant_id uuid,
  p_reason text default 'underlying activity no longer qualifies (refund or chargeback)'
)
returns referral_grant_reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant referral_grants%rowtype;
  v_row referral_grant_reversals;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from profiles where id = auth.uid() and is_moderator) then
    raise exception 'Not authorized.';
  end if;

  select * into v_grant from referral_grants where id = p_grant_id;
  if not found then
    raise exception 'No such referral grant.';
  end if;

  select * into v_row from referral_grant_reversals where referral_grant_id = p_grant_id;
  if found then
    return v_row; -- already reversed — idempotent, not an error
  end if;

  insert into referral_grant_reversals (referral_grant_id, kobo_reversed, reason)
  values (p_grant_id, v_grant.naira_reward_kobo, p_reason)
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function reverse_referral_grant(uuid, text) from public;

-- ============================================================================================
-- reconcile_referral_grants — re-derives eligibility for every referral_grants row that hasn't
-- already been reversed, using the exact same signal functions grant_referral_reward() itself
-- calls, and reverses anything that no longer qualifies (a refund or dispute landed after the
-- reward was already granted). Service-role only, scheduled daily via pg_cron below — same
-- pattern purge_expired_account_deletions() (schema.sql) already establishes for a periodic
-- background sweep. Returns the number of grants reversed on this run, purely for observability
-- in the cron job's own log.
-- ============================================================================================

create or replace function reconcile_referral_grants()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant record;
  v_still_eligible boolean;
  v_reversed_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  for v_grant in
    select g.id, g.kind, r.referee_id
    from referral_grants g
    join referrals r on r.id = g.referral_id
    where not exists (select 1 from referral_grant_reversals x where x.referral_grant_id = g.id)
  loop
    case v_grant.kind
      when 'reader_purchase' then v_still_eligible := referral_reader_signal(v_grant.referee_id);
      when 'writer_earnings' then v_still_eligible := referral_writer_signal(v_grant.referee_id);
      when 'guild_activity'  then v_still_eligible := referral_guild_signal(v_grant.referee_id);
      else v_still_eligible := true; -- unknown kind: never written by this schema, leave untouched
    end case;

    if not coalesce(v_still_eligible, false) then
      perform reverse_referral_grant(v_grant.id, 'underlying activity no longer qualifies (refund or chargeback)');
      v_reversed_count := v_reversed_count + 1;
    end if;
  end loop;

  return v_reversed_count;
end;
$$;

revoke all on function reconcile_referral_grants() from public;

-- Requires the pg_cron extension (same one purge_expired_account_deletions already needs — see
-- schema.sql's own comment on that schedule call for how to enable it). Runs daily at 04:00 UTC,
-- staggered an hour after the account-deletion purge. Re-running is always safe: every grant it
-- touches is either already reversed (skipped, per the `not exists` filter above) or genuinely
-- re-evaluated fresh each time.
select cron.schedule('reconcile-referral-grants', '0 4 * * *', $$select reconcile_referral_grants();$$);

-- ============================================================================================
-- author_balance_kobo — extended once more (same function, same signature) so a reversed
-- referral grant actually reduces what its referrer can withdraw. Based on the copy in
-- 56_migration_referral_rewards.sql, the latest one actually redefined — same pre-existing
-- schema.sql drift note applies as it did there.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = check_user_id and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    +
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = check_user_id and kind = 'release_to_member' and status = 'success'), 0)
    +
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = check_user_id), 0)
    +
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0);
$$ language sql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
