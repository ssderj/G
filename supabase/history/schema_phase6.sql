-- Phase 6: makes Guild Level, Guild XP, and Guild Reputation genuinely shared across a Player
-- Guild's real members (Phase 5's player_guilds/player_guild_members), instead of every member's
-- screen computing them from that one device's own activity alone.
--
-- Founder Guilds are deliberately NOT touched by this phase. Every *other* "member" shown inside
-- a Founder Guild is still a simulated presence (see guild-order.jsx's HONESTY NOTE) — there is
-- no real multi-member roster to sum there yet, so Founder Guild Level/XP/Reputation keep using
-- the local-only formulas in guild-progression.jsx, same as before. This phase only applies once
-- a guild has a real roster: a Player Guild (owned or joined).

-- One row per (guild, member), holding that member's own raw contribution counts — not a
-- pre-computed XP or reputation number. Keeping the raw counts means the reward formulas in
-- guild-progression.jsx can change later without a data migration, and means a member's own row
-- stays meaningful on its own (e.g. for a future per-member breakdown).
--
-- Same ceilings as migration_bound_guild_member_stats.sql (added after this table already
-- shipped, for existing deployments) — a fresh install gets them inline here instead. See that
-- migration file for why these bounds exist and how the ceilings were sized: every value here is
-- computed client-side with no server-side source of truth to verify against, so this caps a bad
-- push to a generous-but-implausible ceiling rather than leaving it unbounded.
create table if not exists guild_member_stats (
  guild_id uuid not null,
  user_id uuid not null,
  published_count integer not null default 0 check (published_count between 0 and 10000),
  quests_completed integer not null default 0 check (quests_completed between 0 and 50),
  quest_guild_xp integer not null default 0 check (quest_guild_xp between 0 and 100000),
  writing_day_count integer not null default 0 check (writing_day_count between 0 and 20000),
  fireside_post_count integer not null default 0 check (fireside_post_count between 0 and 200000),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id),
  -- Ties every stats row to an actual current membership row, not just a valid guild — so
  -- leaving a guild (player_guild_members' row for this (guild_id, user_id) being deleted)
  -- cascades into deleting this stats row too, instead of it lingering and still counting toward
  -- the guild's total via sumGuildMemberStats forever. player_guild_members' own primary key
  -- (guild_id, user_id) is what makes this composite FK valid, and its own FK to player_guilds
  -- already covers what a plain `guild_id references player_guilds(id)` FK here would have.
  foreign key (guild_id, user_id) references player_guild_members (guild_id, user_id) on delete cascade
);

alter table guild_member_stats enable row level security;

-- Read is restricted to fellow guild members, not "anyone signed in" like Phase 3's Fireside —
-- these numbers roll straight into a Level every member's Guild Hall renders, so it's worth
-- actually checking membership now that player_guild_members exists to check against.
create policy "guild members read guild member stats" on guild_member_stats
  for select using (
    exists (
      select 1 from player_guild_members m
      where m.guild_id = guild_member_stats.guild_id and m.user_id = auth.uid()
    )
  );

-- A member may only write their own row, and only for a guild they're currently in. The FK above
-- now enforces both directions of that at the database level — an insert or update for a
-- (guild_id, user_id) with no matching player_guild_members row is rejected by the FK itself, and
-- leaving a guild cascades into deleting the stats row. This RLS check is kept anyway as a
-- friendlier "permission denied" instead of a raw FK-violation error, and as defense in depth.
create policy "a member inserts their own stats row" on guild_member_stats
  for insert with check (
    auth.uid() = user_id
    and exists (select 1 from player_guild_members m where m.guild_id = guild_member_stats.guild_id and m.user_id = auth.uid())
  );
create policy "a member updates their own stats row" on guild_member_stats
  for update using (auth.uid() = user_id);

create index if not exists guild_member_stats_guild_idx on guild_member_stats (guild_id);

-- Tightens the mitigation from migration_bound_guild_member_stats.sql. That migration bounds
-- each column to a generous *absolute* ceiling (e.g. published_count <= 10000) — enough to stop
-- an arbitrary number, but a single malicious upsert can still jump straight from 0 to that
-- ceiling in one write. This trigger adds two more layers on top of the same honest premise (no
-- server-side source of truth exists yet to verify these numbers against — that's still a larger
-- feature, not something this trigger claims to fix):
--   1. Non-decreasing: every column the app only ever increments, so any UPDATE that lowers one
--      is clamped back up rather than allowed through — either a bug or an attempt to manipulate
--      a total downward.
--   2. Per-write delta caps: bounds how much a single write can add, independent of the absolute
--      ceiling, sized generously enough that a real device catching up after being offline for a
--      long stretch still succeeds — clamped down to the cap rather than rejected outright. An
--      earlier version of this trigger used `raise exception` here instead, which had a real bug:
--      writing_day_count grows unboundedly over a writer's lifetime, so a device returning after
--      a long enough absence (2+ months) could exceed even a generous fixed delta cap — and
--      since a rejected write leaves the old row (and its stale baseline) in place, every future
--      push would keep failing the exact same way, permanently stalling that column for that
--      member. Clamping means the write always succeeds; an oversized push just catches up
--      gradually over the next few syncs instead of being silently and permanently dropped.
create or replace function guard_guild_member_stats_delta()
returns trigger
language plpgsql
as $$
begin
  new.published_count := greatest(old.published_count, least(new.published_count, old.published_count + 50));
  -- quests_completed: there are 5 Guild Quests total today (GUILD_QUEST_DEFS in guild-hall.jsx);
  -- a generous cap of 10 leaves headroom for quests added later without needing a migration.
  new.quests_completed := greatest(old.quests_completed, least(new.quests_completed, old.quests_completed + 10));
  -- quest_guild_xp: today's 5 quests sum to 22,500 at most (see
  -- migration_bound_guild_member_stats.sql) — a single write can't legitimately exceed that.
  new.quest_guild_xp := greatest(old.quest_guild_xp, least(new.quest_guild_xp, old.quest_guild_xp + 22500));
  -- writing_day_count: 60 covers two full months of offline catch-up in a single sync; a longer
  -- absence just takes an extra sync or two to fully catch up instead of failing outright.
  new.writing_day_count := greatest(old.writing_day_count, least(new.writing_day_count, old.writing_day_count + 60));
  -- fireside_post_count: a generous burst allowance for a very active catch-up sync.
  new.fireside_post_count := greatest(old.fireside_post_count, least(new.fireside_post_count, old.fireside_post_count + 500));

  return new;
end;
$$;

drop trigger if exists guild_member_stats_guard_delta on guild_member_stats;
create trigger guild_member_stats_guard_delta
  before update on guild_member_stats
  for each row execute function guard_guild_member_stats_delta();
