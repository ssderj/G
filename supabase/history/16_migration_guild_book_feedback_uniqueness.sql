-- guild_book_feedback had no uniqueness constraint of any kind, unlike its close sibling
-- `reviews` (`unique (book_id, reviewer_id)`, added in schema_phase2.sql). The client's
-- addGuildBookFeedback (src/lib/library-guild.js) did a plain `insert` rather than an `upsert`,
-- so nothing — client or server — stopped the same guild member from posting unlimited feedback
-- rows against the same book, skewing the Guild Bookshelf's feedback view and letting one member
-- flood it.
--
-- Fix: add a `unique (guild_id, book_id, author_id)` constraint, matching `reviews`' shape, and
-- switch the client to `upsert(..., { onConflict: 'guild_id,book_id,author_id' })` (see the
-- accompanying client change) — a member revising their feedback now updates their existing row
-- instead of adding a new one alongside it.
--
-- **Before running this**: if any guild already has duplicate (guild_id, book_id, author_id)
-- rows in guild_book_feedback from before this fix, adding the constraint will fail until those
-- are deduplicated first. This migration keeps only the most recent row per (guild_id, book_id,
-- author_id) and deletes the rest -- run the SELECT below first if you want to review what would
-- be removed before it runs.
--
--   select guild_id, book_id, author_id, count(*)
--   from guild_book_feedback
--   group by guild_id, book_id, author_id
--   having count(*) > 1;
--
-- Safe to run anytime after that; idempotent (guarded by an existence check against
-- pg_constraint below, since Postgres has no `add constraint if not exists`).

delete from guild_book_feedback a
using guild_book_feedback b
where a.guild_id = b.guild_id
  and a.book_id = b.book_id
  and a.author_id = b.author_id
  and a.created_at < b.created_at;

-- Postgres doesn't support `add constraint if not exists` the way it supports `add column if not
-- exists`, so idempotency here is a plain existence check against pg_constraint instead.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'guild_book_feedback_guild_id_book_id_author_id_key'
  ) then
    alter table guild_book_feedback
      add constraint guild_book_feedback_guild_id_book_id_author_id_key
      unique (guild_id, book_id, author_id);
  end if;
end $$;
