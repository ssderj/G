-- Migration 59: two fixes found during a full audit of the referral reward system (55–58)
-- against ten specific correctness/security requirements. Everything else audited clean; these
-- are the only two gaps found, both scoped narrowly, neither touching money math, RLS, or the
-- withdrawal/purchase/wallet tables at all.
--
-- ================================================================================================
-- FIX 1 — reverse_referral_grant() was missing its execute grant, making the manual/moderator
-- reversal path unreachable from the client.
-- ================================================================================================
--
-- 58_migration_referral_reward_limits_and_anti_abuse.sql wrote reverse_referral_grant() with an
-- internal check explicitly designed to allow TWO callers: `auth.role() = 'service_role'` OR a
-- signed-in user with `profiles.is_moderator = true`. But the migration only wrote
-- `revoke all on function reverse_referral_grant(uuid, text) from public;` and never followed it
-- with a `grant execute ... to authenticated` — the exact two-line pattern every other
-- moderator-callable function in this schema uses (see admin_set_login_ban(), which is otherwise
-- the closest analog: internal is_moderator check, external grant to authenticated so the RPC
-- call can even reach that check).
--
-- Net effect before this fix: a moderator calling supabase.rpc('reverse_referral_grant', {...})
-- from a client gets a Postgres permission-denied error before the function body's own
-- authorization check ever runs — the manual reversal path was completely dead code. The
-- automated path (reconcile_referral_grants(), on its daily pg_cron sweep) was NOT affected by
-- this — it calls reverse_referral_grant() from inside a security-definer function it owns, which
-- executes with the owner's privileges regardless of GRANT/REVOKE on the callee, the same reason
-- create_withdrawal_locked() and create_guild_event_entry_locked() correctly need no explicit
-- service_role grant of their own. So refunds WERE already being reversed daily; only the
-- on-demand moderator override was broken. Fixed by adding the missing grant — no change to the
-- function's own body, its idempotency, or its authorization check.

grant execute on function reverse_referral_grant(uuid, text) to authenticated;

-- ================================================================================================
-- FIX 2 — referral_reward_progress() didn't reflect a reversal, so a referrer's own dashboard
-- kept showing a clawed-back reward as still "unlocked" and counted its kobo in their displayed
-- lifetime-earnings total, forever.
-- ================================================================================================
--
-- author_balance_kobo() has always correctly netted out reversals (58_migration_..._anti_abuse.sql
-- extended it to subtract referral_grant_reversals the same migration that introduced them) — the
-- real, withdrawable balance was never wrong, and create_withdrawal_locked() reads that same
-- function, so nothing here ever let a referrer withdraw clawed-back money. This fix is entirely
-- about referral_reward_progress()'s OWN output — the RPC src/library/referral-dashboard.jsx
-- calls to render "Earned rewards" / "Lifetime referral earnings" / each referral's reward
-- badges — which read naira_reward_kobo straight off referral_grants and never checked
-- referral_grant_reversals at all, so a reversed grant kept reporting unlocked = true with its
-- original, no-longer-real amount, indistinguishably from a still-valid one.
--
-- This is NOT the same thing 58's own header meant by "referral_reward_progress() still shows the
-- original grant as history, same 'ledger is history, balance is the net' split" — that line was
-- about the underlying referral_grants row correctly staying in place forever (append-only, never
-- deleted, so there's always a permanent record a reward WAS granted). Keeping the history row is
-- right and unchanged here. The bug is that "history" and "still true right now" were being
-- collapsed into a single unlocked boolean the client had no way to tell apart, on the one screen
-- whose entire job is telling a referrer how much they've earned.
--
-- Fix: add a `reversed` column (a plain existence check against referral_grant_reversals, same
-- shape every other signal function here already uses) and make `unlocked` mean what the client
-- actually needs it to mean — "you still have this" — false once reversed, rather than "was ever
-- granted." The row itself, and its original naira_reward_kobo, are still returned every time;
-- nothing is hidden, only correctly labeled. Same signature otherwise, same idempotent
-- attempt-then-report shape, same security definer / search_path — only the returns table shape
-- and the two lines computing naira_reward_kobo/unlocked change.

create or replace function referral_reward_progress()
returns table (referral_id uuid, referee_id uuid, kind text, unlocked boolean, naira_reward_kobo bigint, reversed boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral referrals%rowtype;
  v_kind text;
  v_kinds text[] := array['reader_purchase', 'writer_earnings', 'guild_activity'];
begin
  for v_referral in select * from referrals where referrer_id = auth.uid() loop
    foreach v_kind in array v_kinds loop
      begin
        perform grant_referral_reward(v_referral.id, v_kind);
      exception when others then
        null; -- not eligible yet — expected, not an error worth surfacing here
      end;

      referral_id := v_referral.id;
      referee_id := v_referral.referee_id;
      kind := v_kind;

      select g.naira_reward_kobo, (x.id is not null)
        into naira_reward_kobo, reversed
        from referral_grants g
        left join referral_grant_reversals x on x.referral_grant_id = g.id
        where g.referral_id = v_referral.id and g.kind = v_kind;

      reversed := coalesce(reversed, false);
      unlocked := naira_reward_kobo is not null and not reversed;
      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function referral_reward_progress() from public;
grant execute on function referral_reward_progress() to authenticated;

-- Safe to run anytime: FIX 1 only adds a grant (no behavior change for any caller that could
-- already reach the function). FIX 2 is create-or-replace on a function whose only caller,
-- src/lib/referrals.js's fetchReferralRewardProgress(), is updated in the same change to read
-- the new `reversed` field — a deployment that updates the database without yet updating the
-- client keeps working exactly as before, since the client only reads the columns it already
-- knew about (naira_reward_kobo, unlocked) and simply won't surface `reversed` until it's
-- updated. No table, RLS policy, or money-computing function (author_balance_kobo,
-- grant_referral_reward, any *_signal or *_reward_kobo function) is touched by this migration.
