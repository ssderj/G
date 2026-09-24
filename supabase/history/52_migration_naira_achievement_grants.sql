-- Migration 52: Naira Achievement Grants — the server-side implementation of Tier 1 of
-- NAIRA_ACHIEVEMENTS (see the comment on NAIRA_ACHIEVEMENTS in src/writing/health-checks.jsx).
-- Scope note, and what's deliberately NOT in this migration:
--
--   nairaFirstPurchase / nairaBookCollector / nairaGrandCollector (buyer purchase counts),
--   nairaRookieMerchant / nairaHustler / nairaSeniorMan (author sale counts), and
--   nairaFirstPublication (a real published_books or guild_published_books row >= 30,000 words)
--   are implemented below — real signals that already exist server-side today.
--
--   nairaWelcome ("complete your profile") is NOT implemented here and stays exactly as it was
--   (locked, "Requires backend verification — not yet available") even though some of its
--   pieces ARE real server signals (profiles.pen_name, a player_guild_members/
--   founder_guild_members row, 3+ distinct rows in `follows`, a status='success' row in
--   guild_event_entries). One piece of the agreed definition — a profile's motto — is not:
--   `motto` only ever lives in this device's local profile object and syncProfile() (see
--   src/lib/profile.js) never sends it to the `profiles` table at all, so there is nothing on
--   this server to check it against yet. Rather than silently drop motto from the definition or
--   guess a different one, this stays flagged for a real decision (add + sync a motto column, a
--   genuine schema/client change, vs. redefining "complete your profile" without it) the same way
--   nairaDedicatedWriter/nairaMasterWriter/nairaFirstBook/nairaReader/nairaLoyal already are.
--
--   nairaDedicatedWriter, nairaMasterWriter, nairaFirstBook (word-count-based), nairaReader,
--   nairaLoyal (reading-hours/streak-based) are untouched — no server-verifiable signal for any
--   of them exists yet (manuscript text is an unvalidated local blob; there's no reading-time or
--   streak tracking anywhere). Still locked, still honest.
--
-- word_count on published_books: the original ask assumed this column might not exist yet.
-- Checked against the actual schema first (per the ground rules) — it was already added by
-- 26_migration_published_books_richer_metadata.sql and is already populated on every publish by
-- publishBookRemote (src/lib/library.js). No new column, no backfill needed.
--
-- Payout pipeline: an achievement grant is a NEW CREDIT SOURCE that author_balance_kobo() sums
-- in — not a second wallet or a second withdraw flow. "Once released, a Naira is a Naira" (see
-- 41_migration_guild_member_earnings_withdrawal.sql's own header); the existing withdrawals /
-- paystack-withdraw pipeline is the only way any of this actually reaches a bank account, exactly
-- as it already is for a book sale or a released guild earning.
--
-- RLS posture: same as purchases/withdrawals — a user can select their own grant rows, but there
-- is no client insert/update policy at all. Every row is created only by
-- grant_naira_achievement(), a security definer function that re-derives everything from
-- auth.uid() and re-checks the real signal itself — never from anything the client reports.
--
-- One-time-claim enforcement: unique (user_id, achievement_id) on achievement_grants, plus
-- grant_naira_achievement() locking on pg_advisory_xact_lock(hashtext('naira_achievement:' ||
-- user_id || ':' || achievement_id)) before checking "already granted", the same
-- lock-then-recheck shape settle_guild_event()/create_withdrawal_locked() already use.
--
-- No separate "claim" step in the frontend (see AchievementCard in src/writing/achievements.jsx
-- — unlocked just renders "Unlocked ✓", there was never a claim button to begin with, and this
-- migration doesn't add one). So the read path itself is what grants: naira_achievement_progress()
-- below attempts grant_naira_achievement() for each Tier 1 id on every call (swallowing "not
-- eligible yet" / "already granted" as expected, non-error outcomes) and then reports the
-- resulting state. The very same locking + uniqueness constraint that makes
-- grant_naira_achievement() safe to call directly also makes calling it from inside a read
-- perfectly safe — it's the same one-time-claim guarantee either way, just triggered by viewing
-- the Hall of Legends instead of a separate button click.
--
-- Safe to run anytime: both new tables/functions are additive, and author_balance_kobo()'s new
-- term is 0 for every writer until their first real grant exists.

-- ============================================================================================
-- achievement_grants — one row per (user, Naira achievement) ever paid out. Permanent once
-- written — never updated or deleted by anything in this schema.
-- ============================================================================================

create table if not exists achievement_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  achievement_id text not null,
  naira_reward_kobo bigint not null check (naira_reward_kobo > 0),
  created_at timestamptz not null default now(),
  unique (user_id, achievement_id)
);

alter table achievement_grants enable row level security;

create policy "a user reads their own achievement grants" on achievement_grants
  for select using (auth.uid() = user_id);
-- No client insert/update/delete policy — every row is created only by
-- grant_naira_achievement() below, running as the authenticated user via auth.uid().

create index if not exists achievement_grants_user_id_idx on achievement_grants (user_id);

-- ============================================================================================
-- naira_achievement_current — the real, live signal for one Tier 1 achievement, for the calling
-- user only (auth.uid(), never a client-supplied id). Shared by grant_naira_achievement() and
-- naira_achievement_progress() so there is exactly one definition of each signal, not two copies
-- that could drift. Returns null for any id outside Tier 1 (nairaWelcome and every Tier 2 id) —
-- callers treat that as "leave this one exactly as it already was" (see the header above).
-- ============================================================================================

create or replace function naira_achievement_current(p_achievement_id text)
returns bigint as $$
  select case p_achievement_id
    when 'nairaFirstPurchase' then
      (select count(*) from purchases where buyer_id = auth.uid() and status = 'success')
    when 'nairaBookCollector' then
      (select count(*) from purchases where buyer_id = auth.uid() and status = 'success')
    when 'nairaGrandCollector' then
      (select count(*) from purchases where buyer_id = auth.uid() and status = 'success')
    when 'nairaRookieMerchant' then
      (select count(*) from purchases where author_id = auth.uid() and status = 'success')
    when 'nairaHustler' then
      (select count(*) from purchases where author_id = auth.uid() and status = 'success')
    when 'nairaSeniorMan' then
      (select count(*) from purchases where author_id = auth.uid() and status = 'success')
    when 'nairaFirstPublication' then
      (select case when exists (
        select 1 from published_books where author_id = auth.uid() and word_count >= 30000
        union all
        select 1 from guild_published_books where author_id = auth.uid() and word_count >= 30000
      ) then 1 else 0 end)
    else null
  end;
$$ language sql stable security definer set search_path = public;

revoke all on function naira_achievement_current(text) from public;
grant execute on function naira_achievement_current(text) to authenticated;

-- ============================================================================================
-- grant_naira_achievement — the one place an achievement_grants row is ever created. Re-derives
-- the real signal itself (via naira_achievement_current above) rather than trusting anything the
-- caller reports, locks per (user, achievement) before checking "already granted" so two
-- concurrent calls can never both pass, and is a no-op (returns the existing row) on a retry
-- against an already-granted achievement rather than raising — naira_achievement_progress()
-- below depends on that idempotency to call this safely on every read.
-- ============================================================================================

create or replace function grant_naira_achievement(p_achievement_id text)
returns achievement_grants
language plpgsql security definer set search_path = public as $$
declare
  v_row achievement_grants;
  v_target bigint;
  v_reward_kobo bigint;
  v_current bigint;
begin
  select * into v_row from achievement_grants
  where user_id = auth.uid() and achievement_id = p_achievement_id;
  if found then
    return v_row; -- already granted — idempotent, not an error
  end if;

  -- target/reward mirror NAIRA_ACHIEVEMENTS in src/writing/health-checks.jsx exactly (nairaReward
  -- there is Naira, not kobo — x100 here). Any id outside this list (nairaWelcome, every Tier 2
  -- id) falls through to the else and is refused — there is deliberately no signal to check yet.
  case p_achievement_id
    when 'nairaFirstPurchase'    then v_target := 1;   v_reward_kobo := 10000;
    when 'nairaBookCollector'    then v_target := 50;  v_reward_kobo := 500000;
    when 'nairaGrandCollector'   then v_target := 100; v_reward_kobo := 1000000;
    when 'nairaRookieMerchant'   then v_target := 10;  v_reward_kobo := 100000;
    when 'nairaHustler'          then v_target := 50;  v_reward_kobo := 500000;
    when 'nairaSeniorMan'        then v_target := 100; v_reward_kobo := 1500000;
    when 'nairaFirstPublication' then v_target := 1;   v_reward_kobo := 100000;
    else
      raise exception 'This achievement has no server-verifiable signal yet.';
  end case;

  -- Locked per (user, achievement) — same lock-then-recheck shape settle_guild_event()/
  -- create_withdrawal_locked() already use, scoped narrower than a whole-user lock since two
  -- different achievements for the same writer have nothing to serialize against each other.
  perform pg_advisory_xact_lock(hashtext('naira_achievement:' || auth.uid()::text || ':' || p_achievement_id));

  -- Re-read under the lock in case a concurrent call just granted it.
  select * into v_row from achievement_grants
  where user_id = auth.uid() and achievement_id = p_achievement_id;
  if found then
    return v_row;
  end if;

  v_current := naira_achievement_current(p_achievement_id);
  if v_current is null or v_current < v_target then
    raise exception 'Achievement not yet earned.';
  end if;

  insert into achievement_grants (user_id, achievement_id, naira_reward_kobo)
  values (auth.uid(), p_achievement_id, v_reward_kobo)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function grant_naira_achievement(text) from public;
grant execute on function grant_naira_achievement(text) to authenticated;

-- ============================================================================================
-- naira_achievement_progress — one round trip for the Hall of Legends' Naira Rewards grid.
-- Attempts grant_naira_achievement() for every Tier 1 id (each call is independently locked and
-- idempotent — see above), swallowing the expected "not eligible yet" outcome, then reports
-- current/unlocked per id from the now-current achievement_grants state. This is what actually
-- pays an achievement out the moment it's first met — there's no separate claim step (see the
-- migration header). current is capped at target for display, same convention
-- computeLifetimeAchievements() already uses client-side.
-- ============================================================================================

create or replace function naira_achievement_progress()
returns table (achievement_id text, current_count bigint, unlocked boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_target bigint;
  v_ids text[] := array['nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector',
                         'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan', 'nairaFirstPublication'];
  v_targets bigint[] := array[1, 50, 100, 10, 50, 100, 1];
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
    unlocked := exists (select 1 from achievement_grants g where g.user_id = auth.uid() and g.achievement_id = v_id);
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

-- ============================================================================================
-- author_balance_kobo — extended once more (same function, same signature, still the one place
-- a writer's withdrawable balance is computed) to add successful achievement grants as a credit.
-- Based on the LATEST logical definition (41_migration_guild_member_earnings_withdrawal.sql's
-- version, which excludes anthology-sourced purchases and adds released guild earnings back in)
-- — not the older copy still sitting in supabase/schema.sql, which predates migration 41 and
-- hasn't been kept in sync with it. That drift is pre-existing and out of scope here (only
-- NAIRA_ACHIEVEMENTS is in scope for this migration); flagging it since a fresh install running
-- schema.sql alone would need 41 and this migration layered on top to reach this correct state.
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
              where user_id = check_user_id), 0);
$$ language sql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;

-- Safe to run anytime: achievement_grants starts empty on every deployment, so this added term is
-- 0 for every existing writer until their first real Tier 1 grant — no existing balance changes
-- on deployment.
