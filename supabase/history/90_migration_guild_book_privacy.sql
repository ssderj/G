-- Migration 90: Guild privacy — a book published specifically to a Guild must only be
-- readable/discoverable by actual Guild members, never through published_books or
-- published_book_content's own open policies (release blocker #2).
--
-- The bug: publishBookWithDetails (ink-root.jsx) writes EVERY publish — regardless of
-- destination — into published_books (publishBookRemote) and published_book_content
-- (publishBookContentRemote). Both tables' own select policies were "for select using (true)":
-- fully public, by design, for the Grand Library's Discover feed (destination = 'inkroot'). A
-- book published with destination = 'guild' got the exact same open policies, so its listing
-- (title/blurb/cover/price/...) and its ENTIRE manuscript were both world-readable to anyone
-- with the anon key, purchase or membership aside. The app's own UI never surfaces a guild book
-- outside the Guild Bookshelf (fetchDiscoverBooks/fetchPublishedBooksByAuthor both filter to
-- destination = 'inkroot' client-side — see lib/library.js), but that's a UI filter, not a
-- permission boundary: a direct `supabase.from('published_books').select(...)` (no
-- `.eq('destination', ...)` needed) or `.from('published_book_content').select('content')` call
-- returned every guild-only book's full listing and text regardless of who asked.
--
-- guild_published_books (the Guild Bookshelf's own real shelf — see its own header comment
-- earlier in this file) already gates a Founder Guild book's *listing copy* correctly, by real
-- founder_guild_members membership. This migration makes published_books/published_book_content/
-- published_book_samples agree with that same boundary for the SAME book id, instead of leaving
-- a second, fully-open copy of the same content sitting a table over.
--
-- Player Guilds are unaffected either way: guild_published_books' own header already documents
-- Player/Joined Guild bookshelves as local-only, no shared-shelf feature built for them yet — a
-- destination:'guild' book from a Player Guild writer never gets a guild_published_books row at
-- all, so after this migration it's readable by its own author only. That's strictly more
-- correct than the fully-public hole it had before, not a feature regression: nothing in the
-- app ever legitimately showed that book to anyone but its author regardless.
--
-- checkBookReadAccess/fetchPublishedBookContent/openReaderBook (lib/library.js, ink-root.jsx)
-- are unchanged and don't need to be. checkBookReadAccess reads price/author_id from
-- published_books, which for a non-member now comes back as no row (RLS-denied) instead of a
-- real price — a harmless quirk, since its `(book && book.price) || 0` falls through to
-- `{allowed: true, price: 0}` — because the actual manuscript fetch right after it
-- (fetchPublishedBookContent, gated by the same membership check below) still returns no row
-- either, and openReaderBook already shows "book unavailable" for exactly that case, same as any
-- other network/lookup failure. A legitimate guild member's or the book's own author's read of
-- both tables passes normally under the new policies below.
-- ============================================================================================

-- ---------- published_books ----------
-- Replaces the single open "anyone can read published books" policy with four narrower
-- permissive ones (same OR-together pattern Migration 89 used for published_book_content) — a
-- request passes if ANY one matches, so the Grand Library's own public Discover query
-- (`.eq('destination', 'inkroot')`, no auth needed), an author's own Author Studio listing (any
-- destination), a Founder Guild member's Guild Bookshelf lookup, and the moderation queue's
-- 'published_book' report-preview lookup (fetchReportedContentPreview in lib/moderation.js) all
-- keep working unmodified; nobody else gets a row back for a guild-only book.
drop policy if exists "anyone can read published books" on published_books;

create policy "anyone can read grand library books" on published_books
  for select using (destination = 'inkroot' and not removed_by_moderator);

create policy "author reads own book listing" on published_books
  for select using (auth.uid() = author_id);

create policy "guild members read their guild's book listings" on published_books
  for select using (
    destination = 'guild'
    and not removed_by_moderator
    and exists (
      select 1
      from guild_published_books g
      join founder_guild_members m on m.guild_id = g.guild_id and m.user_id = auth.uid()
      where g.book_id = published_books.id
    )
  );

-- Bugfix, pre-launch audit: the four policies above replace what used to be one policy —
-- "anyone can read published books" — that carried `not removed_by_moderator or auth.uid() =
-- author_id` (see migration 78). That condition didn't make it into any of the four
-- replacements below when this migration was first written, so a moderator-removed book quietly
-- became publicly/guild-readable again the moment this migration ran — the takedown stayed
-- recorded in the column but stopped doing anything. Restored above (on "anyone can read grand
-- library books" and this policy) and on the Player Guild sibling in migration 92; the author's
-- own policy intentionally stays unconditional, same as every other table's "author sees their
-- own removed content" carve-out, and the moderator policy below is unconditional on purpose.
-- published_book_content/published_book_samples need no matching edit: their own policies join
-- back to this table, and a subquery is subject to the querying user's RLS on the table it reads,
-- so a row this table now hides from a non-author/non-moderator is invisible to those subqueries
-- too, automatically.

-- Same moderator bypass guild_published_books already carries, so the moderation queue's
-- 'published_book' report preview keeps resolving a book's title/blurb regardless of
-- destination. NOT recreated here on purpose (bugfix, pre-launch audit): migration 78
-- (moderator content removal) already created a policy of this exact name and definition on
-- this table. Re-declaring it here with no `drop policy if exists` first duplicated the name,
-- which Postgres rejects ("policy already exists") — on any deployment that had already applied
-- migration 78, running this migration would fail at this exact statement, aborting before any
-- of the guild-privacy policies below it ever took effect.

-- ---------- published_book_content ----------
-- "free book content is public" (Migration 89) needs the same destination = 'inkroot' scoping —
-- as written it would otherwise still hand out a guild-only book's ENTIRE manuscript to anyone,
-- for free, the moment its price is 0 (the common case: guild books aren't usually priced).
drop policy if exists "free book content is public" on published_book_content;

create policy "free grand library book content is public" on published_book_content
  for select using (
    exists (
      select 1 from published_books b
      where b.id = published_book_content.book_id and b.destination = 'inkroot' and b.price <= 0
    )
  );

-- The missing piece: an actual Founder Guild member reading a book published to THEIR OWN
-- guild's shelf. "author reads own book content" and "purchasers read paid book content" (both
-- Migration 89) are left exactly as they were — both are destination-agnostic on purpose, since
-- authorship or a real purchase proves the right thing regardless of where a book was published.
create policy "guild members read their guild's book content" on published_book_content
  for select using (
    exists (
      select 1
      from published_books b
      join guild_published_books g on g.book_id = b.id
      join founder_guild_members m on m.guild_id = g.guild_id and m.user_id = auth.uid()
      where b.id = published_book_content.book_id and b.destination = 'guild'
    )
  );

-- ---------- published_book_samples ----------
-- The "Peek at the opening" mirror (Migration 89) is derived straight from
-- published_book_content by a trigger, and was just as fully public ("anyone can read published
-- book samples", using (true)) as published_book_content itself used to be — the same leak, just
-- capped at 640 characters instead of the full manuscript. Nothing in the app's own UI ever
-- calls fetchPublishedBookSample for a guild-only book (BookDetailModal only ever opens from the
-- Grand Library's Discover feed or an Author's Hall, both filtered to destination = 'inkroot' —
-- see lib/library.js), but that's the same UI-filter-not-a-permission-boundary gap
-- published_books/published_book_content had, so it gets the same fix here, mirroring the
-- policies above.
drop policy if exists "anyone can read published book samples" on published_book_samples;

create policy "anyone can read grand library book samples" on published_book_samples
  for select using (
    exists (
      select 1 from published_books b
      where b.id = published_book_samples.book_id and b.destination = 'inkroot'
    )
  );

create policy "author reads own book sample" on published_book_samples
  for select using (
    exists (
      select 1 from published_books b
      where b.id = published_book_samples.book_id and b.author_id = auth.uid()
    )
  );

create policy "guild members read their guild's book sample" on published_book_samples
  for select using (
    exists (
      select 1
      from published_books b
      join guild_published_books g on g.book_id = b.id
      join founder_guild_members m on m.guild_id = g.guild_id and m.user_id = auth.uid()
      where b.id = published_book_samples.book_id and b.destination = 'guild'
    )
  );
