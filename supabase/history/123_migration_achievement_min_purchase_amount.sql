-- ============================================================================================
-- Migration 123 — closes achievement wash-trading between accounts that have NEVER shared a
-- device, by requiring a purchase to clear a minimum amount before it counts toward a Naira
-- achievement signal (production audit — achievement rewards, follow-up to migration 107).
--
-- The gap: migration 107 made naira_purchase_signal() exclude a purchase when the buyer and
-- seller share a device_signals device, closing same-device wash trading. It put no floor on the
-- purchase amount itself, so two accounts that have never touched the same device — a rented VPS
-- plus a second phone, a friend's account, a throwaway signed up somewhere else — can still
-- round-trip a book priced at, say, ₦1 back and forth as many times as it takes to rack up
-- nairaFirstPurchase/nairaBookCollector/nairaGrandCollector (buyer side) or
-- nairaRookieMerchant/nairaHustler/nairaSeniorMan (seller side), then cash the achievement out
-- through achievement_grants -> author_balance_kobo() for real, withdrawable Naira — at a cost of
-- a few hundred Naira in Paystack fees against a payout worth far more. referral_reward_config's
-- reader_min_purchase_kobo already closed the equivalent hole for referral rewards (migration
-- 56); achievements never got the same floor.
--
-- The fix: naira_purchase_signal()'s buyer-side and seller-side CASE branches each gain
-- `and amount_kobo >= achievement_min_purchase_kobo()`, alongside the existing
-- accounts_share_device_signal() exclusion from migration 107 — both checks now have to pass for
-- a purchase to count. achievement_min_purchase_kobo() reads from a new
-- achievement_reward_config singleton row: moderator read/update only, same singleton shape and
-- trust tier as referral_reward_config and rising_star_config, seeded at 50000 (₦500) — the same
-- floor referral_reward_config already uses for reader_min_purchase_kobo, so a wash-traded
-- purchase now has to actually cost what either scheme already requires to matter.
--
-- A dedicated config table rather than folding this into referral_reward_config: the two floors
-- protect different reward systems (achievements vs. referrals) that a moderator may reasonably
-- want to retune independently, even though they start at the same value today.
--
-- Deliberately NOT retroactive: achievement_grants is append-only and this migration does not
-- touch it or grant_naira_achievement(). reconcile_naira_achievements() (migration 110) already
-- only reverses a grant when REFUNDS are what pulled its live count under target — it compares
-- v_now (status = 'success' only) against v_with_refunds (also counts 'refunded' rows), and
-- reverses only when v_with_refunds still clears the target. A purchase that now fails the new
-- amount floor is excluded from BOTH v_now and v_with_refunds identically (the floor applies
-- regardless of status), so it can never be what tips that comparison — the same "a rule change
-- since the grant isn't clawed back" behavior migrations 103 and 107 already established for this
-- exact sweep. A moderator can still reverse a specific grant by hand through
-- reverse_achievement_grant() if one looks wash-traded.
--
-- Safe to run anytime. The new table starts with achievement_min_purchase_kobo = 50000: any
-- purchase below that amount stops counting toward a new achievement claim from the moment this
-- migration runs, but nothing already granted is touched.
-- ============================================================================================

-- ============================================================================================
-- Audited but NOT implemented — a third correlation signal (payment-instrument fingerprint):
--
-- Checked supabase/functions/paystack-webhook/index.ts (the only place that flips a purchases
-- row to 'success', on charge.success) and paystack-init-purchase/index.ts. Neither reads nor
-- stores anything from Paystack's charge payload that identifies the payment instrument itself
-- — no authorization_code, card bin/last4, or Paystack `signature` field (Paystack's charge.
-- success payload nests these under `data.authorization`; the webhook only ever reads
-- `event.data.reference`). The `purchases` table (schema.sql, ~line 1760, plus its later
-- `alter table purchases` additions) has no column for any of this either. `bank_accounts.
-- account_number` is a different thing entirely — an author's own saved withdrawal
-- destination, entered directly by that author, not anything captured from a buyer's payment
-- instrument at charge time.
--
-- So there is currently no persisted fingerprint to join purchase rows on, and this migration
-- does not add a `purchase_instruments_linked()` function or invent one — doing so would mean
-- fabricating a correlation signal, not implementing one. Capturing `data.authorization.
-- authorization_code` (and/or bin+last4) on the webhook's charge.success handler and persisting
-- it on `purchases` (or a new payment-instrument table) is real payment-data work — a new
-- column, a backfill question for existing rows, and its own privacy/PCI-adjacent handling
-- decision — not a quick follow-up migration, and is left for a dedicated pass.
--
-- Net effect: as of this migration, accounts_share_device_signal() (migration 107) plus the
-- amount floor above are the only two correlation signals naira_purchase_signal() has. A wash-
-- trading operator running two accounts that have never shared a device AND paying with two
-- genuinely different cards/bank accounts is not caught by anything in this schema today — only
-- the device-signal check and the price floor stand between that pattern and a real payout.
-- ============================================================================================

-- ============================================================================================
-- 1. achievement_reward_config — singleton config row, same shape/trust-tier as
-- referral_reward_config and rising_star_config: moderator read/update only, nothing here is
-- client-writable.
-- ============================================================================================

create table if not exists achievement_reward_config (
  id boolean primary key default true check (id),
  achievement_min_purchase_kobo bigint not null default 50000 check (achievement_min_purchase_kobo >= 0),
  updated_at timestamptz not null default now()
);

insert into achievement_reward_config (id) values (true) on conflict (id) do nothing;

alter table achievement_reward_config enable row level security;

-- Not publicly readable, same reasoning as referral_reward_config/rising_star_config: the exact
-- floor is part of what makes this hard to game, and there's no legitimate reader-facing reason
-- to expose it.
create policy "moderators read achievement reward config" on achievement_reward_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update achievement reward config" on achievement_reward_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- 2. achievement_min_purchase_kobo — reads the floor from achievement_reward_config. Same
-- pattern as referral_fee_share_bps() reading from referral_reward_config: `stable` (not
-- `immutable`), since it reads a table a moderator can update.
-- ============================================================================================

create or replace function achievement_min_purchase_kobo()
returns bigint
language sql stable as $$
  select achievement_min_purchase_kobo from achievement_reward_config;
$$;

-- ============================================================================================
-- 3. naira_purchase_signal — redeclared: same signature and same six ids as migration 110, with
-- the new amount floor added to both branches alongside the existing device-signal exclusion.
-- ============================================================================================

create or replace function naira_purchase_signal(
  p_user_id uuid,
  p_achievement_id text,
  p_include_refunded boolean default false
)
returns bigint
language plpgsql stable security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector' then
      select count(*) into v_result from purchases
      where buyer_id = p_user_id
        and (status = 'success' or (p_include_refunded and status = 'refunded'))
        and kind = 'book' and amount_kobo > 0
        and amount_kobo >= achievement_min_purchase_kobo()
        and not accounts_share_device_signal(p_user_id, author_id);
    when 'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan' then
      select count(*) into v_result from purchases
      where author_id = p_user_id
        and (status = 'success' or (p_include_refunded and status = 'refunded'))
        and kind in ('book', 'pack') and amount_kobo > 0
        and amount_kobo >= achievement_min_purchase_kobo()
        and not accounts_share_device_signal(p_user_id, buyer_id);
    else
      v_result := null;
  end case;
  return v_result;
end;
$$;

-- Unchanged posture from migration 110/111: takes an arbitrary user id, so it is never
-- client-callable directly.
revoke all on function naira_purchase_signal(uuid, text, boolean) from public, anon, authenticated;
