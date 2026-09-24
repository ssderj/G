-- Fixes: published_books, reviews, fireside_posts, guild_book_feedback, and guild_published_books
-- each kept their own author_name/reviewer_name column — a copy of the writer's display name,
-- set at write time (src/lib/library.js, library-guild.js) and re-copied by
-- src/lib/profile.js's propagateDisplayName() on every pen name change. That meant one pen name
-- change fanned out into five separate updates, each independently able to fail (best-effort,
-- non-fatal by design — see the old propagateDisplayName comment) and leave a stray old name on
-- a past book, review, Fireside post, or guild listing indefinitely. Five copies of the same fact
-- is also just more surface area than this needs: `profiles` (Phase 4) already holds the one
-- name that matters, keyed by the same id every one of these tables already stores as
-- author_id/reviewer_id.
--
-- Fix: drop the five denormalized columns outright. The application code (as of this migration)
-- no longer writes them and no longer reads them — every function that used to select
-- author_name/reviewer_name now selects the bare id and looks the current name up from
-- `profiles` at read time instead (see src/lib/library.js's withReviewerNames and
-- src/lib/library-guild.js's use of fetchProfileNames). syncProfile() no longer needs
-- propagateDisplayName() at all: since nothing keeps its own copy anymore, a pen name change is
-- visible everywhere the instant the one `profiles` row is updated.
--
-- Safe to run once the application code has already been updated to stop reading these columns
-- (dropping a column an older client still selects would break that client's queries outright,
-- not fail gracefully). If you're upgrading gradually, deploy the updated client first, confirm
-- it's live, then run this. Column drops are irreversible — the values themselves aren't needed
-- afterward (every reader now sources the name from `profiles` instead), but there's no undo
-- once this runs.
--
-- Safe to run more than once: every drop is guarded with `if exists`.

begin;

alter table published_books drop column if exists author_name;
alter table reviews drop column if exists reviewer_name;
alter table fireside_posts drop column if exists author_name;
alter table guild_book_feedback drop column if exists author_name;
alter table guild_published_books drop column if exists author_name;

commit;
