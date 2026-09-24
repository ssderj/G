-- Upgrade path for a deployment that already ran schema.sql through schema_phase7.sql before
-- schema_phase8.sql existed. See schema_phase8.sql's own header for the full rationale — this
-- file is the same change, just wrapped for a database that already has data in it.
--
-- Safe to run more than once: table/index creation uses if-not-exists, and every policy is
-- dropped before being recreated.
--
-- IMPORTANT — read before running: creating founder_guild_members does not, by itself, backfill
-- who's actually in which Founder Guild — that information only ever lived on each writer's own
-- device (guildProfile.founderGuildId in local storage), never server-side, until this phase's
-- client-side change (see src/lib/library-guild.js's syncFounderGuildMembership, wired into
-- ink-root.jsx and sync-context.jsx). Existing users backfill their own membership row
-- automatically the next time their app loads while signed in, or the next time they sign in —
-- no admin action needed. Until a given user's device has done that at least once, the tightened
-- policies below will correctly (if perhaps confusingly, at first) treat them as a non-member of
-- their own Founder Guild. If you'd rather avoid that gap entirely, deploy the updated client
-- first and give it a little time before running this migration.

begin;

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

drop policy if exists "anyone can read founder guild members" on founder_guild_members;
create policy "anyone can read founder guild members" on founder_guild_members
  for select using (true);
drop policy if exists "a writer joins a founder guild on their own behalf" on founder_guild_members;
create policy "a writer joins a founder guild on their own behalf" on founder_guild_members
  for insert with check (auth.uid() = user_id);
drop policy if exists "a writer leaves a founder guild on their own behalf" on founder_guild_members;
create policy "a writer leaves a founder guild on their own behalf" on founder_guild_members
  for delete using (auth.uid() = user_id);

create index if not exists founder_guild_members_guild_idx on founder_guild_members (guild_id);

drop policy if exists "signed-in readers read fireside posts" on fireside_posts;
drop policy if exists "guild members read fireside posts" on fireside_posts;
create policy "guild members read fireside posts" on fireside_posts
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers post to fireside" on fireside_posts;
drop policy if exists "guild members post to fireside" on fireside_posts;
create policy "guild members post to fireside" on fireside_posts
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers read reactions" on fireside_reactions;
drop policy if exists "guild members read reactions" on fireside_reactions;
create policy "guild members read reactions" on fireside_reactions
  for select using (
    exists (
      select 1 from fireside_posts p
      join founder_guild_members m on m.guild_id = p.guild_id and m.user_id = auth.uid()
      where p.id = fireside_reactions.post_id
    )
  );

drop policy if exists "a reader adds their own reaction" on fireside_reactions;
drop policy if exists "guild members add their own reaction" on fireside_reactions;
create policy "guild members add their own reaction" on fireside_reactions
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fireside_posts p
      join founder_guild_members m on m.guild_id = p.guild_id and m.user_id = auth.uid()
      where p.id = fireside_reactions.post_id
    )
  );

drop policy if exists "signed-in readers read guild feedback" on guild_book_feedback;
drop policy if exists "guild members read guild feedback" on guild_book_feedback;
create policy "guild members read guild feedback" on guild_book_feedback
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers post guild feedback" on guild_book_feedback;
drop policy if exists "guild members post guild feedback" on guild_book_feedback;
create policy "guild members post guild feedback" on guild_book_feedback
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_book_feedback.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "signed-in readers read guild published books" on guild_published_books;
drop policy if exists "guild members read guild published books" on guild_published_books;
create policy "guild members read guild published books" on guild_published_books
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

drop policy if exists "author publishes own book to a guild" on guild_published_books;
drop policy if exists "guild members publish own book to guild" on guild_published_books;
create policy "guild members publish own book to guild" on guild_published_books
  for insert with check (
    auth.uid() = author_id
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = guild_published_books.guild_id and m.user_id = auth.uid()
    )
  );

commit;
