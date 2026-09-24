-- ============================================================================================
-- Migration 130 — closes a double-escrow race in deposit_guild_event_prize_escrow() found in
-- the event-escrow money-trace audit.
--
-- The gap: deposit_guild_event_prize_escrow() (migration 108, ceiling changed in 116) checked
-- "has this event already been escrowed" BEFORE taking pg_advisory_xact_lock(hashtext(p_guild_id)),
-- and never re-checked it after acquiring the lock. Every sibling function in this file that
-- does a check-then-lock-then-insert (spend_from_guild_treasury, propose_guild_treasury_spend)
-- re-checks its guard condition again immediately after the lock, specifically so a second
-- caller who read stale state before the lock can't slip through. This function was the one
-- place that pattern was dropped.
--
-- Concretely: two concurrent calls for the SAME event (a double-click, two treasury-authorized
-- officers, or a client retry) can both pass the "not already escrowed" check before either
-- commits, then serialize on the guild-level lock and both insert an 'event_prize_escrow' debit
-- row for the same event. Settlement itself isn't double-paid (settle_guild_event pays
-- guaranteed_prize_kobo once, from the event row, not by summing escrow rows) — but
-- cancel_guild_event's release does a bare `select ... into v_escrow` with no ORDER BY/LIMIT
-- against what can now be two matching rows, so cancellation only releases one of them. The
-- other debit is stuck forever: guild_treasury_transactions is append-only (see its own
-- immutability trigger), so it can never be corrected in place. Net effect is real guild funds
-- silently destroyed, not minted — but it's a genuine, reachable race, not a hypothetical.
--
-- Fix, two layers (belt and suspenders, same posture this schema already takes elsewhere):
--   1. Application-level: the "already escrowed" check now happens AFTER
--      pg_advisory_xact_lock(hashtext(p_guild_id::text)), immediately on acquiring it and before
--      the rate-limit bump — the exact same "re-check first, so a doomed caller doesn't burn the
--      guild's rate-limit quota" ordering spend_from_guild_treasury already uses. Nothing else in
--      the function changes: same authorization check, same ceiling, same available-balance
--      recheck, same insert.
--   2. Database-level backstop: a partial unique index on
--      guild_treasury_transactions(escrow_event_id) where kind = 'event_prize_escrow' and
--      status = 'success'. Even if a future edit reintroduces a check-before-lock ordering bug,
--      the second insert now fails outright at the database instead of silently succeeding.
--      Existing rows are unaffected — the index will refuse to build if a double-escrow has
--      already occurred on this database; see the verification note below for what to do then.
--
-- Not run against a live database from this session. Verify after applying:
--   * Before applying the index: run
--       select escrow_event_id, count(*) from guild_treasury_transactions
--       where kind = 'event_prize_escrow' and status = 'success'
--       group by escrow_event_id having count(*) > 1;
--     If this returns any rows, resolve them first (decide, per event, which escrow row is
--     authoritative and record a manual 'event_prize_escrow_release' credit for the rest — the
--     ledger is append-only, so this must be a new correcting row, never an update/delete) before
--     the create unique index statement below will succeed.
--   * Two concurrent deposit_guild_event_prize_escrow() calls for the same event: the first
--     succeeds, the second now fails with "This event's guaranteed prize has already been
--     escrowed." (previously: succeeded, on a guild treasury with enough balance to cover both).
--   * A single deposit_guild_event_prize_escrow() call still succeeds exactly as before.
--   * A direct `insert into guild_treasury_transactions` attempting a second
--     kind='event_prize_escrow'/status='success' row for the same escrow_event_id is refused by
--     the new unique index even if some future code path skipped the function entirely.
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
  -- Migration 130: the fast, pre-lock version of this check stays here as a cheap early exit for
  -- the common case (a plain double-submit or an already-escrowed event) — but it is no longer
  -- the only check. See the authoritative re-check right after the lock below.
  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
  ) then
    raise exception 'This event''s guaranteed prize has already been escrowed.';
  end if;
  -- Migration 116: was `>= guild_treasury_multi_approval_threshold_kobo()` (₦100,000), whose
  -- message pointed at a multi-approval flow that can't be linked to an event — so any larger
  -- prize simply couldn't be escrowed. Escrow now has its own ceiling (₦5,000,000); the shared
  -- multi-approval threshold that ordinary spends use is untouched.
  if v_event.guaranteed_prize_kobo > guild_event_escrow_max_kobo() then
    raise exception 'A guaranteed prize can be at most ₦% — lower the prize to escrow it.',
      to_char(guild_event_escrow_max_kobo() / 100, 'FM999,999,999');
  end if;

  -- Same lock key spend_from_guild_treasury already uses for this guild, so escrowing a prize
  -- correctly serializes against a concurrent ordinary treasury spend (or another escrow
  -- deposit) rather than racing it.
  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  -- Migration 130: re-check under the lock, same "check-before-lock is a fast path, the
  -- authoritative check happens after" shape spend_from_guild_treasury's idempotency-key lookup
  -- already uses. Without this, two concurrent callers could both pass the check above before
  -- either committed, then both insert an escrow row for the same event once serialized here.
  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
  ) then
    raise exception 'This event''s guaranteed prize has already been escrowed.';
  end if;

  -- Migration 120: velocity limit, matching spend_from_guild_treasury's own — see this
  -- function's own comment above check_and_bump_guild_rate_limit's case statement. Bumped only
  -- after every authorization/state check above has already passed, so a caller who was never
  -- going to succeed anyway (wrong role, event already escrowed, prize too large) can't burn a
  -- guild's quota with doomed calls.
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

revoke all on function deposit_guild_event_prize_escrow(uuid, uuid) from public;
grant execute on function deposit_guild_event_prize_escrow(uuid, uuid) to authenticated;

-- Database-level backstop: at most one successful escrow debit per event, full stop, regardless
-- of what any application-level check does or fails to do.
create unique index if not exists guild_treasury_transactions_one_escrow_per_event
  on guild_treasury_transactions (escrow_event_id)
  where kind = 'event_prize_escrow' and status = 'success';
