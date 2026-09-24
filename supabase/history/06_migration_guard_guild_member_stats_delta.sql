-- Tightens the mitigation from migration_bound_guild_member_stats.sql for deployments that
-- already ran schema_phase6.sql. That migration bounds each column to a generous *absolute*
-- ceiling (e.g. published_count <= 10000) — enough to stop an arbitrary number, but a single
-- malicious upsert could still jump straight from 0 to that ceiling in one write. This adds two
-- more layers on top of the same honest premise (no server-side source of truth exists yet to
-- verify these numbers against — that's still a larger feature, not something this migration
-- claims to fix):
--   1. Non-decreasing: every column the app only ever increments, so any UPDATE that lowers one
--      is clamped back up rather than allowed through — either a bug or an attempt to manipulate
--      a total downward.
--   2. Per-write delta caps: bounds how much a single write can add, independent of the absolute
--      ceiling, sized generously enough that a real device catching up after being offline for a
--      long stretch still succeeds — clamped down to the cap rather than rejected outright. A
--      `raise exception` version of this was tried first and had a real bug: writing_day_count
--      grows unboundedly over a writer's lifetime, so a device returning after a long enough
--      absence (2+ months) could exceed even a generous fixed delta cap — and since a rejected
--      write leaves the old row (and its stale baseline) in place, every future push would keep
--      failing the exact same way, permanently stalling that column for that member. Clamping
--      means the write always succeeds; an oversized push just catches up gradually over the
--      next few syncs instead of being silently and permanently dropped.
--
-- See schema_phase6.sql for the same trigger applied to fresh installs.

create or replace function guard_guild_member_stats_delta()
returns trigger
language plpgsql
as $$
begin
  new.published_count := greatest(old.published_count, least(new.published_count, old.published_count + 50));
  new.quests_completed := greatest(old.quests_completed, least(new.quests_completed, old.quests_completed + 10));
  new.quest_guild_xp := greatest(old.quest_guild_xp, least(new.quest_guild_xp, old.quest_guild_xp + 22500));
  new.writing_day_count := greatest(old.writing_day_count, least(new.writing_day_count, old.writing_day_count + 60));
  new.fireside_post_count := greatest(old.fireside_post_count, least(new.fireside_post_count, old.fireside_post_count + 500));

  return new;
end;
$$;

drop trigger if exists guild_member_stats_guard_delta on guild_member_stats;
create trigger guild_member_stats_guard_delta
  before update on guild_member_stats
  for each row execute function guard_guild_member_stats_delta();
