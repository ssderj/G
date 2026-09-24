-- Migration 110: Naira achievement grants had no reversal path — a refund or chargeback after a
-- grant kept the reward withdrawable forever (production audit, Critical).
--
-- The gap: the six purchase-based Naira achievements (First Purchase, Book Collector, Grand
-- Collector, Rookie Merchant, Hustler, Senior Man) pay real, withdrawable Naira through
-- achievement_grants -> author_balance_kobo(). The signal behind them (naira_achievement_current)
-- only counts purchases with status = 'success', and the webhook flips a purchase to 'refunded' on
-- refund.processed / charge.dispute.create (migration 50) — but grant_naira_achievement() is a
-- one-time claim, and achievement_grants is append-only. So the sequence "buy N books -> reach
-- the target -> get paid -> refund/dispute the purchases" left the reward in place. Referral
-- rewards closed exactly this hole in migration 58/59 (referral_grant_reversals +
-- reconcile_referral_grants()); achievements never got the same treatment. This migration is that
-- treatment, mirroring the referral shape one for one.
--
-- What this adds:
--   1. achievement_grant_reversals — append-only, one row per reversed achievement_grants row
--      (unique on achievement_grant_id, so a grant is reversed at most once, ever). A user can
--      read their own reversals; there is no client write policy at all.
--   2. reverse_achievement_grant(grant_id, reason) — the one place a reversal row is created.
--      service_role or a moderator only; idempotent (a retry returns the existing reversal).
--   3. naira_purchase_signal(user_id, achievement_id, include_refunded) — the six purchase-based
--      signals from naira_achievement_current(), extracted so they can be evaluated for an
--      explicit user (the sweep has no auth.uid()). naira_achievement_current() now calls it for
--      those six ids, so there is still exactly ONE definition of each signal, not two copies.
--      Filters are byte-for-byte migration 107's (paid books only / paid book+pack sales, and the
--      same-device wash-trading exclusion). Not callable by clients (it takes an arbitrary user id).
--   4. reconcile_naira_achievements() — service-role/cron only. For every un-reversed grant of one
--      of those six achievements, reverses it if the user's REFUND-DRIVEN count has fallen below
--      the target (see "deliberately not retroactive" below). Scheduled daily at 04:30 UTC via
--      pg_cron, staggered from 'reconcile-referral-grants' (04:00). It carries migration 102's
--      cron guard from the start: a pg_cron job has no JWT, so auth.role() is NULL — the guard
--      also accepts the postgres/supabase_admin session and the function marks its own transaction
--      as service_role so reverse_achievement_grant()'s guard accepts the call.
--   5. author_balance_kobo() now subtracts sum(kobo_reversed) from achievement_grant_reversals for
--      the checked user, the same way it already subtracts referral_grant_reversals. Based on
--      migration 100's version (the latest), including its caller check.
--   6. naira_achievement_progress() gains a `reversed` column and `unlocked` now means "you still
--      have this" (false once reversed) — same fix referral_reward_progress() got in migration 59,
--      so the Hall of Legends can't keep showing a clawed-back reward as unlocked. Extra column
--      only; src/lib/naira-achievements.js keeps working unchanged (it reads current_count and
--      unlocked only).
--
-- Deliberately NOT retroactive for rule changes. The sweep reverses a grant only when refunds are
-- what pulled the count under the target: count(success + refunded) >= target AND
-- count(success) < target. A grant that would fail today's stricter signals for any OTHER reason
-- (earned before migration 103 counted free packs/tips, or before migration 107's device check)
-- is left alone — migrations 103 and 107 both chose "not clawed back" explicitly, and a sweep
-- that silently reversed them would override that decision with real money. The two counts share
-- every filter except the status, so the comparison isolates refunds exactly.
--
-- Deliberately narrow: only the six purchase-based ids are swept. The other six (publication,
-- writing credit, reading hours, streak) don't depend on anything a refund can change. A
-- moderator can still reverse any grant by hand through reverse_achievement_grant().
--
-- A reversed grant is permanent: grant_naira_achievement()'s idempotent lookup keeps returning the
-- original (reversed) row, so buying, refunding, and re-buying can't re-earn the same reward.
-- Same "reversed can never be re-granted" rule referral_grants has.
--
-- To verify on a live project after applying this:
--   select jobname, status, return_message, start_time
--     from cron.job_run_details d join cron.job j using (jobid)
--    where j.jobname = 'reconcile-naira-achievements' order by start_time desc limit 5;
-- Safe to run anytime: the new table starts empty, and until a refund actually pulls a granted
-- achievement under its target the sweep reverses nothing.

-- ============================================================================================
-- 1. achievement_grant_reversals
-- ============================================================================================

create table if not exists achievement_grant_reversals (
  id uuid primary key default gen_random_uuid(),
  achievement_grant_id uuid not null references achievement_grants(id) on delete cascade,
  kobo_reversed bigint not null check (kobo_reversed > 0),
  reason text not null check (char_length(reason) <= 500),
  created_at timestamptz not null default now(),
  unique (achievement_grant_id)
);

alter table achievement_grant_reversals enable row level security;

-- Readable by the user it affects, same join-back shape referral_grant_reversals uses.
drop policy if exists "a user reads their own achievement grant reversals" on achievement_grant_reversals;
create policy "a user reads their own achievement grant reversals" on achievement_grant_reversals
  for select using (
    exists (
      select 1 from achievement_grants g
      where g.id = achievement_grant_reversals.achievement_grant_id and g.user_id = auth.uid()
    )
  );
-- No client insert/update/delete policy at all — every row is created only by
-- reverse_achievement_grant() below, which only service_role or a moderator can call.

create index if not exists achievement_grant_reversals_grant_id_idx
  on achievement_grant_reversals (achievement_grant_id);

-- ============================================================================================
-- 2. naira_purchase_signal — the six purchase-based signals, for an explicit user.
-- p_include_refunded = true also counts status = 'refunded' rows (used only by the sweep, to tell
-- a refund-driven shortfall apart from a rule-change shortfall). Returns null for any other id.
-- ============================================================================================

create or replace function naira_purchase_signal(
  p_user_id uuid,
  p_achievement_id text,
  p_include_refunded boolean default false
)
returns bigint
language plpgsql stable security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector' then
      select count(*) into v_result from purchases
      where buyer_id = p_user_id
        and (status = 'success' or (p_include_refunded and status = 'refunded'))
        and kind = 'book' and amount_kobo > 0
        and not accounts_share_device_signal(p_user_id, author_id);
    when 'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan' then
      select count(*) into v_result from purchases
      where author_id = p_user_id
        and (status = 'success' or (p_include_refunded and status = 'refunded'))
        and kind in ('book', 'pack') and amount_kobo > 0
        and not accounts_share_device_signal(p_user_id, buyer_id);
    else
      v_result := null;
  end case;
  return v_result;
end;
$$;

-- Takes an arbitrary user id, so it is never client-callable. Called only from other
-- security-definer functions in this file (owner privileges apply to those calls).
revoke all on function naira_purchase_signal(uuid, text, boolean) from public;

-- naira_achievement_current — the six purchase-based ids now delegate to naira_purchase_signal
-- (same filters as migration 107, still the calling user only via auth.uid()). Every other branch
-- is copied unchanged from migration 107's version.
create or replace function naira_achievement_current(p_achievement_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector',
         'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan' then
      v_result := naira_purchase_signal(auth.uid(), p_achievement_id, false);
    when 'nairaFirstPublication' then
      select (case when exists (
        select 1 from published_books where author_id = auth.uid() and word_count >= 30000
        union all
        select 1 from guild_published_books where author_id = auth.uid() and word_count >= 30000
      ) then 1 else 0 end) into v_result;
    when 'nairaFirstBook' then
      select (case when sync_writing_credit_ledger() >= 30000 then 1 else 0 end) into v_result;
    when 'nairaDedicatedWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaMasterWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaReader' then
      select coalesce(sum(minutes), 0) / 60 into v_result
      from reading_heartbeats_daily where user_id = auth.uid();
    when 'nairaLoyal' then
      select naira_longest_activity_streak() into v_result;
    else
      v_result := null;
  end case;
  return v_result;
end;
$$;

revoke all on function naira_achievement_current(text) from public;
grant execute on function naira_achievement_current(text) to authenticated;

-- ============================================================================================
-- 3. reverse_achievement_grant — the one place an achievement_grant_reversals row is created.
-- Idempotent: a retry against an already-reversed grant returns the existing reversal instead of
-- raising. The per-grant advisory lock makes two concurrent calls (sweep + a moderator) safe
-- rather than one of them failing on the unique constraint.
-- ============================================================================================

create or replace function reverse_achievement_grant(
  p_grant_id uuid,
  p_reason text default 'underlying purchases were refunded or charged back'
)
returns achievement_grant_reversals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant achievement_grants%rowtype;
  v_row achievement_grant_reversals;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and not exists (select 1 from profiles where id = auth.uid() and is_moderator) then
    raise exception 'Not authorized.';
  end if;

  select * into v_grant from achievement_grants where id = p_grant_id;
  if not found then
    raise exception 'No such achievement grant.';
  end if;

  perform pg_advisory_xact_lock(hashtext('achievement_reversal:' || p_grant_id::text));

  select * into v_row from achievement_grant_reversals where achievement_grant_id = p_grant_id;
  if found then
    return v_row; -- already reversed — idempotent, not an error
  end if;

  insert into achievement_grant_reversals (achievement_grant_id, kobo_reversed, reason)
  values (
    p_grant_id,
    v_grant.naira_reward_kobo,
    left(coalesce(nullif(btrim(p_reason), ''), 'underlying purchases were refunded or charged back'), 500)
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function reverse_achievement_grant(uuid, text) from public;
-- Granted to authenticated so a moderator can reverse a grant on demand from a client session; the
-- body's own service_role/is_moderator check is what actually authorizes (same as
-- reverse_referral_grant — see migration 59, fix 1).
grant execute on function reverse_achievement_grant(uuid, text) to authenticated;

-- ============================================================================================
-- 4. reconcile_naira_achievements — the daily sweep. Service-role/cron only. Returns the number of
-- grants reversed on this run, purely for observability in the cron job's own log.
-- ============================================================================================

create or replace function reconcile_naira_achievements()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant record;
  v_target bigint;
  v_now bigint;
  v_with_refunds bigint;
  v_reversed_count integer := 0;
begin
  -- Migration 102's guard: a pg_cron job has no JWT (auth.role() is NULL), so a direct
  -- postgres/supabase_admin session is accepted too. A signed-in client or the anon key still
  -- can't call this.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  -- So reverse_achievement_grant()'s own service_role guard accepts the call below (is_local =
  -- true: cleared at the end of this transaction).
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for v_grant in
    select g.id, g.user_id, g.achievement_id
    from achievement_grants g
    where g.achievement_id in ('nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector',
                               'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan')
      and not exists (select 1 from achievement_grant_reversals x where x.achievement_grant_id = g.id)
  loop
    -- Targets mirror grant_naira_achievement()'s own table for these six ids.
    v_target := case v_grant.achievement_id
      when 'nairaFirstPurchase'  then 1
      when 'nairaBookCollector'  then 50
      when 'nairaGrandCollector' then 100
      when 'nairaRookieMerchant' then 10
      when 'nairaHustler'        then 50
      when 'nairaSeniorMan'      then 100
    end;

    v_now := coalesce(naira_purchase_signal(v_grant.user_id, v_grant.achievement_id, false), 0);
    if v_now >= v_target then
      continue; -- still qualifies on non-refunded purchases alone
    end if;

    -- Below target now. Reverse only if refunds are the reason — i.e. counting the refunded
    -- purchases back in would still have met the target (see this migration's header on why rule
    -- changes since the grant are deliberately not clawed back).
    v_with_refunds := coalesce(naira_purchase_signal(v_grant.user_id, v_grant.achievement_id, true), 0);
    if v_with_refunds >= v_target then
      perform reverse_achievement_grant(v_grant.id, 'underlying purchases were refunded or charged back');
      v_reversed_count := v_reversed_count + 1;
    end if;
  end loop;

  return v_reversed_count;
end;
$$;

revoke all on function reconcile_naira_achievements() from public;

-- Requires pg_cron (enabled by schema.sql's account-deletion purge schedule). Daily at 04:30 UTC,
-- staggered half an hour after 'reconcile-referral-grants'. Re-running is always safe: reversed
-- grants are skipped and everything else is re-evaluated fresh.
select cron.schedule('reconcile-naira-achievements', '30 4 * * *', $$select reconcile_naira_achievements();$$);

-- ============================================================================================
-- 5. author_balance_kobo — a reversed achievement grant now reduces what its owner can withdraw.
-- Migration 100's version (the latest) plus one subtracted term; caller check unchanged.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
begin
  if check_user_id is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  return
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
    -
    coalesce((select sum(x.kobo_reversed) from achievement_grant_reversals x
              join achievement_grants ag on ag.id = x.achievement_grant_id
              where ag.user_id = check_user_id), 0)
    +
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0);
end;
$$ language plpgsql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;

-- ============================================================================================
-- 6. naira_achievement_progress — `reversed` column; `unlocked` = still held.
-- The return shape changes, which create-or-replace can't do, so it is dropped and recreated.
-- ============================================================================================

drop function if exists naira_achievement_progress();

create function naira_achievement_progress()
returns table (achievement_id text, current_count bigint, unlocked boolean, reversed boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_target bigint;
  v_grant_id uuid;
  v_ids text[] := array['nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector',
                         'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan', 'nairaFirstPublication',
                         'nairaFirstBook', 'nairaDedicatedWriter', 'nairaMasterWriter', 'nairaReader', 'nairaLoyal'];
  v_targets bigint[] := array[1, 50, 100, 10, 50, 100, 1,
                               1, 50000, 100000, 5, 7];
begin
  for i in 1 .. array_length(v_ids, 1) loop
    v_id := v_ids[i];
    v_target := v_targets[i];
    begin
      perform grant_naira_achievement(v_id);
    exception when others then
      null; -- not eligible yet — expected, not an error worth surfacing here
    end;

    achievement_id := v_id;

    select g.id into v_grant_id
    from achievement_grants g
    where g.user_id = auth.uid() and g.achievement_id = v_id;

    reversed := v_grant_id is not null
      and exists (select 1 from achievement_grant_reversals x where x.achievement_grant_id = v_grant_id);
    unlocked := v_grant_id is not null and not reversed;

    if unlocked then
      current_count := v_target;
    else
      current_count := least(coalesce(naira_achievement_current(v_id), 0), v_target);
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function naira_achievement_progress() from public;
grant execute on function naira_achievement_progress() to authenticated;
