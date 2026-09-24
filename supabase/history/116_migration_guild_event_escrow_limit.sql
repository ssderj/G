-- Migration 116: a guild couldn't escrow a large guaranteed event prize (reported by the owner).
--
-- The gap: deposit_guild_event_prize_escrow() refused any guaranteed prize at or above the
-- treasury multi-approval threshold (₦100,000) with "requires multiple approvals ... then contact
-- Inkroot to link it to this event" — but there is no flow that links a multi-approved spend to
-- an event, so every prize of ₦100,000 or more was a dead end.
--
-- What this changes:
--   1. guild_event_escrow_max_kobo() — the escrow ceiling, one definition: ₦5,000,000
--      (500,000,000 kobo). Change the number here to move the limit.
--   2. deposit_guild_event_prize_escrow() checks that ceiling instead of the multi-approval
--      threshold. Everything else in it is unchanged (authorization, one-escrow-per-event, the
--      guild-scoped advisory lock, the available-balance recheck). The shared
--      guild_treasury_multi_approval_threshold_kobo() and the 24-hour direct-spend cap (migration
--      112) that ordinary spends use are untouched.
--
-- Trade-off to know about: escrowing between ₦100,000 and ₦5,000,000 is now a single-authorizer
-- action (leader, treasurer or officer), bounded by the guild's available balance and the
-- ceiling, not by the multi-approval flow. The escrowed money is still locked to that event
-- (released only on cancel, paid only on settlement).
--
-- Not run against a live database from this session. Verify after applying: a guild with enough
-- balance can escrow a ₦1,000,000 prize; a ₦5,000,001 prize is refused with the "at most ₦5,000,000"
-- message; insufficient balance is still refused.

create or replace function guild_event_escrow_max_kobo()
returns bigint as $$
  select 500000000::bigint;
$$ language sql immutable;

revoke all on function guild_event_escrow_max_kobo() from public, anon, authenticated;

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
