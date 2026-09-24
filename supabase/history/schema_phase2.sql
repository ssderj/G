-- Phase 2: publishing/reviews. Layers on top of Phase 1's kv_store (see schema.sql) — a book's
-- actual content still lives only in kv_store (and locally in IndexedDB), same as today. This
-- table is the *public listing* — the subset of a project's data other readers are allowed to
-- see at all, which is why it's a separate table with its own (much more open) RLS policies
-- rather than just widening kv_store's access.

create table if not exists published_books (
  id text primary key, -- matches the app's own local project id, so no id-mapping layer is needed
  author_id uuid not null references auth.users(id) on delete cascade,
  -- No author_name column: the display name is looked up live from `profiles` (Phase 4) by
  -- author_id whenever a listing is read — see src/lib/library.js. A denormalized copy here
  -- would need re-syncing on every pen name change (see profile.js's syncProfile); reading the
  -- one profiles row directly instead means there's nothing to keep in sync at all.
  title text not null,
  blurb text,
  genre text,
  tags jsonb,
  price numeric default 0,
  destination text not null default 'inkroot', -- 'guild' | 'inkroot' — mirrors the app's own publishStatus values
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table published_books enable row level security;

-- Unlike kv_store, a published listing is meant to be public — that's the entire point of
-- publishing. Only the author can create/modify/remove their own listings, but anyone can read
-- any of them (this is what lets the Grand Library show other people's books at all).
create policy "anyone can read published books" on published_books
  for select using (true);
create policy "author creates own listings" on published_books
  for insert with check (auth.uid() = author_id);
create policy "author updates own listings" on published_books
  for update using (auth.uid() = author_id);
create policy "author deletes own listings" on published_books
  for delete using (auth.uid() = author_id);

create table if not exists reviews (
  id uuid primary key default gen_random_uuid(),
  book_id text not null references published_books(id) on delete cascade,
  reviewer_id uuid not null references auth.users(id) on delete cascade,
  -- No reviewer_name column — same reasoning as published_books.author_name above.
  rating smallint not null check (rating between 1 and 5),
  body text,
  created_at timestamptz not null default now(),
  -- One review per reader per book — matches the original app's local `myRating` concept
  -- (a single rating value per reader), just made real across readers instead of only the
  -- local device.
  unique (book_id, reviewer_id)
);

alter table reviews enable row level security;

create policy "anyone can read reviews" on reviews
  for select using (true);
create policy "signed-in readers write their own review" on reviews
  for insert with check (auth.uid() = reviewer_id);
create policy "reviewer updates own review" on reviews
  for update using (auth.uid() = reviewer_id);
create policy "reviewer deletes own review" on reviews
  for delete using (auth.uid() = reviewer_id);

create table if not exists follows (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id)
);

alter table follows enable row level security;

create policy "anyone can read follows" on follows
  for select using (true);
create policy "a reader manages their own follow" on follows
  for insert with check (auth.uid() = follower_id);
create policy "a reader removes their own follow" on follows
  for delete using (auth.uid() = follower_id);

create index if not exists reviews_book_idx on reviews (book_id);
create index if not exists follows_followee_idx on follows (followee_id);
create index if not exists published_books_author_idx on published_books (author_id);
