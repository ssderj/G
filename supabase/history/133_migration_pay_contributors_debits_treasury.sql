-- ============================================================================================
-- Migration 133 — resolves the settlement product question from migration 131 section 8, per
-- the app owner's direction: the guaranteed prize is paid to winners in full from escrow exactly
-- as it always was (settle_guild_event, unchanged — see migration 108/120); entry-fee revenue
-- keeps flowing into the guild's own treasury exactly as it always has
-- (kind='event_entry_revenue', unchanged — see migration 108 section on that credit). Nothing
-- about settlement itself changes, and settle_guild_event is NOT touched by this migration.
--
-- What contributor sharing actually is, then: an ordinary, guild-officer-authorized SPEND from
-- the guild's own already-collected treasury balance (which now includes that event's entry
-- fees, mixed in with everything else the guild owns) — split across contributors by their
-- escrow share_bps instead of paid to one payee. Not a special pool earmarked from one event;
-- exactly the same "guild owns it, an officer decides how much of it to spend and when" posture
-- spend_from_guild_treasury() already has for every other guild expenditure.
--
-- The gap this closes: pay_guild_event_escrow_contributors() as shipped in migration 131 credited
-- each contributor's bucket='member' balance with source='guild_treasury', but never inserted the
-- matching bucket='guild' DEBIT that every other guild-treasury outflow in this schema writes
-- (spend_from_guild_treasury, deposit_guild_event_prize_escrow) — so guild_treasury_available_kobo()
-- never actually went down. A guild could pay contributors and then spend or escrow the exact same
-- kobo again elsewhere: money the ledger showed as both spent and still available, the specific
-- failure mode this audit was about in the first place. Fixed the same way every sibling function
-- already proves it: check-then-lock-then-recheck-then-debit, under the SAME advisory lock key
-- (hashtext(p_guild_id::text)) spend_from_guild_treasury/deposit_guild_event_prize_escrow use, so
-- this correctly serializes against a concurrent ordinary spend or a concurrent second payout
-- instead of racing either.
--
-- The old payout index only fits "one row per event" and would have rejected every contributor
-- past the first once this migration adds a second row per event (the new guild-bucket debit,
-- alongside the existing per-contributor member-bucket credits) — replaced with one scoped to
-- bucket = 'guild', which is still exactly one row per event (the debit), leaving the per-
-- contributor credit rows unrestricted.
--
-- Also rate-limited via check_and_bump_guild_rate_limit(), same treatment migration 120 gave
-- deposit_guild_event_prize_escrow() and for the same reason: this moves guild treasury money in
-- amounts an officer chooses, repeatedly, and belongs under the same defense-in-depth ceiling
-- every other discretionary treasury spend already has.
--
-- Safe to run anytime: pay_guild_event_escrow_contributors() has never been reachable outside this
-- same session's migration 131 (that migration and this one ship together), so there is no
-- existing payout row anywhere that this changes the meaning of.
-- ============================================================================================

drop index if exists guild_treasury_transactions_escrow_payout_idx;
create unique index guild_treasury_transactions_escrow_payout_idx
  on guild_treasury_transactions (escrow_event_id)
  where kind = 'event_prize_escrow_contributor_payout' and status = 'success' and bucket = 'guild';

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
    when 'deposit_guild_event_prize_escrow' then v_max_calls := 3; v_window_seconds := 86400;
    -- Migration 133: pays multiple contributors out of the guild's own treasury balance in one
    -- call — same discretionary-spend shape as the two above, same window, same smaller ceiling
    -- reasoning as deposit_guild_event_prize_escrow's own comment (each call can move a
    -- meaningfully larger amount than a single ordinary spend).
    when 'pay_guild_event_escrow_contributors' then v_max_calls := 3; v_window_seconds := 86400;
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

create or replace function pay_guild_event_escrow_contributors(
  p_guild_id uuid, p_event_id uuid, p_pool_kobo bigint
)
returns setof guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_debit guild_treasury_transactions%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can authorize a treasury spend.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id for update;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.funding_mode <> 'contributors' then
    raise exception 'This event has no contributor escrow to pay a revenue share to.';
  end if;
  if v_event.status <> 'settled' then
    raise exception 'This event has not been settled yet.';
  end if;
  if p_pool_kobo is null or p_pool_kobo <= 0 then
    raise exception 'Pool amount must be positive.';
  end if;
  -- Re-check under the lock too (see this migration's header) — a stale read here is exactly
  -- the double-escrow race migration 130 fixed elsewhere in this file, just for this function.
  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow_contributor_payout' and status = 'success'
  ) then
    raise exception 'The contributor revenue share for this event has already been paid out.';
  end if;

  -- Same lock key every other guild-treasury outflow (spend_from_guild_treasury,
  -- deposit_guild_event_prize_escrow) uses, so this correctly serializes against a concurrent
  -- ordinary spend or a second, racing payout call instead of both reading the same starting
  -- balance and together overdrawing it.
  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow_contributor_payout' and status = 'success'
  ) then
    raise exception 'The contributor revenue share for this event has already been paid out.';
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'pay_guild_event_escrow_contributors');

  if guild_treasury_available_kobo(p_guild_id) < p_pool_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  -- The actual outflow from the guild's own bucket — mirrors spend_from_guild_treasury's single
  -- debit row exactly, just tagged/destined for this event's contributors instead of a named
  -- payee. This is what makes guild_treasury_available_kobo() correctly reflect the spend, and
  -- what the unique index above now keys "already paid out" against.
  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     escrow_event_id, status, title, created_by)
  values
    (p_guild_id, 'guild', null, 'debit', 'event_prize_escrow_contributor_payout', p_pool_kobo, 'NGN',
     'guild_treasury', 'member_balance', p_event_id, 'success',
     'Prize escrow revenue share — ' || v_event.title, auth.uid())
  returning * into v_debit;
  return next v_debit;

  -- Per-contributor credits: floor-then-largest-remainder on kobo (same technique
  -- distribute_guild_revenue already uses), so these always sum to exactly p_pool_kobo — the
  -- exact amount just debited above, never a kobo more or less.
  return query
  with shares as (
    select contributor_id, share_bps,
      floor(p_pool_kobo * share_bps::numeric / 10000)::bigint as base,
      (p_pool_kobo * share_bps::numeric / 10000) - floor(p_pool_kobo * share_bps::numeric / 10000) as frac
    from guild_event_escrow_contribution_shares(p_event_id)
    where share_bps > 0
  ),
  ranked as (
    select contributor_id, base, frac,
           row_number() over (order by frac desc, contributor_id) as rn,
           (p_pool_kobo - sum(base) over ())::bigint as remainder
    from shares
  ),
  final_amounts as (
    select contributor_id, base + case when rn <= remainder then 1 else 0 end as payout_kobo
    from ranked
  )
  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     escrow_event_id, status, title, created_by)
  select v_event.guild_id, 'member', contributor_id, 'credit', 'event_prize_escrow_contributor_payout',
         payout_kobo, 'NGN', 'guild_treasury', 'member_balance', p_event_id, 'success',
         'Prize escrow revenue share — ' || v_event.title, auth.uid()
  from final_amounts
  where payout_kobo > 0
  returning *;
end;
$$;

revoke all on function pay_guild_event_escrow_contributors(uuid, uuid, bigint) from public;
grant execute on function pay_guild_event_escrow_contributors(uuid, uuid, bigint) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- Verification — run after applying:
--   * guild_treasury_available_kobo(p_guild_id) drops by exactly p_pool_kobo immediately after a
--     call to pay_guild_event_escrow_contributors — confirm with guild_treasury_summary() before
--     and after.
--   * sum(amount_kobo) over the member-bucket credit rows this call inserted = p_pool_kobo
--     exactly, for awkward pool sizes too (e.g. p_pool_kobo = 3 against 4 contributors: three get
--     1 kobo, one gets 0 — nothing lost or invented; same check as migration 131 section 9).
--   * A second call for the same event raises 'already been paid out', both before and after
--     concurrently racing two calls against each other (confirm only one debit row exists — the
--     new unique index enforces this even if the application-level check above is ever removed
--     by mistake).
--   * A call requesting more than guild_treasury_available_kobo(p_guild_id) is refused outright,
--     leaves zero rows inserted (not a partial payout), and does not consume a rate-limit slot
--     (the balance check runs after check_and_bump_guild_rate_limit is bumped in this version —
--     if that ordering matters to you, note it mirrors deposit_guild_event_prize_escrow's own
--     current ordering exactly, not a new inconsistency introduced here).
-- ============================================================================================
