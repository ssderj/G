-- Anti-impersonation/trust-and-safety follow-up: adds a real moderator role and the RLS
-- policies it needs, so content_reports (see 25_migration_report_reasons_impersonation_scam.sql)
-- can actually be worked through an in-app moderation queue (src/moderation/moderation-queue.jsx)
-- instead of requiring direct service-role database access for every review.
--
-- Run this after 26_migration_published_books_richer_metadata.sql. Safe to re-run.

-- Same manually-granted, not-self-service model as `verified` (see
-- 24_migration_verified_author_badge.sql) — a deployment operator flips this in the Supabase SQL
-- editor for a trusted account, e.g.:
--   update profiles set is_moderator = true where id = '00000000-0000-0000-0000-000000000000';
alter table profiles add column if not exists is_moderator boolean not null default false;

-- Replaces protect_verified_column so it guards BOTH verified and is_moderator the same way —
-- see schema.sql's comment on this function for the full reasoning.
create or replace function protect_verified_column()
returns trigger as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if new.verified is distinct from old.verified then
      new.verified := old.verified;
    end if;
    if new.is_moderator is distinct from old.is_moderator then
      new.is_moderator := old.is_moderator;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;
-- protect_verified_column_trigger already exists (from 24_migration_verified_author_badge.sql)
-- and references this function by name, so replacing the function above is all that's needed —
-- no need to re-create the trigger itself.

alter table content_reports add column if not exists resolved_by uuid references auth.users(id) on delete set null;
alter table content_reports add column if not exists resolved_at timestamptz;

drop policy if exists "moderators read all reports" on content_reports;
create policy "moderators read all reports" on content_reports
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop policy if exists "moderators update report status" on content_reports;
create policy "moderators update report status" on content_reports
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );

-- Locks every content_reports column except `status` to its existing value for any non-
-- service_role update, and auto-stamps resolved_by/resolved_at from the actual acting
-- moderator's own auth.uid() — see schema.sql's comment on this function for the full reasoning.
create or replace function stamp_report_resolution()
returns trigger as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    new.reporter_id := old.reporter_id;
    new.content_type := old.content_type;
    new.content_id := old.content_id;
    new.guild_id := old.guild_id;
    new.reason := old.reason;
    new.details := old.details;
    new.created_at := old.created_at;
    if new.status is distinct from old.status then
      new.resolved_by := auth.uid();
      new.resolved_at := now();
    else
      new.resolved_by := old.resolved_by;
      new.resolved_at := old.resolved_at;
    end if;
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists stamp_report_resolution_trigger on content_reports;
create trigger stamp_report_resolution_trigger
  before update on content_reports
  for each row execute function stamp_report_resolution();

-- Lets a moderator see the actual reported content in the queue even when they aren't a member
-- of the guild it came from.
drop policy if exists "moderators read all fireside posts" on fireside_posts;
create policy "moderators read all fireside posts" on fireside_posts
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop policy if exists "moderators read all guild feedback" on guild_book_feedback;
create policy "moderators read all guild feedback" on guild_book_feedback
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop policy if exists "moderators read all guild published books" on guild_published_books;
create policy "moderators read all guild published books" on guild_published_books
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
