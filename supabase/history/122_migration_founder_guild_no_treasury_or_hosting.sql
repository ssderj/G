-- ============================================================================================
-- Migration 122: Founder Guilds — reverse the treasury/host-their-own-events half of Founder
-- Guild Parity (69_migration_founder_guild_parity.sql). Product decision: a Founder Guild is
-- not a real organization with its own money — it should never accumulate a treasury balance
-- or run its own entry-fee events. Inkroot itself can still fund and run a cash-prize event
-- for (or across) a Founder Guild's members — that path (host='inkroot', backed by
-- platform_reserve_kobo — see 113_migration_inkroot_prize_reserve.sql) is untouched by this
-- migration and is exactly how "the app raises and spends its own money" already works.
--
-- What actually changes, and why each is scoped narrowly rather than touched at is_guild_officer/
-- is_guild_treasury_authorized (both of those also gate Anthologies, World Bible, Manuscript
-- approval, etc. for Founder Guilds — none of that was asked for and none of it is touched here):
--
--   1. contribute_to_guild_treasury / spend_from_guild_treasury / propose_guild_treasury_spend —
--      each now refuses outright for a Founder Guild, before any authorization check. A Founder
--      Guild's guild_treasury_summary will report a real, permanent 0 for guildOwnedNaira/
--      availableNaira going forward (see point 3) — there's no code path left that can ever
--      credit or debit that bucket for one.
--
--   2. create_guild_event(p_host = 'guild') — now refuses for a Founder Guild. A Founder Guild
--      can no longer host its own entry-fee competition. (host = 'inkroot' is completely
--      unaffected — that branch was never gated by is_guild_officer to begin with; it's
--      is_inkroot_admin()-only and always has been.)
--
--   3. settle_guild_event() — two changes:
--        a. host = 'inkroot', target is a Founder Guild: declared winner shares must now sum to
--           exactly 10000 bps (100%). Previously, any shortfall against 100% became a normal
--           distribute_guild_revenue() "guild share" credit — bucket='guild' — which would have
--           quietly reopened exactly the treasury balance point 1 just closed off. A Player
--           Guild target is unaffected: it can still receive a partial share the way an
--           Inkroot-funded prize always could (that's the guild's own money to keep, same as
--           before).
--        b. host = 'inkroot' authorization is widened from "only a null-session/service-role
--           caller" to "a null-session caller OR is_inkroot_admin()". This isn't a Founder-Guild
--           change — it fixes a real gap the audit surfaced: InkrootEventsAdmin's UI has offered
--           a settle control since 43_migration_inkroot_events_admin.sql, but 48_migration_
--           guild_event_financial_agreement.sql's settle_guild_event rewrite silently dropped the
--           is_inkroot_admin() branch that made it work, leaving only the original service-role/
--           SQL-only path. Every admin click on that control has been failing since. Reserve
--           top-ups (top_up_platform_reserve/withdraw_from_platform_reserve) stay exactly as
--           SQL/service-role-only as migration 113 left them — that boundary is deliberate and
--           this migration does not touch it.
--
-- Existing data: no Founder Guild has ever been able to accumulate a guild-bucket balance before
-- this (is_guild_officer already gated host='guild' creation the same way, and no in-app path
-- ever called contribute_to_guild_treasury successfully against one — is_guild_member requires
-- founder_guild_members, but nothing stopped a member from contributing their own balance in
-- today, which is exactly what point 1 now closes), so there is nothing to migrate or backfill.
--
-- Safe to run anytime: every changed function is a straight create-or-replace with its existing
-- signature; every new check only narrows a path that previously succeeded for a Founder Guild
-- specifically, and every Player Guild call site is byte-for-byte unaffected.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 1. Treasury: no Founder Guild may hold, receive, or spend guild-owned funds.
-- ------------------------------------------------------------------------------------------

create or replace function contribute_to_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_note text default null,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
  if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
    raise exception 'Founder Guilds do not have a treasury — there is nothing to contribute to here.';
  end if;

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_member(p_guild_id) then
    raise exception 'Not a member of this guild.';
  end if;
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if author_balance_kobo(auth.uid()) < p_amount_kobo then
    raise exception 'That would exceed your available balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'credit', 'contribution', p_amount_kobo, 'NGN', 'member_balance',
     'guild_treasury', p_project_event_id, 'success', p_note, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

create or replace function spend_from_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_title text,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
  v_cap bigint;
begin
  if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
    raise exception 'Founder Guilds do not have a treasury — there is nothing to spend here.';
  end if;

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
  end if;
  if p_amount_kobo >= guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'Withdrawals of this size require multiple approvals — use propose_guild_treasury_spend instead.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  v_cap := guild_treasury_direct_spend_cap_kobo();
  if guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo > v_cap then
    raise exception 'This guild has reached its direct-spend limit of ₦% for a rolling 24 hours. Propose the spend for multi-approval, or try again later.',
      to_char(v_cap / 100, 'FM999,999,999');
  end if;

  if guild_treasury_available_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'debit', 'spend', p_amount_kobo, 'NGN', 'guild_treasury',
     'external', p_project_event_id, 'success', p_title, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

create or replace function propose_guild_treasury_spend(
  p_guild_id uuid, p_amount_kobo bigint, p_title text, p_idempotency_key text default null
)
returns guild_treasury_spend_requests
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_spend_requests;
begin
  if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
    raise exception 'Founder Guilds do not have a treasury — there is nothing to spend here.';
  end if;

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'A spend request needs a title.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can propose a treasury spend.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo < guild_treasury_multi_approval_threshold_kobo()
     and guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo <= guild_treasury_direct_spend_cap_kobo() then
    raise exception 'Amounts under the multi-approval threshold can be authorized directly with spend_from_guild_treasury.';
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  if guild_treasury_available_kobo(p_guild_id) - guild_treasury_reserved_by_other_requests_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance once pending proposals are accounted for.';
  end if;

  insert into guild_treasury_spend_requests (guild_id, amount_kobo, title, requested_by, idempotency_key)
  values (p_guild_id, p_amount_kobo, trim(p_title), auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    return v_row;
  end if;

  insert into guild_treasury_spend_approvals (request_id, approver_id) values (v_row.id, auth.uid());
  return v_row;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 2. Events: a Founder Guild may no longer host its own (host='guild') entry-fee event.
-- host='inkroot' is completely untouched below — it was never reachable through this branch.
-- ------------------------------------------------------------------------------------------

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
  v_available bigint;
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;

  if p_host = 'inkroot' then
    if not is_inkroot_admin() then
      raise exception 'Only an Inkroot admin can host a cash-prize event.';
    end if;
    if p_cash_prize_kobo is null or p_cash_prize_kobo <= 0 then
      raise exception 'An Inkroot-hosted event needs a positive cash prize.';
    end if;
    if p_entry_fee_kobo is not null then
      raise exception 'An Inkroot-hosted event has no entry fee — it''s funded directly.';
    end if;
    if not exists (select 1 from player_guilds g where g.id = p_guild_id) then
      raise exception 'Guild not found.';
    end if;
    perform pg_advisory_xact_lock(hashtext('platform_reserve'));
    v_available := platform_reserve_available_kobo();
    if p_cash_prize_kobo > v_available then
      raise exception 'Inkroot''s prize reserve can''t cover this prize: ₦% is available and this event needs ₦%. Top up the reserve first.',
        trim(to_char(v_available / 100.0, 'FM999,999,999,990.00')),
        trim(to_char(p_cash_prize_kobo / 100.0, 'FM999,999,999,990.00'));
    end if;
    insert into guild_events (guild_id, host, title, cash_prize_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'inkroot', trim(p_title), p_cash_prize_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    insert into platform_reserve_kobo (kind, amount_kobo, event_id, note, created_by)
    values ('event_prize_reserved', p_cash_prize_kobo, v_row.id, 'Reserved at event creation — ' || left(v_row.title, 200), auth.uid());
    return v_row;
  elsif p_host = 'guild' then
    if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
      raise exception 'A Founder Guild cannot host its own event — Inkroot can still run an official cash-prize event for it.';
    end if;
    if not is_guild_officer(p_guild_id) then
      raise exception 'Only the guild owner can host a guild event.';
    end if;
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    if p_cash_prize_kobo is not null then
      raise exception 'A guild-hosted event funds its own prize from entry fees — it has no separate cash prize.';
    end if;
    insert into guild_events (guild_id, host, title, entry_fee_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'guild', trim(p_title), p_entry_fee_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    return v_row;
  else
    raise exception 'Unknown event host.';
  end if;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 3. settle_guild_event — (a) an Inkroot-hosted prize for a Founder Guild must be declared
-- 100% to winners, so no leftover ever lands in that guild's (now nonexistent) treasury bucket;
-- (b) the is_inkroot_admin() settle path is restored — see migration header, point 3b.
-- The host='guild' branch is otherwise byte-for-byte what 120_migration_guild_event_settlement_
-- hardening.sql left it (lock ordering, approval-status gate, escrow handling all unchanged).
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
    -- Migration 122: restores the is_inkroot_admin() app path (see migration header, point 3b) —
    -- a null session (service-role/SQL) still works exactly as before.
    if auth.uid() is not null and not is_inkroot_admin() then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));
  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
  end if;
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
    -- Migration 122: for a Founder Guild target, the whole prize must go to named winners — no
    -- leftover may become a "guild share" credit, since a Founder Guild has no treasury bucket
    -- to hold one. A Player Guild target is unaffected: it may still leave a share for itself,
    -- exactly as before.
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

  if v_event.host = 'inkroot' then
    perform platform_reserve_record_settlement(p_event_id);
  end if;

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

revoke all on function contribute_to_guild_treasury(uuid, bigint, text, text, uuid) from public;
revoke all on function spend_from_guild_treasury(uuid, bigint, text, text, uuid) from public;
revoke all on function propose_guild_treasury_spend(uuid, bigint, text, text) from public;
revoke all on function create_guild_event(uuid, text, text, bigint, bigint) from public;
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function contribute_to_guild_treasury(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function spend_from_guild_treasury(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function propose_guild_treasury_spend(uuid, bigint, text, text) to authenticated;
grant execute on function create_guild_event(uuid, text, text, bigint, bigint) to authenticated;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;

-- After applying: guild_treasury_summary()/guild_treasury_available_kobo() etc. need no changes —
-- they already just sum guild_treasury_transactions, which no code path can write to for a
-- Founder Guild anymore. Any Founder Guild treasury balance from before this migration (there
-- should be none — see migration header) would simply become permanently unspendable, not
-- deleted; if one exists in your deployment, decide by hand whether to zero it out via a direct
-- SQL credit reversal.
