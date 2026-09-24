-- Migration 111: no friction between saving a new payout account and withdrawing to it
-- (production audit, High).
--
-- The gap: paystack-save-bank-account verifies that a bank account is real, then the account is
-- immediately withdrawable. Someone who gets into a writer's signed-in session (stolen device,
-- hijacked Google account) could add their own bank account, make it the default, and withdraw the
-- writer's whole balance to it within a minute — before the real owner has any chance to notice.
--
-- What this adds:
--   1. A cooldown. create_withdrawal_locked() and create_manual_withdrawal_locked() now refuse a
--      withdrawal to an account whose bank_accounts.created_at is inside the cooldown window
--      (default 24h): "This payout account was just added — for your security, withdrawals to a
--      newly added account are available after 24 hours". Both call one shared check,
--      assert_bank_account_cooldown_elapsed(), so the two paths can't drift.
--   2. The window is configurable, not hardcoded: payout_security_config (singleton row, same shape
--      as referral_reward_config), readable/updatable only by a platform admin. 0 turns the
--      cooldown off.
--   3. A first-ever exemption, so a brand-new writer's first legitimate withdrawal isn't blocked:
--      an account is exempt when the user has never had any other saved account. "Never" has to
--      survive deletion — bank_accounts allows a client-side DELETE, so without a memory of removals
--      an attacker could delete the victim's saved account and re-add their own as the
--      "first-ever". bank_account_removals (written by a delete trigger, never client-writable)
--      records that; any user who has ever removed an account gets the cooldown on every account
--      they add afterward.
--   4. An alert to the owner whenever an account is added or the default changes. A trigger on
--      bank_accounts writes a `payout_account_changed` row into `notifications` (the existing
--      Author Inbox pattern — push-on-write, delivered live over Realtime). It is a trigger rather
--      than code in paystack-save-bank-account because the default also changes through the
--      set_default_bank_account() RPC, which never touches that Edge Function. The payload carries
--      only the last four digits of the account number, never the full number.
--
-- NOT built: an email. Nothing in this repo sends email (no provider, no secret, no function), and
-- Supabase Auth's admin API can't send arbitrary messages — only its own invite/recovery/magic-link
-- templates. The in-app alert therefore reaches an owner who opens Inkroot; if you want it to
-- reach a compromised owner who doesn't, add a mail provider and send from the same trigger
-- payload (or from a Database Webhook on notifications inserts of this type).
--
-- What the cooldown does NOT do: a takeover of an account that has never saved a bank account is
-- indistinguishable from that writer's first legitimate withdrawal, so that case stays exempt by
-- design (per the audit's own carve-out).
--
-- Also here: set_default_bank_account() now returns early when the target is already the default.
-- Its old body cleared every default and then re-set the target, which would have fired a false
-- "default changed" alert on a no-op tap.
--
-- Safe to run anytime: the new tables start empty, existing accounts are all older than the
-- window (or the exempt first account), and the notifications check constraint only gains a value.

-- ============================================================================================
-- 1. Config
-- ============================================================================================

create table if not exists payout_security_config (
  id boolean primary key default true check (id),
  new_account_cooldown_hours integer not null default 24 check (new_account_cooldown_hours between 0 and 720),
  updated_at timestamptz not null default now()
);

insert into payout_security_config (id) values (true) on conflict (id) do nothing;

alter table payout_security_config enable row level security;

-- Direct is_platform_admin check rather than is_inkroot_admin(): that function returns true when
-- auth.uid() is null, which is right for its server-side callers but not for a policy on a
-- security control.
drop policy if exists "platform admins read payout security config" on payout_security_config;
create policy "platform admins read payout security config" on payout_security_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin));
drop policy if exists "platform admins update payout security config" on payout_security_config;
create policy "platform admins update payout security config" on payout_security_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin));

-- ============================================================================================
-- 2. Removal memory (for the first-ever exemption)
-- ============================================================================================

create table if not exists bank_account_removals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  removed_at timestamptz not null default now()
);

alter table bank_account_removals enable row level security;
-- No policies at all: written only by the trigger below, read only by security-definer functions.

create index if not exists bank_account_removals_user_id_idx on bank_account_removals (user_id);

create or replace function record_bank_account_removal()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- When the whole user is being deleted, bank_accounts rows go with them via ON DELETE CASCADE
  -- and this trigger fires for each — the user row is already gone by then, and inserting a
  -- removal that references it would fail the foreign key and block the deletion.
  if exists (select 1 from auth.users where id = old.user_id) then
    insert into bank_account_removals (user_id) values (old.user_id);
  end if;
  return old;
end;
$$;

drop trigger if exists bank_accounts_record_removal on bank_accounts;
create trigger bank_accounts_record_removal
  after delete on bank_accounts
  for each row execute function record_bank_account_removal();

-- ============================================================================================
-- 3. The cooldown itself
-- ============================================================================================

-- bank_account_withdrawable_at — when withdrawals to this account are allowed. Returns a
-- timestamp in the past (created_at) when no cooldown applies: the cooldown is switched off (0
-- hours), or this is the user's first-ever saved account. Null if the account isn't theirs.
create or replace function bank_account_withdrawable_at(p_user_id uuid, p_bank_account_id uuid)
returns timestamptz
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_created timestamptz;
  v_hours integer;
begin
  select created_at into v_created
  from bank_accounts where id = p_bank_account_id and user_id = p_user_id;
  if not found then
    return null;
  end if;

  -- First-ever exemption: no other account was ever saved before this one, and none was ever
  -- removed (see bank_account_removals above).
  if not exists (
       select 1 from bank_accounts
       where user_id = p_user_id and id <> p_bank_account_id and created_at < v_created
     )
     and not exists (select 1 from bank_account_removals where user_id = p_user_id) then
    return v_created;
  end if;

  select new_account_cooldown_hours into v_hours from payout_security_config;
  return v_created + make_interval(hours => coalesce(v_hours, 24));
end;
$$;

revoke all on function bank_account_withdrawable_at(uuid, uuid) from public, anon, authenticated;

create or replace function assert_bank_account_cooldown_elapsed(p_user_id uuid, p_bank_account_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_at timestamptz;
  v_hours integer;
begin
  v_at := bank_account_withdrawable_at(p_user_id, p_bank_account_id);
  if v_at is null then
    raise exception 'Saved bank account not found.';
  end if;
  if v_at > now() then
    select new_account_cooldown_hours into v_hours from payout_security_config;
    v_hours := coalesce(v_hours, 24);
    raise exception 'This payout account was just added — for your security, withdrawals to a newly added account are available after % hour%.',
      v_hours, case when v_hours = 1 then '' else 's' end;
  end if;
end;
$$;

revoke all on function assert_bank_account_cooldown_elapsed(uuid, uuid) from public, anon, authenticated;

-- create_withdrawal_locked / create_manual_withdrawal_locked — identical to their previous
-- versions (migrations 50 and 62, still the latest) except for the one added check after the
-- "account belongs to this user" test.
create or replace function create_withdrawal_locked(
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
  perform assert_bank_account_cooldown_elapsed(p_user_id, p_bank_account_id);

  perform pg_advisory_xact_lock(hashtext(p_user_id::text));
  if author_balance_kobo(p_user_id) < p_amount_kobo then
    raise exception 'Amount is more than your available balance.';
  end if;

  insert into withdrawals (user_id, bank_account_id, amount_kobo, status)
  values (p_user_id, p_bank_account_id, p_amount_kobo, 'pending')
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function create_withdrawal_locked(uuid, uuid, bigint) from public;

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
  perform assert_bank_account_cooldown_elapsed(p_user_id, p_bank_account_id);

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

-- ============================================================================================
-- 4. Alert the owner when an account is added or the default changes
-- ============================================================================================

alter table notifications drop constraint if exists notifications_type_check;
alter table notifications add constraint notifications_type_check check (type in (
  'new_follower', 'new_review',
  'guild_order_proposal_opened', 'guild_order_chapter_added',
  'guild_order_passage_added', 'guild_order_world_entry_added',
  'guild_event_result_posted',
  'payout_account_changed'
));

create or replace function notify_payout_account_changed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hours integer;
begin
  select new_account_cooldown_hours into v_hours from payout_security_config;

  insert into notifications (recipient_id, type, actor_id, payload)
  values (
    new.user_id, 'payout_account_changed', null,
    jsonb_build_object(
      'change', case when tg_op = 'INSERT' then 'added' else 'default_changed' end,
      'bank_name', new.bank_name,
      'last4', right(new.account_number, 4),
      'is_default', new.is_default,
      -- True only when this account is actually locked right now (a first-ever account, or one
      -- that was already past its window, isn't) — so the alert never warns about a lock that
      -- doesn't exist.
      'cooldown_applies', coalesce(bank_account_withdrawable_at(new.user_id, new.id) > now(), false),
      'cooldown_hours', coalesce(v_hours, 24)
    )
  );
  return new;
end;
$$;

drop trigger if exists bank_accounts_notify_added on bank_accounts;
create trigger bank_accounts_notify_added
  after insert on bank_accounts
  for each row execute function notify_payout_account_changed();

drop trigger if exists bank_accounts_notify_default_changed on bank_accounts;
create trigger bank_accounts_notify_default_changed
  after update of is_default on bank_accounts
  for each row when (new.is_default and not old.is_default)
  execute function notify_payout_account_changed();

-- set_default_bank_account — unchanged except for the early return: re-selecting the account
-- that's already the default is a no-op, not a "default changed" alert.
create or replace function set_default_bank_account(target_account_id uuid)
returns void as $$
begin
  if not exists (select 1 from bank_accounts where id = target_account_id and user_id = auth.uid()) then
    raise exception 'Not your saved bank account';
  end if;
  if exists (select 1 from bank_accounts where id = target_account_id and user_id = auth.uid() and is_default) then
    return;
  end if;
  update bank_accounts set is_default = false where user_id = auth.uid();
  update bank_accounts set is_default = true where id = target_account_id;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function set_default_bank_account(uuid) from public;
grant execute on function set_default_bank_account(uuid) to authenticated;

-- ============================================================================================
-- 5. Hardening carried over from migration 110
-- ============================================================================================

-- naira_purchase_signal (migration 110) takes an arbitrary user id and has no caller check of its
-- own, and `revoke ... from public` alone doesn't remove the direct EXECUTE grants Supabase gives
-- anon/authenticated by default on new public functions. Only the security-definer functions
-- (naira_achievement_current, reconcile_naira_achievements) ever need to call it.
revoke all on function naira_purchase_signal(uuid, text, boolean) from public, anon, authenticated;
