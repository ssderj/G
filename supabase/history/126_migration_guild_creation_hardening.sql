-- ============================================================================================
-- Migration 126 — closes four gaps found in the production Guild/Guild-Event audit that
-- produced migration 125. All four are about create_or_get_own_guild() / join_player_guild_by_code()
-- / founder_guild_members enforcing things the CLIENT already assumes are true, but the server
-- never actually checked — so a direct RPC/table call (devtools, a script, a second client) could
-- get past every one of them.
--
--   1. "One guild at a time" was a client-only rule (ink-root.jsx's guildProfile.guildType +
--      guildCooldownRemainingMs). Neither create_or_get_own_guild() nor join_player_guild_by_code()
--      checked whether the caller already belonged to a *different* guild (Player or Founder)
--      before seating them in a new one. Fixed by adding the same check server-side to both.
--
--   2. founder_guild_members had no per-user uniqueness at all (its primary key is
--      (guild_id, user_id), which only stops re-joining the SAME guild twice) — a writer could
--      hold membership rows in several Founder Guilds simultaneously. Fixed with a unique index
--      on user_id alone, the same "hard backstop" pattern player_guilds_owner_id_key already
--      uses for one-Player-Guild-per-owner (migration 72). The join policy is also tightened so
--      a Player Guild member/owner can't join a Founder Guild without leaving first — the
--      cross-type half of point 1 that a plain unique index on this table can't express by itself.
--
--   3. Guild name/motto were the only two free-text, user-controlled columns in the whole schema
--      that migration 22 (22_migration_text_field_length_caps.sql) didn't cap — every other
--      title/body/note/display-name column got a char_length constraint; player_guilds.name and
--      .motto were missed. Fixed with the same kind of constraint migration 22 uses elsewhere.
--
--   4. Reserved/staff-impersonation names (isReservedName, src/shared-utils/identity-safety.js)
--      were only ever checked against a writer's own profile name/pen name (see saveProfile in
--      ink-root.jsx) — a guild could be founded or renamed to "Inkroot Official", "Admin",
--      "Support", etc. with nothing server-side stopping it. Fixed with a server-side port of the
--      same normalize+blocklist check, applied inside create_or_get_own_guild(). Deliberately
--      simpler than the client's version — no accent-folding, since that needs the `unaccent`
--      extension and this schema doesn't otherwise depend on it — same "modest, not a complete
--      security boundary on its own" caveat the client-side version's own comment already makes;
--      moderation/reports remain the backstop for anything cleverer than a plain reserved word.
--
-- Also closes a fifth issue found while rewriting create_or_get_own_guild() for the above: because
-- Founder Guild rows have owner_id IS NULL, the function's existing "an id that already belongs to
-- someone else is never ours to write to" guard (`owner_id <> auth.uid()`) silently evaluates to
-- NULL — not TRUE — for a Founder Guild row, so that guard never actually fired for one. A caller
-- who passed one of the ten hardcoded Founder Guild backendGuildIds (see FOUNDER_GUILDS in
-- guild-hall.jsx — these are public constants, not secrets) as p_id couldn't overwrite the Founder
-- Guild's name/motto (the later `on conflict ... where player_guilds.owner_id = auth.uid()` still
-- caught that part), but DID get a stray player_guild_members row inserted against that Founder
-- Guild's id for themselves, and got the Founder Guild's own row handed back as if it were their
-- newly founded guild. Harmless to permissions (is_guild_member()/is_guild_officer() route a
-- Founder Guild id to founder_guild_members, never to player_guild_members, regardless), but it's
-- data pollution with a confusing client-side result. Fixed by refusing any p_id that's a Founder
-- Guild row outright, before either insert.
--
-- Not run against a live database from this session. Verify after applying: a Founder Guild
-- member cannot call create_or_get_own_guild until they've left (founder_guild_members has no row
-- for them); a Player Guild owner/member cannot join a Founder Guild until they've left their
-- Player Guild; a name of "Inkroot Support" / "Admin" / "STAFF" (any case/spacing) is refused; a
-- 61+ character name is refused; passing a Founder Guild's backendGuildId as p_id is refused; a
-- normal founding/editing/re-entering flow for one's own guild is completely unaffected.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 3. Length caps on player_guilds.name / .motto — same pattern as migration 22.
--
-- **Before running**: same caveat as migration 22 — adding a CHECK constraint validates every
-- existing row against it. Check first:
--
--   select id, name from player_guilds where char_length(name) > 60;
--   select id, motto from player_guilds where motto is not null and char_length(motto) > 200;
--
-- If either returns rows, raise the cap below to fit them, or ask the owner to shorten it first.
-- ------------------------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_guilds_name_length_check') then
    alter table player_guilds add constraint player_guilds_name_length_check check (char_length(name) <= 60);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'player_guilds_motto_length_check') then
    alter table player_guilds add constraint player_guilds_motto_length_check check (motto is null or char_length(motto) <= 200);
  end if;
end $$;

-- ------------------------------------------------------------------------------------------
-- 2a. One Founder Guild at a time — the same unconditional hard backstop
-- player_guilds_owner_id_key already is for Player Guild ownership.
-- ------------------------------------------------------------------------------------------

create unique index if not exists founder_guild_members_user_id_key on founder_guild_members (user_id);

-- ------------------------------------------------------------------------------------------
-- 2b. Joining a Founder Guild now also refuses a caller who's already an owner or member of a
-- Player Guild — the cross-type half of "one guild at a time" that a same-table unique index
-- can't express. Policies can't be altered in place, so drop + recreate.
-- ------------------------------------------------------------------------------------------

drop policy if exists "a writer joins a founder guild on their own behalf" on founder_guild_members;
create policy "a writer joins a founder guild on their own behalf" on founder_guild_members
  for insert with check (
    auth.uid() = user_id
    and not is_banned(auth.uid())
    and not exists (select 1 from player_guild_members m where m.user_id = auth.uid())
  );

-- ------------------------------------------------------------------------------------------
-- 4. Reserved/staff-impersonation guild names — server-side port of
-- src/shared-utils/identity-safety.js's isReservedName/normalizeIdentityName (minus accent
-- folding — see this migration's header). Named distinctly from any future writer-name
-- equivalent so the two can evolve independently.
-- ------------------------------------------------------------------------------------------

create or replace function normalize_guild_identity_name(p_name text)
returns text
language sql immutable
as $$
  select regexp_replace(
    translate(lower(coalesce(p_name, '')), '013457@$', 'oieastas'),
    '[^a-z0-9]', '', 'g'
  );
$$;

create or replace function is_reserved_guild_name(p_name text)
returns boolean
language sql immutable
as $$
  select length(normalize_guild_identity_name(p_name)) > 0
    and normalize_guild_identity_name(p_name) = any(array[
      'inkroot', 'inkrootsupport', 'inkrootstaff', 'inkrootteam', 'inkrootofficial',
      'inkrootadmin', 'inkrootmoderator', 'inkrootmod', 'inkrootsecurity', 'inkroothelp',
      'support', 'staff', 'admin', 'administrator', 'moderator', 'mod', 'official', 'system',
      'inkrootteamofficial'
    ]);
$$;

-- ------------------------------------------------------------------------------------------
-- 1 + 4 + 5. create_or_get_own_guild — adds the "not already seated in a different guild" check,
-- the reserved-name check, and the Founder-Guild-id guard described above. Everything from
-- migration 125 (name required, banned check, ownership checks, the upsert itself) is unchanged.
-- ------------------------------------------------------------------------------------------

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

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Give your guild a name.';
  end if;

  if char_length(trim(p_name)) > 60 then
    raise exception 'Guild name is too long (60 characters max).';
  end if;

  if is_reserved_guild_name(p_name) then
    raise exception 'That name isn''t available.';
  end if;

  -- A Founder Guild's id is a public constant (see FOUNDER_GUILDS in guild-hall.jsx), never a
  -- guild this RPC is allowed to touch — see this migration's header, point 5.
  if exists (select 1 from player_guilds where id = p_id and is_founder_guild) then
    raise exception 'That id is reserved.';
  end if;

  select * into v_existing from player_guilds where owner_id = auth.uid();
  -- Found is the giveaway of the bug this closes: a *different* locally-generated id (from a
  -- second device, or a cleared local profile) trying to found a second guild for the same
  -- owner. Same id just means "re-entering / editing my own guild" and always falls through to
  -- the upsert below, same as it always has.
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  -- Migration 126: "one guild at a time" was previously only a client-side rule. A caller
  -- already seated in a *different* Player Guild (as owner or member — create_or_get_own_guild
  -- always inserts the owner into player_guild_members too, so this one check covers both) or
  -- in any Founder Guild must leave it before founding/re-entering this one.
  if exists (
    select 1 from player_guild_members m where m.user_id = auth.uid() and m.guild_id <> p_id
  ) then
    raise exception 'You''re already seated in a guild — leave it before founding a new one.';
  end if;
  if exists (select 1 from founder_guild_members m where m.user_id = auth.uid()) then
    raise exception 'Leave your Founder Guild before founding a Player Guild.';
  end if;

  -- An id that already exists under a different owner is never ours to write to.
  if exists (select 1 from player_guilds where id = p_id and owner_id <> auth.uid()) then
    raise exception 'You can only edit a guild you own.';
  end if;

  insert into player_guilds (id, name, motto, crest_url, owner_id, updated_at)
  values (p_id, trim(p_name), p_motto, p_crest_url, auth.uid(), now())
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

-- ------------------------------------------------------------------------------------------
-- 1. join_player_guild_by_code — adds the same "not already seated in a different guild" check.
-- Everything else (ban check from migration 117, rate limit from migration 101, the idempotent
-- insert, the return shape) is unchanged.
-- ------------------------------------------------------------------------------------------

create or replace function join_player_guild_by_code(p_code text)
returns table (id uuid, name text, motto text, crest_url text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t join a guild.';
  end if;

  -- Migration 126: same "one guild at a time" backstop as create_or_get_own_guild() above.
  -- Checked before the rate-limited lookup so a caller already seated elsewhere never spends an
  -- attempt guessing a code they'd be refused anyway.
  if exists (select 1 from player_guild_members m where m.user_id = auth.uid()) then
    raise exception 'You''re already seated in a guild — leave it before joining another.';
  end if;
  if exists (select 1 from founder_guild_members m where m.user_id = auth.uid()) then
    raise exception 'Leave your Founder Guild before joining a Player Guild.';
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
