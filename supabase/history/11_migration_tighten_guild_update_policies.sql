-- Fixes: when schema_phase8.sql tightened guild_book_feedback's and guild_published_books' read
-- and insert policies to actually check Founder Guild membership (via founder_guild_members),
-- it deliberately left each table's UPDATE policy as plain author-only ("update/delete stay
-- author-only, unchanged" -- see that file's own comments) — so a writer who has since left a
-- Founder Guild could still edit the content of their own old feedback row or guild book
-- listing there, even though they could no longer read the guild's Fireside/Bookshelf, post new
-- feedback, or publish a new listing to it. Low-stakes (same author, already-posted content,
-- not a new post into a guild they've left), but inconsistent with the membership check every
-- other write in this table now gets, and worth closing since it's a small change.
--
-- Fix: re-check current founder_guild_members membership on UPDATE too, same shape as the
-- existing INSERT policy on each table. DELETE stays plain author-only on both tables,
-- unchanged — a writer retracting their own already-posted feedback, or removing their own
-- guild listing (which already has its own membership-independent path — see
-- unpublishBookFromGuildRemote in library-guild.js), doesn't need to be blocked by a membership
-- check the way editing content does.
--
-- See schema_phase8.sql for the same two policies applied to a fresh install.
--
-- Requires founder_guild_members to already exist -- run this after schema_phase8.sql or
-- migration_founder_guild_membership.sql, whichever this deployment used to get that table.
--
-- Safe to run more than once: each policy is dropped before being recreated.

begin;

drop policy if exists "author updates own feedback" on guild_book_feedback;
drop policy if exists "guild members update own feedback" on guild_book_feedback;
create policy "guild members update own feedback" on guild_book_feedback
  for update using (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "author updates own guild listing" on guild_published_books;
drop policy if exists "guild members update own guild listing" on guild_published_books;
create policy "guild members update own guild listing" on guild_published_books
  for update using (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

commit;
