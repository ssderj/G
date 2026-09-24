-- Migration 57: Referral Rewards funded by Inkroot's own platform fee — not a flat, unlimited
-- amount picked upfront.
--
-- 56_migration_referral_rewards.sql paid a fixed ₦200 / ₦2,000 / ₦3,000 per reward kind,
-- unconnected to how much money the qualifying activity actually generated for Inkroot. That's
-- exactly the "unlimited separate cash pool" this migration replaces: from here on, a referral
-- reward is always a small, fixed SHARE of the real platform fee Inkroot itself already
-- collected from the qualifying transaction(s) — never a number invented independently of it,
-- and never anything drawn from an author's or guild member's own agreed earnings.
--
-- The mechanism this leans on already exists and is untouched by this migration:
-- `_shared/payments.ts`'s authorAmountKobo(amountKobo) (PLATFORM_FEE_BPS = 1000, i.e. 10%) is
-- applied at the moment ANY real Naira payment is initiated — a book/tip purchase
-- (purchases.author_amount_kobo) or a Guild Event entry (guild_event_entries.net_kobo) — so
-- `gross - net` is always sitting right there on the row, is exactly what Paystack actually
-- confirmed, and reflects whatever PLATFORM_FEE_BPS was in effect at the time (past rows keep
-- whatever split they were written with — same posture that constant's own comment already
-- documents). This migration never recomputes a fee from scratch; it only ever reads
-- `gross - net` off rows that already exist.
--
-- Worked example, matching the request exactly: a ₦5,000 (500,000 kobo) book purchase.
-- author_amount_kobo = 450,000 (author's normal 90% — completely untouched by any of this).
-- Inkroot's platform fee = 500,000 - 450,000 = 50,000 kobo (₦500). referral_fee_share_bps() below
-- (2000 = 20%) means the referral reward funded by this specific purchase is
-- 50,000 * 20% = 10,000 kobo (₦100) — a small portion of Inkroot's own fee, nothing more.
--
-- referral_fee_share_bps() — one function, not a literal repeated three times — is the ONE place
-- this percentage lives; change it there and every reward kind's payout changes with it, the
-- same "change it in one place" posture PLATFORM_FEE_BPS itself uses.
--
-- What funds each kind, concretely (eligibility gates — referral_reader_signal/
-- referral_writer_signal/referral_guild_signal, i.e. the ₦500 / ₦5,000 / ₦5,000 floors that make
-- an activity "genuine" — are UNCHANGED from migration 56; only the payout AMOUNT changes here):
--
--   reader_purchase — the platform fee (amount_kobo - author_amount_kobo) of the one specific
--     qualifying purchase itself (the earliest purchase meeting the ₦500 floor).
--
--   writer_earnings — the platform fee summed across every one of that author's successful sales
--     to date (amount_kobo - author_amount_kobo per purchases row, author_id = the referred
--     writer) — the same population of rows referral_writer_signal already sums
--     author_amount_kobo over to check the ₦5,000 earnings floor, just reading the OTHER side of
--     the same split.
--
--   guild_activity — the platform fee behind the guild's own real revenue: for every
--     'anthology_share' distribution, the fee (amount_kobo - author_amount_kobo) on the ONE
--     underlying purchase it was distributed from (via source_purchase_id — not multiplied by
--     however many members that sale's proceeds were split across, since the fee itself was
--     charged once, on the original sale, before any splitting happened); for every
--     'event_revenue' distribution, the summed fee (amount_kobo - net_kobo) across that Guild
--     Event's own successful entries (via project_event_id). Both fee sources were already real,
--     externally-verified Paystack charges before distribute_guild_revenue() ever ran — this
--     just reads what Inkroot already kept from them.
--
-- Never touches an author's or a guild member's own share: every formula below reads ONLY the
-- `gross - net` (or `amount_kobo - author_amount_kobo`) side of each row — the side that was
-- already Inkroot's, before this migration existed. author_amount_kobo, net_kobo, and every
-- guild_treasury_transactions distribution amount are exactly what they always were.
--
-- Past grants are NOT retroactively changed: any referral_grants row already written under
-- migration 56's flat amounts keeps that value forever — referral_grants is a permanent ledger,
-- never rewritten, same as achievement_grants. Only a reward granted from this migration onward
-- uses the formula below. (On a fresh install, 55/56/57 all run before any real referral
-- activity exists, so this distinction never actually matters in practice — it matters only for
-- a deployment that had already been live on 56.)
--
-- Safe to run anytime: the three new *_reward_kobo() functions are pure additive reads, and
-- grant_referral_reward() is the only thing changed to call them instead of its old fixed case
-- statement — referral_grants' own shape, RLS, and referral_reward_progress() are all untouched.

-- ============================================================================================
-- referral_fee_share_bps — the one number this whole migration is actually about. 2000 = 20% of
-- Inkroot's own platform fee on the qualifying activity. A business threshold, not a technical
-- constant — tune it here if the percentage proves wrong; nothing else in this migration needs
-- to change if it does.
-- ============================================================================================

create or replace function referral_fee_share_bps()
returns integer
language sql immutable as $$
  select 2000; -- 20%
$$;

-- ============================================================================================
-- referral_reader_reward_kobo — 20% of the platform fee on the ONE purchase that made this
-- referral eligible (the earliest of the referee's successful purchases at/above the ₦500
-- floor — same row referral_reader_signal already checks exists). Returns null if there is no
-- such purchase (the caller only ever calls this after referral_reader_signal already confirmed
-- there is).
-- ============================================================================================

create or replace function referral_reader_reward_kobo(p_referee_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select round((p.amount_kobo - p.author_amount_kobo) * referral_fee_share_bps() / 10000.0)::bigint
  from purchases p
  where p.buyer_id = p_referee_id and p.status = 'success' and p.amount_kobo >= 50000
  order by coalesce(p.paid_at, p.created_at) asc
  limit 1;
$$;

revoke all on function referral_reader_reward_kobo(uuid) from public;
grant execute on function referral_reader_reward_kobo(uuid) to authenticated;

-- ============================================================================================
-- referral_writer_reward_kobo — 20% of the total platform fee Inkroot has collected across every
-- one of the referred writer's successful sales to date. Reads amount_kobo - author_amount_kobo
-- (Inkroot's side) on exactly the rows referral_writer_signal sums author_amount_kobo (the
-- author's side) over to check the ₦5,000 earnings floor — same population, opposite column.
-- ============================================================================================

create or replace function referral_writer_reward_kobo(p_referee_id uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select round(coalesce(sum(p.amount_kobo - p.author_amount_kobo), 0) * referral_fee_share_bps() / 10000.0)::bigint
  from purchases p
  where p.author_id = p_referee_id and p.status = 'success';
$$;

revoke all on function referral_writer_reward_kobo(uuid) from public;
grant execute on function referral_writer_reward_kobo(uuid) to authenticated;

-- ============================================================================================
-- referral_guild_reward_kobo — 20% of the total platform fee behind the referred guild owner's
-- own real guild revenue (anthology_share + event_revenue, the same two kinds
-- referral_guild_signal already restricts to). Each underlying sale/event's fee is counted
-- exactly once (DISTINCT on source_purchase_id / project_event_id) regardless of how many guild
-- members that sale's NET proceeds were subsequently split across — the fee itself was charged
-- once, on the original gross amount, before any splitting happened.
-- ============================================================================================

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
-- grant_referral_reward — re-declared (same signature, same idempotent/locking shape as
-- 56_migration_referral_rewards.sql) to source v_reward_kobo from the three *_reward_kobo()
-- functions above instead of a fixed ₦200/₦2,000/₦3,000 case statement. Eligibility itself
-- (referral_reader_signal / referral_writer_signal / referral_guild_signal) is UNCHANGED —
-- still what decides whether a reward exists AT ALL; the functions above only decide how much,
-- now genuinely tied to what the qualifying activity actually earned Inkroot.
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
    return v_row; -- already granted — idempotent, not an error. Keeps whatever amount it was
                   -- originally granted with, even if that predates this migration.
  end if;

  if p_kind not in ('reader_purchase', 'writer_earnings', 'guild_activity') then
    raise exception 'Unknown referral reward kind.';
  end if;

  -- Locked per (referral, kind) — same shape as migration 56 and grant_naira_achievement().
  perform pg_advisory_xact_lock(hashtext('referral_reward:' || p_referral_id::text || ':' || p_kind));

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

  -- The actual connection to the transaction system: the reward is whatever share of Inkroot's
  -- own already-collected platform fee the qualifying activity generated — never a number
  -- independent of it, and never anything above what the fee itself was.
  case p_kind
    when 'reader_purchase' then v_reward_kobo := referral_reader_reward_kobo(v_referral.referee_id);
    when 'writer_earnings' then v_reward_kobo := referral_writer_reward_kobo(v_referral.referee_id);
    when 'guild_activity'  then v_reward_kobo := referral_guild_reward_kobo(v_referral.referee_id);
  end case;

  if coalesce(v_reward_kobo, 0) <= 0 then
    -- Shouldn't happen given the eligibility floors above (each guarantees a real, positive
    -- underlying fee) — guarded anyway since referral_grants itself requires a positive amount,
    -- and "no fee to fund this from yet" is a clearer error than a constraint violation.
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
