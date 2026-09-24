-- Migration 81: Guild Order — a real shared World Bible, for both guild types.
--
-- Closes fix-tracker item 15: Roster, Manuscript (migration 65/66), Treasury, and Anthology
-- (migration 69) are all real for both guild types now — World Bible was the one tab left behind,
-- still writing only to this device's own local GoState (`patchState({ worldEntries: [...] })`),
-- merged at render time with the deterministic fake GO_WORLD_SEED list so it never looked empty.
--
-- One table, not two — unlike guild_order_chapters/guild_order_passages (migration 65), a World
-- Bible entry has no separate "contribution log" concept to protect: it's a single short
-- title+blurb written by one real member in one sitting, not a document multiple members add
-- prose to over time the way a manuscript chapter is. So this is closer in shape to
-- fireside_posts (one real member, one real row, append-only from the reader's point of view)
-- than to the chapters/passages split.
--
-- guild_type/guild_id follow guild_order_chapters' own convention exactly (guild_id is `text`,
-- not `uuid`, so a Founder Guild's fixed lore key and a Player Guild's stringified uuid can share
-- one column; guild_type is the explicit discriminator RLS below uses rather than guessing from
-- the string's shape).
--
-- Permission model — same "lighter than GO_PERMISSIONS' full rung ladder" precedent migration 65
-- set for Manuscript: any real member of either guild type can add an entry. GO_PERMISSIONS.
-- addWorldEntry (rung 2, "Writer") still gates the client's own "+ Add an entry" button, same as
-- draftChapter's rung 2 gates Manuscript's — but nothing here re-derives that rung server-side
-- (see migration 65's own comment on why duplicating author-reputation.jsx's Reputation formula
-- in SQL, for a threshold that only gates one client-side button, isn't worth the drift risk).
-- GO_PERMISSIONS.curateWorldEntry (rung 4) has no server-side counterpart either, because the
-- current UI has no edit/delete/curate action at all to gate — this migration only builds what
-- GoWorldBibleTab actually does today (read the shelf, add an entry); a future curation feature
-- gets its own policy when that UI exists, not a speculative one now.

create table if not exists guild_order_world_entries (
  id uuid primary key default gen_random_uuid(),
  guild_type text not null check (guild_type in ('founder', 'player')),
  guild_id text not null,
  category text not null check (char_length(category) <= 60),
  title text not null check (char_length(title) > 0 and char_length(title) <= 200),
  blurb text not null check (char_length(blurb) <= 2000),
  author_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table guild_order_world_entries enable row level security;

-- Same inlined real-member check guild_order_chapters' policies already use, repeated here
-- rather than factored into a shared function, matching this schema's existing style.
create policy "members read their guild's world bible" on guild_order_world_entries
  for select using (
    (guild_type = 'founder' and exists (
      select 1 from founder_guild_members m where m.guild_id = guild_order_world_entries.guild_id and m.user_id = auth.uid()
    ))
    or (guild_type = 'player' and (
      exists (select 1 from player_guild_members m where m.guild_id = guild_order_world_entries.guild_id::uuid and m.user_id = auth.uid())
      or exists (select 1 from player_guilds g where g.id = guild_order_world_entries.guild_id::uuid and g.owner_id = auth.uid())
    ))
  );

create policy "members add entries to their guild's world bible" on guild_order_world_entries
  for insert with check (
    author_id = auth.uid()
    and (
      (guild_type = 'founder' and exists (
        select 1 from founder_guild_members m where m.guild_id = guild_order_world_entries.guild_id and m.user_id = auth.uid()
      ))
      or (guild_type = 'player' and (
        exists (select 1 from player_guild_members m where m.guild_id = guild_order_world_entries.guild_id::uuid and m.user_id = auth.uid())
        or exists (select 1 from player_guilds g where g.id = guild_order_world_entries.guild_id::uuid and g.owner_id = auth.uid())
      ))
    )
  );

-- An author can delete their own entry — not in the current UI yet, but harmless to allow and
-- avoids a writer being stuck with a typo'd entry forever with no recourse; matches
-- guild_order_passages' own "authors delete their own passages" precedent for the same reason.
create policy "authors delete their own world bible entries" on guild_order_world_entries
  for delete using (author_id = auth.uid());

create index if not exists guild_order_world_entries_guild_idx on guild_order_world_entries (guild_type, guild_id, created_at desc);

-- Live sync, same pass as the table itself this time (unlike Manuscript, which shipped real-only
-- in migration 65 and got Realtime as a separate follow-up in migration 66) — no reason to ship
-- this one non-live first when the pattern's already proven.
alter publication supabase_realtime add table guild_order_world_entries;
