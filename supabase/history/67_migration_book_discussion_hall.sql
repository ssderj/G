-- Migration 67: a real, shared Book Discussion Hall.
--
-- DiscussionHallModal's own comment (grand-library-cards.jsx) has said since it was written:
-- "a real, working thread of the reader's own posts about a book, kept on this device... honestly
-- marked as device-local until Inkroot has a shared backend to carry every reader's posts to
-- every device." This is that backend.
--
-- book_discussion_posts mirrors `reviews` immediately above almost exactly on purpose — same
-- shape of problem (a reader's own content about a book, meant to be visible to every other
-- reader), same answer: `book_id text references published_books(id)` (published_books.id is
-- text, not uuid — it's the app's own local project id, see that table's own comment), open
-- `select` for anyone, insert/delete gated to the post's own author, and the same is_banned()
-- check on insert reviews already uses. The one real difference: reviews are one-per-reader-per-
-- book (upserted), a discussion is an ongoing conversation — so this is insert/delete only, no
-- update, and no uniqueness constraint; a reader can post as many times as they like, same as a
-- Fireside post or a Guild Order passage.
create table if not exists book_discussion_posts (
  id uuid primary key default gen_random_uuid(),
  book_id text not null references published_books(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  body text not null check (char_length(body) > 0 and char_length(body) <= 500),
  created_at timestamptz not null default now()
);

alter table book_discussion_posts enable row level security;

create policy "anyone can read discussion posts" on book_discussion_posts
  for select using (true);
create policy "signed-in readers post their own" on book_discussion_posts
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "authors delete their own posts" on book_discussion_posts
  for delete using (auth.uid() = author_id);

create index if not exists book_discussion_posts_book_idx on book_discussion_posts (book_id, created_at);

-- Enables Realtime for the Discussion Hall — same mechanism the Fireside and (as of migration 66)
-- the Guild Order manuscript use: `postgres_changes` filtered on book_id, subscribed per open
-- modal.
alter publication supabase_realtime add table book_discussion_posts;

-- Backs the Grand Library's "Book Discussion Halls" shelf (grand-library-screen.jsx) — same
-- ranked-ids-then-hydrate-each-via-fetchPublishedBookById shape as Most Read/Trending
-- (compute_most_read/compute_trending), not gated to signed-in callers the way those two are:
-- they guard genuinely sensitive verified purchase/read activity, while a public post *count* on
-- a public book isn't sensitive the same way, so there's no reason to make a signed-out browser
-- fall back to nothing here.
create or replace function most_discussed_books(p_result_limit integer default null)
returns table (book_id text, post_count bigint) as $$
  select book_id, count(*) as post_count
  from book_discussion_posts
  group by book_id
  order by post_count desc
  limit coalesce(p_result_limit, 8)
$$ language sql stable;
