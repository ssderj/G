-- ============================================================================================
-- Migration 129 — closes the "end_date is decorative" gap found in the final audit:
-- create_guild_event_entry_locked() (the only path that ever creates a paid entry) checked
-- status = 'open' and approval_status = 'active', but never compared now() to the event's own
-- end_date. Nothing else in the schema read end_date either — no scheduled job existed to force
-- ACTIVE -> CLOSED once it passed. An event whose end_date had already come and gone kept
-- accepting real paid entries indefinitely, until a human happened to notice and call
-- complete_guild_event() (or close_guild_event(), pre-review-workflow) by hand.
--
-- Two changes, same "hard backstop at the money-moving function + housekeeping to keep the
-- visible state honest" split this schema already uses elsewhere (e.g. the participant_limit
-- check right next to it):
--
--   1. create_guild_event_entry_locked() now refuses a new entry once now() > end_date, even if
--      status/approval_status haven't caught up yet — this is the actual point of enforcement;
--      nothing below can be paid around.
--
--   2. close_ended_guild_events() — a new service-role-only function, scheduled hourly via
--      pg_cron (same cron-guard shape as reconcile_referral_grants/reconcile_naira_achievements:
--      auth.role() = 'service_role', or the local postgres/supabase_admin session pg_cron itself
--      runs as). For every host='guild' event still status='open'/approval_status='active' whose
--      end_date has passed, it does exactly what complete_guild_event() already does by hand —
--      status = 'closed', approval_status = 'completed', completed_at = now() — so an event's
--      visible state stops silently lying about whether it's still running, and the existing
--      "mark it completed, then submit/approve results" flow (submit_guild_event_results,
--      settle_guild_event) picks it up completely unchanged; this only makes the transition into
--      that flow automatic instead of relying on the organizer to remember to click "Complete".
--
-- complete_guild_event() itself is untouched — an organizer can still close early, before
-- end_date, exactly as before. This migration only adds the automatic path for the case nothing
-- currently covered: nobody closing it at all.
--
-- Not run against a live database from this session. Verify after applying:
--   * paystack-init-event-entry -> create_guild_event_entry_locked for an event whose end_date
--     has passed now fails with "This event's entry period has ended." even if its status/
--     approval_status still read 'open'/'active'.
--   * An entry attempt before end_date, or for an event with no end_date at all (host='inkroot'),
--     is unaffected.
--   * `select close_ended_guild_events();` run as a normal signed-in user is refused ("Not
--     authorized."); run via the scheduled cron job (or as postgres/supabase_admin), it flips
--     every active, end_date-passed, host='guild' event to closed/completed and leaves every
--     other event (not yet ended, host='inkroot', already closed/cancelled/settled) untouched.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. create_guild_event_entry_locked — adds the end_date check. Every other check (service-role
-- only, advisory lock, status/approval_status, duplicate-entry handling, participant_limit) is
-- unchanged, byte-for-byte, from the current final definition.
-- ----------------------------------------------------------------------------------------------

create or replace function create_guild_event_entry_locked(
  p_user_id uuid, p_event_id uuid, p_paystack_reference text, p_amount_kobo bigint, p_net_kobo bigint
)
returns guild_event_entries
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_entries%rowtype;
  v_row guild_event_entries;
  v_count integer;
  v_had_existing boolean;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;

  -- Same lock key settle_guild_event() uses for this event — an entry can't be created mid-
  -- settlement, and two simultaneous entry attempts for the same event now fully serialize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'This event has no entry fee to pay.';
  end if;
  if v_event.status <> 'open' or v_event.approval_status <> 'active' then
    raise exception 'This event is no longer taking entries.';
  end if;
  -- Migration 129: a hard stop independent of status/approval_status, which only get flipped by
  -- complete_guild_event() (manual) or close_ended_guild_events() (hourly cron) — neither of
  -- which is instantaneous with the clock ticking past end_date.
  if v_event.end_date is not null and now() > v_event.end_date then
    raise exception 'This event''s entry period has ended.';
  end if;

  select * into v_existing from guild_event_entries
  where event_id = p_event_id and entrant_id = p_user_id;
  -- FOUND is reset by every later SELECT INTO (the participant-limit count below), so it is
  -- captured here instead of being re-read further down.
  v_had_existing := found;

  if v_had_existing and v_existing.status not in ('pending', 'failed') then
    raise exception 'You''ve already entered this event.';
  end if;

  -- Their own unfinished checkout: same slot, new reference. No limit check — they already hold it.
  if v_had_existing and v_existing.status = 'pending' then
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, created_at = now()
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  if v_had_existing then
    -- A previously failed attempt: re-open it rather than violating unique (event_id, entrant_id).
    update guild_event_entries
      set paystack_reference = p_paystack_reference, amount_kobo = p_amount_kobo,
          net_kobo = p_net_kobo, status = 'pending', created_at = now(), paid_at = null
      where id = v_existing.id
      returning * into v_row;
    return v_row;
  end if;

  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status)
  values (p_event_id, p_user_id, p_paystack_reference, p_amount_kobo, p_net_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_guild_event_entry_locked(uuid, uuid, text, bigint, bigint) from public;

-- ----------------------------------------------------------------------------------------------
-- 2. close_ended_guild_events — the housekeeping sweep. Same target state as complete_guild_event
-- (status = 'closed', approval_status = 'completed'), just system-triggered instead of owner-
-- triggered, so submit_guild_event_results/settle_guild_event's existing 'completed'/'active'
-- gates need no changes at all to pick these up.
-- ----------------------------------------------------------------------------------------------

create or replace function close_ended_guild_events()
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
begin
  -- Same cron-only guard reconcile_referral_grants/reconcile_naira_achievements use: a pg_cron
  -- job has no JWT (auth.role() is NULL), so a direct postgres/supabase_admin session is
  -- accepted too. A signed-in client or the anon key still can't call this.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  with closed as (
    update guild_events
    set status = 'closed', approval_status = 'completed', completed_at = now()
    where host = 'guild'
      and status = 'open'
      and approval_status = 'active'
      and end_date is not null
      and end_date < now()
    returning 1
  )
  select count(*) into v_count from closed;
  return v_count;
end;
$$;

revoke all on function close_ended_guild_events() from public, anon, authenticated;

-- Requires pg_cron (already enabled by schema.sql's account-deletion purge schedule). Hourly —
-- fine-grained enough that an event's entries close within an hour of its stated end_date without
-- needing a bespoke per-event scheduler.
select cron.schedule('close-ended-guild-events', '0 * * * *', $$select close_ended_guild_events();$$);

-- Safe to run anytime: the entry-locked check is strictly additive (an entry that was already
-- going to be refused by status/approval_status is unaffected; only an entry attempt in the
-- window where those flags haven't caught up to a passed end_date yet is newly refused), and the
-- sweep only ever touches a host='guild' event that is still 'open'/'active' with a passed
-- end_date — never a cancelled, settled, or already-completed one.
