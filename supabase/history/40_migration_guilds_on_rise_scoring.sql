-- Migration 40: Guilds on the Rise — recent guild momentum, computed server-side, not guild size.
--
-- Living Universe's existing "Guilds on the Rise" section (living-universe-screen.jsx) has, up to
-- now, only ever ranked Founder Guilds by combined participant counts across the on-device Guild
-- Events simulation (see useLuGuildEvents) — flavor, not a real ranking, and Founder Guilds have
-- no real multi-member roster to begin with (see guild-progression.jsx's own honesty note: every
-- *other* member of a Founder Guild is a simulated presence). This migration adds the real thing,
-- scoped to what actually has a real, joinable roster today: Player Guilds
-- (player_guilds/player_guild_members, Phase 5). A new function, compute_guilds_on_rise(), gives
-- any signed-in client a genuine top-N list, computed entirely server-side from real tables, so no
-- client can hand the app a pre-computed score and have it trusted.
--
-- Signals used, all recent-window only (see point 1 below), matching the spec this migration was
-- written against:
--   - New members       -> guild_join_events (new table below)
--   - Reputation growth  -> shown alongside the score (see point 2), reusing computeGuildReputation's
--                          own weights (publishedBook=40, completedProject=10 -- author-reputation.jsx)
--   - Reading activity   -> book_read_events (migration 38), scoped to current members' books
--   - Books published    -> book_publish_events (migration 38), scoped to current members
--   - Event activity     -> guild_quest_events (new table below). Guild Quests are the one *real*,
--                          shared, guild-scoped activity with a live backend signal today -- actual
--                          Guild Events (contests/sprints) are still on-device only (see
--                          useLuGuildEvents), and GUILD_REPUTATION_SOURCES already lists "Writing
--                          Events" as not-yet-tracked honestly. Using quest completions here, under
--                          an "event activity" label, is that same honesty: it's the real thing
--                          this app can currently measure in that category, not a stand-in dressed
--                          up as something it isn't.
--   - Anthology activity -> guild_anthologies + guild_anthology_submissions (migration 35), both
--                          already real, already access-controlled, already timestamped.
--
-- Three design commitments, same shape as migration 38's Rising Star scoring:
--
--   1. RECENT MOMENTUM, NOT GUILD SIZE. Every signal below is filtered to a configurable recent
--      window (default 7 days) and nothing here is a lifetime total or a raw membership count. A
--      guild with hundreds of long-idle members but zero activity this window scores zero and
--      simply doesn't appear -- this function has no lifetime column to fall back on, same as
--      compute_rising_stars().
--
--   2. HARD TO FAKE. Gaming vectors this migration specifically closes:
--        a. Leave/rejoin cycling to keep re-earning "new member" credit -- player_guild_members
--           rows are freely deleted on leave and re-inserted on rejoin (Phase 5), so without a
--           separate ledger a guild could farm "new members" by having the same person leave and
--           rejoin on a loop. guild_join_events below mirrors follow_events' fix exactly: an
--           insert-only ledger with unique (guild_id, user_id), so only the FIRST join a person has
--           ever made to a given guild counts, forever, no matter how many times they leave and
--           come back.
--        b. Spamming self-reads or self-purchases to inflate a member's book's reading activity --
--           already impossible; book_read_events (migration 38) refuses a book's own author a read
--           on their own work, and this function additionally never awards a book's own author
--           credit for reading their own guildmate's book (reader_id <> the book's author_id is
--           already guaranteed upstream, but this migration also never lets an author's OWN reads
--           of their OWN book count here, closing the same loop for the guild-level aggregate).
--        c. Faking quest-completion bursts -- guild_quest_events only ever logs a POSITIVE
--           increase actually written to guild_member_stats.quests_completed, which is itself
--           already bounded by guard_guild_member_stats_delta() (migrations 06/15): a single write
--           can't jump quests_completed by more than that trigger's own ceiling allows. This
--           migration inherits that protection rather than re-implementing it.
--        d. A single-account "guild" gaming its way onto the list -- guilds_on_rise_config.min_members
--           hard-floors eligibility to guilds with at least that many CURRENT members (default 2):
--           a shell guild with one member farming its own signals in isolation is not eligible at
--           all, regardless of score.
--        e. One member spamming anthology submissions, or a burst of publishes from one prolific
--           member, to dominate a guild's ranking alone -- every count-based term uses the same
--           diminishing-returns curve (value * sqrt(count)) as the rest of this app's real anti-farm
--           mechanic (diminishingPoints, author-reputation.jsx), and each raw count is capped before
--           the sqrt is taken (guilds_on_rise_config's max_counted_* columns), same shape as Rising
--           Star's max_counted_publishes_per_window.
--        f. Reading activity specifically also carries Rising Star's own collusion floor: a
--           guild-wide minimum-distinct-recent-readers floor (min_distinct_recent_readers) below
--           which the reading term is hard-zeroed, not just reduced -- a couple of colluding
--           accounts opening a guildmate's book back and forth can't manufacture "reading activity"
--           on their own.
--      Deliberately NOT attempted, same stance migration 39 already took for Best Sellers/Most
--      Read: detecting "this reader is in the same guild as this author" and discounting it. A
--      guild's own readers genuinely reading a guildmate's book is real demand, not gaming --
--      that's the community support Guild Halls exist to encourage.
--
--   3. CONFIGURABLE, SERVER-SIDE. Every window, floor, cap, and weight lives in the new
--      guilds_on_rise_config singleton row, moderator-tunable the same way rising_star_config and
--      book_ranking_config already are -- never hard-coded, never client-supplied.
--
-- ============================================================================================
-- 1. guild_join_events — an insert-only ledger of genuinely NEW guild memberships, separate from
--    the mutable player_guild_members (which reflects only CURRENT membership and is deleted on
--    leave).
-- ============================================================================================

create table if not exists guild_join_events (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The whole anti-cycling guard: only the first join a given person has EVER made to this guild
  -- can ever insert here. See log_guild_join_event() below for the on-conflict-do-nothing that
  -- enforces it.
  unique (guild_id, user_id)
);

alter table guild_join_events enable row level security;
-- Public read, same reasoning as follow_events/book_publish_events -- "who recently joined this
-- guild" isn't sensitive, and this is what a future client-side display could read directly
-- without needing its own RPC.
create policy "anyone can read guild join events" on guild_join_events
  for select using (true);
-- Deliberately no insert policy for authenticated: only the trigger below (security definer)
-- writes here, so a client can't backdate a join or otherwise spoof "new member" without an
-- actual row in player_guild_members having caused it.

create or replace function log_guild_join_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into guild_join_events (guild_id, user_id)
  values (new.guild_id, new.user_id)
  on conflict (guild_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists player_guild_members_log_join_event on player_guild_members;
create trigger player_guild_members_log_join_event
  after insert on player_guild_members
  for each row execute function log_guild_join_event();

create index if not exists guild_join_events_guild_idx on guild_join_events (guild_id, created_at desc);

-- ============================================================================================
-- 2. guild_quest_events — an insert-only ledger of genuine, positive increases to
--    guild_member_stats.quests_completed, giving "event activity" (Guild Quests) a real
--    timestamped history that the plain running-total column doesn't carry on its own.
-- ============================================================================================

create table if not exists guild_quest_events (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null,
  user_id uuid not null,
  -- Always > 0 -- see log_guild_quest_event() below, which never logs a non-positive delta.
  delta integer not null check (delta > 0),
  created_at timestamptz not null default now(),
  foreign key (guild_id, user_id) references player_guild_members (guild_id, user_id) on delete cascade
);

alter table guild_quest_events enable row level security;
-- Fellow-member-only read, same trust tier as guild_member_stats itself (the table this is
-- derived from) rather than book_publish_events' public-read shape above -- per-member quest
-- activity is guild-internal the same way guild_member_stats already is.
create policy "guild members read their guild's quest events" on guild_quest_events
  for select using (
    exists (
      select 1 from player_guild_members m
      where m.guild_id = guild_quest_events.guild_id and m.user_id = auth.uid()
    )
  );
-- Deliberately no insert policy for authenticated -- only the trigger below (security definer)
-- writes here, and only ever with a delta that guard_guild_member_stats_delta() has already
-- capped upstream.

create or replace function log_guild_quest_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_delta integer;
begin
  v_delta := new.quests_completed - (case when TG_OP = 'UPDATE' then old.quests_completed else 0 end);
  if v_delta > 0 then
    insert into guild_quest_events (guild_id, user_id, delta)
    values (new.guild_id, new.user_id, v_delta);
  end if;
  return new;
end;
$$;

drop trigger if exists guild_member_stats_log_quest_event on guild_member_stats;
create trigger guild_member_stats_log_quest_event
  after insert or update on guild_member_stats
  for each row execute function log_guild_quest_event();

create index if not exists guild_quest_events_guild_idx on guild_quest_events (guild_id, created_at desc);

-- ============================================================================================
-- 3. guilds_on_rise_config — the one moderator-tunable row every window, floor, cap, and weight
--    below is read from. Singleton pattern, same shape as rising_star_config / book_ranking_config.
-- ============================================================================================

create table if not exists guilds_on_rise_config (
  id boolean primary key default true check (id),
  window_days integer not null default 7 check (window_days between 1 and 90),
  min_members integer not null default 2 check (min_members >= 1),
  min_distinct_recent_readers integer not null default 3 check (min_distinct_recent_readers >= 0),
  max_counted_publishes_per_window integer not null default 10 check (max_counted_publishes_per_window between 1 and 200),
  max_counted_quest_events_per_window integer not null default 20 check (max_counted_quest_events_per_window between 1 and 500),
  max_counted_anthology_events_per_window integer not null default 10 check (max_counted_anthology_events_per_window between 1 and 200),
  result_limit integer not null default 6 check (result_limit between 1 and 100),
  weight_new_members numeric not null default 3.0 check (weight_new_members >= 0),
  weight_reading_activity numeric not null default 2.0 check (weight_reading_activity >= 0),
  weight_publishing_activity numeric not null default 3.0 check (weight_publishing_activity >= 0),
  weight_quest_activity numeric not null default 2.0 check (weight_quest_activity >= 0),
  weight_anthology_activity numeric not null default 2.5 check (weight_anthology_activity >= 0),
  updated_at timestamptz not null default now()
);

insert into guilds_on_rise_config (id) values (true) on conflict (id) do nothing;

alter table guilds_on_rise_config enable row level security;
-- Same trust tier as rising_star_config / book_ranking_config -- moderator-only, not publicly
-- readable (the exact floors/caps are part of what makes this hard to game).
create policy "moderators read guilds on rise config" on guilds_on_rise_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update guilds on rise config" on guilds_on_rise_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- 4. compute_guilds_on_rise() — the score itself. security definer so it can read across every
--    guild's member roster and activity ledgers for aggregation, but it only ever returns
--    per-guild aggregates, never a raw per-member row.
-- ============================================================================================

create or replace function compute_guilds_on_rise(p_window_days integer default null, p_result_limit integer default null)
returns table (
  guild_id uuid,
  guild_name text,
  guild_motto text,
  crest_url text,
  member_count integer,
  new_members integer,
  reading_activity integer,
  books_published integer,
  quest_activity integer,
  anthology_activity integer,
  reputation_growth numeric,
  score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select * from guilds_on_rise_config limit 1
  ),
  params as (
    select
      -- p_window_days/p_result_limit let a caller preview a different window/size, but every
      -- WEIGHT, FLOOR, and CAP below always comes from cfg -- never from an argument.
      greatest(1, least(90, coalesce(p_window_days, (select window_days from cfg), 7)))::int as window_days,
      greatest(1, least(100, coalesce(p_result_limit, (select result_limit from cfg), 6)))::int as result_limit,
      coalesce((select min_members from cfg), 2)::int as min_members,
      coalesce((select min_distinct_recent_readers from cfg), 3)::int as min_readers,
      coalesce((select max_counted_publishes_per_window from cfg), 10)::int as max_pub,
      coalesce((select max_counted_quest_events_per_window from cfg), 20)::int as max_quest,
      coalesce((select max_counted_anthology_events_per_window from cfg), 10)::int as max_anth,
      coalesce((select weight_new_members from cfg), 3.0)::numeric as w_members,
      coalesce((select weight_reading_activity from cfg), 2.0)::numeric as w_reading,
      coalesce((select weight_publishing_activity from cfg), 3.0)::numeric as w_publishing,
      coalesce((select weight_quest_activity from cfg), 2.0)::numeric as w_quest,
      coalesce((select weight_anthology_activity from cfg), 2.5)::numeric as w_anthology
  ),
  windows as (
    select now() - make_interval(days => window_days) as cur_start from params
  ),
  -- Only guilds with a real, current roster at or above the anti-shell-guild floor are eligible
  -- at all -- see this migration's header, gaming vector d.
  eligible_guilds as (
    select g.id as guild_id, g.name, g.motto, g.crest_url, count(m.user_id)::integer as member_count
    from player_guilds g
    join player_guild_members m on m.guild_id = g.id
    group by g.id, g.name, g.motto, g.crest_url
    having count(m.user_id) >= (select min_members from params)
  ),
  joins_cur as (
    select j.guild_id, count(*) as ct
    from guild_join_events j, windows w
    where j.created_at >= w.cur_start
    group by j.guild_id
  ),
  member_books as (
    -- Every currently-published book belonging to a current member of each guild -- a writer in
    -- more than one guild contributes to each, honestly (they're a real member of both).
    select eg.guild_id, b.id as book_id, b.author_id
    from eligible_guilds eg
    join player_guild_members m on m.guild_id = eg.guild_id
    join published_books b on b.author_id = m.user_id
  ),
  reads_cur as (
    select mb.guild_id, count(distinct r.reader_id) as readers
    from member_books mb
    join book_read_events r on r.book_id = mb.book_id
    , windows w
    where r.created_at >= w.cur_start
      -- Never a book's own author reading their own work counted toward their own guild's
      -- reading activity -- book_read_events' insert policy already refuses this at the source,
      -- this is defensive-only at the aggregate layer (this migration's header, gaming vector b).
      and r.reader_id <> mb.author_id
    group by mb.guild_id
  ),
  publishes_cur as (
    select mb.guild_id, count(distinct e.book_id) as ct
    from member_books mb
    join book_publish_events e on e.book_id = mb.book_id
    , windows w
    where e.first_published_at >= w.cur_start
    group by mb.guild_id
  ),
  quests_cur as (
    select q.guild_id, sum(q.delta) as ct
    from guild_quest_events q, windows w
    where q.created_at >= w.cur_start
    group by q.guild_id
  ),
  anthologies_cur as (
    select a.guild_id, count(*) as ct
    from guild_anthologies a, windows w
    where a.created_at >= w.cur_start
    group by a.guild_id
  ),
  submissions_cur as (
    select a.guild_id, count(*) as ct
    from guild_anthology_submissions s
    join guild_anthologies a on a.id = s.anthology_id
    , windows w
    where s.submitted_at >= w.cur_start
    group by a.guild_id
  )
  select
    eg.guild_id, eg.name, eg.motto, eg.crest_url, eg.member_count,
    coalesce(jc.ct, 0)::integer as new_members,
    coalesce(rc.readers, 0)::integer as reading_activity,
    coalesce(pc.ct, 0)::integer as books_published,
    coalesce(qc.ct, 0)::integer as quest_activity,
    (coalesce(ac.ct, 0) + coalesce(sc.ct, 0))::integer as anthology_activity,
    -- Informational only, not summed a second time into `score` below (books_published and
    -- quest_activity already each have their own independently-weighted score term) -- mirrors
    -- what this recent-window activity would be worth under Guild Reputation's own real formula
    -- (computeGuildReputation: publishedBook=40, completedProject=10, author-reputation.jsx),
    -- same "reputation_gained" pattern as compute_rising_stars().
    round(
      (case when coalesce(pc.ct, 0) > 0 then 40.0 * sqrt(least(coalesce(pc.ct, 0), (select max_pub from params))) else 0 end)
      + (case when coalesce(qc.ct, 0) > 0 then 10.0 * sqrt(least(coalesce(qc.ct, 0), (select max_quest from params))) else 0 end)
    , 2) as reputation_growth,
    round(
      (select w_members from params) * (case when coalesce(jc.ct, 0) > 0 then sqrt(coalesce(jc.ct, 0)) else 0 end)
      -- Reading term is floored to zero entirely below min_distinct_recent_readers -- the
      -- anti-collusion guard described in this migration's header, gaming vector f.
      + (case when coalesce(rc.readers, 0) >= (select min_readers from params)
          then (select w_reading from params) * sqrt(coalesce(rc.readers, 0))
          else 0 end)
      + (select w_publishing from params) * sqrt(least(coalesce(pc.ct, 0), (select max_pub from params)))
      + (select w_quest from params) * sqrt(least(coalesce(qc.ct, 0), (select max_quest from params)))
      + (select w_anthology from params) * sqrt(least(coalesce(ac.ct, 0) + coalesce(sc.ct, 0), (select max_anth from params)))
    , 4) as score
  from eligible_guilds eg
  left join joins_cur jc on jc.guild_id = eg.guild_id
  left join reads_cur rc on rc.guild_id = eg.guild_id
  left join publishes_cur pc on pc.guild_id = eg.guild_id
  left join quests_cur qc on qc.guild_id = eg.guild_id
  left join anthologies_cur ac on ac.guild_id = eg.guild_id
  left join submissions_cur sc on sc.guild_id = eg.guild_id
  -- No recent signal of any kind at all -- not "on the rise" this window, full stop, rather than
  -- a 0-score row cluttering the result (same convention as compute_rising_stars()).
  where coalesce(jc.ct, 0) + coalesce(rc.readers, 0) + coalesce(pc.ct, 0) + coalesce(qc.ct, 0) + coalesce(ac.ct, 0) + coalesce(sc.ct, 0) > 0
  order by score desc, eg.guild_id
  limit (select result_limit from params);
$$;

revoke all on function compute_guilds_on_rise(integer, integer) from public;
grant execute on function compute_guilds_on_rise(integer, integer) to authenticated;
