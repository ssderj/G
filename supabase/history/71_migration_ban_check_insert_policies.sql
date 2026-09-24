-- 71_migration_ban_check_insert_policies.sql
--
-- Closes the gap flagged in the production-readiness audit: a banned account can still create
-- and join Player Guilds, join Founder Guilds, mass-follow, react to Fireside posts, write
-- guild-stats rows, file content reports, record device signals, and propose/add content to
-- Guild Order chapters and passages. `is_banned()` was only ever checked on the INSERT policies
-- for `published_books` and `reviews` (see ~line 355 and ~line 382 of supabase/schema.sql) — it
-- was never carried over to these 10 tables.
--
-- Policies can't be altered in place, so each one below is dropped and recreated with
-- `and not is_banned(auth.uid())` added to its existing `with check` clause. The `using`/other
-- clauses are unchanged; only the insert policies listed in the audit are touched here.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state
-- folded in for fresh installs.

-- player_guilds — "owner creates their guild"
drop policy if exists "owner creates their guild" on player_guilds;
create policy "owner creates their guild" on player_guilds
  for insert with check (auth.uid() = owner_id and not is_banned(auth.uid()));

-- player_guild_members — "a writer joins on their own behalf"
drop policy if exists "a writer joins on their own behalf" on player_guild_members;
create policy "a writer joins on their own behalf" on player_guild_members
  for insert with check (auth.uid() = user_id and not is_banned(auth.uid()));

-- founder_guild_members — "a writer joins a founder guild on their own behalf"
drop policy if exists "a writer joins a founder guild on their own behalf" on founder_guild_members;
create policy "a writer joins a founder guild on their own behalf" on founder_guild_members
  for insert with check (auth.uid() = user_id and not is_banned(auth.uid()));

-- follows — "a reader manages their own follow"
drop policy if exists "a reader manages their own follow" on follows;
create policy "a reader manages their own follow" on follows
  for insert with check (auth.uid() = follower_id and not is_banned(auth.uid()));

-- fireside_reactions — "guild members add their own reaction"
drop policy if exists "guild members add their own reaction" on fireside_reactions;
create policy "guild members add their own reaction" on fireside_reactions
  for insert with check (
    auth.uid() = user_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from fireside_posts p
      join founder_guild_members m on m.guild_id = p.guild_id and m.user_id = auth.uid()
      where p.id = fireside_reactions.post_id
    )
  );

-- guild_member_stats — "a member inserts their own stats row"
drop policy if exists "a member inserts their own stats row" on guild_member_stats;
create policy "a member inserts their own stats row" on guild_member_stats
  for insert with check (
    auth.uid() = user_id
    and not is_banned(auth.uid())
    and exists (select 1 from player_guild_members m where m.guild_id = guild_member_stats.guild_id and m.user_id = auth.uid())
  );

-- content_reports — "a user files their own report"
drop policy if exists "a user files their own report" on content_reports;
create policy "a user files their own report" on content_reports
  for insert with check (auth.uid() = reporter_id and not is_banned(auth.uid()));

-- device_signals — "a user records their own device signal"
drop policy if exists "a user records their own device signal" on device_signals;
create policy "a user records their own device signal" on device_signals
  for insert with check (auth.uid() = user_id and not is_banned(auth.uid()));

-- guild_order_chapters — "members propose chapters"
drop policy if exists "members propose chapters" on guild_order_chapters;
create policy "members propose chapters" on guild_order_chapters
  for insert with check (
    proposed_by = auth.uid()
    and not is_banned(auth.uid())
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

-- guild_order_passages — "members add passages to their guild's chapters"
drop policy if exists "members add passages to their guild's chapters" on guild_order_passages;
create policy "members add passages to their guild's chapters" on guild_order_passages
  for insert with check (
    author_id = auth.uid()
    and not is_banned(auth.uid())
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
