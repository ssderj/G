-- Migration 41: Guild Member Earnings — the withdrawal half of the Guild Treasury's 'member'
-- bucket (see 33_migration_guild_treasury.sql and 37_migration_guild_revenue_distribution.sql,
-- which is the first thing that actually credits it, via anthology sales). Until now a member
-- could see their held earnings total in guild_treasury_summary() (member_earnings_mine_kobo)
-- but had no way to ever get that money out — 'release_to_member' was reserved in the original
-- kind check constraint but nothing wrote one. This migration is what writes it.
--
-- Design choice: releasing earnings is a two-step handoff, not a new payout pipeline of its own.
--   1. withdraw_guild_member_earnings() below moves kobo out of a member's held-in-trust balance
--      in ONE guild's treasury and into their own, already-existing, cross-guild withdrawable
--      balance (author_balance_kobo) — instantly and synchronously, the same way
--      contribute_to_guild_treasury() moves it the other direction. This is pure bookkeeping: no
--      bank, no Paystack call, nothing that can fail asynchronously, so it's safe to record as a
--      single 'success' ledger row exactly like every other synchronous write this table
--      already has.
--   2. Actually paying it out to a bank account reuses paystack-withdraw / the withdrawals table
--      completely unchanged — the same pipeline every ordinary book-sale withdrawal already
--      goes through. This is deliberate: withdrawals already has its own correct
--      pending -> success/failed lifecycle via a mutable row + the Paystack webhook, which
--      guild_treasury_transactions can no longer support for a new row now that it's append-only
--      (see 34_migration_guild_treasury_ledger_hardening.sql's own comment on why an async
--      settlement needs a new row, not an update). Building a second, parallel
--      pending/success/failed payout pipeline just for guild-sourced kobo would duplicate that
--      entire lifecycle for no real benefit — once released, a Naira is a Naira, indistinguishable
--      from one earned by a solo book sale.
--
-- "Verified available earnings" (what a member may actually withdraw) means settled
-- (status = 'success') member-bucket credits, minus anything already released or in flight —
-- never a still-pending credit. See guild_treasury_member_earnings_mine_kobo below.
--
-- Never allows withdrawing another member's funds: every balance this migration checks is
-- derived from auth.uid() alone, server-side, inside a security definer function — there is no
-- argument a client can pass to check or move a balance belonging to anyone else. Same posture
-- every other write in this table already takes (see 33_migration_guild_treasury.sql's header).
--
-- Safe to run anytime, including against a deployment with existing rows: every function is
-- created with or-replace, withdraw_guild_member_earnings is a brand new function nothing
-- previously called, and author_balance_kobo's added term is 0 for every writer who has never
-- released guild-held earnings — this doesn't change any existing balance on deployment.

-- ============================================================================================
-- Balances — "mine, in this one guild" versions of the existing guild-wide member-earnings
-- queries, scoped to auth.uid() the same way guild_treasury_summary()'s existing
-- member_earnings_mine_kobo field already computes inline. Pulled into their own functions here
-- so withdraw_guild_member_earnings() and guild_member_earnings_summary() both use the exact
-- same definition rather than two copies of the same query drifting apart.
-- ============================================================================================

-- Available: settled credits minus anything already released or in flight — what's actually
-- withdrawable right now. Same shape as guild_treasury_member_earnings_kobo(), just scoped to
-- the caller instead of every member of the guild combined.
create or replace function guild_treasury_member_earnings_mine_kobo(p_guild_id uuid)
returns bigint as $$
  select
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid()
                and direction = 'credit' and status = 'success'), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid()
                and direction = 'debit' and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

-- Pending: the caller's own member-bucket rows in this guild still waiting on settlement —
-- mirrors guild_treasury_pending_kobo()'s "any status = 'pending' row counts, regardless of
-- direction" convention, just scoped to one member instead of the whole guild.
create or replace function guild_treasury_member_pending_kobo(p_guild_id uuid)
returns bigint as $$
  select coalesce(sum(amount_kobo), 0) from guild_treasury_transactions
  where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid() and status = 'pending';
$$ language sql stable security definer set search_path = public;

-- Lifetime: every kobo this member has ever been credited in this guild's treasury, gross —
-- never reduced by a later release. "Lifetime earnings" means what was earned, not what's still
-- held.
create or replace function guild_treasury_member_lifetime_kobo(p_guild_id uuid)
returns bigint as $$
  select coalesce(sum(amount_kobo), 0) from guild_treasury_transactions
  where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid()
    and direction = 'credit' and status = 'success';
$$ language sql stable security definer set search_path = public;

-- One round trip for the Member Earnings panel — same "bundle everything one screen needs into
-- one RPC" shape as guild_treasury_summary() above.
create or replace function guild_member_earnings_summary(p_guild_id uuid)
returns table (
  available_kobo bigint,
  pending_kobo bigint,
  lifetime_kobo bigint
)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this guild.';
  end if;
  return query select
    guild_treasury_member_earnings_mine_kobo(p_guild_id),
    guild_treasury_member_pending_kobo(p_guild_id),
    guild_treasury_member_lifetime_kobo(p_guild_id);
end;
$$;

revoke all on function guild_treasury_member_earnings_mine_kobo(uuid) from public;
revoke all on function guild_treasury_member_pending_kobo(uuid) from public;
revoke all on function guild_treasury_member_lifetime_kobo(uuid) from public;
revoke all on function guild_member_earnings_summary(uuid) from public;
grant execute on function guild_treasury_member_earnings_mine_kobo(uuid) to authenticated;
grant execute on function guild_treasury_member_pending_kobo(uuid) to authenticated;
grant execute on function guild_treasury_member_lifetime_kobo(uuid) to authenticated;
grant execute on function guild_member_earnings_summary(uuid) to authenticated;

-- ============================================================================================
-- withdraw_guild_member_earnings — releases part of the caller's own held-in-trust earnings in
-- one guild's treasury into their own author_balance_kobo (see the migration header above for
-- why this is a release, not a direct bank payout). Same idempotency-key shape as
-- contribute_to_guild_treasury()/spend_from_guild_treasury(): if p_idempotency_key is supplied,
-- a matching row is looked up first and returned as-is on any retry, never moving the kobo
-- twice.
-- ============================================================================================

create or replace function withdraw_guild_member_earnings(
  p_guild_id uuid, p_amount_kobo bigint, p_idempotency_key text default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this guild.';
  end if;
  -- Same lock key contribute_to_guild_treasury() uses (keyed to the writer, not the guild) —
  -- deliberately serializes with a concurrent contribution too, since both read and act on this
  -- same writer's balances.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if guild_treasury_member_earnings_mine_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed your verified available earnings in this guild.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'member', auth.uid(), 'debit', 'release_to_member', p_amount_kobo, 'NGN',
     'member_earnings_held', 'member_balance', 'success', 'Released to your withdrawable balance',
     auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

revoke all on function withdraw_guild_member_earnings(uuid, bigint, text) from public;
grant execute on function withdraw_guild_member_earnings(uuid, bigint, text) to authenticated;

-- ============================================================================================
-- author_balance_kobo — extended once more (same function, same signature, still the one place
-- a writer's withdrawable balance is computed) to add back in any earnings they've released
-- from a guild treasury via withdraw_guild_member_earnings() above. Without this, a release
-- would move the kobo out of member_earnings_kobo but into nowhere — not lost, since the ledger
-- row exists, but not withdrawable from anywhere either.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = check_user_id and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    +
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = check_user_id and kind = 'release_to_member' and status = 'success'), 0);
$$ language sql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
