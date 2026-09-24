-- ============================================================================================
-- Migration 138 — deposit_guild_event_prize_escrow() only ever took the guild-level advisory
-- lock (hashtext(p_guild_id::text)), never the per-event entry/settlement locks migration 120
-- introduced and that every other function touching an event's guaranteed-prize escrow row
-- (cancel_guild_event, admin_cancel_guild_event_dispute, settle_guild_event) already takes
-- before doing anything else.
--
-- The gap: a deposit and a cancel_guild_event for the SAME event, racing each other, could
-- interleave so that cancel_guild_event's select for a 'success' event_prize_escrow row (done
-- under its own entry+settlement locks) finds nothing — because the concurrent deposit hasn't
-- committed its insert yet — while the deposit's own approval_status check still sees the
-- pre-cancellation status and proceeds anyway. Both transactions then commit: the guild
-- treasury is debited into escrow for an event that is now cancelled, with no release ever
-- recorded for it. Narrow window, but exactly the class of bug migration 120 exists to close,
-- and the one escrow-lifecycle function that didn't follow that convention.
--
-- Fix: take the same two locks, in the same order (entry, then settlement) every other
-- escrow-lifecycle function uses, before the existing guild-level lock. Lock-ordering check: no
-- other function ever holds the guild-level lock while trying to acquire the entry/settlement
-- locks (spend_from_guild_treasury and pay_guild_event_escrow_contributors only ever take the
-- guild-level lock; cancel_guild_event/admin_cancel_guild_event_dispute/settle_guild_event only
-- ever take entry+settlement, never the guild-level lock), so adding entry+settlement ahead of
-- the guild-level lock here introduces no new lock-ordering cycle.
--
-- Safe to run anytime: same signature, same grants, same behavior for every call that wasn't
-- already racing another one.
-- ============================================================================================

create or replace function deposit_guild_event_prize_escrow(p_guild_id uuid, p_event_id uuid)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_treasury_transactions;
begin
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
  end if;

  -- Migration 138: same entry-then-settlement lock order cancel_guild_event/
  -- admin_cancel_guild_event_dispute/settle_guild_event already take, so a concurrent
  -- cancellation and a concurrent deposit for the same event now fully serialize instead of
  -- racing each other.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.guaranteed_prize_kobo is null or v_event.guaranteed_prize_kobo <= 0 then
    raise exception 'This event has no guaranteed prize declared to escrow.';
  end if;
  if v_event.approval_status not in ('draft', 'pending_approval', 'approved', 'published') then
    raise exception 'The guaranteed prize can only be escrowed before the event is activated.';
  end if;
  -- Migration 130: cheap pre-lock fast path for the common case — no longer the only check.
  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
  ) then
    raise exception 'This event''s guaranteed prize has already been escrowed.';
  end if;
  if v_event.guaranteed_prize_kobo > guild_event_escrow_max_kobo() then
    raise exception 'A guaranteed prize can be at most ₦% — lower the prize to escrow it.',
      to_char(guild_event_escrow_max_kobo() / 100, 'FM999,999,999');
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  -- Migration 130: the authoritative re-check, under the lock.
  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
  ) then
    raise exception 'This event''s guaranteed prize has already been escrowed.';
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'deposit_guild_event_prize_escrow');

  if guild_treasury_available_kobo(p_guild_id) < v_event.guaranteed_prize_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     escrow_event_id, status, title, created_by)
  values
    (p_guild_id, 'guild', null, 'debit', 'event_prize_escrow', v_event.guaranteed_prize_kobo, 'NGN',
     'guild_treasury', 'event_prize_escrow_held', p_event_id, 'success',
     'Guaranteed prize escrow — ' || v_event.title, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

-- Grants carry over unchanged — same signature as before.
revoke all on function deposit_guild_event_prize_escrow(uuid, uuid) from public;
grant execute on function deposit_guild_event_prize_escrow(uuid, uuid) to authenticated;
