-- Closes a gap in the mitigation from 06_migration_guard_guild_member_stats_delta.sql: that
-- migration's trigger only ran `before update`, not `before insert`. guild_member_stats rows are
-- deleted automatically when a member leaves their Player Guild (the foreign key to
-- player_guild_members cascades — see 05_migration_guild_member_stats_membership_fk.sql), so
-- leaving and rejoining the same guild deletes and recreates the row. The very next upsert after
-- rejoining is therefore an INSERT, not an UPDATE — which never passed through the delta-cap
-- trigger at all. A single malicious write could set every column straight to its absolute
-- ceiling (e.g. 100,000 quest_guild_xp, 10,000 published_count) in one shot, simply by leaving
-- and rejoining first, completely bypassing the "per-write delta cap" the 06 migration was meant
-- to guarantee. The absolute `check` ceilings from 04_migration_bound_guild_member_stats.sql
-- still held either way — this only closes the "jump straight to the ceiling in one write" gap.
--
-- Fix: make the same trigger fire `before insert or update`, and have the function treat a fresh
-- INSERT as a delta from an implicit all-zero baseline (there's no OLD row to read on INSERT).
-- That means a brand-new stats row is now bound by the exact same per-write delta cap as any
-- other write — e.g. an insert can't set quest_guild_xp above 22,500 in one shot, same as an
-- update couldn't. Behavior for the existing UPDATE case is unchanged.
--
-- Safe to run anytime, on any deployment that has 06_migration_guard_guild_member_stats_delta.sql
-- (or schema_phase6.sql) applied. `create or replace function` + `drop trigger if exists` means
-- this is idempotent — running it twice, or against a database that already has this fix, is a
-- no-op.
--
-- See schema.sql for the same trigger applied to fresh installs.

create or replace function guard_guild_member_stats_delta()
returns trigger
language plpgsql
as $$
declare
  old_published integer := 0;
  old_quests integer := 0;
  old_xp integer := 0;
  old_writing_days integer := 0;
  old_fireside integer := 0;
begin
  if tg_op = 'UPDATE' then
    old_published := old.published_count;
    old_quests := old.quests_completed;
    old_xp := old.quest_guild_xp;
    old_writing_days := old.writing_day_count;
    old_fireside := old.fireside_post_count;
  end if;

  new.published_count := greatest(old_published, least(new.published_count, old_published + 50));
  new.quests_completed := greatest(old_quests, least(new.quests_completed, old_quests + 10));
  new.quest_guild_xp := greatest(old_xp, least(new.quest_guild_xp, old_xp + 22500));
  new.writing_day_count := greatest(old_writing_days, least(new.writing_day_count, old_writing_days + 60));
  new.fireside_post_count := greatest(old_fireside, least(new.fireside_post_count, old_fireside + 500));

  return new;
end;
$$;

drop trigger if exists guild_member_stats_guard_delta on guild_member_stats;
create trigger guild_member_stats_guard_delta
  before insert or update on guild_member_stats
  for each row execute function guard_guild_member_stats_delta();
