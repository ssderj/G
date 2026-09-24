-- ============================================================================================
-- Migration 137 — closes two TOCTOU gaps found in AUDIT_v21_race_conditions.md (item 8):
--
--   1. create_or_get_own_guild() / join_player_guild_by_code() enforced migration 126's
--      "seated in at most one guild" rule with a plain read-then-insert, no lock. Two
--      concurrent calls for the same user (join guild A + join guild B, or found-a-guild +
--      join-by-code) could both pass the "not already seated" check before either
--      `insert into player_guild_members` committed, landing the user in two guilds at once —
--      nothing in the schema stops that (player_guild_members' PK is (guild_id, user_id), no
--      unique index on user_id alone). Double-*founding* was already blocked at the DB level
--      by player_guilds_owner_id_key; this only closes the membership half.
--
--   2. complete_guild_event() and the close_ended_guild_events() cron sweep flipped
--      guild_events.status/approval_status without taking the same
--      hashtext('guild_event_entry:' || event_id) advisory lock
--      create_guild_event_entry_locked() / cancel_guild_event() / settle_guild_event() all take
--      first. An entry payment already past its own status check (holding that lock) could
--      commit a beat after one of these two flipped the event closed — not a fund-safety bug,
--      just the one asymmetry against the locking convention this file otherwise applies
--      consistently to every other guild_events transition.
--
-- Fix, both cases: take the same lock key the rest of that function family already uses,
-- before the check that used to run unlocked. No schema change, no new columns, no client-
-- facing behavior change on the non-racing path — every existing single-caller test in
-- AUDIT_v20/v21 should still pass unchanged.
--
-- Not run against a live database from this session (static fix for a static finding — see
-- AUDIT_v21_race_conditions.md's own "Not exercised" note). Verify after applying:
--   * Two concurrent join_player_guild_by_code() calls for the same user (different codes), or
--     one join_player_guild_by_code() + one create_or_get_own_guild() call for the same user
--     fired at the same instant, result in exactly one player_guild_members row for that user —
--     the second call raises 'You're already seated in a guild...' instead of both succeeding.
--   * A concurrent create_guild_event_entry_locked() and complete_guild_event() for the same
--     event fully serialize (one waits for the other's transaction to finish) rather than
--     interleaving.
--   * close_ended_guild_events() still closes every event whose end_date has passed, and its
--     return value (count closed) is unchanged for the non-concurrent case.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 1. create_or_get_own_guild — adds a per-caller advisory lock, taken before the "not seated
-- elsewhere" checks (unchanged otherwise, byte-for-byte, from migration 125/126's version).
-- Lock key is shared with join_player_guild_by_code() below, so the two fully serialize
-- against each other for the same caller, not just against themselves.
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
-- 2. join_player_guild_by_code — same lock, same key, taken before its own "not seated
-- elsewhere" check. Everything else (ban check, rate limit, the idempotent insert, the return
-- shape) is unchanged from migration 126's version.
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

  -- Migration 137: same lock key create_or_get_own_guild() above takes — see its comment.
  -- Taken before either "not seated elsewhere" check below, and before the rate-limited
  -- lookup, so a caller who loses the race pays no rate-limit cost for a guess that was
  -- always going to be refused once it re-checks (matches the existing reasoning for why
  -- the rate limit itself sits after this check, not before it).
  perform pg_advisory_xact_lock(hashtext('guild_membership:' || auth.uid()::text));

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

-- ------------------------------------------------------------------------------------------
-- 3. complete_guild_event — adds the same hashtext('guild_event_entry:' || event_id) lock
-- create_guild_event_entry_locked()/cancel_guild_event()/settle_guild_event() already take,
-- before reading the event's current status. Everything else unchanged.
-- ------------------------------------------------------------------------------------------

create or replace function complete_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can complete this event.';
  end if;

  -- Migration 137: same lock create_guild_event_entry_locked()/cancel_guild_event()/
  -- settle_guild_event() take before touching guild_events' status/approval_status — an entry
  -- payment already past its own status check can no longer land a beat after this call closes
  -- the event out from under it.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'Only an active event can be marked completed.';
  end if;

  update guild_events set approval_status = 'completed', completed_at = now(), status = 'closed'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 4. close_ended_guild_events — rewritten from a single bulk UPDATE into a per-event loop so
-- each event can take its own guild_event_entry lock before being closed, same as #3 above.
-- The final WHERE clause is re-checked inside the loop, under the lock, so an event that
-- another concurrent call already closed/cancelled/settled in the gap between the outer
-- SELECT and this event's turn in the loop is correctly skipped rather than double-closed.
-- ------------------------------------------------------------------------------------------

create or replace function close_ended_guild_events()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event_id uuid;
  v_count integer := 0;
begin
  -- Same cron-only guard reconcile_referral_grants/reconcile_naira_achievements use: a pg_cron
  -- job has no JWT (auth.role() is NULL), so a direct postgres/supabase_admin session is
  -- accepted too. A signed-in client or the anon key still can't call this.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  for v_event_id in
    select id from guild_events
    where host = 'guild'
      and status = 'open'
      and approval_status = 'active'
      and end_date is not null
      and end_date < now()
  loop
    perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || v_event_id::text));

    update guild_events
    set status = 'closed', approval_status = 'completed', completed_at = now()
    where id = v_event_id
      and status = 'open'
      and approval_status = 'active'
      and end_date is not null
      and end_date < now();

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function close_ended_guild_events() from public, anon, authenticated;

-- Safe to run anytime: every function here is redefined with the exact same signature it
-- already had (grants carry over unchanged for create_or_get_own_guild/
-- join_player_guild_by_code; close_ended_guild_events keeps its existing revoke and its
-- existing cron.schedule('close-ended-guild-events', ...) entry from migration 129, which
-- points at this function by name and needs no changes). The only new behavior is stricter
-- serialization on an already-existing rule — no caller that wasn't racing another call sees
-- any difference.
-- ============================================================================================
