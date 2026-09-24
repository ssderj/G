-- Trust-and-safety follow-up: a real login ban, and a soft (non-blocking) device-correlation
-- signal to help catch ban evasion via a fresh account. See:
--   - profiles.login_banned and admin_set_login_ban() below for the login ban itself
--   - device_signals below, and shared-utils/device-signal.js, for the correlation signal
--
-- Run this after 29_migration_moderator_grants_verified.sql. Safe to re-run.

alter table profiles add column if not exists login_banned boolean not null default false;
alter table profiles add column if not exists login_ban_reason text check (login_ban_reason is null or char_length(login_ban_reason) <= 500);

-- Replaces protect_admin_profile_columns so it also: (a) locks login_banned/login_ban_reason to
-- the same service_role-only rule as is_moderator, and (b) recognizes the narrow
-- inkroot.trusted_admin_rpc bypass that admin_set_login_ban() (below) uses to write that mirror
-- without needing to run as service_role itself — see schema.sql's comment on this function for
-- the full reasoning.
create or replace function protect_admin_profile_columns()
returns trigger as $$
declare
  acting_is_moderator boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if coalesce(current_setting('inkroot.trusted_admin_rpc', true), '') = 'true' then
    return new;
  end if;
  if new.is_moderator is distinct from old.is_moderator then
    new.is_moderator := old.is_moderator;
  end if;
  if new.login_banned is distinct from old.login_banned then
    new.login_banned := old.login_banned;
  end if;
  if new.login_ban_reason is distinct from old.login_ban_reason then
    new.login_ban_reason := old.login_ban_reason;
  end if;
  select p.is_moderator into acting_is_moderator from profiles p where p.id = auth.uid();
  if coalesce(acting_is_moderator, false) and auth.uid() <> old.id then
    new.pen_name := old.pen_name;
    new.display_name := old.display_name;
    new.avatar_url := old.avatar_url;
  else
    new.banned := old.banned;
    new.ban_reason := old.ban_reason;
    new.verified := old.verified;
  end if;
  return new;
end;
$$ language plpgsql security definer;
-- protect_admin_profile_columns_trigger already exists (from 28_migration_content_ban.sql) and
-- references this function by name, so replacing the function above is all that's needed — no
-- need to re-create the trigger itself.

-- The real login ban — see schema.sql's comment on this function for the full reasoning on why
-- this works as a plain SECURITY DEFINER RPC (callable via supabase.rpc(...) directly from the
-- client) rather than needing a separately-deployed Edge Function or a service-role key on the
-- client.
create or replace function admin_set_login_ban(target_user_id uuid, should_ban boolean, reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from profiles where id = auth.uid() and is_moderator) then
    raise exception 'Only a moderator can change login-ban status.';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'Cannot change your own login-ban status.';
  end if;

  update auth.users set banned_until = case when should_ban then 'infinity'::timestamptz else null end
  where id = target_user_id;

  if should_ban then
    delete from auth.sessions where user_id = target_user_id;
    delete from auth.refresh_tokens where user_id = target_user_id::text;
  end if;

  perform set_config('inkroot.trusted_admin_rpc', 'true', true);
  update profiles set login_banned = should_ban, login_ban_reason = case when should_ban then reason else null end
  where id = target_user_id;
end;
$$;

grant execute on function admin_set_login_ban(uuid, boolean, text) to authenticated;

-- Soft, moderator-facing ban-evasion signal — see schema.sql's comment on this table for the
-- full reasoning on what this is (and, importantly, isn't).
create table if not exists device_signals (
  device_id text not null check (char_length(device_id) <= 100),
  user_id uuid not null references auth.users(id) on delete cascade,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  primary key (device_id, user_id)
);

create index if not exists device_signals_device_id_idx on device_signals (device_id);

alter table device_signals enable row level security;

create policy "a user records their own device signal" on device_signals
  for insert with check (auth.uid() = user_id);
create policy "a user updates their own device signal" on device_signals
  for update using (auth.uid() = user_id);
create policy "moderators read all device signals" on device_signals
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
