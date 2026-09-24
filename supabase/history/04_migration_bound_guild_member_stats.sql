-- Bounds guild_member_stats' columns against obviously-abusive values.
--
-- Context: every number pushGuildMemberStats (src/lib/guild-progression-remote.js) writes is
-- computed entirely client-side, from local project data and localStorage-only lifetimeStats —
-- there is no server-side source of truth to derive or check these against (no daily-writing-log
-- table, no quest-completion-log table). guild_member_stats' RLS only checks that a member is
-- writing their own row for a guild they belong to (schema_phase6.sql) — it never checks that the
-- *values* are plausible. Since the anon key and a valid session are all that's needed to call
-- supabase.from('guild_member_stats').upsert(...) directly, anyone can currently push arbitrary
-- numbers (e.g. published_count: 999999999) and inflate their guild's shared Level/XP/Reputation,
-- which sumGuildMemberStats (guild-progression.jsx) totals unquestioningly across every member.
--
-- This migration does NOT make the numbers trustworthy — that needs real source-of-truth tables
-- (a writing-day log, a quest-completion log, etc.) for the server to derive them from instead of
-- taking the client's word, which is a larger feature, not a fix. What it does do is cap the
-- damage: replace "unbounded" with "bounded to generous ceilings no legitimate device could ever
-- reach," so a bad push degrades to a capped nuisance instead of an arbitrary number.
--
-- Ceilings, and why:
--   published_count      <= 10,000   — no real writer publishes anywhere near this many books
--   quests_completed     <= 50       — there are 5 Guild Quests today (GUILD_QUEST_DEFS in
--                                      guild-hall.jsx); 50 leaves headroom for new quests being
--                                      added later without this constraint needing a migration
--   quest_guild_xp        <= 100,000  — today's 5 quests sum to 22,500 guildXP at most; well over
--                                      4x headroom for future quests
--   writing_day_count    <= 20,000   — ~54 years of daily writing; no legitimate account gets
--                                      near this
--   fireside_post_count  <= 200,000  — generous headroom over any plausible posting activity
--
-- All five also get a non-negative floor — the columns already default to 0 and the app only
-- ever increments them, so a negative push is never legitimate.

alter table guild_member_stats
  add constraint guild_member_stats_published_count_range
    check (published_count between 0 and 10000),
  add constraint guild_member_stats_quests_completed_range
    check (quests_completed between 0 and 50),
  add constraint guild_member_stats_quest_guild_xp_range
    check (quest_guild_xp between 0 and 100000),
  add constraint guild_member_stats_writing_day_count_range
    check (writing_day_count between 0 and 20000),
  add constraint guild_member_stats_fireside_post_count_range
    check (fireside_post_count between 0 and 200000);
