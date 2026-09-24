-- ============================================================================================
-- Migration 132 — wires refund_guild_event_escrow_contributors() (migration 131) into the two
-- functions that release an escrowed prize on cancellation. This is the integration migration
-- 131's own header said should be its own small, easy-to-review change, diffed against each
-- function's exact current body — so it changes nothing else about either function: same
-- authorization checks, same advisory locks (including the migration-120 settlement-lock-key
-- addition), same Inkroot-reserve branch, same admin-audit-log call. The only change in each is
-- the escrow-release block growing one `if funding_mode = ... else ...` branch.
--
-- funding_mode = 'treasury' (every event that exists before this migration, and the default for
-- every new one) takes the exact branch both functions already had — byte-for-byte unchanged.
-- funding_mode = 'contributors' now calls refund_guild_event_escrow_contributors() instead of
-- writing a single lump credit back to the guild treasury, so each contributor gets back exactly
-- their own amount_kobo (see migration 131 section 6 for why that needs no rounding at all).
--
-- Safe to run anytime: funding_mode is 'treasury' for every row that predates migration 131, so
-- the new branch is provably unreachable for any event that exists today.
-- ============================================================================================

create or replace function cancel_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_escrow guild_treasury_transactions%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can cancel this event.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'A settled event cannot be cancelled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has already been cancelled.';
  end if;
  if exists (
    select 1 from guild_event_entries
    where event_id = p_event_id
      and (status = 'success' or (status = 'pending' and created_at > now() - interval '30 minutes'))
  ) then
    raise exception 'This event already has a paid (or still-processing) entrant — it can no longer be cancelled.';
  end if;

  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
    if v_event.funding_mode = 'contributors' then
      perform refund_guild_event_escrow_contributors(p_event_id);
    else
      select * into v_escrow from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success';
      if found then
        insert into guild_treasury_transactions
          (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
           escrow_event_id, status, title, created_by)
        values
          (p_guild_id, 'guild', null, 'credit', 'event_prize_escrow_release', v_escrow.amount_kobo, 'NGN',
           'event_prize_escrow_held', 'guild_treasury', p_event_id, 'success',
           'Guaranteed prize escrow released (event cancelled) — ' || v_event.title, auth.uid());
      end if;
    end if;
  end if;

  -- Migration 113: an Inkroot-hosted event's reserved prize goes back to the available reserve.
  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid()
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function admin_cancel_guild_event_dispute(p_event_id uuid, p_reason text)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_escrow guild_treasury_transactions%rowtype;
  v_prev_status text;
  v_amount bigint;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can force-cancel a guild event.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Give a reason for the record.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'A settled event cannot be cancelled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'This event has already been cancelled.';
  end if;

  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
    if v_event.funding_mode = 'contributors' then
      -- No single v_escrow.amount_kobo to log here — refunds fan out across contributors, so
      -- the admin-audit amount below is the sum of what actually got refunded, read back from
      -- the ledger, not a single row's amount.
      perform refund_guild_event_escrow_contributors(p_event_id);
      select coalesce(sum(amount_kobo), 0) into v_amount from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow_contributor_refund' and status = 'success';
    else
      select * into v_escrow from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success';
      if found then
        insert into guild_treasury_transactions
          (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
           escrow_event_id, status, title, created_by)
        values
          (v_event.guild_id, 'guild', null, 'credit', 'event_prize_escrow_release', v_escrow.amount_kobo, 'NGN',
           'event_prize_escrow_held', 'guild_treasury', p_event_id, 'success',
           'Guaranteed prize escrow released (dispute cancellation) — ' || v_event.title, auth.uid());
      end if;
      v_amount := v_escrow.amount_kobo;
    end if;
  end if;

  -- Migration 113: an Inkroot-hosted event's reserved prize goes back to the available reserve.
  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  -- Migration 114: the money this cancellation gave back — the released guild escrow, the
  -- summed contributor refunds, or the Inkroot prize reserve row platform_reserve_release_event()
  -- just wrote (read back, so an event created before migration 113 with no reservation
  -- correctly logs no amount).
  v_prev_status := v_event.status;
  if v_event.host = 'inkroot' then
    select amount_kobo into v_amount from platform_reserve_kobo
    where event_id = p_event_id and kind = 'event_prize_released';
  end if;

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid(), cancellation_reason = trim(p_reason)
  where id = p_event_id
  returning * into v_event;

  perform record_admin_action('force_cancel_guild_event', 'guild_events', p_event_id,
    jsonb_build_object('status', v_prev_status),
    jsonb_build_object('status', v_event.status, 'cancelled_by', v_event.cancelled_by),
    v_amount, v_event.cancellation_reason);
  return v_event;
end;
$$;

revoke all on function cancel_guild_event(uuid, uuid) from public;
revoke all on function admin_cancel_guild_event_dispute(uuid, text) from public;
grant execute on function cancel_guild_event(uuid, uuid) to authenticated;
grant execute on function admin_cancel_guild_event_dispute(uuid, text) to authenticated;

-- Now that cancel_guild_event()/admin_cancel_guild_event_dispute() are the real (and only
-- intended) callers, refund_guild_event_escrow_contributors() can stay un-granted to
-- `authenticated` — see migration 131 section 6's own note. No change needed here; this comment
-- is just confirming the wiring is complete and intentional.

-- ----------------------------------------------------------------------------------------------
-- Verification — run after applying:
--   * Create a 'contributors'-mode event, have two members each contribute (e.g. ₦30,000 and
--     ₦5,000 kobo-equivalent), cancel it before any entrant pays, and confirm:
--       select member_id, amount_kobo from guild_treasury_transactions
--       where escrow_event_id = '<event id>' and kind = 'event_prize_escrow_contributor_refund';
--     returns exactly two rows, each equal to that contributor's own original amount_kobo.
--   * Re-run cancel_guild_event() (or rather, confirm it now raises 'This event has already
--     been cancelled.' — cancellation is one-shot) so refund idempotency itself is only ever
--     exercised via a retried admin_cancel_guild_event_dispute() on a not-yet-cancelled event;
--     confirm a second call to refund_guild_event_escrow_contributors(p_event_id) directly
--     (as an admin/service role) inserts zero additional rows.
-- ============================================================================================
