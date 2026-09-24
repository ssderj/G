-- ============================================================================================
-- Migration 107 — closes achievement "wash trading" between accounts that share a device
-- signal (production audit — achievement rewards).
--
-- The bug: naira_achievement_current()'s six purchase-based signals — nairaFirstPurchase/
-- nairaBookCollector/nairaGrandCollector (buyer side) and nairaRookieMerchant/nairaHustler/
-- nairaSeniorMan (seller side) — counted any `purchases` row with status='success' and
-- amount_kobo > 0, with nothing checking whether the buyer and seller were genuinely two
-- different people. Two accounts controlled by the same person (or one person operating a
-- second account) could buy each other's books back and forth purely to farm these signals,
-- then call grant_naira_achievement() to convert the count into real, withdrawable Naira via
-- achievement_grants -> author_balance_kobo(). The referral system already closed the
-- equivalent hole for itself (grant_referral_reward() calls referral_devices_linked() before
-- paying anything out); this table's own device_signals data was never reused for achievements.
--
-- The fix: a purchase only counts toward a buyer-side or seller-side achievement signal if the
-- OTHER party on that row has never signed in from a device this account has also signed in
-- from (device_signals, populated on every sign-in by shared-utils/device-signal.js — the same
-- soft correlation signal moderation already relies on, see fetchDeviceCorrelation). This is a
-- signal, not a hard ban, same posture the referral system's own version of this check takes:
-- it can't stop two genuinely different people who happen to share a device (a household, a
-- library computer) from ever transacting, but it does stop a single person's own two accounts,
-- signed in from the same browser/device at some point, from ever paying each other for
-- achievement credit.
--
-- accounts_share_device_signal() is a standalone function (not achievement- or referral-
-- specific) with the same query shape referral_devices_linked() already uses, so both features
-- can call it without either depending on the other's vocabulary. referral_devices_linked()
-- itself is left exactly as it was — no behavior change there, this migration only adds a new,
-- symmetric helper for achievements to use.
--
-- Safe to run anytime; no data changes, no new columns. A previously-granted achievement is
-- NOT retroactively revoked by this migration — grant_naira_achievement() is idempotent and
-- only ever checked at the moment a NEW grant is requested, same as every other achievement/
-- referral grant in this schema. Clawing back an already-paid grant that turns out to have been
-- wash-traded is a moderation action (mirroring reverse_referral_grant()), not something this
-- fix does automatically.
-- ============================================================================================

create or replace function accounts_share_device_signal(p_user_id_a uuid, p_user_id_b uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from device_signals a
    join device_signals b on b.device_id = a.device_id
    where a.user_id = p_user_id_a and b.user_id = p_user_id_b
  );
$$;

revoke all on function accounts_share_device_signal(uuid, uuid) from public;
grant execute on function accounts_share_device_signal(uuid, uuid) to authenticated;

create or replace function naira_achievement_current(p_achievement_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), author_id);
    when 'nairaBookCollector' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), author_id);
    when 'nairaGrandCollector' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), author_id);
    when 'nairaRookieMerchant' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), buyer_id);
    when 'nairaHustler' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), buyer_id);
    when 'nairaSeniorMan' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0
        and not accounts_share_device_signal(auth.uid(), buyer_id);
    when 'nairaFirstPublication' then
      select (case when exists (
        select 1 from published_books where author_id = auth.uid() and word_count >= 30000
        union all
        select 1 from guild_published_books where author_id = auth.uid() and word_count >= 30000
      ) then 1 else 0 end) into v_result;
    when 'nairaFirstBook' then
      select (case when sync_writing_credit_ledger() >= 30000 then 1 else 0 end) into v_result;
    when 'nairaDedicatedWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaMasterWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaReader' then
      select coalesce(sum(minutes), 0) / 60 into v_result
      from reading_heartbeats_daily where user_id = auth.uid();
    when 'nairaLoyal' then
      select naira_longest_activity_streak() into v_result;
    else
      v_result := null;
  end case;
  return v_result;
end;
$$;

revoke all on function naira_achievement_current(text) from public;
grant execute on function naira_achievement_current(text) to authenticated;
