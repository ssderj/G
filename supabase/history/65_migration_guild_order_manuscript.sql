-- Migration 65: Guild Order — a real shared manuscript, for both guild types.
--
-- guild-order.jsx's own HONESTY NOTE has said since it was written: "Inkroot has no backend, so
-- there are no other real writers in this guild yet... Swapping the simulated roster/seed content
-- for real members later only touches goBuildRoster and the *_SEED constants." The Roster tab is
-- swapped over in this same pass (client-only change, no schema needed — it reads
-- founder_guild_members/player_guild_members, both of which already existed). The Manuscript tab
-- needs real storage, which is what this migration adds.
--
-- Two tables, not one, on purpose:
--   - guild_order_chapters: the chapter list itself — title, status, who proposed it. One row per
--     chapter, mutable (status advances; a member correcting a typo in the title updates in place).
--   - guild_order_passages: an append-only log of real prose contributions to a chapter, each
--     attributed to whichever real member wrote it. Deliberately NOT a single mutable `content`
--     column on the chapter row — a single shared text field would mean two members editing at
--     once silently clobber each other (this app's usual last-write-wins sync model is fine for a
--     solo writer's own device, not for two different PEOPLE typing into the same field), and it
--     would erase who-wrote-what the moment a second contributor touched it. A passage per
--     contribution keeps every real writer's actual words attributed to them, permanently, and
--     sidesteps the write-conflict problem entirely — this is closer to how the Fireside already
--     works (fireside_posts is append-only too) than to a single editable document.
--
-- guild_id is `text`, not `uuid`, on both — a Founder Guild's id is one of the fixed
-- ('fantasy'/'romance'/...) keys founder_guild_members.guild_id already uses, a Player Guild's is
-- player_guilds' real uuid stringified. guild_type is the explicit discriminator so RLS below
-- knows which membership table to check rather than guessing from the string's shape.
--
-- Permission model — deliberately lighter than GO_PERMISSIONS' full six-rung ladder:
--   - Any real member (of either guild type) can propose a chapter (status starts 'draft') and add
--     a passage to any chapter.
--   - Any real member can advance a chapter's status, EXCEPT to 'approved' — that needs real
--     standing: for a Player Guild, the owner or a treasurer/officer (player_guild_members.role,
--     see 44_migration_guild_treasury_roles_and_approvals.sql — already real, already
--     RLS-authoritative, so this reuses it rather than inventing a second role system); for a
--     Founder Guild, at least one quality-length published book (published_books.word_count >=
--     15000, the same REPUTATION_QUALITY_MIN_WORDS bar author-reputation.jsx already uses to decide
--     whether a book counts toward Reputation at all). That bar is a real, honest, cheap-to-check
--     SQL proxy for "an established member of this guild" — it is NOT a re-implementation of
--     author-reputation.jsx's full diminishing-returns Reputation formula (follow/purchase/rating/
--     review/etc., each with its own sqrt curve): duplicating that formula in SQL would be a second
--     copy of business logic that can silently drift from the client's own, for a threshold that
--     only ever gates one binary action here. The client still computes and displays each real
--     member's full Reputation-based role/rung on the Roster tab; this migration only gates the one
--     write that actually needs enforcing.
--   - Deleting a chapter or a passage is restricted to whoever proposed/wrote it, and (for a
--     chapter) only while it's still a draft — once any real passage has been added or it's moved
--     to review, it's part of the guild's shared record and no longer deletable by the proposer.
--
-- No `alter publication supabase_realtime add table` for either — unlike the Fireside, there's no
-- live subscription for the manuscript in this pass; readers see new chapters/passages on their
-- next fetch (opening the tab, or after their own action), not the instant another member posts.

create table if not exists guild_order_chapters (
  id uuid primary key default gen_random_uuid(),
  guild_type text not null check (guild_type in ('founder', 'player')),
  guild_id text not null,
  order_index integer not null default 0,
  title text not null check (char_length(title) <= 200),
  status text not null default 'draft' check (status in ('draft', 'in review', 'approved')),
  proposed_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists guild_order_passages (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references guild_order_chapters(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  content text not null check (char_length(content) > 0 and char_length(content) <= 8000),
  created_at timestamptz not null default now()
);

alter table guild_order_chapters enable row level security;
alter table guild_order_passages enable row level security;

-- Real-member check, inlined per policy rather than pulled into a shared function — matches this
-- schema's existing style (see founder_guild_members/player_guild_members checks scattered
-- throughout above) of a few repeated lines over one more moving part.
create policy "members read their guild's chapters" on guild_order_chapters
  for select using (
    (guild_type = 'founder' and exists (
      select 1 from founder_guild_members m where m.guild_id = guild_order_chapters.guild_id and m.user_id = auth.uid()
    ))
    or (guild_type = 'player' and (
      exists (select 1 from player_guild_members m where m.guild_id = guild_order_chapters.guild_id::uuid and m.user_id = auth.uid())
      or exists (select 1 from player_guilds g where g.id = guild_order_chapters.guild_id::uuid and g.owner_id = auth.uid())
    ))
  );

create policy "members propose chapters" on guild_order_chapters
  for insert with check (
    proposed_by = auth.uid()
    and status = 'draft'
    and (
      (guild_type = 'founder' and exists (
        select 1 from founder_guild_members m where m.guild_id = guild_order_chapters.guild_id and m.user_id = auth.uid()
      ))
      or (guild_type = 'player' and (
        exists (select 1 from player_guild_members m where m.guild_id = guild_order_chapters.guild_id::uuid and m.user_id = auth.uid())
        or exists (select 1 from player_guilds g where g.id = guild_order_chapters.guild_id::uuid and g.owner_id = auth.uid())
      ))
    )
  );

-- Any real member can update a chapter (retitle it, send it to review) — approving it is the one
-- transition that needs real standing, checked in `with check` against the row's post-update
-- state rather than in `using`, so an ordinary member can still freely make every OTHER edit.
create policy "members update chapters, approving needs standing" on guild_order_chapters
  for update using (
    (guild_type = 'founder' and exists (
      select 1 from founder_guild_members m where m.guild_id = guild_order_chapters.guild_id and m.user_id = auth.uid()
    ))
    or (guild_type = 'player' and (
      exists (select 1 from player_guild_members m where m.guild_id = guild_order_chapters.guild_id::uuid and m.user_id = auth.uid())
      or exists (select 1 from player_guilds g where g.id = guild_order_chapters.guild_id::uuid and g.owner_id = auth.uid())
    ))
  )
  with check (
    status <> 'approved'
    or (guild_type = 'founder' and exists (
      select 1 from published_books b where b.author_id = auth.uid() and b.destination = 'inkroot' and b.word_count >= 15000
    ))
    or (guild_type = 'player' and (
      exists (select 1 from player_guilds g where g.id = guild_order_chapters.guild_id::uuid and g.owner_id = auth.uid())
      or exists (select 1 from player_guild_members m where m.guild_id = guild_order_chapters.guild_id::uuid and m.user_id = auth.uid() and m.role in ('treasurer', 'officer'))
    ))
  );

create policy "proposer deletes their own still-draft chapter" on guild_order_chapters
  for delete using (proposed_by = auth.uid() and status = 'draft');

create policy "members read their guild's passages" on guild_order_passages
  for select using (
    exists (
      select 1 from guild_order_chapters c where c.id = guild_order_passages.chapter_id
      and (
        (c.guild_type = 'founder' and exists (
          select 1 from founder_guild_members m where m.guild_id = c.guild_id and m.user_id = auth.uid()
        ))
        or (c.guild_type = 'player' and (
          exists (select 1 from player_guild_members m where m.guild_id = c.guild_id::uuid and m.user_id = auth.uid())
          or exists (select 1 from player_guilds g where g.id = c.guild_id::uuid and g.owner_id = auth.uid())
        ))
      )
    )
  );

create policy "members add passages to their guild's chapters" on guild_order_passages
  for insert with check (
    author_id = auth.uid()
    and exists (
      select 1 from guild_order_chapters c where c.id = guild_order_passages.chapter_id
      and (
        (c.guild_type = 'founder' and exists (
          select 1 from founder_guild_members m where m.guild_id = c.guild_id and m.user_id = auth.uid()
        ))
        or (c.guild_type = 'player' and (
          exists (select 1 from player_guild_members m where m.guild_id = c.guild_id::uuid and m.user_id = auth.uid())
          or exists (select 1 from player_guilds g where g.id = c.guild_id::uuid and g.owner_id = auth.uid())
        ))
      )
    )
  );

create policy "authors delete their own passages" on guild_order_passages
  for delete using (author_id = auth.uid());

create index if not exists guild_order_chapters_guild_idx on guild_order_chapters (guild_type, guild_id);
create index if not exists guild_order_passages_chapter_idx on guild_order_passages (chapter_id);

-- updated_at bookkeeping, same pattern as published_books/player_guilds above — set on every
-- update so "last touched" is real rather than left at insert time.
create or replace function touch_guild_order_chapters_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists touch_guild_order_chapters_updated_at_trigger on guild_order_chapters;
create trigger touch_guild_order_chapters_updated_at_trigger
  before update on guild_order_chapters
  for each row execute function touch_guild_order_chapters_updated_at();
