-- Migration 62: manual withdrawals.
--
-- Paystack Transfers (what create_withdrawal_locked()/paystack-withdraw actually pay out through)
-- require a fully verified Paystack business — in Nigeria, that means a registered business with
-- a TIN on file. Purchases and tips don't need that tier (they're just paystack-init-purchase's
-- inline checkout — money coming IN), only paying money OUT does. Until Inkroot's business is
-- verified, every real call to paystack-withdraw's /transfer request would simply be rejected by
-- Paystack.
--
-- This migration adds a second, parallel way for a withdrawal to actually get paid: instead of an
-- automatic Paystack transfer, a platform admin sees the request, sends the money themselves by
-- whatever means (their own bank), and marks it settled by hand. Deliberately NOT a replacement
-- for the Paystack path — create_withdrawal_locked, paystack-withdraw, and the webhook are all
-- untouched, so flipping back to (or alongside) automatic transfers later is just a client-side
-- choice of which withdrawal function to call, not a re-plumb.
--
-- Both paths write to the same `withdrawals` table and are subject to the exact same balance
-- check (author_balance_kobo, under the exact same advisory-lock key) — a manual request reserves
-- the writer's balance exactly as a Paystack one does, so the two can never double-spend against
-- each other.

alter table withdrawals add column if not exists method text not null default 'paystack'
  check (method in ('paystack', 'manual'));

-- Set by a platform admin when settling a manual request — either a short note for their own
-- records on success ("sent via GTB, ref 1234"), or the reason on failure ("account name mismatch,
-- ask the writer to re-add their bank"). Distinct from failure_reason (which already exists for
-- the Paystack path) only in that failure_reason is also mirrored here on a manual rejection, so
-- fetchWithdrawals()'s existing failure display works unchanged for either method.
alter table withdrawals add column if not exists admin_note text
  check (admin_note is null or char_length(admin_note) <= 500);

-- ------------------------------------------------------------------------------------------------
-- create_manual_withdrawal_locked — the manual-path sibling of create_withdrawal_locked
-- (50_migration_economy_security_audit.sql). Identical shape and identical posture: explicit
-- p_user_id rather than auth.uid() because it's called by manual-withdraw using the service-role
-- client (the Edge Function has already authenticated the caller via requireUser before ever
-- reaching this), service-role-only by both the runtime check below and by never being granted to
-- authenticated, same advisory-lock key so it serializes against a Paystack withdrawal attempt,
-- guild treasury contribution, or guild member earnings release for this exact writer.
-- ------------------------------------------------------------------------------------------------

create or replace function create_manual_withdrawal_locked(
  p_user_id uuid, p_bank_account_id uuid, p_amount_kobo bigint
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from bank_accounts where id = p_bank_account_id and user_id = p_user_id) then
    raise exception 'Saved bank account not found.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status, method)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending', 'manual')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_manual_withdrawal_locked(uuid, uuid, bigint) from public;

-- ------------------------------------------------------------------------------------------------
-- admin_list_pending_manual_withdrawals / admin_settle_manual_withdrawal — the review queue.
-- Both gated by is_inkroot_admin() (43_migration_inkroot_events_admin.sql) — the same trust flag
-- and the same "real enforcement is server-side, the UI button is just convenience" posture as
-- every other Inkroot admin action. Unlike create_manual_withdrawal_locked above, these two ARE
-- meant to be called directly by a signed-in admin's own client — settling a request is pure
-- bookkeeping (the actual bank transfer happens outside the app, by hand), not a call to any
-- external API that would need a service-role secret.
-- ------------------------------------------------------------------------------------------------

create or replace function admin_list_pending_manual_withdrawals()
returns table (
  id uuid, user_id uuid, writer_name text, amount_kobo bigint,
  bank_name text, account_number text, account_name text, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only a platform admin can view manual withdrawal requests.';
  end if;
  return query
    select w.id, w.user_id, coalesce(p.pen_name, p.display_name, 'Unnamed writer'), w.amount_kobo,
           b.bank_name, b.account_number, b.account_name, w.created_at
    from withdrawals w
    join bank_accounts b on b.id = w.bank_account_id
    left join profiles p on p.id = w.user_id
    where w.method = 'manual' and w.status = 'pending'
    order by w.created_at asc;
end;
$$;

revoke all on function admin_list_pending_manual_withdrawals() from public;
grant execute on function admin_list_pending_manual_withdrawals() to authenticated;

create or replace function admin_settle_manual_withdrawal(
  p_withdrawal_id uuid, p_new_status text, p_note text default null
)
returns withdrawals
language plpgsql security definer set search_path = public as $$
declare
  v_row withdrawals;
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

  update withdrawals
    set status = p_new_status,
        completed_at = now(),
        admin_note = p_note,
        failure_reason = case when p_new_status = 'failed' then p_note else null end
    where id = p_withdrawal_id
    returning * into v_row;
  return v_row;
end;
$$;

revoke all on function admin_settle_manual_withdrawal(uuid, text, text) from public;
grant execute on function admin_settle_manual_withdrawal(uuid, text, text) to authenticated;
