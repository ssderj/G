-- ============================================================================================
-- Migration 109 — an escrowed guaranteed prize pays declared winners in full; it is no longer
-- run through the entry-fee financial agreement's prize_pool_bps split.
--
-- Correction to migration 108: that migration funded v_gross from the escrow for an escrowed
-- event, but still required the event's existing guild_event_financial_agreements row and still
-- validated winner shares against its prize_pool_bps — meaning the guild's own guild_share_bps
-- (and any other_allocations) would have skimmed a cut off the escrowed prize itself, on top of
-- already receiving 100% of collected entry fees as separate Event Revenue Pool income (see
-- migration 108's entry_fee_kobo -> event_entry_revenue credit).
--
-- Confirmed by the app owner: if a guild puts up, say, a guaranteed ₦100,000 prize, all ₦100,000
-- goes to the declared winners — full stop. The financial agreement's prize_pool_bps/
-- guild_share_bps/other_allocations split exists to divide variable, uncommitted entry-fee
-- revenue; it has no reason to also apply to a fixed amount the guild explicitly set aside as
-- the prize. An escrowed event therefore no longer needs a financial agreement on file at all —
-- same "no split to declare" reasoning host='inkroot' events have always had (they've never
-- required one either) — and settle_guild_event now requires declared winner shares to sum to
-- exactly 10000 (100%) for an escrowed event, not to whatever prize_pool_bps a stale/prior
-- agreement might say.
--
-- What did NOT change: a non-escrowed host='guild' event (no guaranteed_prize_kobo) is completely
-- untouched — it still requires and validates against its locked financial agreement exactly as
-- it always has. The entry-fee -> event_entry_revenue credit for an escrowed event (migration
-- 108) is also untouched.
--
-- Safe to run anytime: no schema change, only these two functions' logic for the
-- guaranteed_prize_kobo-is-set branch, which no existing row could have exercised correctly
-- before now (migration 108 only shipped once, in this same batch of work).
-- ============================================================================================

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_escrowed boolean;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can activate this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'published' then
    raise exception 'Publish this event before opening it for entries.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;

  -- An escrowed event has nothing for a financial agreement to divide: the guaranteed prize
  -- pays winners in full (see settle_guild_event below) and entry fees go to the guild's Event
  -- Revenue Pool outright — same "no split to declare" posture host='inkroot' events already
  -- have. A non-escrowed event is completely unchanged from before this migration.
  if v_event.host = 'guild' and not v_escrowed then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  if v_escrowed then
    if not exists (
      select 1 from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
    ) then
      raise exception 'Deposit the guaranteed prize into escrow before opening this event for entries.';
    end if;
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

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

  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;
  if v_event.status = 'cancelled' then
    raise exception 'A cancelled event cannot be settled.';
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

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

revoke all on function activate_guild_event(uuid, uuid) from public;
revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function activate_guild_event(uuid, uuid) to authenticated;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;
