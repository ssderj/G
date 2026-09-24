-- ============================================================================================
-- Migration 108 — locked-escrow guaranteed prizes for Player-Guild-hosted events, with a hard
-- no-cancellation-after-first-paid-entry rule (moderator dispute override excepted).
--
-- Confirmed scope, from the app owner directly (do not extend beyond this):
--   - Founder Guilds are NOT permitted to host events, paid or otherwise. Nothing here touches
--     that — guild_events.guild_id stays uuid references player_guilds(id) exactly as it always
--     has been; is_guild_officer/is_guild_treasury_authorized are unchanged.
--   - A Player Guild that wants to promise a fixed prize on a guild-hosted event must deposit
--     that full amount into a locked escrow before the event can open for entries. Until now,
--     a host='guild' event's only "prize" was whatever entry fees happened to come in
--     (settle_guild_event computed v_gross from a live sum of guild_event_entries.net_kobo) —
--     nothing was ever guaranteed.
--   - Entry fees still flow the same way they always have (through the event's own locked
--     financial agreement) — EXCEPT for an escrowed event, where the app owner explicitly asked
--     that entry fees go into the guild's ordinary Event Revenue Pool (a plain credit to the
--     guild treasury, kind='event_entry_revenue') and the escrowed prize is paid out separately,
--     from the escrow, at settlement — the two pools never mix.
--   - Cancellation is allowed ONLY while zero entrants have paid (and none has an entry attempt
--     still in flight — see the 30-minute window note below). The instant one entrant is
--     paid/in-flight, the event cannot be cancelled by its own guild for any reason, including
--     low turnout — it must run to its normal conclusion (complete -> results -> settle).
--   - The one exception: a platform admin (is_inkroot_admin() — the same financial trust domain
--     migration 43 already carved out from is_moderator, not a new role) can force-cancel for a
--     genuine dispute (fraud, etc.) even after entries exist. This does NOT auto-refund paid
--     entrants through Paystack — this codebase has never called Paystack's refund API itself
--     (every 'refunded' status transition in paystack-webhook is reactive to a refund Paystack
--     already processed, initiated by an admin from Paystack's own dashboard, same as the
--     existing manual-withdrawal precedent) — an admin using this override still has to process
--     the actual bank-level refunds in Paystack by hand; this function only unwinds Inkroot's own
--     ledger (releasing the escrow) and marks the event so the app stops treating it as live.
--
-- Design notes on HOW this reuses (rather than replaces) existing machinery — read before
-- touching settle_guild_event or distribute_guild_revenue again:
--   - distribute_guild_revenue() dedups by project_event_id ALONE (any existing
--     guild_treasury_transactions row with that project_event_id blocks it from ever running for
--     that event again, regardless of kind). The escrow lock/release rows below therefore use a
--     NEW, separate escrow_event_id column instead of project_event_id — tagging them with
--     project_event_id would permanently block this event's own settle_guild_event() call before
--     it ever ran, since the escrow row is written at activation time, long before settlement.
--   - The escrowed prize is still split via the event's existing, unchanged
--     guild_event_financial_agreements row (prize_pool_bps/guild_share_bps/other_allocations,
--     still required to sum to exactly 10000, still locked at activation, still validated by
--     settle_guild_event exactly as before) — only WHAT FUNDS v_gross changes (the escrow amount
--     instead of the live entry-fee sum). This is deliberate: it reuses every existing
--     validation/locking guarantee that system already has instead of inventing a parallel one.
--   - The separate entry-fee credit (kind='event_entry_revenue') is inserted directly, AFTER
--     distribute_guild_revenue's call in the same function body — never before it and never via
--     a second distribute_guild_revenue call for the same project_event_id (see the dedup note
--     above: a second call for the same event would silently no-op).
--
-- Safe to run anytime: every new column is nullable/additive, every widened check constraint
-- accepts every value it already did, and every existing function's non-escrowed/non-cancelled
-- code path is provably unchanged (every new branch below is gated on guaranteed_prize_kobo
-- being set, or on the new cancel functions, neither of which any existing row/caller triggers).
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. Schema: the guaranteed prize amount, the cancellation record, and the escrow ledger link.
-- ----------------------------------------------------------------------------------------------

alter table guild_events add column if not exists guaranteed_prize_kobo bigint
  check (guaranteed_prize_kobo is null or guaranteed_prize_kobo > 0);
alter table guild_events add column if not exists cancelled_at timestamptz;
alter table guild_events add column if not exists cancellation_reason text;
alter table guild_events add column if not exists cancelled_by uuid references auth.users(id) on delete set null;

alter table guild_events drop constraint if exists guild_events_status_check;
alter table guild_events add constraint guild_events_status_check
  check (status in ('open', 'closed', 'settled', 'cancelled'));

alter table guild_events drop constraint if exists guild_events_approval_status_check;
alter table guild_events add constraint guild_events_approval_status_check
  check (approval_status in ('draft', 'pending_approval', 'approved', 'published', 'active', 'completed', 'rejected', 'cancelled'));

-- Kept entirely separate from project_event_id — see this migration's header on why reusing
-- project_event_id here would silently break distribute_guild_revenue() for every escrowed event.
alter table guild_treasury_transactions add column if not exists escrow_event_id uuid references guild_events(id) on delete set null;

alter table guild_treasury_transactions drop constraint if exists guild_treasury_transactions_kind_check;
alter table guild_treasury_transactions add constraint guild_treasury_transactions_kind_check
  check (kind in ('contribution', 'spend', 'anthology_share', 'event_revenue', 'release_to_member',
                   'event_prize_escrow', 'event_prize_escrow_release', 'event_entry_revenue'));

alter table guild_treasury_transactions drop constraint if exists guild_treasury_transactions_source_check;
alter table guild_treasury_transactions add constraint guild_treasury_transactions_source_check
  check (source in ('member_balance', 'guild_treasury', 'anthology_sale', 'event_sale', 'member_earnings_held',
                     'event_prize_escrow_held'));

alter table guild_treasury_transactions drop constraint if exists guild_treasury_transactions_destination_check;
alter table guild_treasury_transactions add constraint guild_treasury_transactions_destination_check
  check (destination in ('guild_treasury', 'member_balance', 'member_earnings_held', 'external',
                          'event_prize_escrow_held'));

-- ----------------------------------------------------------------------------------------------
-- 2. Declaring the amount — create_guild_event_draft / update_guild_event_draft gain one new,
-- optional parameter. Every existing call site (guild-events.js's createGuildEventDraft/
-- updateGuildEventDraft) keeps working unchanged, since it simply won't pass this argument and
-- the column stays null — the exact same "additive parameter, old callers unaffected" pattern
-- publish_guild_event's hosting-fee check already established for this same function family.
-- ----------------------------------------------------------------------------------------------

create or replace function create_guild_event_draft(
  p_guild_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can host a guild event.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status, guaranteed_prize_kobo
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    p_entry_fee_kobo, p_participant_limit, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed', p_guaranteed_prize_kobo
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function update_guild_event_draft(
  p_guild_id uuid,
  p_event_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can edit this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Only a draft or rejected event can be edited.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  update guild_events set
    title = trim(p_title),
    description = nullif(trim(coalesce(p_description, '')), ''),
    rules = nullif(trim(coalesce(p_rules, '')), ''),
    event_type = coalesce(p_event_type, 'other'),
    entry_fee_kobo = p_entry_fee_kobo,
    participant_limit = p_participant_limit,
    prize_structure = coalesce(p_prize_structure, '[]'::jsonb),
    guild_share_bps = coalesce(p_guild_share_bps, 0),
    start_date = p_start_date,
    end_date = p_end_date,
    organizer_id = p_organizer_id,
    cover_image_url = p_cover_image_url,
    guaranteed_prize_kobo = p_guaranteed_prize_kobo,
    approval_status = 'draft',
    rejection_reason = null,
    reviewed_by = null,
    reviewed_at = null,
    submitted_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) from public;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) from public;
grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) to authenticated;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 3. deposit_guild_event_prize_escrow — the actual lock. Takes NO amount parameter: it reads
-- guaranteed_prize_kobo off the event row itself, so a client can never escrow a different
-- number than what was declared and reviewed (same "never trust a client-supplied amount"
-- stance as every other money-moving function in this schema). Mirrors spend_from_guild_treasury
-- exactly (same authorization check, same advisory lock key on the guild, same multi-approval
-- threshold refusal for a large amount, same available-balance recheck under the lock) — this
-- IS a treasury spend, just tagged and destined differently.
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
  if v_event.guaranteed_prize_kobo >= guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'A guaranteed prize this large requires multiple approvals — get the treasury spend approved through the guild''s existing multi-approval flow first, then contact Inkroot to link it to this event.';
  end if;

  -- Same lock key spend_from_guild_treasury already uses for this guild, so escrowing a prize
  -- correctly serializes against a concurrent ordinary treasury spend (or another escrow
  -- deposit) rather than racing it.
  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));
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
-- 4. activate_guild_event — redefined only to add the escrow precondition, gated purely on
-- guaranteed_prize_kobo being set. An ordinary (non-escrowed) guild event's activation is
-- completely unchanged — same financial-agreement lock as before, nothing else touched.
-- ----------------------------------------------------------------------------------------------

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
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

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
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

-- ----------------------------------------------------------------------------------------------
-- 5. cancel_guild_event — the owner-initiated path. Refuses outright the instant one entrant is
-- paid, or has a payment attempt still within the same 30-minute "still might complete" window
-- create_guild_event_entry_locked's own participant-limit count already uses (an in-flight
-- pending entry could still turn into 'success' seconds after this check ran; without this,
-- cancelling and then having that pending charge succeed into a now-cancelled, refund-less event
-- would be exactly the outcome this feature exists to prevent). Locked on the SAME advisory-lock
-- key create_guild_event_entry_locked actually uses ('guild_event_entry:<event id>', not the
-- differently-named key its own comment claims to share with settle_guild_event) so this can
-- never race a concurrent entry attempt either.
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
-- 6. admin_cancel_guild_event_dispute — the ONLY way an already-entered event can still be
-- cancelled. is_inkroot_admin()-gated, same financial trust domain migration 43 already
-- separated from is_moderator ("a content moderator authorizing a real cash payout is a
-- different trust domain" — see that migration's header). Requires a reason, same as
-- reject_guild_event/reject_guild_event_results. Releases the escrow (if any) back to the guild
-- treasury exactly like cancel_guild_event does, but does NOT touch guild_event_entries rows —
-- any already-'success' entry stays 'success' in this app's own ledger until Paystack's own
-- refund.processed webhook event flips it to 'refunded' once an admin has actually processed the
-- real bank-level refund from Paystack's dashboard (this codebase has never called Paystack's
-- refund API itself — see this migration's header).
-- ----------------------------------------------------------------------------------------------

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

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid(), cancellation_reason = trim(p_reason)
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

revoke all on function admin_cancel_guild_event_dispute(uuid, text) from public;
grant execute on function admin_cancel_guild_event_dispute(uuid, text) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 7. settle_guild_event — redefined only to fund v_gross from escrow instead of the live
-- entry-fee sum when guaranteed_prize_kobo is set, and to separately credit collected entry fees
-- to the guild treasury as plain revenue in that case. A non-escrowed guild event's settlement,
-- and every host='inkroot' settlement, is completely unchanged.
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

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;

    select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
    from jsonb_array_elements(p_shares) s;
    if v_shares_sum <> v_agreement.prize_pool_bps then
      raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
    end if;

    select coalesce(sum(net_kobo), 0) into v_entry_fees
    from guild_event_entries where event_id = p_event_id and status = 'success';

    if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 then
      -- The escrowed amount funds the winners'/guild's split below; collected entry fees are a
      -- completely separate pool (the app owner's own instruction — see this migration's header)
      -- and are credited to the guild treasury directly, never split with winners.
      v_gross := v_event.guaranteed_prize_kobo;
    else
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

  -- Entry-fee revenue for an escrowed event — inserted directly (not through
  -- distribute_guild_revenue, and only after its call above) rather than a second
  -- distribute_guild_revenue call for the same p_event_id, which its own dedup would silently
  -- no-op. See this migration's header for why ordering here matters.
  if v_event.host = 'guild' and v_event.guaranteed_prize_kobo is not null
     and v_event.guaranteed_prize_kobo > 0 and v_entry_fees > 0 then
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

revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;
