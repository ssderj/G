-- ============================================================================================
-- Migration 94 — The Inkroot Official Badge (gates Naira achievement payouts) and the daily
-- check-in calendar
-- ============================================================================================
--
-- Two independent features, shipped together because the first depends on nothing new and the
-- second is small; they don't share any table.
--
-- PART 1 — Inkroot Official Badge
--
-- Not the same thing as profiles.verified (that's a moderator-curated identity checkmark, set
-- manually after confirming who someone is out-of-band — see its comment on the profiles table).
-- This badge is the opposite kind of signal: fully automated, criteria-based, and recomputed live
-- on every check rather than stored — the account-age criterion is time-based, so a cached column
-- would need a cron job to ever flip false->true on its own; computing it on read avoids that
-- entirely, same choice naira_achievement_progress() already made for achievement progress.
--
-- Requirements (all four, every time it's checked):
--   1. Has purchased a book, OR published one (Grand Library or a guild) — proof of real
--      participation in the economy, not just a signed-up account.
--   2. Is a member of a guild — either kind (Founder or Player).
--   3. Has at least one successful, paid guild-event entry. guild_event_entries.amount_kobo is
--      `not null check (amount_kobo > 0)` on every row (see that table's definition) — there is no
--      such thing as a free entry in that table, so a plain existence check is already sufficient;
--      no need to join guild_events to filter by price.
--   4. Account is at least 7 days old, read from auth.users.created_at (profiles has no created_at
--      of its own — only updated_at — and auth.users is the real source of truth for account age
--      regardless; admin_set_login_ban() and the on_auth_user_created trigger already establish
--      the precedent of touching auth.users from a security definer function here).
--
-- The badge itself is inert — it's just a boolean function. The actual anti-farming enforcement
-- is wiring it into grant_naira_achievement() below: achievement PROGRESS still shows real
-- current_count to everyone (so a new writer can see they're 8,000 words from an achievement),
-- but the payout — the insert into achievement_grants that actually moves Naira — refuses until
-- all four criteria are met. naira_achievement_progress()'s existing `exception when others then
-- null` around its call to grant_naira_achievement already tolerates this new exception with zero
-- changes needed there.

create or replace function inkroot_official_badge_earned(p_user uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    (
      exists (select 1 from purchases where buyer_id = p_user and status = 'success')
      or exists (select 1 from published_books where author_id = p_user)
      or exists (select 1 from guild_published_books where author_id = p_user)
    )
    and (
      exists (select 1 from founder_guild_members where user_id = p_user)
      or exists (select 1 from player_guild_members where user_id = p_user)
    )
    and exists (select 1 from guild_event_entries where entrant_id = p_user and status = 'success')
    and exists (select 1 from auth.users where id = p_user and created_at <= now() - interval '7 days');
$$;

revoke all on function inkroot_official_badge_earned(uuid) from public;
grant execute on function inkroot_official_badge_earned(uuid) to authenticated;

-- Per-criterion breakdown for the UI, same table-returning convention as
-- naira_achievement_progress — lets the badge card say "3 of 4 met" with which one is missing,
-- rather than a flat yes/no the writer can't act on.
create or replace function inkroot_official_badge_status()
returns table (has_book boolean, in_guild boolean, paid_event boolean, week_old boolean, earned boolean)
language sql stable security definer set search_path = public as $$
  select
    exists (select 1 from purchases where buyer_id = auth.uid() and status = 'success')
      or exists (select 1 from published_books where author_id = auth.uid())
      or exists (select 1 from guild_published_books where author_id = auth.uid()),
    exists (select 1 from founder_guild_members where user_id = auth.uid())
      or exists (select 1 from player_guild_members where user_id = auth.uid()),
    exists (select 1 from guild_event_entries where entrant_id = auth.uid() and status = 'success'),
    exists (select 1 from auth.users where id = auth.uid() and created_at <= now() - interval '7 days'),
    inkroot_official_badge_earned(auth.uid());
$$;

revoke all on function inkroot_official_badge_status() from public;
grant execute on function inkroot_official_badge_status() to authenticated;

-- The actual gate. Everything below the idempotency check (already-granted short-circuit) and
-- above the existing `case` is new; the rest of the function is unchanged from migration 53/54's
-- version, reproduced here in full since this is a CREATE OR REPLACE and Postgres needs the whole
-- body, not a diff.
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

  if not inkroot_official_badge_earned(auth.uid()) then
    raise exception 'The Inkroot Official Badge is required before Naira achievements can be granted.';
  end if;

  case p_achievement_id
    when 'nairaFirstPurchase'    then v_target := 1;      v_reward_kobo := 10000;
    when 'nairaBookCollector'    then v_target := 50;      v_reward_kobo := 500000;
    when 'nairaGrandCollector'   then v_target := 100;     v_reward_kobo := 1000000;
    when 'nairaRookieMerchant'   then v_target := 10;      v_reward_kobo := 100000;
    when 'nairaHustler'          then v_target := 50;      v_reward_kobo := 500000;
    when 'nairaSeniorMan'        then v_target := 100;     v_reward_kobo := 1500000;
    when 'nairaFirstPublication' then v_target := 1;       v_reward_kobo := 100000;
    when 'nairaFirstBook'        then v_target := 1;       v_reward_kobo := 50000;
    when 'nairaDedicatedWriter'  then v_target := 50000;   v_reward_kobo := 50000;
    when 'nairaMasterWriter'     then v_target := 100000;  v_reward_kobo := 100000;
    when 'nairaReader'           then v_target := 5;       v_reward_kobo := 50000;
    when 'nairaLoyal'            then v_target := 7;       v_reward_kobo := 100000;
    else
      raise exception 'This achievement has no server-verifiable signal yet.';
  end case;

  perform pg_advisory_xact_lock(hashtext('naira_achievement:' || auth.uid()::text || ':' || p_achievement_id));

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
-- PART 2 — Daily check-in calendar
-- ============================================================================================
--
-- One row per user per calendar day. The date always comes from the server clock (current_date,
-- inside the security definer RPC below) — there is deliberately no client insert policy on this
-- table, so a writer can't backdate a check-in by posting an arbitrary checkin_date directly.
-- Distinct from the existing per-project "writing streak" in tab-progress.jsx, which is a
-- client-derived word-count signal, not a real server-verified daily action — the two aren't
-- meant to be merged.

create table if not exists daily_checkins (
  user_id uuid not null references auth.users(id) on delete cascade,
  checkin_date date not null,
  created_at timestamptz not null default now(),
  primary key (user_id, checkin_date)
);

alter table daily_checkins enable row level security;

drop policy if exists "a user reads their own check-ins" on daily_checkins;
create policy "a user reads their own check-ins" on daily_checkins
  for select using (auth.uid() = user_id);

-- Idempotent — check-in for today twice is a no-op, not an error, same "already done" tolerance
-- as grant_naira_achievement's own idempotency check above. Returns the resulting streak so the
-- client doesn't need a second round trip after checking in.
create or replace function check_in_today()
returns table (checked_in_today boolean, current_streak integer)
language plpgsql security definer set search_path = public as $$
begin
  insert into daily_checkins (user_id, checkin_date)
  values (auth.uid(), current_date)
  on conflict (user_id, checkin_date) do nothing;

  return query
  with days as (
    -- Gaps-and-islands: for consecutive calendar dates, (date - row_number()) lands on the same
    -- value, so the island containing today's row is exactly the current streak.
    select checkin_date,
           checkin_date - (row_number() over (order by checkin_date))::integer as grp
    from daily_checkins
    where user_id = auth.uid() and checkin_date <= current_date
  )
  select true, (select count(*)::integer from days where grp = (select grp from days where checkin_date = current_date));
end;
$$;

revoke all on function check_in_today() from public;
grant execute on function check_in_today() to authenticated;

-- Read-only fetch for a given month, so the client can render a calendar grid without a raw
-- table read (keeps the same "app talks to functions/narrow policies, not ad hoc queries"
-- shape as the rest of this schema, and leaves room to add derived fields later without a
-- client-side query change).
create or replace function fetch_checkins_for_month(p_year integer, p_month integer)
returns table (checkin_date date)
language sql stable security definer set search_path = public as $$
  select checkin_date from daily_checkins
  where user_id = auth.uid()
    and checkin_date >= make_date(p_year, p_month, 1)
    and checkin_date < (make_date(p_year, p_month, 1) + interval '1 month')::date
  order by checkin_date;
$$;

revoke all on function fetch_checkins_for_month(integer, integer) from public;
grant execute on function fetch_checkins_for_month(integer, integer) to authenticated;
