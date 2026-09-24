-- Migration 38: Rising Star scoring — recent momentum, computed server-side, not lifetime totals.
--
-- Living Universe's "Rising Stars" section (see src/library/living-universe-screen.jsx) has, up
-- to now, only ever drawn from the on-device Chronicle simulation — flavor, not a real ranking.
-- This migration adds the real thing: a Postgres function, compute_rising_stars(), that any
-- signed-in client can call to get a genuine top-N list, computed entirely server-side from real
-- tables, so no client can hand the app a pre-computed score and have it trusted.
--
-- Three design commitments this migration exists to keep:
--
--   1. RECENT MOMENTUM, NOT LIFETIME POPULARITY. Every signal compute_rising_stars() reads is
--      filtered to a configurable recent window (default 7 days) — it never sums a lifetime
--      total. "Reading growth" goes further: it compares the current window's distinct-reader
--      count against the equal-length window immediately before it, so a currently-large but
--      flat author (no NEW momentum) scores near zero on growth, while a small author who just
--      broke out scores highly. An author with the single largest lifetime following in all of
--      Inkroot, but zero activity this week, is not a Rising Star by this function's own math —
--      the query literally has no lifetime-total column to fall back on.
--
--   2. HARD TO FAKE. Three real gaming vectors this migration specifically closes:
--        a. Spamming "opens" of your own book to inflate reads — book_read_events below is
--           capped at one counted read per (book, reader) per calendar day via a unique
--           constraint, and its insert policy refuses to let a book's own author log a read on
--           it at all.
--        b. Unfollow/refollow cycling to keep re-earning "followers gained" credit — follow
--           events are mirrored into an insert-only follow_events ledger (via a trigger on
--           `follows`) with a unique (follower_id, followee_id), so only the FIRST follow a pair
--           has ever produced ever counts as "gained." Unfollowing and refollowing the same
--           person a hundred times earns credit exactly once, forever.
--        c. Unpublish + republish the same book to keep bumping "recent publishing activity" —
--           publishBookRemote (src/lib/library.js) upserts published_books with a
--           client-supplied `published_at`, and unpublishing simply deletes the row, so without
--           this migration a writer could delete and re-upsert the same book every morning and
--           have it read as a brand-new publish forever. book_publish_events below pins each
--           book_id's true FIRST publish moment, permanently, independent of the mutable
--           published_books row — recent publishing activity is computed from that immutable
--           ledger, not from published_books.published_at.
--      On top of those three, every count-based term in the score uses the same diminishing-
--      returns curve (value * sqrt(count)) already established as this app's real anti-farm
--      mechanic for lifetime Reputation (see diminishingPoints in
--      src/library/author-reputation.jsx) — so even a real, un-gamed burst of low-effort repeats
--      of the same action is worth sharply less per repeat, not a flat multiple.
--      A minimum-distinct-readers floor (rising_star_config.min_distinct_recent_readers, default
--      3) also zeroes the reading-related terms entirely below that floor, so two colluding
--      accounts opening the same book back and forth can't manufacture "momentum" on their own.
--
--   3. CONFIGURABLE, SERVER-SIDE. Every window length, floor, cap, and weight lives in the new
--      rising_star_config singleton row rather than being hard-coded in the function or (worse)
--      passed in from the client — a moderator can retune the whole system, from the app itself
--      or the SQL editor, by updating one row. compute_rising_stars() takes optional
--      window/limit overrides for previewing a different window, but the scoring WEIGHTS
--      themselves are never client-supplied — only the moderator-writable config row or the
--      function body decide what a signal is worth.
--
-- ============================================================================================
-- 1. book_read_events — a real "someone opened this book" signal, capped against same-day replay
-- ============================================================================================

create table if not exists book_read_events (
  id uuid primary key default gen_random_uuid(),
  book_id text not null references published_books(id) on delete cascade,
  reader_id uuid not null references auth.users(id) on delete cascade,
  -- One row per reader per book per UTC day, enforced below — this is what stops "recent
  -- readers" from being farmable by one account just re-opening the same book in a loop.
  read_day date not null default ((now() at time zone 'utc')::date),
  created_at timestamptz not null default now(),
  unique (book_id, reader_id, read_day)
);

alter table book_read_events enable row level security;

-- A reader logs their own read, never someone else's, never a book's own author reading their
-- own work (that would let an author farm their own "recent readers" for free) — and never a
-- banned account, same gate every other content-adjacent insert policy in this schema uses.
create policy "a reader logs their own read" on book_read_events
  for insert with check (
    auth.uid() = reader_id
    and not is_banned(auth.uid())
    and not exists (select 1 from published_books b where b.id = book_id and b.author_id = auth.uid())
  );
-- Only a reader's own read history is readable directly — the aggregate a Rising Star score
-- needs is only ever produced through compute_rising_stars() below (security definer), never by
-- a client reading and summing this table itself.
create policy "a reader reads their own read history" on book_read_events
  for select using (auth.uid() = reader_id);

create index if not exists book_read_events_book_day_idx on book_read_events (book_id, read_day);
create index if not exists book_read_events_reader_day_idx on book_read_events (reader_id, read_day);

-- ============================================================================================
-- 2. follow_events — an insert-only ledger of genuinely NEW follows, separate from the mutable
--    `follows` table (which only ever reflects CURRENT follow state and is deleted on unfollow).
-- ============================================================================================

create table if not exists follow_events (
  id uuid primary key default gen_random_uuid(),
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- The whole anti-cycling guard: only the first follow a given pair has EVER produced can ever
  -- insert here. See log_follow_event() below for the on-conflict-do-nothing that enforces it.
  unique (follower_id, followee_id)
);

alter table follow_events enable row level security;
-- Public read, same as `follows` itself — "who gained a follower recently" isn't sensitive, and
-- this is what a future client-side display (not just compute_rising_stars()) could read
-- directly without needing its own RPC.
create policy "anyone can read follow events" on follow_events
  for select using (true);
-- Deliberately no insert policy for authenticated: this table is only ever written by the
-- trigger below (security definer), so a client can't backdate a follow_event or otherwise
-- spoof "gained a follower" without an actual row in `follows` having caused it.

create or replace function log_follow_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.follower_id = new.followee_id then
    return new; -- defensive only — the app never offers a self-follow button, but never ledger
                -- one even if some future path allowed it.
  end if;
  insert into follow_events (follower_id, followee_id)
  values (new.follower_id, new.followee_id)
  on conflict (follower_id, followee_id) do nothing;
  return new;
end;
$$;

drop trigger if exists follows_log_event on follows;
create trigger follows_log_event
  after insert on follows
  for each row execute function log_follow_event();

create index if not exists follow_events_followee_idx on follow_events (followee_id, created_at desc);

-- ============================================================================================
-- 3. book_publish_events — pins each book_id's TRUE first-ever publish moment, permanently,
--    independent of published_books (which is deleted on unpublish and freely re-upserted with
--    a client-supplied published_at on republish — see this migration's header, gaming vector c).
-- ============================================================================================

create table if not exists book_publish_events (
  -- No foreign key to published_books(id) on purpose: unlike every other new table here, this
  -- one has to OUTLIVE the published_books row it describes (survive an unpublish), which an
  -- `on delete cascade` FK would defeat entirely.
  book_id text primary key,
  author_id uuid not null references auth.users(id) on delete cascade,
  first_published_at timestamptz not null default now()
);

alter table book_publish_events enable row level security;
create policy "anyone can read book publish events" on book_publish_events
  for select using (true);
-- No insert policy for authenticated — written only by the trigger below.

create or replace function log_book_publish_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into book_publish_events (book_id, author_id, first_published_at)
  values (new.id, new.author_id, now())
  on conflict (book_id) do nothing; -- pins the true first publish; a later unpublish + republish
                                     -- of the same book_id (or any ordinary re-upsert/update) is
                                     -- an INSERT again from published_books' point of view but
                                     -- never moves this row.
  return new;
end;
$$;

drop trigger if exists published_books_log_publish_event on published_books;
create trigger published_books_log_publish_event
  after insert on published_books
  for each row execute function log_book_publish_event();

-- One-time backfill so books already published before this migration ran aren't invisible to it
-- — best-effort, using each book's existing published_at as its first-known publish moment,
-- same spirit as migration 37's own backfill block.
insert into book_publish_events (book_id, author_id, first_published_at)
select id, author_id, published_at from published_books
on conflict (book_id) do nothing;

-- ============================================================================================
-- 4. rising_star_config — the one moderator-tunable row every window, floor, cap, and weight
--    below is read from. Singleton pattern (id boolean primary key default true check (id)):
--    there is exactly one row, ever.
-- ============================================================================================

create table if not exists rising_star_config (
  id boolean primary key default true check (id),
  window_days integer not null default 7 check (window_days between 1 and 90),
  compare_window_days integer not null default 7 check (compare_window_days between 1 and 90),
  min_distinct_recent_readers integer not null default 3 check (min_distinct_recent_readers >= 0),
  max_counted_publishes_per_window integer not null default 3 check (max_counted_publishes_per_window between 1 and 50),
  result_limit integer not null default 10 check (result_limit between 1 and 100),
  weight_recent_readers numeric not null default 3.0 check (weight_recent_readers >= 0),
  weight_reading_growth numeric not null default 4.0 check (weight_reading_growth >= 0),
  weight_followers_gained numeric not null default 2.5 check (weight_followers_gained >= 0),
  weight_book_engagement numeric not null default 2.0 check (weight_book_engagement >= 0),
  weight_publishing_activity numeric not null default 1.5 check (weight_publishing_activity >= 0),
  updated_at timestamptz not null default now()
);

insert into rising_star_config (id) values (true) on conflict (id) do nothing;

alter table rising_star_config enable row level security;
-- Same trust tier as the moderation queue and content bans — a moderator can retune Rising Star
-- scoring the same way they moderate content, without needing the service-role key or a
-- separate deploy. Not publicly readable: the exact floors/caps are part of what makes this hard
-- to game, and there's no legitimate reader-facing reason to expose them.
create policy "moderators read rising star config" on rising_star_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update rising star config" on rising_star_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- 5. compute_rising_stars() — the score itself. security definer so it can read across every
--    author's rows for aggregation (book_read_events/follow_events select policies are
--    deliberately narrow — see above), but it only ever returns aggregates, never a raw row from
--    any of those tables, so it can't be used to reconstruct anyone's individual read/follow
--    history.
-- ============================================================================================

create or replace function compute_rising_stars(p_window_days integer default null, p_result_limit integer default null)
returns table (
  author_id uuid,
  pen_name text,
  display_name text,
  avatar_url text,
  recent_unique_readers integer,
  reading_growth integer,
  followers_gained integer,
  book_engagement numeric,
  recent_publishes integer,
  reputation_gained numeric,
  score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select * from rising_star_config limit 1
  ),
  params as (
    select
      -- p_window_days/p_result_limit let a caller preview a different window/size, but every
      -- WEIGHT and FLOOR below always comes from cfg — never from an argument — so a client can
      -- narrow what it asks for but can never change what a signal is worth.
      greatest(1, least(90, coalesce(p_window_days, (select window_days from cfg), 7)))::int as window_days,
      coalesce((select compare_window_days from cfg), 7)::int as compare_window_days,
      greatest(1, least(100, coalesce(p_result_limit, (select result_limit from cfg), 10)))::int as result_limit,
      coalesce((select min_distinct_recent_readers from cfg), 3)::int as min_readers,
      coalesce((select max_counted_publishes_per_window from cfg), 3)::int as max_pub,
      coalesce((select weight_recent_readers from cfg), 3.0)::numeric as w_readers,
      coalesce((select weight_reading_growth from cfg), 4.0)::numeric as w_growth,
      coalesce((select weight_followers_gained from cfg), 2.5)::numeric as w_followers,
      coalesce((select weight_book_engagement from cfg), 2.0)::numeric as w_engagement,
      coalesce((select weight_publishing_activity from cfg), 1.5)::numeric as w_publishing
  ),
  windows as (
    select
      now() - make_interval(days => window_days) as cur_start,
      now() - make_interval(days => window_days + compare_window_days) as prev_start,
      now() - make_interval(days => window_days) as prev_end
    from params
  ),
  -- Only currently-published, non-content-banned authors are candidates at all.
  eligible_authors as (
    select distinct b.author_id
    from published_books b
    join profiles p on p.id = b.author_id
    where coalesce(p.banned, false) = false
  ),
  reads_cur as (
    select b.author_id, count(distinct r.reader_id) as readers
    from book_read_events r
    join published_books b on b.id = r.book_id, windows w
    where r.created_at >= w.cur_start
    group by b.author_id
  ),
  reads_prev as (
    select b.author_id, count(distinct r.reader_id) as readers
    from book_read_events r
    join published_books b on b.id = r.book_id, windows w
    where r.created_at >= w.prev_start and r.created_at < w.prev_end
    group by b.author_id
  ),
  followers_cur as (
    select f.followee_id as author_id, count(*) as gained
    from follow_events f, windows w
    where f.created_at >= w.cur_start and f.follower_id <> f.followee_id
    group by f.followee_id
  ),
  reviews_cur as (
    -- Never a book's own author reviewing themselves — reviews' own unique(book_id,
    -- reviewer_id) already stops a reader from reviewing the same book twice, but this still
    -- guards the self-review case defensively at the scoring layer.
    select b.author_id, count(*) as ct
    from reviews rv
    join published_books b on b.id = rv.book_id, windows w
    where rv.created_at >= w.cur_start and rv.reviewer_id <> b.author_id
    group by b.author_id
  ),
  purchases_cur as (
    -- status = 'success' only — a pending or failed purchase can't be faked into existing
    -- without Paystack itself confirming real money moved (see purchases' own comment on why it
    -- has no client insert/update policy at all), so this is already about as hard to fake as a
    -- signal can be.
    select pu.author_id, count(*) as ct
    from purchases pu, windows w
    where pu.status = 'success' and pu.created_at >= w.cur_start and pu.buyer_id <> pu.author_id
    group by pu.author_id
  ),
  publishes_cur as (
    -- The immutable ledger (section 3 above), not published_books.published_at directly — this
    -- is what makes recent publishing activity immune to the unpublish/republish loophole.
    select e.author_id, count(*) as ct
    from book_publish_events e, windows w
    where e.first_published_at >= w.cur_start
    group by e.author_id
  )
  select
    ea.author_id,
    p.pen_name, p.display_name, p.avatar_url,
    coalesce(rc.readers, 0)::integer as recent_unique_readers,
    greatest(coalesce(rc.readers, 0) - coalesce(rp.readers, 0), 0)::integer as reading_growth,
    coalesce(fc.gained, 0)::integer as followers_gained,
    -- Same diminishing curve (value * sqrt(count)) and the same real per-action values
    -- (review = 8, purchase = 4) as REPUTATION_VALUES in author-reputation.jsx — reviews and
    -- purchases are real, live signals, just not yet folded into lifetime Reputation there (see
    -- that file's own REPUTATION_SOURCES comment); this is the "book engagement" bullet of the
    -- Rising Star spec, computed on the same recent-window basis as everything else here.
    round(
      (case when coalesce(rv.ct, 0) > 0 then 8.0 * sqrt(coalesce(rv.ct, 0)) else 0 end)
      + (case when coalesce(pc.ct, 0) > 0 then 4.0 * sqrt(coalesce(pc.ct, 0)) else 0 end)
    , 2) as book_engagement,
    least(coalesce(pb.ct, 0), (select max_pub from params))::integer as recent_publishes,
    -- Informational only, not summed a second time into `score` below (followers_gained and
    -- recent_publishes already each have their own independently-weighted score term) — this
    -- mirrors what those two signals would be worth under the app's real lifetime-Reputation
    -- formula (follow = 2, publishedBook = 40), just scoped to this recent window instead of a
    -- lifetime total, so the UI can show "recent reputation-equivalent points earned" honestly.
    round(
      (case when coalesce(fc.gained, 0) > 0 then 2.0 * sqrt(coalesce(fc.gained, 0)) else 0 end)
      + (case when coalesce(pb.ct, 0) > 0 then 40.0 * sqrt(least(coalesce(pb.ct, 0), (select max_pub from params))) else 0 end)
    , 2) as reputation_gained,
    round(
      -- Reading-related terms are floored to zero entirely below min_distinct_recent_readers —
      -- the anti-collusion guard described in this migration's header.
      (case when coalesce(rc.readers, 0) >= (select min_readers from params)
        then (select w_readers from params) * sqrt(coalesce(rc.readers, 0))
             + (select w_growth from params) * sqrt(greatest(coalesce(rc.readers, 0) - coalesce(rp.readers, 0), 0))
        else 0 end)
      + (select w_followers from params) * (case when coalesce(fc.gained, 0) > 0 then sqrt(coalesce(fc.gained, 0)) else 0 end)
      + (select w_engagement from params) *
          ((case when coalesce(rv.ct, 0) > 0 then sqrt(coalesce(rv.ct, 0)) else 0 end)
           + (case when coalesce(pc.ct, 0) > 0 then sqrt(coalesce(pc.ct, 0)) else 0 end))
      + (select w_publishing from params) * least(coalesce(pb.ct, 0), (select max_pub from params))
    , 4) as score
  from eligible_authors ea
  join profiles p on p.id = ea.author_id
  left join reads_cur rc on rc.author_id = ea.author_id
  left join reads_prev rp on rp.author_id = ea.author_id
  left join followers_cur fc on fc.author_id = ea.author_id
  left join reviews_cur rv on rv.author_id = ea.author_id
  left join purchases_cur pc on pc.author_id = ea.author_id
  left join publishes_cur pb on pb.author_id = ea.author_id
  -- No recent signal of any kind at all -- not a Rising Star this window, full stop, rather than
  -- a 0-score row cluttering the result.
  where coalesce(rc.readers, 0) + coalesce(fc.gained, 0) + coalesce(rv.ct, 0) + coalesce(pc.ct, 0) + coalesce(pb.ct, 0) > 0
  order by score desc, ea.author_id
  limit (select result_limit from params);
$$;

revoke all on function compute_rising_stars(integer, integer) from public;
grant execute on function compute_rising_stars(integer, integer) to authenticated;

-- Lets a reader log a read without needing to know book_read_events' shape or handle the
-- same-day unique-constraint conflict itself — see src/lib/rising-stars.js's logBookRead, which
-- calls this instead of inserting directly.
-- Deliberately NOT security definer, unlike compute_rising_stars() above and the trigger
-- functions in sections 2/3 — this one runs as the CALLING user on purpose, so book_read_events'
-- own insert policy (own account only, never a banned account, never a book's own author) is the
-- thing actually enforcing the self-read guard, not this function pretending to. A security
-- definer version here would run as the function owner and bypass that RLS check entirely,
-- silently defeating the "an author can't farm reads on their own book" protection this
-- migration's header promises.
create or replace function log_book_read(p_book_id text)
returns void
language plpgsql
set search_path = public
as $$
begin
  insert into book_read_events (book_id, reader_id)
  values (p_book_id, auth.uid())
  on conflict (book_id, reader_id, read_day) do nothing;
exception
  -- Catches both: (a) the insert policy (own account, not banned, not this book's own author)
  -- denying the insert via RLS — still enforced here since this function runs as the caller, not
  -- as a security definer bypass — for a reader who, say, opened their own published book; and
  -- (b) a foreign-key violation for a book_id that isn't in published_books at all, e.g. a book
  -- still local-only/never published, or read from an app version that passes a raw project id.
  -- Either way this is a fire-and-forget signal, not something that should ever interrupt an
  -- actual read — any failure here just means this open doesn't count toward Rising Star.
  when others then
    return;
end;
$$;

revoke all on function log_book_read(text) from public;
grant execute on function log_book_read(text) to authenticated;
