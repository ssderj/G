-- Fixes: guild_book_feedback had select/insert/delete RLS policies but no update policy at
-- all — fine while nothing in the app ever updated a feedback row, but src/lib/profile.js's
-- propagateDisplayName() (added alongside this migration) now needs to refresh author_name here
-- whenever a writer changes their pen name, the same way it already can on published_books,
-- reviews, fireside_posts, and guild_published_books. Without this policy, that update is
-- silently rejected by RLS (0 rows affected, no error) and old feedback rows would keep
-- showing a writer's previous name indefinitely.
--
-- Author-only, same shape as this table's existing delete policy and every other table's own
-- update policy in schema_phase3.sql/schema_phase7.sql.
--
-- Safe to run more than once: `create policy` below will error on a second run if the policy
-- already exists (Postgres has no `create policy if not exists`) — drop-if-exists first so this
-- matches the safe-to-rerun pattern the other migrations use.

begin;

drop policy if exists "author updates own feedback" on guild_book_feedback;

create policy "author updates own feedback" on guild_book_feedback
  for update using (auth.uid() = author_id);

commit;
