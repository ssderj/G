-- Migration 104: an abandoned or failed event-entry payment locked the entrant out for good
-- (production audit — Paystack cancelled/failed payment handling).
--
-- The bug: paystack-init-event-entry creates the guild_event_entries row as 'pending' BEFORE
-- opening Paystack checkout, and nothing ever moves a pending entry to 'failed' — there is no
-- charge.failed handling in paystack-webhook, and a cancelled popup or a failed
-- /transaction/initialize call never touches the row. So after ONE cancelled payment:
--   * create_guild_event_entry_locked() answered every retry with "You've already entered this
--     event." (it only ignored 'failed' rows, which never occur), and the table's own
--     unique (event_id, entrant_id) would have rejected a second insert anyway;
--   * the Guild Events card showed "Payment pending..." with no way to pay, forever;
--   * the dead 'pending' row kept counting toward participant_limit (here and in
--     guild_event_entry_count()), so abandoned attempts could silently fill a limited event.
--
-- The fix, in this function only:
--   * If the entrant already has a 'pending' (or 'failed') row for this event, it is REUSED:
--     it gets the new paystack_reference/amounts and a fresh created_at, instead of raising or
--     inserting a duplicate. paystack-webhook then settles it under the new reference exactly like
--     a first attempt. (paystack-init-hosting-fee already re-issues a fresh reference for a
--     pending payment the same way.) Known trade-off: if someone completes the OLD checkout after
--     retrying, that old reference no longer matches a pending row, so the webhook ignores it.
--   * A 'success' or 'refunded' entry still raises "You've already entered this event."
--   * A pending entry only counts toward participant_limit for 30 minutes (a checkout that isn't
--     finished by then is treated as abandoned), here and in guild_event_entry_count(), so the
--     "X / limit entered" display and the server check agree. Successful entries always count.
--   * The participant-limit check is skipped when re-using the entrant's OWN pending row (they
--     already hold that slot), and still applied when re-using a 'failed' one.
-- Everything else (lock key, event/host/status checks, return type) is unchanged from migration
-- 50. The matching UI change is in src/guild/guild-events-panel.jsx (a "Try payment again" button
-- next to "Payment pending...").
-- Safe to run anytime; no data changes.

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

create or replace function guild_event_entry_count(p_event_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from guild_event_entries
  where event_id = p_event_id
    and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'));
$$;

revoke all on function guild_event_entry_count(uuid) from public;
grant execute on function guild_event_entry_count(uuid) to authenticated;
