-- Migration 102: the daily referral-reversal sweep could never actually run (production audit).
--
-- The bug: reconcile_referral_grants() opens with
--     if coalesce(auth.role(), '') <> 'service_role' then raise exception 'Not authorized.';
-- but its only scheduled caller is pg_cron (see the 'reconcile-referral-grants' schedule), and a
-- cron job has no request context at all — no JWT is set, so auth.role() is NULL, the guard
-- fails, and every 04:00 run raises 'Not authorized.' before touching anything. Migration 59's
-- note that "refunds WERE already being reversed daily" was never true for that reason: a
-- security-definer function runs with its owner's *privileges*, but auth.role()/auth.uid() read
-- the caller's JWT settings, which a cron job doesn't have. reverse_referral_grant(), which the
-- sweep calls, carries the same JWT-based guard and would have refused it too.
--
-- Effect while broken: a referral reward that was granted and whose qualifying purchase was later
-- refunded/charged back was never clawed back automatically, so the referrer kept real,
-- withdrawable Naira the platform fee no longer funded. (The on-demand moderator path through
-- reverse_referral_grant() was unaffected.)
--
-- The fix, kept as narrow as possible:
--   * The guard now also accepts a direct database session as the postgres/supabase_admin login
--     (session_user — unlike current_user, that is NOT changed by security definer, and a request
--     arriving through the API is always the 'authenticator' login, never one of these). A
--     signed-in client or the anon key still can't call this; service_role still can.
--   * Once the guard has passed, the function marks its own transaction as service_role
--     (is_local = true, so it clears itself at the end of the transaction) so the unchanged
--     guard inside reverse_referral_grant() accepts the call. Both the legacy per-claim and the
--     JSON claims setting are set, since auth.role() reads whichever the project's version of
--     Supabase Auth defines.
-- Nothing else changes: same loop, same signals, same idempotency, same return value.
--
-- To verify on a live project after applying this:
--     select jobname, status, return_message, start_time
--       from cron.job_run_details d join cron.job j using (jobid)
--      where j.jobname = 'reconcile-referral-grants' order by start_time desc limit 5;
-- Runs from before this migration should show 'Not authorized.'; runs after should succeed.
-- Safe to run anytime; no data changes.

create or replace function reconcile_referral_grants()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_grant record;
  v_still_eligible boolean;
  v_reversed_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and session_user not in ('postgres', 'supabase_admin') then
    raise exception 'Not authorized.';
  end if;

  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for v_grant in
    select g.id, g.kind, r.referee_id
    from referral_grants g
    join referrals r on r.id = g.referral_id
    where not exists (select 1 from referral_grant_reversals x where x.referral_grant_id = g.id)
  loop
    case v_grant.kind
      when 'reader_purchase' then v_still_eligible := referral_reader_signal(v_grant.referee_id);
      when 'writer_earnings' then v_still_eligible := referral_writer_signal(v_grant.referee_id);
      when 'guild_activity'  then v_still_eligible := referral_guild_signal(v_grant.referee_id);
      else v_still_eligible := true; -- unknown kind: never written by this schema, leave untouched
    end case;

    if not coalesce(v_still_eligible, false) then
      perform reverse_referral_grant(v_grant.id, 'underlying activity no longer qualifies (refund or chargeback)');
      v_reversed_count := v_reversed_count + 1;
    end if;
  end loop;

  return v_reversed_count;
end;
$$;

revoke all on function reconcile_referral_grants() from public;
