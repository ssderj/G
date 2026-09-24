-- ============================================================================================
-- Migration 140 — a pending account-deletion request did not stop the account founding a new
-- Player Guild, which purge_expired_account_deletions() would then orphan on day 30.
--
-- Migration 79 guards the REQUEST side: account_deletions' before insert/update trigger refuses
-- a request from a Player Guild owner unless they've acknowledged what it does to their guild
-- (acknowledges_owned_guild_impact). But that trigger only fires when the account_deletions row
-- is written. Nothing looks at guild ownership again at purge time — and purge deletes the
-- owner's player_guild_members row and permanently bans the account, leaving
-- player_guilds.owner_id pointing at an account that can never sign in again (see migration 79's
-- header for why that is functionally permanent). So: request deletion while owning no guild
-- (nothing to acknowledge, request accepted), found a guild at any point in the next 30 days
-- (create_or_get_own_guild() never looks at account_deletions), and the daily purge orphans it.
--
-- Fix (option (a) from the audit — block it from ever arising; option (b), a purge-time
-- re-check, was NOT chosen and purge_expired_account_deletions() is untouched): while the caller
-- has an account_deletions row with status = 'pending', create_or_get_own_guild() refuses to
-- found a guild. The check applies only when the caller owns NO guild yet (v_existing is null):
--   * pending deletion + already owns a guild, editing it (same p_id)  -> allowed, unchanged.
--   * pending deletion + owns no guild, founding one                   -> refused (new).
--   * pending deletion + owns no guild, re-entering with a local id whose
--     first sync never reached the server                              -> refused (new; it is
--     indistinguishable from founding as far as the server is concerned).
--   * pending deletion + already owns a guild, different p_id          -> refused, as before,
--     by the existing 'You already own a Player Guild' check that runs first.
--   * deletion cancelled (row deleted, or status = 'cancelled')        -> founding/re-entry
--     allowed again; only status = 'pending' blocks.
--
-- The check sits right after the existing 'already own a Player Guild' check, inside the
-- per-caller advisory lock migration 137 added, so it can't be interleaved with a concurrent
-- create_or_get_own_guild()/join_player_guild_by_code() for the same caller. It does NOT
-- serialize against a concurrent account-deletion REQUEST (check_account_deletion_guild_impact()
-- takes no lock) — a request and a founding landing in the same instant could both pass. That
-- window is the same one migration 79's own check already has; closing it would mean taking
-- the same 'guild_membership:' lock in that trigger and is left as a separate decision.
--
-- No client change needed: syncPlayerGuild() throws sanitizeError(error), which passes a
-- plpgsql raise exception (P0001) message through untouched, and ink-root.jsx's guildSyncNotice
-- dialog already displays that message and offers a retry — which succeeds once the deletion
-- is cancelled.
--
-- Safe to run anytime: same signature, same grants, no schema or data change. The only new
-- behavior is refusing a founding that the purge would have orphaned anyway; a caller with no
-- pending deletion (the overwhelmingly common case) and any caller editing a guild they
-- already own see no difference. Existing rows are untouched — a guild already founded during
-- a pending deletion is not repaired by this (see the diagnostic query below).
--
-- Diagnostic (read-only) for guilds already in that state today:
--   select g.id, g.name, g.owner_id, d.scheduled_purge_at
--   from player_guilds g join account_deletions d on d.user_id = g.owner_id
--   where d.status = 'pending' and not g.is_founder_guild;
-- ============================================================================================

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

  -- Migration 137: serializes against a concurrent call to this function, and against
  -- join_player_guild_by_code() below (same lock key), for this same caller — so two
  -- simultaneous attempts to seat this writer in two different guilds can't both pass the
  -- checks that follow before either insert commits. Taken before any of those checks read
  -- player_guild_members/founder_guild_members, and held for the rest of this transaction.
  perform pg_advisory_xact_lock(hashtext('guild_membership:' || auth.uid()::text));

  select * into v_existing from player_guilds where owner_id = auth.uid();
  -- Found is the giveaway of the bug this closes: a *different* locally-generated id (from a
  -- second device, or a cleared local profile) trying to found a second guild for the same
  -- owner. Same id just means "re-entering / editing my own guild" and always falls through to
  -- the upsert below, same as it always has.
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  -- Migration 140: a pending account-deletion request blocks FOUNDING (or re-entering, i.e.
  -- retrying a founding that never reached the server) a guild — the purge cron never re-checks
  -- guild ownership, so a guild founded inside the 30-day grace window would be orphaned on day
  -- 30 exactly the way migration 79's request-time check exists to prevent. Deliberately keyed
  -- on "caller owns no guild yet" (v_existing is null), NOT on the call as a whole: this same
  -- RPC is the upsert behind every edit of an existing guild (saveOwnGuild pushes every
  -- keystroke), and someone who already owns a guild and requested deletion (having acknowledged
  -- migration 79's warning) must keep being able to edit it. Cancelling the deletion (which
  -- deletes the account_deletions row — see cancelAccountDeletion in lib/account-deletion.js)
  -- lifts the block immediately; only status = 'pending' counts. The wording below is shown to
  -- the writer as-is (P0001 passes through sanitizeError, and guildSyncNotice in ink-root.jsx
  -- displays e.message), so it says what to do about it.
  if v_existing.id is null and exists (
    select 1 from account_deletions d where d.user_id = auth.uid() and d.status = 'pending'
  ) then
    raise exception 'You can''t found a guild while an account deletion is pending — cancel the deletion first, then try again.';
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
