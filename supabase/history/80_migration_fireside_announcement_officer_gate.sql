-- 80_migration_fireside_announcement_officer_gate.sql
--
-- Closes item 11 of the audit: fireside_posts didn't restrict who can set
-- category = 'announcement' — any guild member could tag their own post that way, even though
-- src/guild/notice-board.jsx already filters it out on the read/render side unless the author
-- holds officer-or-above authority (rung >= OFFICER_RUNG_THRESHOLD in that file). Not currently
-- exploitable through the app's own UI, but worth locking down here defensively in case that
-- display-side filter is ever loosened or bypassed by a direct API call.
--
-- Matches notice-board.jsx's own Founder Guild check exactly: "any Inkroot admin"
-- (profiles.is_platform_admin), not any per-member role — see that file's header comment for why
-- a Founder Guild's officer authority is delegated that way instead of to a role.
--
-- No Player Guild branch is added here: the membership check in this same policy only ever
-- admits founder_guild_members rows, and founder_guild_members.guild_id is check-constrained to
-- the ten fixed Founder Guild keys, so a Player Guild's (uuid) id can never satisfy it — confirmed
-- by src/shell/home-screen.jsx passing guildId: null into FiresideBoard for a Player Guild, i.e.
-- Player Guild Fireside posting isn't wired up at all today. If that ever changes, this check
-- needs revisiting together with the membership check, not in isolation.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.

drop policy if exists "guild members post to fireside" on fireside_posts;
create policy "guild members post to fireside" on fireside_posts
  for insert with check (
    auth.uid() = author_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from founder_guild_members m
      where m.guild_id = fireside_posts.guild_id and m.user_id = auth.uid()
    )
    and (
      category is distinct from 'announcement'
      or exists (select 1 from profiles p where p.id = auth.uid() and p.is_platform_admin)
    )
  );
