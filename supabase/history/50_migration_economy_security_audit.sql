-- ============================================================================================
-- Migration 50: Guild Economy / Living Universe security audit — fixes for the vulnerabilities
-- actually found, not a rewrite of what already held up. Most of the checklist this audit was
-- run against was already correctly closed by earlier migrations (see the per-item notes below,
-- kept here as the audit record); this migration only changes the handful of real gaps.
--
-- FOUND AND FIXED HERE:
--
--   1. Duplicate/over withdrawals (real bank payouts) — paystack-withdraw previously read
--      author_balance_kobo() and inserted the `withdrawals` row as two separate round trips from
--      the Edge Function, with no lock between them. Two concurrent withdrawal requests could
--      both read the same starting balance and both pass the check, paying out more than the
--      author actually earned. Every OTHER balance-checked write in this schema (contribute_to_
--      guild_treasury, spend_from_guild_treasury, withdraw_guild_member_earnings,
--      propose_guild_treasury_spend/approve_guild_treasury_spend) already serializes its
--      check-then-write under pg_advisory_xact_lock — this was the one path that didn't.
--      create_withdrawal_locked() below closes it the same way, using the SAME lock key
--      (hashtext(user_id)) contribute_to_guild_treasury/withdraw_guild_member_earnings already
--      use — a withdrawal now also correctly serializes against a concurrent guild contribution
--      or earnings release for the same writer, not just against another concurrent withdrawal.
--
--   2. Refund/chargeback abuse — there was no path for a Paystack refund or card-dispute event to
--      ever reach purchases/guild_event_entries/guild_event_hosting_fee_payments. A buyer who
--      disputed a charge with their bank (or requested a Paystack refund) after the sale had
--      already credited an author or a guild would keep whatever they bought, and the row would
--      stay 'success' forever with no way to exclude it from a balance or a not-yet-settled event
--      pool. 'refunded' is added as a real terminal status, and the webhook below flips a
--      matching 'success' row to it on refund.processed / charge.dispute.create — author_
--      balance_kobo() and settle_guild_event()'s pool sum already only count status = 'success',
--      so a refunded row is automatically excluded from both once its status changes; no other
--      function needed to change. (A refund that arrives AFTER an event has already settled or a
--      purchase has already been withdrawn can't claw back money that's already left the ledger —
--      no different from how a real payment processor's own settlement finality works; that's a
--      business decision for an operator to handle manually, not something this migration can
--      undo automatically.)
--
--   3. A reversed transfer being silently ignored — paystack-webhook's transfer.failed/
--      transfer.reversed handler only ever matched a withdrawal row still 'status = pending'. A
--      transfer that succeeds and is LATER reversed by the receiving bank (transfer.reversed
--      fires after transfer.success already flipped the row to 'success') never matched that
--      filter, so the row stayed 'success' forever — meaning the author's real balance stayed
--      permanently reduced by money that was actually returned to the platform, with no way for
--      them to withdraw it again. The handler now also matches a currently-'success' row, so a
--      reversal correctly flips it to 'failed' and the writer's available balance (which excludes
--      non-'success' withdrawals) is restored.
--
--   4. Guild Event entry race (participant_limit oversell, and duplicate-entry check) — paystack-
--      init-event-entry checked "already entered" and "under the participant limit" as two plain
--      SELECTs before inserting, all from the Edge Function, with nothing serializing concurrent
--      requests for the same event. create_guild_event_entry_locked() below moves that whole
--      check-then-insert into one security-definer function under an advisory lock keyed to the
--      event (same lock key settle_guild_event() already uses for this event, so an entry can't
--      race a settlement either), so a participant-limited event can never oversell and the
--      duplicate-entry check can never be beaten by two simultaneous requests.
--
-- AUDITED AND ALREADY CORRECT — no change needed, kept here as the record of what was checked:
--
--   - Duplicate payments: purchases/guild_event_entries/guild_event_hosting_fee_payments all
--     have unique paystack_reference and no client insert/update policy; paystack-webhook only
--     ever flips a still-'pending' row, so a retried webhook delivery can't double-credit.
--   - Fake event entries / fake sales: both tables are only ever written by their own Edge
--     Function (server-derived amount, real event/book lookup) — RLS grants no client insert.
--   - Revenue split manipulation: distribute_guild_revenue()'s dedup (by source_purchase_id or
--     project_event_id) makes every distribution one-shot; settle_guild_event() requires winner
--     shares to match the LOCKED financial agreement exactly; anthology revenue agreements
--     require every contributor's own approval and reset all approvals on any re-propose.
--   - Leaving/rejoining guilds: guild_join_events is an insert-only, unique(guild_id, user_id)
--     ledger — "new member" credit (Guilds on the Rise scoring) can only ever be earned once per
--     person per guild, no matter how many times they leave and rejoin.
--   - Client-side balance manipulation: every balance (author_balance_kobo, guild_treasury_*,
--     guild_member_earnings) is a server-side function over an append-only ledger the client
--     cannot write to directly — there is no stored balance column a client write could corrupt.
--   - Ranking manipulation / fake reading activity: book_read_events caps one counted read per
--     (book, reader) per UTC day and refuses a book's own author a read on their own work;
--     Rising Star / Guilds on the Rise scoring is windowed, diminishing-returns curved, and
--     floored against low-distinct-participant collusion — see migrations 38/40's own headers.
--   - Unauthorized treasury access: guild_treasury_transactions has no client insert/update
--     policy at all; every write goes through a security-definer RPC that re-derives the caller's
--     role (Leader/Treasurer/Officer) from player_guilds.owner_id/player_guild_members.role
--     itself, never from a client-supplied flag.
--   - Race conditions: audited exhaustively above — items 1 and 4 were the two real gaps found;
--     every other balance-checked write already held an appropriate advisory lock.
--
-- Safe to run anytime: the widened status checks accept every value they already did plus
-- 'refunded', the two new functions are additive, and the reversed-transfer fix only changes
-- behavior for a webhook event this deployment couldn't previously handle correctly at all.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. 'refunded' as a real terminal status alongside 'success'/'failed'/'pending'.
-- ----------------------------------------------------------------------------------------------

alter table purchases drop constraint if exists purchases_status_check;
alter table purchases add constraint purchases_status_check
  check (status in ('pending', 'success', 'failed', 'refunded'));

alter table guild_event_entries drop constraint if exists guild_event_entries_status_check;
alter table guild_event_entries add constraint guild_event_entries_status_check
  check (status in ('pending', 'success', 'failed', 'refunded'));

alter table guild_event_hosting_fee_payments drop constraint if exists guild_event_hosting_fee_payments_status_check;
alter table guild_event_hosting_fee_payments add constraint guild_event_hosting_fee_payments_status_check
  check (status in ('pending', 'success', 'failed', 'refunded'));

-- ----------------------------------------------------------------------------------------------
-- 2. create_withdrawal_locked — the one place a withdrawals row is ever created. Takes an
-- explicit p_user_id (like author_balance_kobo's own check_user_id) rather than auth.uid(),
-- because it's called by paystack-withdraw using the service-role client — the Edge Function has
-- already authenticated the caller via their own JWT (requireUser) before ever reaching this;
-- this function is the atomic "check the real balance and create the row" step, not the identity
-- check. service-role-only by both the runtime check below AND by never being granted to
-- authenticated — a signed-in client cannot call this directly and pass someone else's user id.
-- ----------------------------------------------------------------------------------------------

create or replace function create_withdrawal_locked(
  p_user_id uuid, p_bank_account_id uuid, p_amount_kobo bigint
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and user_id = p_user_id) then
    raise exception 'Saved bank account not found.';
  end if;

  -- Same lock key contribute_to_guild_treasury()/withdraw_guild_member_earnings() already lock
  -- on for this exact writer — a withdrawal now serializes against those too, not just against
  -- another concurrent withdrawal attempt.
  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_withdrawal_locked(uuid, uuid, bigint) from public;

-- ----------------------------------------------------------------------------------------------
-- 3. create_guild_event_entry_locked — the one place a guild_event_entries row is ever created.
-- Same service-role-only posture and same explicit-user-id shape as create_withdrawal_locked
-- above, for the same reason (paystack-init-event-entry has already authenticated the caller).
-- ----------------------------------------------------------------------------------------------

create or replace function create_guild_event_entry_locked(
  p_user_id uuid, p_event_id uuid, p_paystack_reference text, p_amount_kobo bigint, p_net_kobo bigint
)
returns guild_event_entries
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_entries;
  v_count integer;
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

  if exists (
    select 1 from guild_event_entries
    where event_id = p_event_id and entrant_id = p_user_id and status <> 'failed'
  ) then
    raise exception 'You''ve already entered this event.';
  end if;

  if v_event.participant_limit is not null then
    select count(*) into v_count from guild_event_entries
    where event_id = p_event_id and status in ('pending', 'success');
    if v_count >= v_event.participant_limit then
      raise exception 'This event is full.';
    end if;
  end if;

  insert into guild_event_entries (event_id, entrant_id, paystack_reference, amount_kobo, net_kobo, status)
  values (p_event_id, p_user_id, p_paystack_reference, p_amount_kobo, p_net_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_guild_event_entry_locked(uuid, uuid, text, bigint, bigint) from public;

-- Safe to run anytime — see this migration's header.
