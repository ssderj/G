-- Phase 4: a small public profiles table. Fixes the one real gap flagged in Phase 3's README —
-- fetchFollowers() could only ever return follower ids, since Supabase doesn't expose other
-- users' auth.users data (email, metadata) through a plain query, and the `follows` table itself
-- never had anywhere to put a display name. This is that place.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  pen_name text,
  display_name text,
  avatar_url text,
  updated_at timestamptz not null default now()
);

alter table profiles enable row level security;

-- Public read, same as published_books/reviews/follows — a profile is meant to be visible to
-- anyone (it's what lets a follower list show names at all). Only the profile's own owner can
-- write to it.
create policy "anyone can read profiles" on profiles
  for select using (true);
create policy "a user updates their own profile" on profiles
  for update using (auth.uid() = id);
create policy "a user inserts their own profile" on profiles
  for insert with check (auth.uid() = id);

-- Auto-creates a minimal profile row the moment someone signs up, so the client only ever needs
-- to UPDATE (via src/lib/profile.js's syncProfile) rather than juggling an insert-or-update
-- dance for a row that might not exist yet.
--
-- display_name is seeded with the same non-identifying 'Writer <id8>' fallback
-- authorDisplayName()/fetchProfileNames() already use client-side — NOT the email local-part.
-- profiles is publicly readable (see the select policy above), so anything seeded here is
-- exposed to every other reader until the writer sets a pen name; an email-derived value was
-- exactly the bug migration_scrub_author_email_fallback.sql fixed on every other author-name
-- column (published_books, reviews, fireside_posts, guild_book_feedback,
-- guild_published_books) — this trigger was the one place that fix missed, since those columns
-- are written by the client but this one is written by a DB trigger. See
-- migration_fix_profile_email_seed.sql for the equivalent fix + backfill on deployments that
-- already ran the old version of this trigger.
create or replace function handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, 'Writer ' || substr(new.id::text, 1, 8));
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();
