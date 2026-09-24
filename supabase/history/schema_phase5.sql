-- Phase 5: makes player-created guilds actually joinable by other writers — the largest gap
-- flagged after Phase 4. Founder Guilds (Phase 3) already had a natural shared identifier;
-- player guilds had neither an id nor any join mechanism at all before this.

create table if not exists player_guilds (
  id uuid primary key,
  name text not null,
  motto text,
  crest_url text,
  owner_id uuid not null references auth.users(id) on delete cascade,
  -- Server-generated, not client-generated, so uniqueness doesn't need client-side retry logic.
  -- 8 hex characters is plenty of entropy for an invite code at this app's scale.
  invite_code text unique not null default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table player_guilds enable row level security;

-- Read is restricted to the guild's owner and its actual members — NOT "anyone can read". A
-- player_guilds row includes invite_code, and Postgres RLS can't hide individual columns from a
-- `select('*')`, so any select policy open to non-members exposes every guild's invite code to
-- every signed-in reader, defeating the entire point of an invite-only guild (a determined client
-- could just query the table directly instead of going through the UI). Joining by code is still
-- possible without a public row-level select: see join_player_guild_by_code() below, a
-- security-definer function that looks the row up server-side and never returns invite_code.
create policy "owner or member can read their player guild" on player_guilds
  for select using (
    auth.uid() = owner_id
    or exists (
      select 1 from player_guild_members m
      where m.guild_id = player_guilds.id and m.user_id = auth.uid()
    )
  );
create policy "owner creates their guild" on player_guilds
  for insert with check (auth.uid() = owner_id);
create policy "owner updates their guild" on player_guilds
  for update using (auth.uid() = owner_id);

create table if not exists player_guild_members (
  guild_id uuid not null references player_guilds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

alter table player_guild_members enable row level security;

create policy "anyone can read player guild members" on player_guild_members
  for select using (true);
create policy "a writer joins on their own behalf" on player_guild_members
  for insert with check (auth.uid() = user_id);
create policy "a writer leaves on their own behalf" on player_guild_members
  for delete using (auth.uid() = user_id);

create index if not exists player_guild_members_guild_idx on player_guild_members (guild_id);

-- Lets a signed-in writer join a guild by invite code without ever needing a public select
-- policy on player_guilds (see the comment above the table's select policy). security definer
-- means this function runs with the privileges of its owner, not the caller — so it can look up
-- the guild by invite_code internally (bypassing the caller's own, now-restricted, RLS) and
-- insert the membership row, but the only thing it ever returns to the caller is the guild's
-- non-secret fields. search_path is pinned so it can't be hijacked by a same-named object
-- elsewhere on the schema search path.
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
  -- secret the way invite_code is, so returning it doesn't reopen the gap this function closes.
  return query select v_guild.id, v_guild.name, v_guild.motto, v_guild.crest_url, v_guild.owner_id;
end;
$$;

-- Callable by any signed-in writer. Note that a security-definer function typically runs as the
-- table owner and so bypasses RLS on every table it touches, including player_guild_members —
-- but that's not a problem here because the membership row this inserts always uses auth.uid()
-- directly (never a caller-supplied user id), so there's no way to call this to join a guild on
-- someone else's behalf even with RLS bypassed.
grant execute on function join_player_guild_by_code(text) to authenticated;
