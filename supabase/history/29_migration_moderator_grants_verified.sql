-- Trust-and-safety follow-up: lets a moderator grant/revoke the verified badge from the
-- moderation queue (src/moderation/moderation-queue.jsx), instead of requiring raw SQL for every
-- verification. is_moderator itself stays service_role-only — see protect_admin_profile_columns
-- below — minting a new moderator remains a higher-trust action reserved for you, the deployment
-- operator, specifically so one moderator account can't mint unlimited others.
--
-- Run this after 28_migration_content_ban.sql. Safe to re-run.

drop policy if exists "moderators ban or unban accounts" on profiles;
drop policy if exists "moderators manage other accounts" on profiles;
create policy "moderators manage other accounts" on profiles
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );

-- Replaces protect_admin_profile_columns so a moderator acting on someone ELSE's row may now
-- also change `verified` (previously service_role-only, alongside is_moderator) — see
-- schema.sql's comment on this function for the full reasoning. is_moderator remains locked to
-- service_role in every path, moderator-on-someone-else's-row included.
create or replace function protect_admin_profile_columns()
returns trigger as $$
declare
  acting_is_moderator boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if new.is_moderator is distinct from old.is_moderator then
    new.is_moderator := old.is_moderator;
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
