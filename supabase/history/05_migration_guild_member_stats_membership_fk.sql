-- Fixes: leaving a Player Guild deletes the player_guild_members row but nothing removes the
-- matching guild_member_stats row, so sumGuildMemberStats (guild-progression.jsx) keeps counting
-- an ex-member's stats toward the guild's shared Level/XP/Reputation indefinitely — the schema's
-- own comment claimed this "falls out of the same membership check" already, which was true for
-- inserts but not for a departure after the fact.
--
-- Fix: tie guild_member_stats to an actual membership row via a composite foreign key on
-- (guild_id, user_id) referencing player_guild_members' own primary key, with on delete cascade
-- — so leaving a guild (or the guild/account being deleted) now removes the stats row
-- automatically. See schema_phase6.sql for the same constraint applied to fresh installs.
--
-- Before adding the constraint, any rows already orphaned by a past departure (no matching
-- player_guild_members row) need to be cleared out first — Postgres won't let a new FK go on if
-- existing data would already violate it.

begin;

delete from guild_member_stats gms
where not exists (
  select 1 from player_guild_members m
  where m.guild_id = gms.guild_id and m.user_id = gms.user_id
);

alter table guild_member_stats
  add constraint guild_member_stats_membership_fk
  foreign key (guild_id, user_id) references player_guild_members (guild_id, user_id) on delete cascade;

commit;
