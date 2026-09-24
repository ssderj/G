-- Migration 85: a real discovery + purchase/download backend for Worldbuilding Packs
-- (fix-tracker item 20).
--
-- Two gaps closed here, found while scoping item 20 against current source rather than trusting
-- the tracker's own description of it:
--
-- 1. DISCOVERY (not mentioned in the tracker item, but a precondition for the rest of it to mean
--    anything): grand-library-screen.jsx's Worldbuilding Packs shelf has only ever been built
--    from `projects.flatMap(...)` — this device's own local `projects` state — never a real
--    cross-author fetch. Unlike published_books (which has fetchDiscoverBooks), there has never
--    been a server-side table for a pack at all. That means, as shipped, a reader can only ever
--    see packs THEY published themselves — another author's pack was never visible to anyone but
--    that author, on any device. `published_packs` below is the missing directory, mirroring
--    published_books' own shape and RLS almost exactly.
--
-- 2. PURCHASE + GATED CONTENT: WorldbuildingPackDetailModal (grand-library-cards.jsx) shows a
--    real pack summary (name/snippet only per entry — see packSummaryForIndex in
--    src/worldbuilding/book-cover.jsx) but ends in a ComingSoonNotice. Per the app owner's own
--    call on this item: content delivery mirrors published_book_content's shape (one jsonb blob,
--    written at publish time) but — unlike that table — is gated by purchase, not open-read. This
--    is a deliberate divergence from the book pattern, not an oversight: published_book_content
--    is intentionally public because reading a book is free by product design (Buy/tip there is
--    support, not a paywall — see that migration's own header). A pack has no such "free to
--    read" story; Buy IS the only gate a pack has, so mirroring published_book_content's
--    open-read policy verbatim would leave nothing left to sell.
--
-- A free pack (price = 0) still goes through the purchases flow rather than skipping it — also
-- the app owner's call, for the same audit-trail consistency purchases already gives every other
-- kind of transaction. Paystack itself won't process a zero-amount charge, so
-- paystack-init-pack-purchase (see that function) writes a `success`, `amount_kobo = 0` row
-- directly instead of ever calling Paystack for a free pack. That's the one existing constraint
-- this migration has to loosen: purchases.amount_kobo's `> 0` check is relaxed to `>= 0` below —
-- book and tip purchases are unaffected (both already refuse to create a purchases row at all
-- for a free book, or below the tip minimum, so neither has ever produced a 0-amount row and
-- neither starts now).

-- ============================================================================================
-- published_packs — the public directory a Worldbuilding Pack never had. `id` is the same
-- "<projectId>:<packKey>" composite string grand-library-screen.jsx already uses locally as
-- `selectedPackKey`, so no new id scheme has to be threaded through the client — a remote row's
-- id lines up with what the UI already computes. `categories` stores exactly the shape
-- packSummaryForIndex() already produces client-side (name/snippet per entry, not full content —
-- see published_pack_content below for that), so the browse card and detail modal keep rendering
-- unchanged whether a pack came from this device's own `projects` or from this table.
-- ============================================================================================

create table if not exists published_packs (
  id text primary key,
  author_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  pack_key text not null,
  title text not null check (char_length(title) <= 200),
  subtitle text check (subtitle is null or char_length(subtitle) <= 200),
  description text check (description is null or char_length(description) <= 2000),
  genre text,
  tags jsonb,
  cover_image_url text,
  -- Same "display-only until a real processor exists" reasoning published_books.price's own
  -- comment gives no longer applies here — Paystack is real (see paystack-init-pack-purchase) —
  -- but the >= 0 floor is the same defensive minimum published_books.price already enforces.
  price numeric default 0 check (price >= 0),
  categories jsonb not null default '[]'::jsonb,
  total_entries integer not null default 0,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table published_packs enable row level security;

create policy "anyone can read published packs" on published_packs
  for select using (true);
create policy "author creates own pack listings" on published_packs
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author updates own pack listings" on published_packs
  for update using (auth.uid() = author_id and not is_banned(auth.uid()))
  with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author deletes own pack listings" on published_packs
  for delete using (auth.uid() = author_id);

create index if not exists published_packs_author_idx on published_packs (author_id);

-- ============================================================================================
-- published_pack_content — the full, downloadable contents of a pack (every selected entry in
-- full, not the name/snippet teaser `categories` above carries). Shaped the same single-jsonb-
-- blob way as published_book_content (see 70_migration_published_book_content.sql) — nothing
-- server-side ever needs to query inside it — but with a purchase check folded into the SELECT
-- policy instead of that table's unconditional "anyone can read": see this migration's own
-- header for why that divergence is deliberate here.
-- ============================================================================================

create table if not exists published_pack_content (
  pack_id text primary key references published_packs(id) on delete cascade,
  content jsonb not null,
  updated_at timestamptz not null default now(),
  check (octet_length(content::text) <= 20971520)
);

alter table published_pack_content enable row level security;

-- A pack's own author can always read their own content (same as an author previewing their own
-- unpublished-elsewhere work); anyone else needs a successful purchases row for this exact pack —
-- the free-pack case is covered too, since paystack-init-pack-purchase writes that same
-- success/pack_id row even when no money moved.
create policy "author or buyer reads pack content" on published_pack_content
  for select using (
    exists (
      select 1 from published_packs pk
      where pk.id = pack_id and pk.author_id = auth.uid()
    )
    or exists (
      select 1 from purchases pu
      where pu.pack_id = published_pack_content.pack_id
        and pu.buyer_id = auth.uid()
        and pu.status = 'success'
    )
  );

create policy "author writes own pack content" on published_pack_content
  for insert with check (
    exists (
      select 1 from published_packs pk
      where pk.id = pack_id and pk.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  );

create policy "author updates own pack content" on published_pack_content
  for update using (
    exists (
      select 1 from published_packs pk
      where pk.id = pack_id and pk.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  )
  with check (
    exists (
      select 1 from published_packs pk
      where pk.id = pack_id and pk.author_id = auth.uid()
    )
    and not is_banned(auth.uid())
  );

-- No explicit delete policy: content is only ever removed via the `on delete cascade` from
-- published_packs, matching published_book_content's own reasoning.

create or replace function stamp_published_pack_content()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists published_pack_content_stamp on published_pack_content;
create trigger published_pack_content_stamp
  before insert or update on published_pack_content
  for each row execute function stamp_published_pack_content();

-- ============================================================================================
-- purchases — add 'pack' as a third kind, alongside 'book'/'tip', and a nullable pack_id
-- (mirrors book_id: set null on the pack's deletion rather than blocking it, same reasoning
-- purchases.book_id's own "on delete set null" already documents — a buyer's purchase history
-- shouldn't disappear just because the thing they bought was later taken down).
-- ============================================================================================

alter table purchases drop constraint if exists purchases_kind_check;
alter table purchases add constraint purchases_kind_check
  check (kind in ('book', 'tip', 'pack'));

alter table purchases add column if not exists pack_id text references published_packs(id) on delete set null;

create index if not exists purchases_pack_id_idx on purchases (pack_id) where pack_id is not null;

-- Loosened for the free-pack case described in this migration's header — a $0 purchases row is
-- now valid. Book and tip purchases never reach 0 (both already refuse to create a row at that
-- amount at the application layer), so this is additive, not a behavior change for either.
alter table purchases drop constraint if exists purchases_amount_kobo_check;
alter table purchases add constraint purchases_amount_kobo_check
  check (amount_kobo >= 0);
