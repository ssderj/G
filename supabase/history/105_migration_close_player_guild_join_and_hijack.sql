-- Migration 105: two ways to get into (or take over) a Player Guild without its invite code
-- (production audit — guild joining / guild-only book access).
--
-- Bug 1 — direct join bypassing the invite code. player_guild_members had an insert policy,
-- "a writer joins on their own behalf" (schema_phase5, re-created by migration 71), that lets any
-- signed-in user insert THEMSELVES into ANY guild straight through PostgREST, and the table's
-- select policy is `using (true)`, so every guild_id is world-readable. Net effect: no invite
-- code needed. Membership is the read gate for a guild's guild-only books ("player guild
-- members read their guild's book content"), and it also exposes player_guilds.invite_code to the
-- new "member". Migration 101's join rate limit and migration 03's invite-code secrecy were both
-- moot while this policy existed. The client never inserts into this table directly: the only
-- writers are join_player_guild_by_code() and create_or_get_own_guild(), both security definer
-- (they bypass RLS), so dropping the policy changes nothing for legitimate joins.
--
-- Bug 2 — guild hijack via create_or_get_own_guild(). Its upsert was `on conflict (id) do update`
-- with no owner check, and it runs as security definer. A caller who owns no guild could pass
-- ANOTHER guild's id: the row's name/motto/crest were overwritten, and the caller was then
-- inserted as a member. Fixed by refusing an id that already belongs to someone else, and by
-- making the conflict update itself owner-scoped as a second line of defense.
--
-- Leaving as-is on purpose: player_guild_members' read policy (rosters use it).
-- Safe to run anytime; no data changes.

drop policy if exists "a writer joins on their own behalf" on player_guild_members;

create or replace function create_or_get_own_guild(p_id uuid, p_name text, p_motto text, p_crest_url text)
returns setof player_guilds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing player_guilds%rowtype;
begin
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t found or edit a guild.';
  end if;

  select * into v_existing from player_guilds where owner_id = auth.uid();
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  -- An id that already exists under a different owner is never ours to write to.
  if exists (select 1 from player_guilds where id = p_id and owner_id <> auth.uid()) then
    raise exception 'You can only edit a guild you own.';
  end if;

  insert into player_guilds (id, name, motto, crest_url, owner_id, updated_at)
  values (p_id, p_name, p_motto, p_crest_url, auth.uid(), now())
  on conflict (id) do update set
    name = excluded.name,
    motto = excluded.motto,
    crest_url = excluded.crest_url,
    updated_at = now()
  where player_guilds.owner_id = auth.uid();

  insert into player_guild_members (guild_id, user_id)
  values (p_id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select * from player_guilds where id = p_id;
end;
$$;

grant execute on function create_or_get_own_guild(uuid, text, text, text) to authenticated;
