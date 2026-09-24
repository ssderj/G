-- Migration 119: an account could follow itself through the API (production-readiness audit).
--
-- The gap: `follows` had no check that follower_id and followee_id differ. The app hides the Follow
-- button on your own profile, and the event/notification triggers already skip a self-follow, but the
-- follows insert policy only checks auth.uid() = follower_id — so a direct REST call could insert
-- (me, me). Effect: at most +1 on the author's own follower count (which feeds reputation), and
-- followAuthor()'s upsert would happily store it.
--
-- The fix: delete any self-follow rows that already exist (they are always junk, and are the only
-- reason a plain validated constraint could fail), then add the CHECK. The delete removes no
-- relationship between two different people. followAuthor() surfaces a violation as an ordinary
-- error (SQLSTATE 23514) if some client ever tries.
--
-- Not run against a live database from this session. Verify after applying: as any user,
--   insert into follows (follower_id, followee_id) values (auth.uid(), auth.uid());
-- fails with follows_no_self; following a different user still works.

delete from follows where follower_id = followee_id;

alter table follows drop constraint if exists follows_no_self;
alter table follows add constraint follows_no_self check (follower_id <> followee_id);
