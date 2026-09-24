-- ============================================================================================
-- Migration 120 — Guild Event settlement hardening (final production audit, Critical + Medium).
--
-- Three confirmed issues, all in the guild-event escrow path added since the last audit:
--
-- A. CRITICAL — settle_guild_event() was directly callable by any authenticated user holding
--    guild treasury authority (Leader/Treasurer/Officer), with no requirement to go through
--    submit_guild_event_results()/approve_guild_event_results()'s own separation-of-duties check
--    (49_migration_guild_event_results_approval.sql: the organizer who submits a result can
--    never also approve it). The app's own UI exposes this directly — the "Declare winners…"
--    control in guild-events-panel.jsx calls settle_guild_event() with no second party involved
--    at all. A single officer could escrow a guaranteed prize and settle it to themselves.
--    settle_guild_event() also had no state-machine gate beyond "not settled/cancelled", so this
--    could happen while the event was still 'draft'/'pending_approval'/'approved'/'published' —
--    before Inkroot ever reviewed it and before it ever opened for entries.
--
--    Fix: (1) settle_guild_event()'s host='guild' branch now requires approval_status in
--    ('active', 'completed') — the same two states the settlement UI already assumed. (2) Its
--    direct `authenticated` grant is revoked, the same treatment distribute_guild_revenue()
--    (another internal-only settlement primitive) already has — settlement for a host='guild'
--    event is now only reachable through approve_guild_event_results(), which is itself
--    security definer and calls settle_guild_event() as the function owner, unaffected by the
--    revoke, exactly like it already calls distribute_guild_revenue() today. A host='inkroot'
--    settlement was never reachable this way to begin with (settle_guild_event() has always
--    required auth.uid() is null on that branch — a genuine service-role/SQL-editor call), so
--    that path, and this migration's frontend change (guild-events-panel.jsx now only renders
--    the direct "Declare winners…" control for host='inkroot'), leave it unchanged.
--
-- B. HIGH — settle_guild_event() serialized on advisory lock key 'guild_event_settlement:<id>',
--    while cancel_guild_event() and admin_cancel_guild_event_dispute() serialized on the
--    different key 'guild_event_entry:<id>'. Because these never shared a lock, a settlement and
--    a cancellation for the same event could run concurrently: each could pass its own "not
--    already settled/cancelled" check before the other committed — one crediting winners the
--    escrowed prize via distribute_guild_revenue(), the other independently crediting that same
--    escrowed amount back to the guild treasury via 'event_prize_escrow_release'. Net effect:
--    the escrow's kobo paid out twice, minting money with no source of funds behind the second
--    credit.
--
--    Fix: settle_guild_event(), cancel_guild_event(), and admin_cancel_guild_event_dispute() now
--    all take BOTH advisory lock keys, in the same fixed order (entry key first, settlement key
--    second) — so a settlement and a cancellation for the same event can never interleave, and
--    the consistent ordering means none of the three can deadlock against each other.
--
-- C. MEDIUM — deposit_guild_event_prize_escrow() debits the guild treasury exactly like
--    spend_from_guild_treasury() does (same balance check, same guild-scoped advisory lock), but
--    was never covered by migration 112's per-guild velocity limit, which exists specifically to
--    stop a single authorized role (e.g. a compromised session) from repeatedly draining a
--    treasury. It only checked the ₦5,000,000 per-event ceiling (migration 116) — nothing
--    limited how many events could be escrowed in a day.
--
--    Fix: check_and_bump_guild_rate_limit() gains a new action, 'deposit_guild_event_prize_
--    escrow' (3 calls per guild per 24 hours — deliberately lower than spend_from_guild_
--    treasury()'s 5, since each call can move up to ₦5,000,000 rather than the ₦300,000/day
--    direct-spend cap), and deposit_guild_event_prize_escrow() now calls it, bumped only after
--    every authorization/state check has already passed so a doomed call never burns quota.
--
-- Safe to run anytime: every change either tightens an existing check (state gate, lock
-- ordering) or adds a new one (the rate limit) — no existing, legitimate call path is affected.
-- Verify after applying:
--   * A guild officer calling `select settle_guild_event(...)` directly from an authenticated
--     session for a host='guild' event now fails with a permission-denied error; calling
--     approve_guild_event_results() for a pending, correctly-submitted result still settles the
--     event exactly as before.
--   * `select settle_guild_event(<guild>, <event>, ...)` for a 'draft' or 'pending_approval'
--     host='guild' event fails with "This event must be active or completed before it can be
--     settled."; an 'active' or 'completed' event is unaffected.
--   * Two concurrent sessions, one calling cancel_guild_event() and one calling
--     approve_guild_event_results() for the same escrowed event, no longer both succeed — the
--     second call now blocks until the first's transaction commits, then correctly fails with
--     "already been cancelled"/"already been settled".
--   * A guild can escrow at most 3 guaranteed prizes per rolling 24 hours; a 4th call fails with
--     the rate limit's own message.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. check_and_bump_guild_rate_limit — add the new action.
-- ----------------------------------------------------------------------------------------------

create or replace function check_and_bump_guild_rate_limit(p_guild_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_calls integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
begin
  -- Server-side limits. To change one, edit it here — never accept it from a caller.
  case p_action
    when 'spend_from_guild_treasury' then v_max_calls := 5; v_window_seconds := 86400;
    -- Migration 120: deposit_guild_event_prize_escrow debits the guild treasury exactly like a
    -- spend (just tagged/destined differently — see 108_migration_guild_event_prize_escrow.sql's
    -- own header), but was never covered by this limiter. A single authorized role could
    -- otherwise call it repeatedly (one new draft event per call, each escrowing up to
    -- guild_event_escrow_max_kobo) and drain the treasury just as fast as the unlimited
    -- spend_from_guild_treasury() this table was built to stop. Same 24-hour window, a
    -- deliberately smaller call count since each call can move a much larger amount than an
    -- ordinary direct spend.
    when 'deposit_guild_event_prize_escrow' then v_max_calls := 3; v_window_seconds := 86400;
    else
      raise exception 'Unknown rate limit action.';
  end case;

  perform pg_advisory_xact_lock(hashtext('guild_rate_limit:' || p_guild_id::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from guild_rate_limits where guild_id = p_guild_id and action = p_action;

  if v_window_start is null or now() - v_window_start > make_interval(secs => v_window_seconds) then
    insert into guild_rate_limits (guild_id, action, window_start, call_count)
    values (p_guild_id, p_action, now(), 1)
    on conflict (guild_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= v_max_calls then
    raise exception 'This guild has reached its limit of % treasury spend requests in 24 hours. Try again later.', v_max_calls;
  end if;

  update guild_rate_limits set call_count = call_count + 1
  where guild_id = p_guild_id and action = p_action;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 2. deposit_guild_event_prize_escrow — add the velocity-limit call. Every other check
-- (authorization, one-escrow-per-event, the ₦5,000,000 ceiling, the guild-scoped advisory lock,
-- the available-balance recheck) is unchanged from migration 116.
-- ----------------------------------------------------------------------------------------------

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

  -- Same lock key spend_from_guild_treasury already uses for this guild, so escrowing a prize
  -- correctly serializes against a concurrent ordinary treasury spend (or another escrow
  -- deposit) rather than racing it.
  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

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

-- ----------------------------------------------------------------------------------------------
-- 3. cancel_guild_event — take the settlement lock too, same order (entry key first) everywhere.
-- Every other check is unchanged from migration 108.
-- ----------------------------------------------------------------------------------------------

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
  -- Migration 120: also take settle_guild_event()'s own lock key, in the same
  -- entry-then-settlement order every one of these event-lifecycle functions now uses (see
  -- that migration's header). Without this, a concurrent cancel_guild_event() and
  -- settle_guild_event() for the same event serialized on different keys and could each pass
  -- their own "not already settled/cancelled" check before the other committed — settling
  -- paid the escrowed prize to declared winners while cancelling separately credited that
  -- same escrow back to the guild treasury, minting money. Taking both locks here closes
  -- that race.
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

revoke all on function cancel_guild_event(uuid, uuid) from public;
grant execute on function cancel_guild_event(uuid, uuid) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 4. admin_cancel_guild_event_dispute — same lock addition. Every other check (and the audit
-- logging migration 114 added) is unchanged.
-- ----------------------------------------------------------------------------------------------

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
  -- Migration 120: also take settle_guild_event()'s own lock key — same reasoning as
  -- cancel_guild_event()'s own copy of this comment (this is the other of the two functions
  -- that can release an escrowed prize back to the guild treasury, so it needs the same
  -- protection against racing a concurrent settlement).
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
  end if;

  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  v_prev_status := v_event.status;
  v_amount := v_escrow.amount_kobo;
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

revoke all on function admin_cancel_guild_event_dispute(uuid, text) from public;
grant execute on function admin_cancel_guild_event_dispute(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 5. settle_guild_event — the core fix. Adds the entry-key lock (same order as above), the
-- approval_status gate, and — after this definition — revokes the direct `authenticated` grant.
-- Every other check (locked-agreement exact match, member-only winners, one-settlement-ever,
-- the escrowed-vs-live-entry-fee gross calculation, the entry-fee revenue credit, the platform
-- reserve settlement record) is byte-for-byte unchanged from the version already in schema.sql.
-- ----------------------------------------------------------------------------------------------

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_gross bigint;
  v_entry_fees bigint;
  v_bad_contributor uuid;
  v_agreement guild_event_financial_agreements%rowtype;
  v_shares_sum integer;
  v_escrowed boolean;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if v_event.host = 'guild' then
    if not is_guild_treasury_authorized(p_guild_id) then
      raise exception 'Only the guild leader, a treasurer, or an officer can settle this event.';
    end if;
  else -- 'inkroot'
    if auth.uid() is not null then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  -- Migration 120: take the SAME lock key create_guild_event_entry_locked/
  -- cancel_guild_event/admin_cancel_guild_event_dispute use, in the same entry-then-
  -- settlement order those functions now all use, before this function's own settlement
  -- lock — see this migration's header. Closes the race where a concurrent cancellation
  -- and settlement could each pass their own "not already settled/cancelled" check on
  -- different, uncoordinated lock keys and both commit, double-releasing an escrowed prize.
  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
  end if;
  -- Migration 120: a host='guild' event previously had no state-machine gate here at all
  -- beyond "not settled/cancelled" — it could be settled (and an escrowed guaranteed
  -- prize paid out) while still 'draft'/'pending_approval'/'approved'/'published', i.e.
  -- before Inkroot ever reviewed it, before it ever opened for entries, and before it ran
  -- at all. Requiring 'active' or 'completed' (the same two states the app's own settlement
  -- UI already assumes — see guild-events-panel.jsx) closes that: a guaranteed prize can
  -- only be escrowed and then settled once the event has actually gone live.
  if v_event.host = 'guild' and v_event.approval_status not in ('active', 'completed') then
    raise exception 'This event must be active or completed before it can be settled.';
  end if;

  select (s->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_shares) s
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;

  if v_event.host = 'guild' then
    select coalesce(sum(net_kobo), 0) into v_entry_fees
    from guild_event_entries where event_id = p_event_id and status = 'success';

    if v_escrowed then
      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> 10000 then
        raise exception 'A guaranteed prize is paid to winners in full — declared shares must add up to exactly 100%%.';
      end if;
      v_gross := v_event.guaranteed_prize_kobo;
    else
      select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
      if not found or not v_agreement.locked then
        raise exception 'This event has no locked financial agreement — it cannot be settled.';
      end if;

      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> v_agreement.prize_pool_bps then
        raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
      end if;

      v_gross := v_entry_fees;
    end if;
  else
    v_gross := v_event.cash_prize_kobo;
  end if;

  perform distribute_guild_revenue(
    p_guild_id := p_guild_id,
    p_gross_amount_kobo := v_gross,
    p_shares := p_shares,
    p_kind := 'event_revenue',
    p_source := 'event_sale',
    p_source_purchase_id := null,
    p_anthology_id := null,
    p_project_event_id := p_event_id,
    p_title := 'Guild event — ' || v_event.title
  );

  if v_event.host = 'guild' and v_escrowed and v_entry_fees > 0 then
    insert into guild_treasury_transactions
      (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
       project_event_id, status, title)
    values
      (p_guild_id, 'guild', null, 'credit', 'event_entry_revenue', v_entry_fees, 'NGN',
       'event_sale', 'guild_treasury', p_event_id, 'success',
       'Guild event entry fees — ' || v_event.title);
  end if;

  if v_event.host = 'inkroot' then
    perform platform_reserve_record_settlement(p_event_id);
  end if;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

-- settle_guild_event() is the one function that actually releases a guild event's prize money —
-- every prior migration in this file granted it directly to `authenticated`, which let ANY
-- single guild Leader/Treasurer/Officer call it themselves (the "Declare winners…" control in
-- guild-events-panel.jsx does exactly this) with themselves named as a 100%-share winner,
-- completely bypassing submit_guild_event_results()/approve_guild_event_results()'s own
-- separation-of-duties check. Revoking the direct grant here, plus the approval_status gate
-- just added above, means a host='guild' event can only ever be settled through
-- approve_guild_event_results() — itself security definer, so it can still call
-- settle_guild_event() as the function owner, exactly like it already calls
-- distribute_guild_revenue() (never granted to authenticated either) today.
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public, anon, authenticated;

-- Not run against a live database from this session — apply and verify per this migration's
-- header before relying on it.
