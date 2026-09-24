-- Trust-and-safety follow-up: a content ban. Blocks a moderator-flagged account from publishing
-- a book, posting to Fireside, leaving guild feedback, or writing a review anywhere — enforced by
-- Postgres RLS on every content-creating table, not just checked client-side. This is a content
-- ban, not a login ban: a banned account can still sign in and read. Blocking sign-in itself
-- would need Supabase's Auth Admin API (service-role-only, meaning a server-side function this
-- client-only app doesn't have) — a real limitation worth revisiting if this isn't enough.
--
-- Run this after 27_migration_moderation_queue.sql. Safe to re-run.

alter table profiles add column if not exists banned boolean not null default false;
alter table profiles add column if not exists ban_reason text check (ban_reason is null or char_length(ban_reason) <= 500);

drop policy if exists "moderators ban or unban accounts" on profiles;
create policy "moderators ban or unban accounts" on profiles
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );

-- Replaces protect_verified_column (renamed protect_admin_profile_columns — see schema.sql's
-- comment on this function for the full reasoning) so it also enforces the ban columns' rule:
-- a moderator may set banned/ban_reason on someone ELSE's row (and nothing else on that row);
-- nobody — moderator included — may set it on their OWN row (no self-unbanning).
create or replace function protect_admin_profile_columns()
returns trigger as $$
declare
  acting_is_moderator boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if new.verified is distinct from old.verified then
    new.verified := old.verified;
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
  end if;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists protect_verified_column_trigger on profiles;
drop trigger if exists protect_admin_profile_columns_trigger on profiles;
create trigger protect_admin_profile_columns_trigger
  before update on profiles
  for each row execute function protect_admin_profile_columns();

create or replace function is_banned(check_user_id uuid)
returns boolean as $$
  select coalesce((select p.banned from profiles p where p.id = check_user_id), false);
$$ language sql stable;

-- Every content-creating insert/update policy, re-created with the ban check added. drop+create
-- (not alter) because Postgres has no ALTER POLICY ... ADD CONDITION — this is the only way to
-- change an existing policy's USING/WITH CHECK expression.

drop policy if exists "author creates own listings" on published_books;
create policy "author creates own listings" on published_books
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()));
drop policy if exists "author updates own listings" on published_books;
create policy "author updates own listings" on published_books
  for update using (auth.uid() = author_id and not is_banned(auth.uid()));

drop policy if exists "signed-in readers write their own review" on reviews;
create policy "signed-in readers write their own review" on reviews
  for insert with check (auth.uid() = reviewer_id and not is_banned(auth.uid()));
drop policy if exists "reviewer updates own review" on reviews;
create policy "reviewer updates own review" on reviews
  for update using (auth.uid() = reviewer_id and not is_banned(auth.uid()));

drop policy if exists "guild members post to fireside" on fireside_posts;
create policy "guild members post to fireside" on fireside_posts
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );
drop policy if exists "author updates own post" on fireside_posts;
create policy "author updates own post" on fireside_posts
  for update using (auth.uid() = author_id and not is_banned(auth.uid()));

drop policy if exists "guild members post guild feedback" on guild_book_feedback;
create policy "guild members post guild feedback" on guild_book_feedback
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );
drop policy if exists "guild members update own feedback" on guild_book_feedback;
create policy "guild members update own feedback" on guild_book_feedback
  for update using (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "guild members publish own book to guild" on guild_published_books;
create policy "guild members publish own book to guild" on guild_published_books
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );
drop policy if exists "guild members update own guild listing" on guild_published_books;
create policy "guild members update own guild listing" on guild_published_books
  for update using (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );
