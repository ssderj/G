-- Migration 92: Player Guild books — completes the ordinary-book-to-Guild publishing path for
-- Player Guilds (self-founded or joined), release blocker #1.
--
-- The bug: publishBookWithDetails/setPublishStatus (ink-root.jsx) only ever pushed a
-- destination:'guild' book into guild_published_books when guildProfile.guildType === 'founder'.
-- A Player Guild owner or joined member choosing "Guild" from the exact same Publishing Wizard
-- (writerGuildName/guildAvailableForTarget in publishing.jsx already offer it to any guild type,
-- not just Founder) had their book land in published_books same as anyone else's, but never got
-- a guild_published_books row at all — so after migration 90 locked published_books/
-- published_book_content down to real guild members for destination:'guild', a Player Guild's
-- own book became readable by its author ONLY, full stop. Not a parallel bug: it's the exact
-- same shape migration 90 already fixed for the read side, just never closed on the write side
-- for the guild type that has a real, joinable roster (player_guild_members) to check against.
--
-- The fix uses the SAME architecture guild_published_books/published_books/published_book_content/
-- published_book_samples already use for Founder Guilds — a membership-checked, OR-together
-- permissive policy per table (Postgres ORs multiple permissive policies for the same command
-- together, same pattern migration 90's own header describes) — just checking player_guild_members
-- instead of founder_guild_members. No new table, no new columns, no parallel bookshelf: a Player
-- Guild's books live in the exact same guild_published_books row a Founder Guild's do, keyed by
-- the real player_guilds.id instead of a fixed slug. guild_book_feedback (the Guild Bookshelf's
-- own real feedback thread, opened from the same GuildBookFeedbackModal a Player Guild's shelf now
-- reaches) gets the identical treatment for the same reason — leaving it Founder-only would have
-- let a Player Guild member open a feedback thread on their own guild's book that silently read
-- back empty and rejected every post attempt with an RLS error, a broken half of the same feature
-- this migration is meant to complete.
--
-- guild_id types: founder_guild_members.guild_id is text (a fixed slug); player_guild_members.
-- guild_id is uuid (a real player_guilds.id). guild_published_books/guild_book_feedback's own
-- guild_id column is text (chosen to hold either without a second column — see each table's own
-- header). Every join below casts player_guild_members.guild_id to text for the comparison,
-- exactly the same shape ink-root.jsx's own activeBookshelfGuildId() now sends as a string either
-- way, so no schema change is needed on either side to make the two line up.
-- ============================================================================================

-- ---------- guild_published_books ----------
-- Adds a Player Guild sibling policy alongside each existing Founder Guild one, per action.
-- Nothing about the Founder Guild policies changes.

create policy "player guild members read guild published books" on guild_published_books
  for select using (
    exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

create policy "player guild members publish own book to guild" on guild_published_books
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and word_count >= min_publish_word_count()
    and exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

create policy "player guild members update own guild listing" on guild_published_books
  for update using (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  )
  with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and word_count >= min_publish_word_count()
    and exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

-- Delete stays exactly as-is (plain author-only) — it never checked guild type either.

-- ---------- guild_book_feedback ----------
-- Same per-action sibling-policy treatment, so the feedback thread on a Player Guild's own
-- guild-published book actually works once that book itself is reachable (above).

create policy "player guild members read guild feedback" on guild_book_feedback
  for select using (
    exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

create policy "player guild members post guild feedback" on guild_book_feedback
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

create policy "player guild members update own feedback" on guild_book_feedback
  for update using (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from player_guild_members m
      where m.guild_id::text = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

-- ---------- published_books / published_book_content / published_book_samples ----------
-- Mirrors migration 90's own Founder Guild read policies exactly, checking player_guild_members
-- instead. These are additional permissive SELECT policies (ORed with every existing one on each
-- table, migration 90's Founder Guild policies included) — nothing existing is dropped or
-- narrowed.

create policy "player guild members read their guild's book listings" on published_books
  for select using (
    destination = 'guild'
    and not removed_by_moderator
    and exists (
      select 1
      from guild_published_books g
      join player_guild_members m on m.guild_id::text = g.guild_id and m.user_id = auth.uid()
      where g.book_id = published_books.id
    )
  );

create policy "player guild members read their guild's book content" on published_book_content
  for select using (
    exists (
      select 1
      from published_books b
      join guild_published_books g on g.book_id = b.id
      join player_guild_members m on m.guild_id::text = g.guild_id and m.user_id = auth.uid()
      where b.id = published_book_content.book_id and b.destination = 'guild'
    )
  );

create policy "player guild members read their guild's book sample" on published_book_samples
  for select using (
    exists (
      select 1
      from published_books b
      join guild_published_books g on g.book_id = b.id
      join player_guild_members m on m.guild_id::text = g.guild_id and m.user_id = auth.uid()
      where b.id = published_book_samples.book_id and b.destination = 'guild'
    )
  );

-- ============================================================================================
-- Not run against a live Supabase instance from this session (no network access here, same
-- caveat as items 19-25 in the fix tracker) — apply migration 92 (or re-run schema.sql on a
-- fresh install) and manually verify: a Player Guild owner publishing a completed book with
-- "Guild" as the destination shows up on their own Guild Hall's Bookshelf; a second account that
-- joins that same Player Guild by invite code can see and open the book (and leave feedback) from
-- their own Guild Hall; a signed-out session and a non-member account (including one seated in a
-- DIFFERENT Player Guild or a Founder Guild) get "book unavailable", same as the Founder Guild
-- case migration 90 already covers; the book's own author can always read/edit it regardless of
-- guild.
-- ============================================================================================
