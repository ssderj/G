-- Phase 3: guild social — the Fireside discussion board and Guild Bookshelf feedback, made
-- genuinely shared instead of local-only. Scoped deliberately to Founder Guilds only: the app's
-- ten static Founder Guilds already give every member who joins one the same stable identifier
-- (guildProfile.founderGuildId), so "everyone in the Ember Quill Guild sees the same Fireside"
-- falls out naturally. Player-created guilds are NOT covered by this phase — today's app has no
-- invite/join flow for another writer's custom guild at all (see App.jsx's enterOwnGuild, which
-- only ever sets up the current writer's own single-member guild) — building real multi-member
-- player guilds means designing that flow first, which is a separate, larger feature than making
-- the already-conceptually-shared Founder Guilds' social features real.
--
-- guild_id below is always one of the app's own static founder-guild key strings, not a foreign
-- key into a `guilds` table — there's no dynamic guild data to look up, so no such table exists.

create table if not exists fireside_posts (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  parent_id uuid references fireside_posts(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  -- No author_name column — looked up live from `profiles` (Phase 4) by author_id when posts
  -- are read (src/lib/library-guild.js). See schema_phase2.sql's published_books for why.
  category text,
  body text not null,
  pinned boolean not null default false,
  created_at timestamptz not null default now()
);

alter table fireside_posts enable row level security;

-- Fireside content is guild-only, not fully public like the Grand Library's reviews — but this
-- phase has no guild_members roster to check membership against (see the note above), so "signed
-- in" is the only check enforced server-side. A determined signed-in reader could technically
-- read or post into a Founder Guild they haven't joined; low-stakes for a discussion board, but
-- worth knowing about — closing this gap for real means adding a guild_members table and
-- checking membership in these policies, a natural next step once one exists.
create policy "signed-in readers read fireside posts" on fireside_posts
  for select using (auth.uid() is not null);
create policy "signed-in readers post to fireside" on fireside_posts
  for insert with check (auth.uid() = author_id);
-- Update is author-only (not "any guild member," unlike the local version's unrestricted pin
-- toggle) — Postgres RLS can't cleanly restrict an UPDATE to just the `pinned` column, and
-- opening update to every signed-in reader would let anyone edit anyone's post body. Founder/
-- moderator-only pinning of *other* members' posts is a reasonable follow-up once a
-- guild_members table with roles exists to check against.
create policy "author updates own post" on fireside_posts
  for update using (auth.uid() = author_id);
create policy "author deletes own post" on fireside_posts
  for delete using (auth.uid() = author_id);

create index if not exists fireside_posts_guild_idx on fireside_posts (guild_id, created_at desc);

-- One row per (post, reader, reaction kind) rather than a jsonb counter on the post — avoids
-- read-modify-write races when multiple guild members react around the same time, and RLS can
-- cleanly scope "a reader manages their own reaction" precisely.
create table if not exists fireside_reactions (
  post_id uuid not null references fireside_posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction text not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, reaction)
);

alter table fireside_reactions enable row level security;

create policy "signed-in readers read reactions" on fireside_reactions
  for select using (auth.uid() is not null);
create policy "a reader adds their own reaction" on fireside_reactions
  for insert with check (auth.uid() = user_id);
create policy "a reader removes their own reaction" on fireside_reactions
  for delete using (auth.uid() = user_id);

create table if not exists guild_book_feedback (
  id uuid primary key default gen_random_uuid(),
  guild_id text not null,
  book_id text not null,
  author_id uuid not null references auth.users(id) on delete cascade,
  -- No author_name column — same reasoning as fireside_posts above.
  stars smallint check (stars between 1 and 5),
  note text,
  created_at timestamptz not null default now()
);

alter table guild_book_feedback enable row level security;

create policy "signed-in readers read guild feedback" on guild_book_feedback
  for select using (auth.uid() is not null);
create policy "signed-in readers post guild feedback" on guild_book_feedback
  for insert with check (auth.uid() = author_id);
create policy "author deletes own feedback" on guild_book_feedback
  for delete using (auth.uid() = author_id);
-- Author-only, same shape as every other update policy in this file — lets a writer edit their
-- own feedback's stars/note after posting it. (An earlier version of this table stored its own
-- author_name copy, and this policy originally existed so a pen name change could refresh that
-- copy too — see schema_phase2.sql's published_books for why that copy no longer exists.)
create policy "author updates own feedback" on guild_book_feedback
  for update using (auth.uid() = author_id);

create index if not exists guild_feedback_book_idx on guild_book_feedback (guild_id, book_id, created_at desc);

-- Enables Supabase Realtime for the Fireside — lets FiresideBoard subscribe to live inserts
-- instead of only refreshing on its own actions, so a guildmate's post appears without a reload.
alter publication supabase_realtime add table fireside_posts;
alter publication supabase_realtime add table fireside_reactions;
