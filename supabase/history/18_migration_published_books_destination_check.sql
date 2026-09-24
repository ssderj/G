-- published_books.destination was a plain, unconstrained text column, documented only in a
-- comment as 'guild' | 'inkroot' — mirroring the app's own publishStatus values (see
-- project-workspace.jsx's handleWizardPublishBook and publishing.jsx's PublishWizard) but never
-- actually enforced. Unlike founder_guild_members.guild_id, which has always had a `check (...
-- in (...))` restricting it to the app's fixed set of guild ids, nothing stopped a row here from
-- holding an arbitrary string.
--
-- Fix: add `check (destination in ('guild', 'inkroot'))`, matching founder_guild_members'
-- pattern.
--
-- **Before running this**: adding a CHECK constraint validates every existing row, so this will
-- fail if any row already holds something other than 'guild' or 'inkroot' (shouldn't happen —
-- nothing in the client has ever written anything else — but check first if you're unsure):
--
--   select id, destination from published_books where destination not in ('guild', 'inkroot');
--
-- Safe to run anytime once no existing row violates it; idempotent (guarded by an existence
-- check against pg_constraint, since Postgres has no `add constraint if not exists`).

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'published_books_destination_check'
  ) then
    alter table published_books
      add constraint published_books_destination_check
      check (destination in ('guild', 'inkroot'));
  end if;
end $$;
