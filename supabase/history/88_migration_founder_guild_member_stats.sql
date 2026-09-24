-- Migration 88: real cross-member Guild Reputation for Founder Guilds (audit finding #1,
-- post-fix-tracker session).
--
-- guild_member_stats (see its own header above) made a Player Guild's Level/XP/Reputation a
-- real sum across its actual members instead of each device computing it from local activity
-- alone — but it explicitly left Founder Guilds uncovered, and at the time that was honest:
-- every OTHER "member" of a Founder Guild really was a simulated presence, so there was no real
-- roster to sum yet. That's no longer true. founder_guild_members has held every Founder
-- Guild's real join/leave history since Phase 8, and Guild Order's Roster/Manuscript/World
-- Bible/Council/Treasury/Anthology were all made real for Founder Guilds by later fix-tracker
-- items (15-17) — Guild Reputation is the one piece of "real once a real roster exists" that
-- never got extended to match.
--
-- This is a NEW table rather than widening guild_member_stats, for one hard reason:
-- guild_member_stats.guild_id is `uuid`, with a composite foreign key to
-- player_guild_members(guild_id, user_id) — but a Founder Guild's membership lives in
-- founder_guild_members, keyed by guild_id `text` (one of the ten fixed founder slugs —
-- 'fantasy', 'romance', etc.), a completely different id space. Retyping guild_member_stats's
-- existing column (and its FK, and every existing Player Guild row already in it) to
-- accommodate a second, incompatible id space would be a real, risky change to a table already
-- holding live data, for no benefit Player Guilds need. founder_guild_member_stats below is the
-- same shape, same check ceilings, same delta-guard trigger (reusing
-- guard_guild_member_stats_delta() as-is — it's already generic over column names, not tied to
-- one table) — just keyed against founder_guild_members instead.
--
-- Client-side, sumGuildMemberStats (guild-progression.jsx) already reduces raw rows into totals
-- generically by column name, so it works unchanged against rows from either table — no
-- duplicate reduction logic needed, just a second fetch/push pointed at this table for a
-- Founder Guild (see guild-progression-remote.js/home-screen.jsx).

create table if not exists founder_guild_member_stats (
  guild_id text not null check (guild_id in (
    'fantasy', 'romance', 'scifi', 'historical', 'horror',
    'mystery', 'comedy', 'worldbuilders', 'poetry', 'general'
  )),
  user_id uuid not null,
  published_count integer not null default 0 check (published_count between 0 and 10000),
  quests_completed integer not null default 0 check (quests_completed between 0 and 50),
  quest_guild_xp integer not null default 0 check (quest_guild_xp between 0 and 100000),
  writing_day_count integer not null default 0 check (writing_day_count between 0 and 20000),
  fireside_post_count integer not null default 0 check (fireside_post_count between 0 and 200000),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id),
  -- Same reasoning as guild_member_stats' own FK: ties every stats row to an actual current
  -- membership row, so leaving a Founder Guild cascades into dropping this row too, instead of
  -- a stale ex-member's numbers still counting toward the guild's total forever.
  foreign key (guild_id, user_id) references founder_guild_members (guild_id, user_id) on delete cascade
);

alter table founder_guild_member_stats enable row level security;

create policy "guild members read founder guild member stats" on founder_guild_member_stats
  for select using (
    exists (
      select 1 from founder_guild_members m
      where m.guild_id = founder_guild_member_stats.guild_id and m.user_id = auth.uid()
    )
  );

create policy "a member inserts their own founder guild stats row" on founder_guild_member_stats
  for insert with check (
    auth.uid() = user_id
    and not is_banned(auth.uid())
    and exists (select 1 from founder_guild_members m where m.guild_id = founder_guild_member_stats.guild_id and m.user_id = auth.uid())
  );
create policy "a member updates their own founder guild stats row" on founder_guild_member_stats
  for update using (auth.uid() = user_id);

-- Reuses guild_member_stats' own delta-guard function unchanged — same column names, same
-- non-decreasing/per-write-delta reasoning applies identically here.
drop trigger if exists founder_guild_member_stats_guard_delta on founder_guild_member_stats;
create trigger founder_guild_member_stats_guard_delta
  before insert or update on founder_guild_member_stats
  for each row execute function guard_guild_member_stats_delta();
