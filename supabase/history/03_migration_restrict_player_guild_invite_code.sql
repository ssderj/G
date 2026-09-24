-- Fixes: player_guilds' select policy was `using (true)` — public read on every column,
-- including invite_code. Postgres RLS can't hide individual columns from a `select('*')`, so any
-- signed-in client could query the table directly (bypassing the join-by-code UI entirely) and
-- read every guild's invite code, defeating the point of an invite-only guild. This migration
-- restricts select to the guild's owner and its actual members, and adds a security-definer
-- function so joining by code still works without a public select policy to support it.
--
-- Safe to run on a deployment that already has data: the new select policy is additive (replaces
-- the old one, doesn't touch rows), and the new function is create-or-replace.

begin;

drop policy if exists "anyone can read player guilds" on player_guilds;

create policy "owner or member can read their player guild" on player_guilds
  for select using (
    auth.uid() = owner_id
    or exists (
      select 1 from player_guild_members m
      where m.guild_id = player_guilds.id and m.user_id = auth.uid()
    )
  );

create or replace function join_player_guild_by_code(p_code text)
returns table (id uuid, name text, motto text, crest_url text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  select * into v_guild from player_guilds g where g.invite_code = lower(p_code);
  if not found then
    raise exception 'No guild found with that invite code.';
  end if;

  insert into player_guild_members (guild_id, user_id)
  values (v_guild.id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  -- owner_id is included here (unlike invite_code) because the client's join flow
  -- (ink-root.jsx's joinGuildByCode) records it locally as joinedGuild.ownerId — owner_id isn't
  -- secret the way invite_code is, so returning it doesn't reopen the gap this migration closes.
  return query select v_guild.id, v_guild.name, v_guild.motto, v_guild.crest_url, v_guild.owner_id;
end;
$$;

grant execute on function join_player_guild_by_code(text) to authenticated;

commit;
