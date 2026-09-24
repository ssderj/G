-- Migration 103: Naira achievements counted free packs and tips as "book purchases"/"sales"
-- (production audit). Money-affecting: every one of these achievements pays real, withdrawable
-- Naira through author_balance_kobo().
--
-- The bug: naira_achievement_current() counted EVERY successful row in `purchases` for the six
-- buyer/seller achievements (First Purchase, Book Collector, Grand Collector, Rookie Merchant,
-- Hustler, Senior Man), with no filter on `kind` or `amount_kobo`:
--   * The UI and product copy promise "Purchase 50 books" / "Make 10 sales"
--     (NAIRA_ACHIEVEMENTS in src/writing/health-checks.jsx) — but a `purchases` row is also a
--     tip (kind = 'tip') or a Worldbuilding Pack (kind = 'pack').
--   * paystack-init-pack-purchase records a FREE pack as an already-settled purchases row with
--     amount_kobo = 0 and — unlike a book — has no "you already own this" check, so one account
--     can "buy" the same free pack again and again (20/hour). A second account that owns the free
--     pack collects the same rows as "sales". Zero cost to either side, and the rewards
--     (up to N5,000 + N10,000 for the buyer, N1,000 + N5,000 + N15,000 for the seller) are
--     withdrawable.
--
-- The fix: the buyer signals now count only real, paid BOOK purchases (kind = 'book',
-- amount_kobo > 0); the seller signals count only paid book or pack sales (amount_kobo > 0, tips
-- excluded). Everything else in this function is copied unchanged from migration 53's version.
-- Grants already written stay as they are (achievement_grants is append-only); this only affects
-- whether a not-yet-granted achievement qualifies from now on.
--
-- NOT changed here, needs a product decision rather than a bug fix: paid purchases between two
-- colluding accounts still count, because nothing at all limits them the way the referral rewards
-- are limited (referral_reward_config: minimum amount, holding period, same-device check, caps —
-- see migration 58). If that matters, the same shape would apply here.
-- Safe to run anytime; no data changes.

create or replace function naira_achievement_current(p_achievement_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0;
    when 'nairaBookCollector' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0;
    when 'nairaGrandCollector' then
      select count(*) into v_result from purchases
      where buyer_id = auth.uid() and status = 'success' and kind = 'book' and amount_kobo > 0;
    when 'nairaRookieMerchant' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0;
    when 'nairaHustler' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0;
    when 'nairaSeniorMan' then
      select count(*) into v_result from purchases
      where author_id = auth.uid() and status = 'success' and kind in ('book', 'pack') and amount_kobo > 0;
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
