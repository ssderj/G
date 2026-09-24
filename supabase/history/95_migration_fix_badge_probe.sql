-- ============================================================================================
-- Migration 95 — fix: inkroot_official_badge_earned let any signed-in user probe any OTHER
-- user's badge eligibility (whether they'd ever made a successful purchase or attended a paid
-- guild event), bypassing purchases' own "read your own rows only" policy in aggregate-boolean
-- form. Flagged in the production audit after migration 94 shipped.
--
-- The fix removes the parameter entirely rather than adding a guard clause — every real call
-- site (inkroot_official_badge_status, grant_naira_achievement) already only ever checked
-- auth.uid(), so there was never a legitimate reason for this to take an arbitrary target user.
-- Dropping the parameter removes the vulnerable surface outright instead of trusting every future
-- caller to remember to pass auth.uid() correctly.
--
-- Postgres treats a changed argument list as a distinct function, not a replacement, so the old
-- inkroot_official_badge_earned(uuid) has to be dropped explicitly or it would keep existing
-- (and keep being callable) side by side with the new one.
drop function if exists inkroot_official_badge_earned(uuid);

create or replace function inkroot_official_badge_earned()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    (
      exists (select 1 from purchases where buyer_id = auth.uid() and status = 'success')
      or exists (select 1 from published_books where author_id = auth.uid())
      or exists (select 1 from guild_published_books where author_id = auth.uid())
    )
    and (
      exists (select 1 from founder_guild_members where user_id = auth.uid())
      or exists (select 1 from player_guild_members where user_id = auth.uid())
    )
    and exists (select 1 from guild_event_entries where entrant_id = auth.uid() and status = 'success')
    and exists (select 1 from auth.users where id = auth.uid() and created_at <= now() - interval '7 days');
$$;

revoke all on function inkroot_official_badge_earned() from public;
grant execute on function inkroot_official_badge_earned() to authenticated;

-- inkroot_official_badge_status() was already self-referential (ignored any notion of a target
-- user and only ever reported on auth.uid()), so this replacement changes nothing about its
-- behavior or its callers — only the one internal call site, updated for the new signature.
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
    inkroot_official_badge_earned();
$$;

revoke all on function inkroot_official_badge_status() from public;
grant execute on function inkroot_official_badge_status() to authenticated;

-- grant_naira_achievement already only ever called this with auth.uid() — updated for the new
-- signature, nothing else in this function's body changes from migration 94's version.
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

  if not inkroot_official_badge_earned() then
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
