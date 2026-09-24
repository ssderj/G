-- Migration 113: Inkroot-hosted events could promise any cash prize with nothing set aside
-- to pay it (production audit, High).
--
-- The gap: create_guild_event()'s host='inkroot' branch only checked that the caller is an admin
-- and that the prize is positive. A guild-hosted guaranteed prize is escrowed in the guild's own
-- treasury (migration 108), but an Inkroot-hosted prize was just a number on the event row: any
-- admin (or a compromised admin session) could publish "₦5,000,000 prize" that Inkroot could not
-- pay, and settle_guild_event() would then credit the winners' guild treasury with money that was
-- never funded — which the guild could withdraw.
--
-- What this adds:
--   1. platform_reserve_kobo — an append-only ledger of Inkroot's own prize reserve. Rows:
--        top_up                — operator adds funds (credit)
--        withdrawal            — operator removes unreserved funds (debit)
--        event_prize_reserved  — debited when an Inkroot-hosted event is created
--        event_prize_released  — credited back if that event is cancelled before settlement
--        event_prize_settled   — recorded when the event settles (no effect on the available
--                                balance: the funds were already taken out at reservation; this
--                                just closes the reservation so it is never released afterward)
--      available = top_ups + releases - reservations - withdrawals. Update/delete are blocked by a
--      trigger that fires for every role, same as guild_treasury_transactions.
--   2. create_guild_event()'s host='inkroot' branch refuses to create the event unless the prize
--      fits inside the available reserve, and debits the reserve in the same transaction, under a
--      dedicated advisory lock so two concurrent event creations can't both spend the same funds.
--   3. settle_guild_event()'s host='inkroot' path closes the reservation (event_prize_settled).
--   4. cancel_guild_event() and admin_cancel_guild_event_dispute() release the reservation when
--      they cancel an Inkroot-hosted event — otherwise cancelling one would strand its funds.
--   5. top_up_platform_reserve() / withdraw_from_platform_reserve() — the only sanctioned writers of
--      the operator rows. Callable ONLY from the SQL editor / service role, never from an app
--      session: if an admin session could top up the reserve, it could mint its own funding and
--      the check above would prove nothing. See PAYMENTS.md, "Inkroot prize reserve".
--
-- IMPORTANT — what this is and isn't. The reserve is an accounting control, not a bank check:
-- a top-up is the operator declaring "I have set this much aside" (in the Paystack balance or the
-- company bank account); nothing here can verify real money. What it does guarantee is that no
-- Inkroot-hosted prize can be published beyond what an operator has explicitly declared funded,
-- and that an admin account alone can't raise that ceiling.
--
-- Existing events: Inkroot-hosted events created before this migration have no reservation row.
-- They settle exactly as before (no reserve interaction) rather than being blocked, since
-- refusing to pay out an already-announced prize would be worse than the gap being closed. To fund
-- them into the ledger, top up the reserve and reserve them by hand; to see which are still open:
--     select id, title, cash_prize_kobo from guild_events
--      where host = 'inkroot' and status = 'open'
--        and not exists (select 1 from platform_reserve_kobo r
--                        where r.event_id = guild_events.id and r.kind = 'event_prize_reserved');
--
-- AFTER APPLYING: the reserve starts at zero, so creating an Inkroot-hosted event fails until an
-- operator tops it up, e.g.
--     select top_up_platform_reserve(50000000, 'Initial prize reserve');   -- ₦500,000
--
-- Safe to run anytime: one new table, and the changed functions only gain checks on paths that
-- previously had none (the Inkroot branch of create; Inkroot handling in cancel/settle).

-- ============================================================================================
-- 1. Ledger
-- ============================================================================================

create table if not exists platform_reserve_kobo (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in (
    'top_up', 'withdrawal', 'event_prize_reserved', 'event_prize_released', 'event_prize_settled'
  )),
  amount_kobo bigint not null check (amount_kobo > 0),
  -- Plain reference, no ON DELETE action: an event with reserve history can't be deleted out from
  -- under its ledger (and SET NULL would be an UPDATE, which the append-only trigger forbids).
  event_id uuid references guild_events(id),
  note text check (note is null or char_length(note) <= 500),
  -- No foreign key on purpose, for the same reason: a user deletion must not try to rewrite ledger rows.
  created_by uuid,
  created_at timestamptz not null default now(),
  check ((kind in ('top_up', 'withdrawal')) = (event_id is null))
);

alter table platform_reserve_kobo enable row level security;

-- Platform admins can read the ledger; nobody can write to it through the API.
drop policy if exists "platform admins read the prize reserve ledger" on platform_reserve_kobo;
create policy "platform admins read the prize reserve ledger" on platform_reserve_kobo
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin));

-- One reservation, one release and one settlement per event, at most.
create unique index if not exists platform_reserve_kobo_event_kind_idx
  on platform_reserve_kobo (event_id, kind) where event_id is not null;

create or replace function forbid_platform_reserve_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'platform_reserve_kobo is a permanent, append-only ledger -- rows can never be updated or deleted. Insert a new row to record a correction instead.';
end;
$$;

drop trigger if exists platform_reserve_kobo_immutable on platform_reserve_kobo;
create trigger platform_reserve_kobo_immutable
  before update or delete on platform_reserve_kobo
  for each row execute function forbid_platform_reserve_mutation();

-- ============================================================================================
-- 2. Internal helpers (security-definer callers only — no client role can execute these)
-- ============================================================================================

create or replace function platform_reserve_available_kobo()
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(case kind
    when 'top_up' then amount_kobo
    when 'event_prize_released' then amount_kobo
    when 'event_prize_reserved' then -amount_kobo
    when 'withdrawal' then -amount_kobo
    else 0
  end), 0)::bigint
  from platform_reserve_kobo;
$$;

revoke all on function platform_reserve_available_kobo() from public, anon, authenticated;

-- Closes an Inkroot-hosted event's reservation as PAID. No-op for an event that never had one
-- (created before this migration) or whose reservation is already closed.
create or replace function platform_reserve_record_settlement(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved platform_reserve_kobo%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('platform_reserve'));
  select * into v_reserved from platform_reserve_kobo
  where event_id = p_event_id and kind = 'event_prize_reserved';
  if not found then
    return;
  end if;
  if exists (select 1 from platform_reserve_kobo
             where event_id = p_event_id and kind in ('event_prize_released', 'event_prize_settled')) then
    return;
  end if;
  insert into platform_reserve_kobo (kind, amount_kobo, event_id, note, created_by)
  values ('event_prize_settled', v_reserved.amount_kobo, p_event_id, 'Prize paid out at settlement', auth.uid());
end;
$$;

revoke all on function platform_reserve_record_settlement(uuid) from public, anon, authenticated;

-- Returns an Inkroot-hosted event's reservation to the available reserve (event cancelled). No-op
-- if it never had one or it's already been released or settled.
create or replace function platform_reserve_release_event(p_event_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reserved platform_reserve_kobo%rowtype;
begin
  perform pg_advisory_xact_lock(hashtext('platform_reserve'));
  select * into v_reserved from platform_reserve_kobo
  where event_id = p_event_id and kind = 'event_prize_reserved';
  if not found then
    return;
  end if;
  if exists (select 1 from platform_reserve_kobo
             where event_id = p_event_id and kind in ('event_prize_released', 'event_prize_settled')) then
    return;
  end if;
  insert into platform_reserve_kobo (kind, amount_kobo, event_id, note, created_by)
  values ('event_prize_released', v_reserved.amount_kobo, p_event_id, 'Event cancelled before settlement', auth.uid());
end;
$$;

revoke all on function platform_reserve_release_event(uuid) from public, anon, authenticated;

-- ============================================================================================
-- 3. Operator entry points — SQL editor / service role only
-- ============================================================================================

create or replace function top_up_platform_reserve(p_amount_kobo bigint, p_note text default null)
returns platform_reserve_kobo
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row platform_reserve_kobo;
begin
  -- session_user is the login role, which security definer does not change: a request arriving
  -- through the API is always 'authenticator', never one of these. So no signed-in app session,
  -- admin or otherwise, can reach this.
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;

  perform pg_advisory_xact_lock(hashtext('platform_reserve'));
  insert into platform_reserve_kobo (kind, amount_kobo, note)
  values ('top_up', p_amount_kobo, left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  returning * into v_row;
  return v_row;
end;
$$;

create or replace function withdraw_from_platform_reserve(p_amount_kobo bigint, p_note text default null)
returns platform_reserve_kobo
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row platform_reserve_kobo;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;

  perform pg_advisory_xact_lock(hashtext('platform_reserve'));
  if platform_reserve_available_kobo() < p_amount_kobo then
    raise exception 'That is more than the unreserved balance — funds committed to open events cannot be withdrawn.';
  end if;
  insert into platform_reserve_kobo (kind, amount_kobo, note)
  values ('withdrawal', p_amount_kobo, left(nullif(btrim(coalesce(p_note, '')), ''), 500))
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function top_up_platform_reserve(bigint, text) from public, anon, authenticated;
revoke all on function withdraw_from_platform_reserve(bigint, text) from public, anon, authenticated;

-- ============================================================================================
-- 4. Redefined functions. Each is the latest version already in this file, unchanged except for
-- the lines marked "Migration 113".
-- ============================================================================================

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
  v_available bigint; -- Migration 113
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
      raise exception 'An Inkroot-hosted event has no entry fee \u2014 it''s funded directly.';
    end if;
    if not exists (select 1 from player_guilds g where g.id = p_guild_id) then
      raise exception 'Guild not found.';
    end if;
    -- Migration 113: the prize must fit inside Inkroot's declared prize reserve, and is taken out
    -- of it in this same transaction under a dedicated lock, so two concurrent creations can't
    -- both spend the same funds. If the reserve can't cover it, no event is created.
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
    if not is_guild_officer(p_guild_id) then
      raise exception 'Only the guild owner can host a guild event.';
    end if;
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    if p_cash_prize_kobo is not null then
      raise exception 'A guild-hosted event funds its own prize from entry fees \u2014 it has no separate cash prize.';
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
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can force-cancel a guild event.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Give a reason for the record.';
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));

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

  -- Migration 113: an Inkroot-hosted event's reserved prize goes back to the available reserve.
  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid(), cancellation_reason = trim(p_reason)
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
