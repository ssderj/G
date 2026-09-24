-- ============================================================================================
-- Migration 134 — two gaps found in a prize-distribution review of the settle_guild_event /
-- submit_guild_event_results / approve_guild_event_results pipeline (migrations 42, 49, 108,
-- 120–122, 125): nothing stopped the same contributor from being declared as more than one
-- winner slot, and there was no way for an Inkroot admin to actually settle a host='inkroot'
-- cash-prize event through the app at all.
--
--   1. Same contributor, multiple winner slots. compute_guild_event_placements() can never
--      produce this — guild_event_submissions has unique(event_id, entrant_id), so one entrant
--      can occupy at most one row in `ranked`/`awarded`. But the legacy organizer-declared path
--      (submit_guild_event_results, kept for events created before migration 121 added judged/
--      objective events) only checked that each `place` number was used once — it never checked
--      that the same contributor_id wasn't listed under two different places. Not a way to
--      overpay (the bps total is still capped), but it lets an organizer hand one person two
--      placements' worth of "1st AND 2nd place winner" standing, which the product rules here
--      don't intend. Fixed in two places, matching this file's existing habit of checking the
--      same thing once for early/friendly rejection (submit_guild_event_results) and once more
--      as the authoritative gate in the function that actually moves money
--      (settle_guild_event) — the same belt-and-suspenders pattern the member-only-winner check
--      already uses in both functions.
--
--   2. No in-app admin settlement path for host='inkroot' events. settle_guild_event()'s own
--      body has always allowed a signed-in is_inkroot_admin() caller through its host='inkroot'
--      branch (`auth.uid() is not null and not is_inkroot_admin()` only raises for a NON-admin
--      caller) — but migration 120's `revoke all ... from public, anon, authenticated` on
--      settle_guild_event() blocks every authenticated client from calling it via
--      supabase.rpc(...) at all, admin or not; only a security-definer wrapper that calls it
--      internally (as the function owner, same as approve_guild_event_results() already does
--      for host='guild') can reach it. No such wrapper existed for host='inkroot', so despite
--      the internal check, there was in practice no way for an Inkroot admin to settle an
--      Inkroot-hosted event except a direct service-role/SQL-editor call — no audit trail, no
--      app-side validation, nothing an admin could do from the product itself.
--
--      admin_settle_inkroot_event() below is that wrapper: is_inkroot_admin()-gated, confirms
--      host = 'inkroot', calls settle_guild_event() internally exactly like
--      approve_guild_event_results() does, and logs the action via record_admin_action()
--      (migration 114) the same way every other admin money-moving function here already does.
--
-- Safe to run anytime: both redefined functions keep their exact existing signatures (grants
-- carry over unchanged), and the new function is additive.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 1a. settle_guild_event — the authoritative gate. Adds a duplicate-contributor check right
--     alongside the existing "every winner must be a member of this guild" check, same shape.
-- ------------------------------------------------------------------------------------------

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_guild player_guilds%rowtype;
  v_gross bigint;
  v_entry_fees bigint;
  v_bad_contributor uuid;
  v_dup_contributor boolean;
  v_agreement guild_event_financial_agreements%rowtype;
  v_shares_sum integer;
  v_escrowed boolean;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  select * into v_guild from player_guilds where id = p_guild_id;

  if v_event.host = 'guild' then
    if not is_guild_treasury_authorized(p_guild_id) then
      raise exception 'Only the guild leader, a treasurer, or an officer can settle this event.';
    end if;
  else -- 'inkroot'
    -- Migration 122: restores the is_inkroot_admin() app path alongside the original
    -- null-session/service-role path — see that migration's header, point 3b.
    if auth.uid() is not null and not is_inkroot_admin() then
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

  -- Migration 134: the same contributor cannot be declared more than one winner slot in a
  -- single settlement. Not a financial exploit on its own (the bps total is still capped
  -- below), but it lets one person collect multiple placements' worth of "winner" standing,
  -- which the product's declared-results model doesn't intend. This is the authoritative
  -- check — submit_guild_event_results() also rejects this earlier for a friendlier error,
  -- but every caller of settle_guild_event() (computed, organizer-submitted, or any future
  -- path) is covered here regardless.
  select exists (
    select 1 from jsonb_array_elements(p_shares) s
    group by (s->>'contributor_id')
    having count(*) > 1
  ) into v_dup_contributor;
  if v_dup_contributor then
    raise exception 'The same person cannot be declared as more than one winner slot.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;

  if v_event.host = 'guild' then
    select coalesce(sum(net_kobo), 0) into v_entry_fees
    from guild_event_entries where event_id = p_event_id and status = 'success';

    if v_escrowed then
      -- The full escrowed amount goes to the declared winners — no financial-agreement skim.
      -- Entry fees are entirely separate Event Revenue Pool income (credited below), never
      -- split with winners here.
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
    -- Migration 122: an Inkroot-hosted prize for a Founder Guild must go entirely to named
    -- winners — no leftover may become a "guild share" credit, since a Founder Guild has no
    -- treasury bucket to hold one. A Player Guild target is unaffected.
    if v_guild.is_founder_guild then
      select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
      from jsonb_array_elements(p_shares) s;
      if v_shares_sum <> 10000 then
        raise exception 'An Inkroot-hosted prize for a Founder Guild must be declared 100%% to named winners — a Founder Guild has no treasury to hold a leftover share.';
      end if;
    end if;
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

  -- Migration 113: close an Inkroot-hosted event's prize reservation as paid (no-op for an event
  -- created before the reserve existed — see the migration header).
  if v_event.host = 'inkroot' then
    perform platform_reserve_record_settlement(p_event_id);
  end if;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

-- settle_guild_event() stays revoked from every client role — migration 120's revoke already
-- covers this redefinition (grants on a function attach to its signature, not its body), but
-- restated here so this file is a complete, correct record on its own.
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------
-- 1b. submit_guild_event_results — same check, added for an early, friendly rejection before
--     a bad organizer-declared result is even written as 'pending_approval'. Everything else
--     unchanged from migration 121's redefinition.
-- ------------------------------------------------------------------------------------------

create or replace function submit_guild_event_results(p_guild_id uuid, p_event_id uuid, p_placements jsonb)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_row guild_event_results%rowtype;
  v_bad_contributor uuid;
  v_shares_sum integer;
  v_dup_place boolean;
  v_dup_contributor boolean;
begin
  if exists (select 1 from guild_event_objective_config where event_id = p_event_id) then
    raise exception 'This event uses computed placements — see compute_guild_event_placements(). Organizer-declared results are no longer accepted for it.';
  end if;

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;
  if v_event.organizer_id is null or auth.uid() <> v_event.organizer_id then
    raise exception 'Only this event''s organizer can submit its results.';
  end if;
  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before submitting results.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  if p_placements is null or jsonb_array_length(p_placements) = 0 then
    raise exception 'Add at least one winner.';
  end if;

  select (p->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_placements) p
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (p->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  select exists (
    select 1 from jsonb_array_elements(p_placements) p
    group by (p->>'place')
    having count(*) > 1
  ) into v_dup_place;
  if v_dup_place then
    raise exception 'Each place (1st, 2nd, ...) can only be used once.';
  end if;

  -- Migration 134: mirrors the authoritative check now in settle_guild_event() — see that
  -- function's own comment for why. Checked here too so an organizer gets a clear error at
  -- submission time instead of a generic failure later at approval time.
  select exists (
    select 1 from jsonb_array_elements(p_placements) p
    group by (p->>'contributor_id')
    having count(*) > 1
  ) into v_dup_contributor;
  if v_dup_contributor then
    raise exception 'The same person cannot be declared as more than one winner slot.';
  end if;

  select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
  if not found or not v_agreement.locked then
    raise exception 'This event has no locked financial agreement — it cannot be settled.';
  end if;
  select coalesce(sum((p->>'share_bps')::integer), 0) into v_shares_sum
  from jsonb_array_elements(p_placements) p;
  if v_shares_sum <> v_agreement.prize_pool_bps then
    raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (p_guild_id, p_event_id, p_placements, 'pending_approval', auth.uid(), now())
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'pending_approval',
    submitted_by = excluded.submitted_by, submitted_at = excluded.submitted_at,
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;
  return v_row;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 2. admin_settle_inkroot_event — the missing in-app path for settling a host='inkroot'
--    cash-prize event. Same shape as approve_guild_event_results(): security definer, calls
--    settle_guild_event() internally (as the function owner, not via RPC — the revoke above
--    only blocks a direct client call), and logs via record_admin_action() like every other
--    admin money-moving function in this schema.
-- ------------------------------------------------------------------------------------------

create or replace function admin_settle_inkroot_event(p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_inkroot_admin() then
    raise exception 'Only a platform admin can settle an Inkroot-hosted event.';
  end if;

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'inkroot' then
    raise exception 'This event is not Inkroot-hosted — settle it through the guild''s own results flow instead.';
  end if;

  v_event := settle_guild_event(v_event.guild_id, p_event_id, p_shares);

  perform record_admin_action('settle_inkroot_event', 'guild_events', v_event.id,
    null, to_jsonb(v_event), v_event.cash_prize_kobo, null);
  return v_event;
end;
$$;

revoke all on function admin_settle_inkroot_event(uuid, jsonb) from public, anon;
grant execute on function admin_settle_inkroot_event(uuid, jsonb) to authenticated;

-- ============================================================================================
-- Verify after applying:
--   * submit_guild_event_results() and settle_guild_event() both refuse with "The same person
--     cannot be declared as more than one winner slot." when p_placements/p_shares lists the
--     same contributor_id under two different places, and both still succeed for a normal,
--     one-slot-per-person set of winners.
--   * A signed-in, non-admin user calling admin_settle_inkroot_event() (or the still-revoked
--     settle_guild_event() directly) is refused.
--   * An is_inkroot_admin() caller can settle a host='inkroot' event via
--     admin_settle_inkroot_event(), the event ends up 'settled', winners are credited exactly
--     as settle_guild_event() always computed them, and a row lands in admin_audit_log with
--     action='settle_inkroot_event'.
--   * admin_settle_inkroot_event() refuses a host='guild' event id, an already-settled event,
--     and a shares total that isn't exactly 100% for a Founder Guild target — all via the
--     underlying settle_guild_event() checks, unchanged.
-- ============================================================================================
