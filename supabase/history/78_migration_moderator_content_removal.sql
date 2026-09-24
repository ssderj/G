-- ============================================================================================
-- Migration 78: Moderator content removal for published_books, fireside_posts, reviews,
-- guild_book_feedback, and book_discussion_posts.
--
-- Closes item 8 of the audit: every is_moderator-gated policy up to now only granted read/update
-- on content_reports and admin config — none granted removal rights over the content itself.
-- The queue's only real levers were changing a report's status, or banning the account behind
-- it (which doesn't retroactively hide anything they already posted, since is_banned() is only
-- ever checked on INSERT/UPDATE, never SELECT). A confirmed scam/plagiarized/harassing post
-- stayed visible indefinitely unless the author deleted it themselves.
--
-- Soft-hide (a `removed_by_moderator` flag plus a filtered SELECT policy), not a hard DELETE —
-- this preserves the row for later investigation (repeat-offender patterns, appeals, undoing a
-- mistaken removal) instead of destroying evidence the moment a moderator acts. The author can
-- still see their own removed content (so it doesn't just vanish on them without explanation);
-- everyone else can't; a moderator can always see everything, removed or not.
--
-- The tricky part isn't hiding content, it's making sure the new moderator-scoped UPDATE policy
-- can ONLY flip that one flag and nothing else — Postgres RLS has no native per-column
-- restriction (this schema hits that same wall in protect_admin_profile_columns above, for
-- profiles). protect_content_from_moderator_edits() below is that trigger's sibling for content
-- tables: one generic, parameterized function (the owning column name is passed in per-table via
-- TG_ARGV) instead of five near-identical copies, since the actual check — "if the caller is a
-- moderator acting on someone else's row, only removed_by_moderator may differ from the old
-- row" — is identical across all five tables.
-- ============================================================================================

alter table published_books add column if not exists removed_by_moderator boolean not null default false;
alter table fireside_posts add column if not exists removed_by_moderator boolean not null default false;
alter table reviews add column if not exists removed_by_moderator boolean not null default false;
alter table guild_book_feedback add column if not exists removed_by_moderator boolean not null default false;
alter table book_discussion_posts add column if not exists removed_by_moderator boolean not null default false;

-- The column-level safety net described above. TG_ARGV[0] is the table's own author/owner
-- column name (author_id for four of the five tables, reviewer_id for reviews) — passed by each
-- CREATE TRIGGER below rather than hardcoded, so this one function covers all five tables.
-- to_jsonb(new) - 'removed_by_moderator' strips that one key before comparing the rest of the
-- row to its old value; if anything else changed, the update is rejected outright.
create or replace function protect_content_from_moderator_edits()
returns trigger
language plpgsql
as $$
declare
  acting_is_moderator boolean;
  author_column text := TG_ARGV[0];
  old_owner uuid;
begin
  select p.is_moderator into acting_is_moderator from profiles p where p.id = auth.uid();
  execute format('select ($1).%I', author_column) into old_owner using old;

  if coalesce(acting_is_moderator, false) and auth.uid() is distinct from old_owner then
    if (to_jsonb(new) - 'removed_by_moderator') is distinct from (to_jsonb(old) - 'removed_by_moderator') then
      raise exception 'A moderator acting on someone else''s content may only change removed_by_moderator.';
    end if;
  end if;

  return new;
end;
$$;

-- ---------- published_books ----------
-- Restricting the existing fully-open read policy means moderators (who need to see removed
-- content too, e.g. to undo a mistaken removal or review a repeat offender's history) need their
-- own bypass — same pattern fireside_posts/guild_book_feedback already use below.
drop policy if exists "anyone can read published books" on published_books;
create policy "anyone can read published books" on published_books
  for select using (not removed_by_moderator or auth.uid() = author_id);
create policy "moderators read all published books" on published_books
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
create policy "moderators remove published books" on published_books
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop trigger if exists protect_from_moderator_edits on published_books;
create trigger protect_from_moderator_edits
  before update on published_books
  for each row execute function protect_content_from_moderator_edits('author_id');

-- ---------- reviews ----------
drop policy if exists "anyone can read reviews" on reviews;
create policy "anyone can read reviews" on reviews
  for select using (not removed_by_moderator or auth.uid() = reviewer_id);
create policy "moderators read all reviews" on reviews
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
create policy "moderators remove reviews" on reviews
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop trigger if exists protect_from_moderator_edits on reviews;
create trigger protect_from_moderator_edits
  before update on reviews
  for each row execute function protect_content_from_moderator_edits('reviewer_id');

-- ---------- fireside_posts ----------
-- The general read policy already excludes non-members entirely; this just adds the removal
-- filter on top of it. "moderators read all fireside posts" already exists (see schema.sql) and
-- needs no change — it's already an unconditional bypass.
drop policy if exists "guild members read fireside posts" on fireside_posts;
create policy "guild members read fireside posts" on fireside_posts
  for select using (
    (not removed_by_moderator or auth.uid() = author_id)
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );
create policy "moderators remove fireside posts" on fireside_posts
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop trigger if exists protect_from_moderator_edits on fireside_posts;
create trigger protect_from_moderator_edits
  before update on fireside_posts
  for each row execute function protect_content_from_moderator_edits('author_id');

-- ---------- guild_book_feedback ----------
-- Same shape as fireside_posts immediately above; "moderators read all guild feedback" already
-- exists unconditionally and needs no change.
drop policy if exists "guild members read guild feedback" on guild_book_feedback;
create policy "guild members read guild feedback" on guild_book_feedback
  for select using (
    (not removed_by_moderator or auth.uid() = author_id)
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );
create policy "moderators remove guild feedback" on guild_book_feedback
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop trigger if exists protect_from_moderator_edits on guild_book_feedback;
create trigger protect_from_moderator_edits
  before update on guild_book_feedback
  for each row execute function protect_content_from_moderator_edits('author_id');

-- ---------- book_discussion_posts ----------
-- This table previously had no UPDATE policy at all (see its own migration's comment: "insert/
-- delete only, no update" — a reader can post as many times as they like, never edit one). This
-- adds the FIRST update policy on the table, and it's moderator-only: an ordinary author still
-- cannot update their own discussion post, only delete it, exactly as before.
drop policy if exists "anyone can read discussion posts" on book_discussion_posts;
create policy "anyone can read discussion posts" on book_discussion_posts
  for select using (not removed_by_moderator or auth.uid() = author_id);
create policy "moderators read all discussion posts" on book_discussion_posts
  for select using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
create policy "moderators remove discussion posts" on book_discussion_posts
  for update using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator)
  );
drop trigger if exists protect_from_moderator_edits on book_discussion_posts;
create trigger protect_from_moderator_edits
  before update on book_discussion_posts
  for each row execute function protect_content_from_moderator_edits('author_id');
