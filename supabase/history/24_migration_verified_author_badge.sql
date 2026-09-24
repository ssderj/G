-- Anti-impersonation, piece 2 of 4 (piece 1 was the reserved/lookalike-name protection in
-- shared-utils/identity-safety.js — see that file's comment header for the full picture).
--
-- Adds a `verified` flag to `profiles` that renders as a checkmark badge next to a name (see
-- src/library/author-identity.jsx's PublicIdentityCard and src/library/grand-library-cards.jsx's
-- review list), so a reader has some way to tell a real, confirmed author from an account merely
-- using their name.
--
-- Deliberately NOT self-service: there's no in-app "request verification" flow yet. A deployment
-- operator flips this manually (e.g. via the Supabase SQL editor, signed in as the project
-- owner) after confirming someone's identity through some out-of-band channel — for example:
--   update profiles set verified = true where id = '00000000-0000-0000-0000-000000000000';
-- That's a real scaling limitation (it only works for a small, manually-curated set of authors),
-- but a manually-curated true signal beats an automated one a scammer could game.
--
-- Run this after 23_migration_account_deletion_storage_cleanup.sql on any deployment that
-- already applied it. Safe to re-run.

alter table profiles add column if not exists verified boolean not null default false;

-- The existing "a user updates their own profile" policy (see schema_phase4.sql) is row-scoped,
-- not column-scoped — Postgres RLS has no native per-column restriction, so without this trigger
-- a signed-in user could include `verified: true` in their own profile update and self-verify.
-- This closes that gap: any change to `verified` that didn't come from service_role (i.e. didn't
-- come from an operator working outside the client app) is silently reverted before the write
-- lands. Regular profile edits (name, pen name, avatar) are completely unaffected.
create or replace function protect_verified_column()
returns trigger as $$
begin
  if new.verified is distinct from old.verified and coalesce(auth.role(), '') <> 'service_role' then
    new.verified := old.verified;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_verified_column_trigger on profiles;
create trigger protect_verified_column_trigger
  before update on profiles
  for each row execute function protect_verified_column();
