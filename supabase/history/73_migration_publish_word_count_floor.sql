-- 73_migration_publish_word_count_floor.sql
--
-- Closes item 4 of the audit: nothing stopped a user from publishing an empty or near-empty
-- book. The existing word_count >= 30000 / >= 15000 checks scattered elsewhere in this schema
-- (achievement grants, referral rewards, Guild Order manuscript eligibility) only ever gate
-- *other* features' eligibility — none of them run at the actual moment a published_books or
-- guild_published_books row is created. publishBookRemote (src/lib/library.js) and
-- publishBookToGuildRemote (src/lib/library-guild.js) are both plain client upserts governed
-- only by these tables' RLS policies, so the floor has to live there.
--
-- Threshold: 5,000 words. Below the existing 15,000/30,000 bars used elsewhere, deliberately —
-- those gate quality-sensitive features (reputation, achievements, referral payouts); this only
-- exists to block a listing with effectively no content, not to second-guess what counts as a
-- "real" book.
--
-- Two halves, same pairing as the ownership cap in 72_migration_player_guild_ownership_cap.sql:
--   1. Client-side: MIN_PUBLISH_WORDS in src/library/publishing.jsx now blocks Step 1 of the
--      Publishing Wizard for a book target under the floor, with a message showing the writer
--      their actual word count — so in normal use nobody ever reaches the server check below.
--   2. Server-side (this file): the real, unconditional floor. min_publish_word_count() is a
--      single-source-of-truth helper so the number only has to change in one place; both tables'
--      insert AND update policies now check against it — update too, since these tables are
--      written via upsert (an update once the row already exists), and that path previously had
--      no word_count check at all (only `using`, no `with check`).
--
-- Not covered here, and worth a follow-up if it matters: publish_guild_anthology() and its
-- revenue-agreement sibling (see supabase/schema.sql) insert into published_books directly as
-- security-definer functions, which bypass RLS (and therefore the policies changed below)
-- entirely. Their own floor is "at least one approved submission" (word_count = 0 rejected,
-- anything above that accepted) — an anthology could still publish under 5,000 words combined.
-- Left alone here since item 4's own scope is the direct per-author publish flow, not anthology
-- publishing.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.
--
-- IMPORTANT — run the check below FIRST. Any already-published book or guild listing under 5,000
-- words will fail the moment its author's next edit re-triggers an upsert (title change, price
-- change, unpublish/republish, etc.), since the update policy now enforces the floor too. That
-- may be exactly the intent (nudge thin listings to either grow or come down) or may not be —
-- decide before running, this migration doesn't retroactively touch any existing row itself.
--
--   select id, author_id, word_count from published_books where word_count < 5000;
--   select id, guild_id, author_id, word_count from guild_published_books where word_count < 5000;

create or replace function min_publish_word_count()
returns integer as $$
  select 5000;
$$ language sql immutable;

drop policy if exists "author creates own listings" on published_books;
create policy "author creates own listings" on published_books
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()) and word_count >= min_publish_word_count());

drop policy if exists "author updates own listings" on published_books;
create policy "author updates own listings" on published_books
  for update using (auth.uid() = author_id and not is_banned(auth.uid()))
  with check (auth.uid() = author_id and not is_banned(auth.uid()) and word_count >= min_publish_word_count());

drop policy if exists "guild members publish own book to guild" on guild_published_books;
create policy "guild members publish own book to guild" on guild_published_books
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and word_count >= min_publish_word_count()
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "guild members update own guild listing" on guild_published_books;
create policy "guild members update own guild listing" on guild_published_books
  for update using (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and word_count >= min_publish_word_count()
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );
