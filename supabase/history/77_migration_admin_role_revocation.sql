-- ============================================================================================
-- Migration 77: In-app revocation of is_platform_admin / is_moderator, with an audit log.
--
-- Fix-tracker item 7 originally asked for a "manage admins" screen backed by an RPC that both
-- grants AND revokes is_platform_admin/is_moderator. That's a direct reversal of a rule this
-- schema already states on purpose in two places:
--
--   - protect_admin_profile_columns()'s own comment: "an admin can't mint another admin any
--     more than a moderator can mint another moderator."
--   - src/lib/moderation.js's setVerified() comment: "is_moderator itself is NOT grantable this
--     way (or any way from the client) ... minting a moderator stays a service_role-only
--     action."
--
-- That rule caps the blast radius of a compromised admin account: even with full control of an
-- admin's session, an attacker still can't mint themselves (or anyone else) a second admin or
-- moderator account through the app. Reversing it for the sake of a self-service screen would
-- undo that protection.
--
-- Per product decision, this migration takes the middle path: REVOKING is_platform_admin or
-- is_moderator is now possible in-app (an admin account already trusted with real authority
-- removing trust from another account is a fundamentally lower-risk action than minting new
-- trust), but GRANTING either flag still requires the same manual service_role/SQL step it
-- always has — protect_admin_profile_columns is untouched for the grant direction. Every
-- revocation is logged to admin_role_revocations so there's a real audit trail of who removed
-- whose access and why, which is the auditability gap item 7 was actually chasing.
-- ============================================================================================

create table if not exists admin_role_revocations (
  id uuid primary key default gen_random_uuid(),
  -- set null (not cascade) on either side: the log entry should survive even if one of the
  -- accounts involved is later deleted — this is a historical record, not a live reference.
  target_user_id uuid references auth.users(id) on delete set null,
  revoked_by uuid references auth.users(id) on delete set null,
  role text not null check (role in ('moderator', 'platform_admin')),
  reason text check (reason is null or char_length(reason) <= 500),
  created_at timestamptz not null default now()
);

alter table admin_role_revocations enable row level security;

-- Only a platform admin can read the log. No insert/update/delete policy at all — same posture
-- as guild_event_hosting_fee_rates: the only writer is admin_revoke_platform_role() below, a
-- security definer function that inserts as its owner (bypassing RLS the same way
-- set_guild_event_hosting_fee already does for that table), never the client directly.
create policy "admins read the role-revocation log" on admin_role_revocations
  for select using (is_inkroot_admin());

create index if not exists admin_role_revocations_created_idx
  on admin_role_revocations (created_at desc);

-- The only in-app path that can flip is_platform_admin or is_moderator to false. Deliberately
-- one-directional (there is no admin_grant_platform_role) — see this migration's header comment.
create or replace function admin_revoke_platform_role(target_user_id uuid, role text, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  if role = 'moderator' then
    update profiles set is_moderator = false where id = target_user_id;
  else
    update profiles set is_platform_admin = false where id = target_user_id;
  end if;

  insert into admin_role_revocations (target_user_id, revoked_by, role, reason)
  values (target_user_id, auth.uid(), role, nullif(trim(coalesce(reason, '')), ''));
end;
$$;

grant execute on function admin_revoke_platform_role(uuid, text, text) to authenticated;
