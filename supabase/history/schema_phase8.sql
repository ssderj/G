-- Phase 8: real Founder Guild membership, closing the RLS gap flagged in every prior phase's
-- own comments (schema_phase3.sql, schema_phase7.sql): fireside_posts, fireside_reactions,
-- guild_book_feedback, and guild_published_books all read/wrote with "is signed in" as the only
-- server-side check, because there was no membership roster for Founder Guilds to check against
-- (unlike Player Guilds, which got one in schema_phase5.sql). That meant any authenticated writer
-- could read or post into a Founder Guild's Fireside/Bookshelf without ever having joined it.
--
-- Founder Guilds are a fixed, permanent set of ten (see FOUNDER_GUILDS in guild-hall.jsx) rather
-- than rows in a table, so guild_id here stays a plain text id (matching the app's own guild key
-- strings) with a check constraint against that fixed list, instead of a foreign key into a
-- guilds table that doesn't exist.

create table if not exists founder_guild_members (
  guild_id text not null check (guild_id in (
    'fantasy', 'romance', 'scifi', 'historical', 'horror',
    'mystery', 'comedy', 'worldbuilders', 'poetry', 'general'
  )),
  user_id uuid not null references auth.users(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (guild_id, user_id)
);

alter table founder_guild_members enable row level security;

-- Public read, same reasoning as player_guild_members' own select policy — membership itself
-- isn't sensitive (unlike a Player Guild's invite_code), and every policy below needs to check
-- "is this uid a member of this guild_id" regardless of who's asking.
create policy "anyone can read founder guild members" on founder_guild_members
  for select using (true);
create policy "a writer joins a founder guild on their own behalf" on founder_guild_members
  for insert with check (auth.uid() = user_id);
create policy "a writer leaves a founder guild on their own behalf" on founder_guild_members
  for delete using (auth.uid() = user_id);

create index if not exists founder_guild_members_guild_idx on founder_guild_members (guild_id);

-- ---------- Tighten fireside_posts (schema_phase3.sql) ----------

drop policy if exists "signed-in readers read fireside posts" on fireside_posts;
create policy "guild members read fireside posts" on fireside_posts
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers post to fireside" on fireside_posts;
create policy "guild members post to fireside" on fireside_posts
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );

-- update/delete stay author-only, unchanged from schema_phase3.sql.

-- ---------- Tighten fireside_reactions (schema_phase3.sql) ----------
-- This table has no guild_id column of its own — membership is checked by joining back to the
-- post being reacted to.

drop policy if exists "signed-in readers read reactions" on fireside_reactions;
create policy "guild members read reactions" on fireside_reactions
  for select using (
    exists (
      select 1 from fireside_posts p
      join founder_guild_members m on m.guild_id = p.guild_id and m.user_id = auth.uid()
      where p.id = fireside_reactions.post_id
    )
  );

drop policy if exists "a reader adds their own reaction" on fireside_reactions;
create policy "guild members add their own reaction" on fireside_reactions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fireside_posts p
      join founder_guild_members m on m.guild_id = p.guild_id and m.user_id = auth.uid()
      where p.id = fireside_reactions.post_id
    )
  );

-- delete stays own-row-only, unchanged from schema_phase3.sql.

-- ---------- Tighten guild_book_feedback (schema_phase3.sql) ----------

drop policy if exists "signed-in readers read guild feedback" on guild_book_feedback;
create policy "guild members read guild feedback" on guild_book_feedback
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers post guild feedback" on guild_book_feedback;
create policy "guild members post guild feedback" on guild_book_feedback
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

-- update stays author-only but now also re-checks current membership, same as select/insert
-- above — an author who has since left the guild can no longer edit an old feedback row there
-- (see the tightened update policy below). Delete stays plain author-only, unchanged: leaving
-- doesn't need to block a writer from retracting their own already-posted feedback the way it
-- blocks them from editing its content.

drop policy if exists "author updates own feedback" on guild_book_feedback;
create policy "guild members update own feedback" on guild_book_feedback
  for update using (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

-- ---------- Tighten guild_published_books (schema_phase7.sql) ----------

drop policy if exists "signed-in readers read guild published books" on guild_published_books;
create policy "guild members read guild published books" on guild_published_books
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "author publishes own book to a guild" on guild_published_books;
create policy "guild members publish own book to guild" on guild_published_books
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

-- update stays author-only but now also re-checks current membership, same reasoning as
-- guild_book_feedback above — an author who has since left the guild can no longer edit an old
-- listing's title/blurb/cover/etc there. Delete stays plain author-only, unchanged: leaving a
-- guild already has its own path to remove a listing (unpublishBookFromGuildRemote in
-- library-guild.js, scoped to book_id + author_id, no guild_id needed), so this doesn't block
-- that.
drop policy if exists "author updates own guild listing" on guild_published_books;
create policy "guild members update own guild listing" on guild_published_books
  for update using (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

-- delete stays author-only, unchanged.
