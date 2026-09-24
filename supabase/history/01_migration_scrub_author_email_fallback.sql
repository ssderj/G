-- Backfill: replace emails stored as author_name/reviewer_name before the client-side fix.
-- Before this fix, publishBookRemote/submitReview/postFiresideMessage/addGuildBookFeedback/
-- publishBookToGuildRemote fell back to `user.email` whenever a writer hadn't set a pen name
-- (user.user_metadata?.penName || user.email) — and all five of these columns are readable by
-- anyone via RLS (`select using (true)` or `auth.uid() is not null`), so any writer without a
-- pen name had their email exposed to every other reader/guildmate. The client now falls back
-- to `Writer <first 8 chars of user id>` instead (same pattern fetchProfileNames already uses
-- for followers) — this migration re-labels the rows that were already written under the old
-- fallback so the public-facing data matches what new rows look like.
--
-- Detection: an email is the only value in these columns that can contain '@' — pen names and
-- display names aren't validated against that character, but nothing in the app lets a writer
-- type one in either, so `like '%@%'` is a safe, cheap signal without needing to know each row's
-- actual email to match against.
--
-- Safe to run more than once: rows already rewritten to 'Writer <id>' no longer contain '@' and
-- won't match a second time.

begin;

update published_books
set author_name = 'Writer ' || substr(author_id::text, 1, 8)
where author_name like '%@%';

update reviews
set reviewer_name = 'Writer ' || substr(reviewer_id::text, 1, 8)
where reviewer_name like '%@%';

update fireside_posts
set author_name = 'Writer ' || substr(author_id::text, 1, 8)
where author_name like '%@%';

update guild_book_feedback
set author_name = 'Writer ' || substr(author_id::text, 1, 8)
where author_name like '%@%';

update guild_published_books
set author_name = 'Writer ' || substr(author_id::text, 1, 8)
where author_name like '%@%';

commit;
