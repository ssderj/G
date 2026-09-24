-- Fixes: handle_new_user() (schema_phase4.sql) seeded every new signup's public profiles.display_name
-- with split_part(email, '@', 1) — the part of their email before the '@'. profiles is publicly
-- readable (`select using (true)`), so this exposed part of a writer's email to every other reader
-- until they set a pen name in Settings.
--
-- This is the exact same bug migration_scrub_author_email_fallback.sql already fixed on
-- published_books.author_name, reviews.reviewer_name, fireside_posts.author_name,
-- guild_book_feedback.author_name, and guild_published_books.author_name — those columns are
-- written client-side (App.jsx fell back to user.email, now fixed to fall back to
-- 'Writer <id8>'), so that migration's `like '%@%'` scrub covered all five. profiles.display_name
-- is written server-side by this trigger instead, so it was never touched by that pass. This
-- migration is the equivalent fix for this one remaining column: replace the trigger so future
-- signups get the same 'Writer <id8>' fallback authorDisplayName() already uses everywhere else,
-- then backfill existing rows that still hold an email.
--
-- Detection: same signal as the earlier scrub — an email is the only value that can contain '@'
-- in this column; nothing in the app lets a writer type one into pen_name/display_name directly.
-- Only rows where a writer never set their own display_name are touched — anyone who has since
-- edited their profile (via syncProfile) already overwrote the email-derived value themselves.
--
-- Safe to run more than once: rows already rewritten to 'Writer <id>' no longer contain '@' and
-- won't match a second time.

begin;

create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Writer ' || substr(new.id::text, 1, 8));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

update profiles
set display_name = 'Writer ' || substr(id::text, 1, 8)
where display_name like '%@%';

commit;
