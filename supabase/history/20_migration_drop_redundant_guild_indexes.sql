-- Three tables (founder_guild_members, player_guild_members, guild_member_stats) each carry a
-- primary key of (guild_id, user_id) *and* a separate single-column index on just guild_id.
-- That second index is pure duplication: a composite btree's leading column already serves a
-- plain "guild_id = X" lookup exactly as well as a dedicated single-column index on that same
-- column would -- Postgres doesn't need a second index to answer that query. All three
-- single-column indexes were never buying any read speed; they were only adding a second index
-- for Postgres to update -- and revalidate the ordering of -- on every insert/delete against
-- these tables (every guild join/leave, every stats push), for zero benefit.
--
-- Safe to run anytime; DROP INDEX IF EXISTS is naturally idempotent, and dropping an index never
-- touches the rows themselves or any other index (including the primary key these once
-- duplicated).

drop index if exists founder_guild_members_guild_idx;
drop index if exists player_guild_members_guild_idx;
drop index if exists guild_member_stats_guild_idx;

-- Separately: reviews_book_idx and follows_followee_idx existed as single-column indexes
-- ((book_id) and (followee_id) respectively), but every caller that uses them
-- (fetchBookStats/fetchAuthorRatingsSummary in library.js; fetchFollowers in library.js) filters
-- on that column *and* orders the result by created_at desc. A single-column index lets Postgres
-- find the matching rows quickly but still has to sort them afterwards; widening each index to
-- include created_at desc lets the database satisfy the filter and the ordering directly from
-- the index, with no separate sort step, as these tables and their review/follower lists grow.
--
-- create index concurrently avoids locking either table against writes while the new index
-- builds -- reviews/follows can both see concurrent inserts from active readers, and this
-- migration shouldn't block those. Can't run inside the same transaction as a plain statement,
-- which is why this migration isn't wrapped in a single `do $$ ... $$` block the way some earlier
-- ones are -- run each statement below individually if your migration runner wraps files in an
-- implicit transaction.
drop index if exists reviews_book_idx;
create index concurrently if not exists reviews_book_idx on reviews (book_id, created_at desc);

drop index if exists follows_followee_idx;
create index concurrently if not exists follows_followee_idx on follows (followee_id, created_at desc);
