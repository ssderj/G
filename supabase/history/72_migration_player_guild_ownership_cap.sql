-- 72_migration_player_guild_ownership_cap.sql
--
-- Closes item 3 of the audit: "one Player Guild per owner" was only ever enforced client-side,
-- via ink-root.jsx's guildCooldownRemainingMs / base.guildType checks before enterOwnGuild is
-- even called. Nothing server-side stopped a direct call from creating a second player_guilds
-- row for the same owner_id — the realistic trigger being a second device, or a locally cleared
-- guild profile, generating a fresh client-side uuid() and upserting a brand-new row instead of
-- reusing the one already on file.
--
-- Two layers, paired deliberately:
--   1. A unique index on owner_id — the unconditional guarantee. Even a raw insert that skips
--      every RPC and policy below cannot create a second row for the same owner.
--   2. create_or_get_own_guild(), a security-definer RPC in the same shape as
--      join_player_guild_by_code() (see supabase/schema.sql, ~line 715) — it checks ownership
--      first and raises a clear, catchable error instead of a raw unique-violation, and folds in
--      the player_guild_members "owner is a member too" insert syncPlayerGuild used to make as a
--      separate call. src/lib/player-guild.js's syncPlayerGuild now calls this RPC instead of
--      upserting player_guilds directly.
--
-- IMPORTANT — run the check below FIRST. If "no cap" has been true in production for a while,
-- there may already be owner_ids with more than one player_guilds row, and the unique index
-- cannot be created until that's resolved (Postgres will simply refuse, with a violation error
-- naming this index). This migration does not guess which of any duplicate rows to keep — that's
-- a product/data decision, not a schema one.
--
--   select owner_id, count(*), array_agg(id order by created_at) as guild_ids
--   from player_guilds group by owner_id having count(*) > 1;
--
-- If that returns any rows, decide (e.g. keep the oldest, merge members/treasury/anthology
-- history into it, delete or reassign the rest) before running the two statements below.

create unique index if not exists player_guilds_owner_id_key on player_guilds (owner_id);

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
  -- Found is the giveaway of the bug this closes: a *different* locally-generated id (from a
  -- second device, or a cleared local profile) trying to found a second guild for the same
  -- owner. Same id just means "re-entering / editing my own guild" and always falls through to
  -- the upsert below, same as it always has.
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  insert into player_guilds (id, name, motto, crest_url, owner_id, updated_at)
  values (p_id, p_name, p_motto, p_crest_url, auth.uid(), now())
  on conflict (id) do update set
    name = excluded.name,
    motto = excluded.motto,
    crest_url = excluded.crest_url,
    updated_at = now();

  -- Same reasoning as join_player_guild_by_code() above: this always uses auth.uid() directly,
  -- never a caller-supplied user id, so bypassing RLS here can't be used to add anyone else.
  insert into player_guild_members (guild_id, user_id)
  values (p_id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select * from player_guilds where id = p_id;
end;
$$;

grant execute on function create_or_get_own_guild(uuid, text, text, text) to authenticated;
