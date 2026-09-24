-- 70_migration_published_book_content.sql
--
-- Fixes the headline finding of the production-readiness audit: a reader on a different device
-- than the author's has never been able to actually read a published book. `openReaderBook`
-- (src/shell/ink-root.jsx) only ever read `storage.get(projectKey(id))` — local IndexedDB — so
-- the lookup came back empty for anyone but the author, and the reader screen hung forever on
-- "Opening book…" with no error. `published_books` (see supabase/schema.sql) is the public
-- listing (title/blurb/cover/price) and was always meant to be public; it was never meant to
-- carry manuscript text, so the actual chapters had nowhere to live server-side except the
-- strictly-private `kv_store` (RLS: auth.uid() = user_id).
--
-- Note on access model: this table is intentionally readable by *anyone*, not gated by
-- `purchases`. grand-library-cards.jsx's own BookDetailModal copy says this explicitly —
-- "Tap Buy above to purchase in Naira — reading in full stays free either way" — Buy/tip is
-- how a reader supports an author, not a paywall. `loadSample` in grand-library-cards.jsx
-- ("Peek at the opening") has the exact same local-only bug and is fixed the same way below.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state
-- folded in for fresh installs.

-- ============================================================================================
-- published_book_content — the public, reader-facing mirror of a book's manuscript, written
-- once at publish time (and again on every re-publish). Deliberately a single jsonb blob
-- shaped exactly like what PublishedBookReader (author-reputation.jsx) needs to render —
-- title/subtitle/seriesName/author/cover/storyFormat/chapters — rather than a normalized
-- per-chapter table, since nothing server-side ever needs to query *inside* a chapter (same
-- reasoning kv_store's own top comment gives for staying a blob). Keyed 1:1 to published_books
-- so it always rides along with that row's own lifecycle (unpublish/delete cascades here too).
-- ============================================================================================

create table if not exists published_book_content (
  book_id text primary key references published_books(id) on delete cascade,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  -- Same reasoning and same limit as kv_store's own check above it: bound a single row against
  -- an unbounded/malicious payload, sized generously above what a real manuscript needs.
  check (octet_length(content::text) <= 20971520)
);

alter table published_book_content enable row level security;

-- Anyone can read — this is the whole point of the fix. No purchase check: see the note above,
-- reading is free by product design; Buy/tip is support, not a paywall.
create policy "anyone can read published book content" on published_book_content
  for select using (true);

-- Only the book's own author can write its content, and only while not banned — same shape as
-- "author creates/updates own listings" on published_books itself.
create policy "author writes own book content" on published_book_content
  for insert with check (
    exists (
      select 1 from published_books b
      where b.id = book_id and b.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  );

create policy "author updates own book content" on published_book_content
  for update using (
    exists (
      select 1 from published_books b
      where b.id = book_id and b.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  )
  with check (
    exists (
      select 1 from published_books b
      where b.id = book_id and b.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  );

-- No explicit delete policy: content is only ever removed via the `on delete cascade` from
-- published_books, matching how a listing's own deletion already works.

create or replace function stamp_published_book_content()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists published_book_content_stamp on published_book_content;
create trigger published_book_content_stamp
  before insert or update on published_book_content
  for each row execute function stamp_published_book_content();
