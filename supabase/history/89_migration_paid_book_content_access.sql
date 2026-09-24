-- Migration 89: enforce purchase-gated manuscript access at the database level (release blocker,
-- pre-launch audit finding #1).
--
-- The bug: published_book_content ("anyone can read published book content" — see
-- 70_migration_published_book_content.sql) was, and still is by default, readable by literally
-- anyone with the anon key, regardless of a book's price. lib/library.js's checkBookReadAccess
-- and ink-root.jsx's openReaderBook already gate the APP's own reading UI correctly (free books,
-- a book's own author, and a reader with a status:'success' purchases row all pass; everyone
-- else sees the "locked" screen) — but that's a React-side gate only. Nothing stopped a direct
-- `supabase.from('published_book_content').select('content').eq('book_id', ...)` call, or the
-- Grand Library's own "Peek at the opening" sample loader (BookDetailModal's loadSample in
-- grand-library-cards.jsx), from pulling a priced book's ENTIRE manuscript over the wire for
-- free — checkBookReadAccess was never consulted by either the raw table grant or that second
-- call site. This migration closes the table-level hole; the React-side gate is left exactly as
-- it was; it was already correct, just not the whole story.
--
-- Free books (price <= 0) stay exactly as public as they've always been — reading a free book in
-- full was always the product's own design (see grand-library-cards.jsx's "reading in full stays
-- free either way" comment, still true and unchanged), never a bug. Only a priced book's actual
-- text changes behavior here: readable by its own author, or by a buyer with a real
-- status:'success' row in `purchases` for that exact book_id — status flips to 'success' only
-- from the paystack-webhook Edge Function after Paystack itself confirms the charge (see
-- PAYMENTS.md), never from anything a client can claim about its own payment. Everyone else gets
-- no row back for a priced book's content, same as any other RLS-denied read — no error, just an
-- empty result, which is exactly what checkBookReadAccess-driven UI already expects and handles.
--
-- One consequence of dropping the single open "anyone can read" policy: BookDetailModal's sample
-- preview ("Peek at the opening") used to fall back to this same table for every reader who
-- isn't the author, then truncate to 640 characters client-side — meaning the full text of a
-- priced book was already sitting in that reader's browser memory (and on the wire) before any
-- truncation happened, an incidental second copy of the exact hole above. A locked-down
-- published_book_content can no longer serve that fallback at all for a priced, unpurchased
-- book. published_book_samples below is the fix: a small, always-public, author-written mirror
-- holding ONLY a short opening excerpt — never the full manuscript — kept in sync automatically
-- by a trigger on published_book_content so nothing in src/lib/library.js's write path
-- (publishBookContentRemote) has to change at all; only the sample'sread path does (see
-- fetchPublishedBookSample, added alongside this migration).
-- ============================================================================================

-- published_book_samples — the public "read a sample" mirror. Deliberately tiny (2000-char cap,
-- vs. published_book_content's 20MB full-manuscript cap) and always openly readable regardless
-- of a book's price — previewing the opening of a priced book is marketing for the Buy button,
-- not the paywall itself, same product philosophy as the sample feature already had before this
-- migration, just made safe to expose unconditionally.
create table if not exists published_book_samples (
  book_id text primary key references published_books(id) on delete cascade,
  sample text not null default '' check (char_length(sample) <= 2000),
  updated_at timestamptz not null default now()
);

alter table published_book_samples enable row level security;

create policy "anyone can read published book samples" on published_book_samples
  for select using (true);
-- No client insert/update/delete policy at all, on purpose: the only writer is
-- sync_published_book_sample() below, a security definer trigger function that re-derives the
-- sample itself from published_book_content every time that table changes — never a value a
-- client hands over directly. Deletion rides published_books' own on delete cascade above.

-- Re-derives a short plain-text opening excerpt from a book's full content every time
-- published_book_content is written, and keeps published_book_samples in sync — so the sample
-- a reader sees can never drift from, or leak more than, whatever the author's latest publish
-- actually contains, and no client-supplied "sample" text is ever trusted directly. Walks
-- chapters in order and takes the first one with any real text after stripping markup, mirroring
-- (deliberately approximately, not character-for-character — this is a marketing preview, not an
-- export) the same "first non-empty chapter, HTML stripped" logic grand-library-cards.jsx's own
-- loadSample already used client-side; see shared-utils/strip-html.jsx's stripHtml for the full
-- client-side version this approximates. Truncated to 640 characters, matching the length the
-- client has always truncated a sample display to.
create or replace function sync_published_book_sample()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chapter jsonb;
  v_raw text;
  v_plain text := null;
begin
  if new.content ? 'chapters' and jsonb_typeof(new.content->'chapters') = 'array' then
    for v_chapter in select * from jsonb_array_elements(new.content->'chapters') loop
      v_raw := regexp_replace(coalesce(v_chapter->>'text', ''), '<[^>]+>', ' ', 'g');
      v_raw := regexp_replace(v_raw, '&nbsp;', ' ', 'gi');
      v_raw := btrim(regexp_replace(v_raw, '\s+', ' ', 'g'));
      if char_length(v_raw) > 0 then
        v_plain := v_raw;
        exit;
      end if;
    end loop;
  end if;
  insert into published_book_samples (book_id, sample, updated_at)
  values (new.book_id, coalesce(left(v_plain, 640), ''), now())
  on conflict (book_id) do update set sample = excluded.sample, updated_at = now();
  return new;
end;
$$;

drop trigger if exists published_book_content_sync_sample on published_book_content;
create trigger published_book_content_sync_sample
  after insert or update on published_book_content
  for each row execute function sync_published_book_sample();

-- Backfill: every book published before this migration has a published_book_content row but no
-- published_book_samples row yet (the trigger above only fires on a future insert/update, i.e.
-- the next time each book is re-published). Re-runs the exact same extraction as the trigger, so
-- readers of an already-published book get a working sample immediately rather than an empty one
-- until its author happens to hit Publish again.
do $$
declare
  r record;
  v_chapter jsonb;
  v_raw text;
  v_plain text;
begin
  for r in select book_id, content from published_book_content loop
    v_plain := null;
    if r.content ? 'chapters' and jsonb_typeof(r.content->'chapters') = 'array' then
      for v_chapter in select * from jsonb_array_elements(r.content->'chapters') loop
        v_raw := regexp_replace(coalesce(v_chapter->>'text', ''), '<[^>]+>', ' ', 'g');
        v_raw := regexp_replace(v_raw, '&nbsp;', ' ', 'gi');
        v_raw := btrim(regexp_replace(v_raw, '\s+', ' ', 'g'));
        if char_length(v_raw) > 0 then
          v_plain := v_raw;
          exit;
        end if;
      end loop;
    end if;
    insert into published_book_samples (book_id, sample, updated_at)
    values (r.book_id, coalesce(left(v_plain, 640), ''), now())
    on conflict (book_id) do update set sample = excluded.sample, updated_at = now();
  end loop;
end $$;

-- The actual fix: replace the single open "anyone can read" policy with three narrower
-- permissive policies (Postgres OR's every applicable permissive select policy together, same
-- pattern purchases' own "buyer reads own" / "author reads sales" pair already uses two policies
-- for) — a request passes if ANY of the three match, so an author reading their own priced book,
-- anyone reading a free book, and a verified buyer reading what they paid for all still work with
-- a single unmodified `supabase.from('published_book_content').select(...).eq('book_id', id)`
-- call; nobody else gets a row back for a priced book.
drop policy if exists "anyone can read published book content" on published_book_content;

create policy "author reads own book content" on published_book_content
  for select using (
    exists (select 1 from published_books b where b.id = book_id and b.author_id = auth.uid())
  );

create policy "free book content is public" on published_book_content
  for select using (
    exists (select 1 from published_books b where b.id = book_id and b.price <= 0)
  );

create policy "purchasers read paid book content" on published_book_content
  for select using (
    exists (
      select 1 from purchases p
      where p.book_id = published_book_content.book_id
        and p.kind = 'book'
        and p.buyer_id = auth.uid()
        and p.status = 'success'
    )
  );
