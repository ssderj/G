-- Migration 114: no central audit trail for admin/financial actions — settling a withdrawal,
-- revoking an admin, approving an event or force-cancelling one left no record of WHO did it or
-- what changed (production audit, Medium).
--
-- The gap: the security-definer admin functions each did their job and returned. Some kept a
-- narrow log of their own (admin_role_revocations, the hosting-fee history, the reserve ledger),
-- but most kept nothing beyond the row's final state: admin_settle_manual_withdrawal() overwrote
-- the withdrawal with no record of which admin marked a real bank transfer as done;
-- approve_guild_event() / reject_guild_event() recorded reviewed_by but not the previous state;
-- admin_set_login_ban() recorded nothing about the actor at all (only the target's mirror
-- columns). After an incident — a wrongly settled payout, a disputed ban — there was no single
-- place to ask "what did this admin do, and to what?"
--
-- What this adds (no existing behavior, signature, or grant changes):
--   1. admin_audit_log — append-only (update/delete blocked by trigger, same technique as
--      platform_reserve_kobo in migration 113), one row per audited action: actor_id, action,
--      target_table, target_id, previous_state, new_state, amount_kobo, reason, created_at.
--      SELECT is is_inkroot_admin()-only; there is deliberately NO client write policy — the only
--      writer is record_admin_action() below. actor_id / target_id are plain uuids with NO foreign
--      key on purpose: an FK with ON DELETE SET NULL would try to UPDATE a log row when an account
--      is deleted (blocked by the immutability trigger, so the deletion would fail), and a
--      historical record should not depend on the referenced account still existing anyway.
--   2. record_admin_action(...) — the one insert path. security definer, execute revoked from
--      every client role (only other security-definer functions, running as the owner, can call
--      it), and it always stamps actor_id = auth.uid() itself — a caller can't choose who the log
--      says did it. actor_id is null for a call with no JWT (cron / service role).
--   3. withdrawals.settled_by — which admin settled a manual withdrawal, stamped by
--      admin_settle_manual_withdrawal() (null on every withdrawal settled before this migration,
--      and on Paystack-method ones, which no admin settles). Note the writer's own SELECT policy
--      on withdrawals returns this column too, like admin_note already does — it's an admin's
--      user id, not a name; src/lib/payments.js selects explicit columns and never reads it.
--   4. Every admin/money function below is redefined to log. Each body is the latest one in this
--      file, byte-for-byte, plus the added audit lines and the settled_by stamp (marked "Migration 114") — no check, error
--      message, or return value changed:
--        admin_settle_manual_withdrawal   -> 'settle_manual_withdrawal' (with amount_kobo, note)
--        admin_revoke_platform_role       -> 'revoke_platform_role'
--        admin_set_login_ban              -> 'login_ban_set' / 'login_ban_cleared'
--        approve_guild_event              -> 'approve_guild_event'
--        reject_guild_event               -> 'reject_guild_event'
--        approve_guild_event_results      -> 'approve_guild_event_results' (with amount_kobo)
--        reject_guild_event_results       -> 'reject_guild_event_results'
--        admin_cancel_guild_event_dispute -> 'force_cancel_guild_event' (with amount_kobo released)
--      The last one wasn't on the audit's minimum list but is the other admin action that moves
--      money (releases an escrow / the Inkroot prize reserve), so it's included.
--
-- Deliberately NOT audited here: top_up_platform_reserve / withdraw_from_platform_reserve (their
-- own append-only ledger already records every movement, and they run from the SQL editor with no
-- auth.uid()); set_guild_event_hosting_fee (own history table with created_by);
-- reverse_referral_grant / reverse_achievement_grant (own reversal tables; also run from cron);
-- read-only admin_list_* functions.
--
-- The two guild-results functions are gated by guild roles (leader / treasurer / officer), not
-- is_inkroot_admin() — they're logged anyway because approval is what releases the money. What is
-- logged as "who" is whoever actually made the call.
--
-- Not run against a live database from this session. Verify after applying: settle a manual
-- withdrawal and check admin_audit_log has a row with your id as actor_id, the withdrawal's
-- before/after status and its amount_kobo, and withdrawals.settled_by = your id; an
-- `update`/`delete` on admin_audit_log fails with the append-only message; a signed-in
-- non-admin sees zero rows from `select * from admin_audit_log`; calling
-- `select record_admin_action('x','y',null)` from a client session is refused.

-- ----------------------------------------------------------------------------------------------
-- 1. admin_audit_log
-- ----------------------------------------------------------------------------------------------

create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  -- No foreign keys on actor_id / target_id — see this migration's header for why.
  actor_id uuid,
  action text not null,
  target_table text not null,
  target_id uuid,
  previous_state jsonb,
  new_state jsonb,
  amount_kobo bigint check (amount_kobo is null or amount_kobo >= 0),
  reason text,
  created_at timestamptz not null default now()
);

alter table admin_audit_log enable row level security;

drop policy if exists "admins read the audit log" on admin_audit_log;
create policy "admins read the audit log" on admin_audit_log
  for select using (is_inkroot_admin());
-- No insert/update/delete policy at all: record_admin_action() (security definer) is the only
-- writer, and the trigger below makes every row permanent even for that owner.

create index if not exists admin_audit_log_created_idx on admin_audit_log (created_at desc);
create index if not exists admin_audit_log_target_idx on admin_audit_log (target_table, target_id);
create index if not exists admin_audit_log_actor_idx on admin_audit_log (actor_id, created_at desc);

create or replace function forbid_admin_audit_log_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'admin_audit_log is a permanent, append-only record -- rows can never be updated or deleted.';
end;
$$;

drop trigger if exists admin_audit_log_immutable on admin_audit_log;
create trigger admin_audit_log_immutable
  before update or delete on admin_audit_log
  for each row execute function forbid_admin_audit_log_mutation();

-- ----------------------------------------------------------------------------------------------
-- 2. record_admin_action — the one insert path (internal; no client role can execute it)
-- ----------------------------------------------------------------------------------------------

create or replace function record_admin_action(
  p_action text,
  p_target_table text,
  p_target_id uuid,
  p_previous_state jsonb default null,
  p_new_state jsonb default null,
  p_amount_kobo bigint default null,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into admin_audit_log
    (actor_id, action, target_table, target_id, previous_state, new_state, amount_kobo, reason)
  values
    (auth.uid(), p_action, p_target_table, p_target_id, p_previous_state, p_new_state,
     p_amount_kobo, nullif(btrim(coalesce(p_reason, '')), ''));
end;
$$;

revoke all on function record_admin_action(text, text, uuid, jsonb, jsonb, bigint, text)
  from public, anon, authenticated;

-- ----------------------------------------------------------------------------------------------
-- 3. withdrawals.settled_by
-- ----------------------------------------------------------------------------------------------

-- set null (not cascade): deleting an admin's account must not delete or block a financial record.
alter table withdrawals
  add column if not exists settled_by uuid references auth.users(id) on delete set null;

-- ----------------------------------------------------------------------------------------------
-- The functions below are redefinitions — same signatures, so existing grants carry over.
-- ----------------------------------------------------------------------------------------------

-- ----------------------------------------------------------------------------------------------
-- 4. admin_set_login_ban — redefined to log the ban/unban (moderator-gated, as before).
-- ----------------------------------------------------------------------------------------------

create or replace function admin_set_login_ban(target_user_id uuid, should_ban boolean, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_moderator) then
    raise exception 'Only a moderator can change login-ban status.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Cannot change your own login-ban status.';
  end if;

  -- Migration 114: snapshot the mirror columns before anything is changed, for the audit log.
  select jsonb_build_object('login_banned', login_banned, 'login_ban_reason', login_ban_reason)
  into v_prev from profiles where id = target_user_id;

  update auth.users set banned_until = case when should_ban then 'infinity'::timestamptz else null end
  where id = target_user_id;

  if should_ban then
    -- Same technique, and the same residual-token caveat, as purge_expired_account_deletions
    -- further below: this blocks all FUTURE sign-ins and token refreshes immediately, but an
    -- access token already issued before this call keeps working until it naturally expires
    -- (your project's JWT expiry window — Auth settings, default 1 hour). Deleting the
    -- session/refresh token here still matters: without it, the ban would only stop a brand-new
    -- sign-in, not someone who's already signed in and would otherwise just keep refreshing
    -- forever on their existing session.
    delete from auth.sessions where user_id = target_user_id;
    delete from auth.refresh_tokens where user_id = target_user_id::text;
  end if;

  -- Updates the client-readable mirror via the narrow trusted-RPC bypass in
  -- protect_admin_profile_columns above — see that trigger's comment on login_banned. is_local
  -- (the third argument) means this setting is automatically cleared at the end of this
  -- transaction, so it can never leak into any later, unrelated statement.
  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  update profiles set login_banned = should_ban, login_ban_reason = case when should_ban then reason else null end
  where id = target_user_id;

  -- Migration 114: only logged when the target profile exists (v_prev is null otherwise, and
  -- the update above changed nothing worth recording).
  if v_prev is not null then
    perform record_admin_action(
      case when should_ban then 'login_ban_set' else 'login_ban_cleared' end,
      'profiles', target_user_id, v_prev,
      jsonb_build_object('login_banned', should_ban, 'login_ban_reason', case when should_ban then reason else null end),
      null, reason);
  end if;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 5. admin_revoke_platform_role — redefined to log the revocation (in addition to admin_role_revocations).
-- ----------------------------------------------------------------------------------------------

create or replace function admin_revoke_platform_role(target_user_id uuid, role text, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prev jsonb;
  v_new jsonb;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can revoke a platform role.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Cannot revoke your own role.';
  end if;
  if role not in ('moderator', 'platform_admin') then
    raise exception 'Unknown role.';
  end if;

  -- Same narrow, transaction-scoped bypass admin_set_login_ban already uses to update
  -- login_banned through protect_admin_profile_columns's lockdown — see that trigger's own
  -- comment. is_local = true (the third set_config argument) means this can never leak into any
  -- later, unrelated statement.
  select jsonb_build_object('is_moderator', is_moderator, 'is_platform_admin', is_platform_admin)
  into v_prev from profiles where id = target_user_id;

  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  if role = 'moderator' then
    update profiles set is_moderator = false where id = target_user_id;
  else
    update profiles set is_platform_admin = false where id = target_user_id;
  end if;

  insert into admin_role_revocations (target_user_id, revoked_by, role, reason)
  values (target_user_id, auth.uid(), role, nullif(trim(coalesce(reason, '')), ''));

  -- Migration 114: admin_role_revocations above stays the role-specific log; this is the
  -- same event in the one cross-cutting audit trail, with the before/after flags.
  select jsonb_build_object('is_moderator', is_moderator, 'is_platform_admin', is_platform_admin)
  into v_new from profiles where id = target_user_id;
  perform record_admin_action('revoke_platform_role', 'profiles', target_user_id, v_prev, v_new, null, reason);
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 6. approve_guild_event / reject_guild_event — redefined to log the decision.
-- ----------------------------------------------------------------------------------------------

create or replace function approve_guild_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_prev_status text;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can approve a guild event.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'pending_approval' then
    raise exception 'This event is not awaiting approval.';
  end if;

  v_prev_status := v_event.approval_status;
  update guild_events set approval_status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;

  perform record_admin_action('approve_guild_event', 'guild_events', p_event_id,
    jsonb_build_object('approval_status', v_prev_status),
    jsonb_build_object('approval_status', v_event.approval_status, 'reviewed_by', v_event.reviewed_by),
    null, null);
  return v_event;
end;
$$;

create or replace function reject_guild_event(p_event_id uuid, p_reason text)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_prev_status text;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can reject a guild event.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Give a reason so the organizer knows what to fix.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'pending_approval' then
    raise exception 'This event is not awaiting approval.';
  end if;

  -- status is left exactly as create_guild_event_draft set it ('closed') — see the migration
  -- header on why that alone is enough to keep a rejected event unpublished.
  v_prev_status := v_event.approval_status;
  update guild_events set approval_status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
    rejection_reason = trim(p_reason)
  where id = p_event_id
  returning * into v_event;

  perform record_admin_action('reject_guild_event', 'guild_events', p_event_id,
    jsonb_build_object('approval_status', v_prev_status),
    jsonb_build_object('approval_status', v_event.approval_status, 'reviewed_by', v_event.reviewed_by),
    null, v_event.rejection_reason);
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 7. approve_guild_event_results / reject_guild_event_results — redefined to log the decision. NOT admin-gated
-- (a guild leader/treasurer/officer decides these); logged anyway because approval moves real money.
-- ----------------------------------------------------------------------------------------------

create or replace function approve_guild_event_results(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
  v_event guild_events%rowtype;
  v_shares jsonb;
  v_paid bigint;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been submitted for this event yet.';
  end if;
  if v_results.status = 'approved' then
    raise exception 'These results have already been approved.';
  end if;
  if v_results.status <> 'pending_approval' then
    raise exception 'These results were rejected — the organizer must resubmit before they can be approved.';
  end if;

  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can approve event results.';
  end if;
  if auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also approve them.';
  end if;

  select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
  into v_shares
  from jsonb_array_elements(v_results.placements) p;

  -- The one call that actually moves money — every check settle_guild_event() has always made
  -- (locked-agreement exact match, member-only winners, dedup lock, one-settlement-ever) still
  -- applies in full; this function adds the submit/approve workflow around it, not a second way
  -- to move money.
  v_event := settle_guild_event(v_results.guild_id, p_event_id, v_shares);

  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  -- Migration 114: the amount actually distributed is whatever settle_guild_event() just
  -- ledgered as event_revenue for this event (member credits + the guild's own share sum to
  -- the gross exactly, see distribute_guild_revenue) — read back rather than re-derived, so
  -- this can't drift from the money movement it describes.
  select coalesce(sum(amount_kobo), 0) into v_paid from guild_treasury_transactions
  where project_event_id = p_event_id and kind = 'event_revenue' and status = 'success';

  perform record_admin_action('approve_guild_event_results', 'guild_event_results', p_event_id,
    jsonb_build_object('status', v_results.status),
    jsonb_build_object('status', 'approved', 'event_status', v_event.status, 'guild_id', v_results.guild_id),
    nullif(v_paid, 0), null);
  return v_event;
end;
$$;

create or replace function reject_guild_event_results(p_event_id uuid, p_reason text)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been submitted for this event yet.';
  end if;
  if v_results.status <> 'pending_approval' then
    raise exception 'These results have already been decided.';
  end if;
  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can reject event results.';
  end if;
  if auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also reject them.';
  end if;

  update guild_event_results
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = p_reason
  where event_id = p_event_id
  returning * into v_results;

  perform record_admin_action('reject_guild_event_results', 'guild_event_results', p_event_id,
    jsonb_build_object('status', 'pending_approval'),
    jsonb_build_object('status', v_results.status, 'guild_id', v_results.guild_id),
    null, v_results.rejection_reason);
  return v_results;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 8. admin_settle_manual_withdrawal — redefined to stamp withdrawals.settled_by and log the settlement.
-- ----------------------------------------------------------------------------------------------

create or replace function admin_settle_manual_withdrawal(
  p_withdrawal_id uuid, p_new_status text, p_note text default null
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
  v_before withdrawals;
begin
  if not is_inkroot_admin() then
    raise exception 'Only a platform admin can settle a manual withdrawal.';
  end if;
  if p_new_status not in ('success', 'failed') then
    raise exception 'Status must be success or failed.';
  end if;

  select * into v_row from withdrawals where id = p_withdrawal_id for update;
  if not found then
    raise exception 'Withdrawal not found.';
  end if;
  if v_row.method <> 'manual' then
    raise exception 'This withdrawal is not a manual request.';
  end if;
  if v_row.status <> 'pending' then
    raise exception 'This withdrawal has already been settled.';
  end if;

  v_before := v_row;

  update withdrawals
    set status = p_new_status,
        completed_at = now(),
        settled_by = auth.uid(),
        admin_note = p_note,
        failure_reason = case when p_new_status = 'failed' then p_note else null end
    where id = p_withdrawal_id
    returning * into v_row;

  perform record_admin_action('settle_manual_withdrawal', 'withdrawals', v_row.id,
    to_jsonb(v_before), to_jsonb(v_row), v_row.amount_kobo, p_note);
  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 9. admin_cancel_guild_event_dispute — redefined to log the force-cancel and the money it released.
-- ----------------------------------------------------------------------------------------------

create or replace function admin_cancel_guild_event_dispute(p_event_id uuid, p_reason text)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_escrow guild_treasury_transactions%rowtype;
  v_prev_status text;
  v_amount bigint;
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

  -- Migration 113: an Inkroot-hosted event's reserved prize goes back to the available reserve.
  if v_event.host = 'inkroot' then
    perform platform_reserve_release_event(p_event_id);
  end if;

  -- Migration 114: the money this cancellation gave back — the released guild escrow, or the
  -- Inkroot prize reserve row platform_reserve_release_event() just wrote (read back, so an
  -- event created before migration 113 with no reservation correctly logs no amount).
  v_prev_status := v_event.status;
  v_amount := v_escrow.amount_kobo;
  if v_event.host = 'inkroot' then
    select amount_kobo into v_amount from platform_reserve_kobo
    where event_id = p_event_id and kind = 'event_prize_released';
  end if;

  update guild_events set status = 'cancelled', approval_status = 'cancelled', cancelled_at = now(),
    cancelled_by = auth.uid(), cancellation_reason = trim(p_reason)
  where id = p_event_id
  returning * into v_event;

  perform record_admin_action('force_cancel_guild_event', 'guild_events', p_event_id,
    jsonb_build_object('status', v_prev_status),
    jsonb_build_object('status', v_event.status, 'cancelled_by', v_event.cancelled_by),
    v_amount, v_event.cancellation_reason);
  return v_event;
end;
$$;
