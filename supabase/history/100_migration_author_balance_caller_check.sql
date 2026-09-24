-- Migration 100: author_balance_kobo() no longer answers for other people (production audit).
--
-- The bug: author_balance_kobo(check_user_id) is security definer and was granted to
-- `authenticated` with no check on WHO is asking, so any signed-in user could call
-- rpc('author_balance_kobo', { check_user_id: <anyone's uuid> }) and read that person's
-- withdrawable balance. Author ids are public (published_books.author_id), so this needed no
-- guessing.
--
-- The fix: same signature, same arithmetic (copied unchanged from migration 58, the latest
-- definition), plus a caller check. Allowed callers:
--   * the user asking about themselves (client's fetchAvailableBalanceNaira, and
--     contribute_to_guild_treasury/withdraw_guild_member_earnings which pass auth.uid()),
--   * service_role (create_withdrawal_locked / create_manual_withdrawal_locked, which run from
--     Edge Functions with an explicit p_user_id — auth.role() still reflects the real caller
--     inside nested security-definer calls).
-- Converted from `language sql` to plpgsql only so it can raise; still stable, still
-- security definer, same search_path. Safe to run anytime; no data changes.

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
begin
  if check_user_id is distinct from auth.uid() and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  return
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
              where member_id = check_user_id and kind = 'release_to_member' and status = 'success'), 0)
    +
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = check_user_id), 0)
    +
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0)
    -
    coalesce((select sum(x.kobo_reversed) from referral_grant_reversals x
              join referral_grants rg on rg.id = x.referral_grant_id
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0);
end;
$$ language plpgsql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
