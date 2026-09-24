-- Phase 7: the Guild Bookshelf's actual shelf, made shared. Phase 3 (schema_phase3.sql) made
-- the *feedback* on a guild book real and shared (guild_book_feedback) — but the shelf itself
-- still only ever showed what THIS device had published to the guild, per GuildBookshelf's own
-- ComingSoonNotice: "coming soon" for every current guildmate's own publications. This table is
-- that missing piece.
--
-- Deliberately its own table rather than reusing Phase 2's `published_books`: that table already
-- receives a row whenever a book is published with destination='guild' (see publishBookRemote in
-- library.js), but its RLS is `for select using (true)` — fully public, by design, since it's
-- also what backs the open Grand Library. A Guild Bookshelf book is meant to stay guild-only, so
-- reusing that table would mean either loosening nothing (leaving guild books unreadable by
-- guildmates, the gap this phase closes) or widening a public table's access model to fit a
-- private one. A separate table keeps the Grand Library's public listing exactly as public as it
-- already is, and gives guild books their own, narrower policy — same reasoning Phase 3 used to
-- give guild_book_feedback its own table instead of folding into `reviews`.
--
-- Same scoping caveat as guild_book_feedback and fireside_posts: guild_id is one of the app's
-- own static Founder Guild key strings, not a foreign key, and — since there's still no
-- guild_members roster for Founder Guilds — "signed in" is the only check enforced server-side,
-- not "actually a member of this guild." Closing that gap for real means adding a guild_members
-- table and checking membership here too, the same follow-up already noted in schema_phase3.sql.

create table if not exists guild_published_books (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  book_id text not null, -- matches the app's own local project id, same as published_books.id
  author_id uuid not null references auth.users(id) on delete cascade,
  -- No author_name column — same reasoning as published_books.author_name in schema_phase2.sql.
  title text not null,
  subtitle text,
  series_name text,
  cover jsonb, -- the structured cover object (style/accent/motif/customImageUrl), not a URL
  genre text,
  blurb text,
  tags jsonb,
  word_count integer default 0,
  story_format text default 'book',
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per book per guild — a book can only be published to one guild at a time in the
  -- app's own local model (publishStatus is a single value per project), so this also lets the
  -- API upsert on republish/edit instead of accumulating duplicate rows.
  unique (guild_id, book_id)
);

alter table guild_published_books enable row level security;

create policy "signed-in readers read guild published books" on guild_published_books
  for select using (auth.uid() is not null);
create policy "author publishes own book to a guild" on guild_published_books
  for insert with check (auth.uid() = author_id);
create policy "author updates own guild listing" on guild_published_books
  for update using (auth.uid() = author_id);
create policy "author removes own guild listing" on guild_published_books
  for delete using (auth.uid() = author_id);

create index if not exists guild_published_books_guild_idx on guild_published_books (guild_id, updated_at desc);
