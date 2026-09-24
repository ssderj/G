-- Migration 117: a suspended (banned) account could join a Player Guild (production-readiness audit).
--
-- The gap: joining a Player Guild used to be a direct insert into player_guild_members guarded by
-- the policy "a writer joins on their own behalf", whose check included `not is_banned(auth.uid())`.
-- That policy was dropped when joining moved into join_player_guild_by_code() (a security-definer
-- function, so it bypasses RLS) — and the function never re-added the ban check. Founder Guild
-- joins (still a direct insert) and Player Guild creation (create_or_get_own_guild) still enforce it.
--
-- What this changes: one added check at the top of join_player_guild_by_code(). Nothing else in the
-- function changed (rate limit, lookup, idempotent insert, return shape).
--
-- Not run against a live database from this session. Verify after applying: a profile with
-- banned = true calling join_player_guild_by_code('<valid code>') gets the suspension error and no
-- player_guild_members row; a normal user still joins.

create or replace function join_player_guild_by_code(p_code text)
returns table (id uuid, name text, motto text, crest_url text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  -- Migration 117: the direct-insert policy this function replaced ("a writer joins on their own
  -- behalf") carried `not is_banned(auth.uid())`; the function did not, so a banned account could
  -- join any guild with an invite code. Same check create_or_get_own_guild() already makes.
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t join a guild.';
  end if;

  -- Counted BEFORE the lookup, and a miss below returns no rows instead of raising: a raised
  -- exception would roll back this function's own transaction, un-counting exactly the failed
  -- guesses the limit exists to catch.
  perform check_and_bump_rate_limit('join_guild');

  select * into v_guild from player_guilds g where g.invite_code = lower(p_code);
  if not found then
    return; -- no rows -> the client's .single() errors and shows "No guild found with that invite code."
  end if;

  insert into player_guild_members (guild_id, user_id)
  values (v_guild.id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select v_guild.id, v_guild.name, v_guild.motto, v_guild.crest_url, v_guild.owner_id;
end;
$$;

grant execute on function join_player_guild_by_code(text) to authenticated;
