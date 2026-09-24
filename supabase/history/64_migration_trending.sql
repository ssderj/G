-- Migration 64: Trending — real, short-window buzz, computed server-side.
--
-- Two places in this app have used the word "Trending" so far, and neither was real:
--   - Living Universe's "Trending Now" section (useLuTrending, inbox-and-living-universe.jsx) is
--     entirely simulated — eight fictional books from LU_BOOK_TITLES/LU_AUTHORS with a score that
--     randomly jitters every 7 seconds. Flavor, not a signal, and (unlike this app's honest
--     Coming Soon pattern everywhere else) never labeled as such.
--   - The Grand Library's own Trending shelf (grand-library-screen.jsx) has, until now, correctly
--     shown ComingSoonShelf rather than pretend otherwise.
-- This migration is the real thing: compute_trending(), reading only book_view_events (migration
-- 60) — the same table Creator Dashboard's Analytics tab already reads from, here surfaced
-- publicly for the first time.
--
-- Deliberately a WEAKER signal than Best Sellers/Most Read, on purpose — this is the "buzz"
-- shelf, not another verified-activity ranking:
--   1. SHORT WINDOW, FAST DECAY. compute_best_sellers()/compute_most_read() (migration 39) use a
--      90-day lookback with a 5-day half-life — "what's been performing well lately." Trending
--      uses a much shorter default lookback/half-life (72 hours / 18 hours, both configurable
--      below) — "what's hot in the last few days," dropping off fast rather than lingering.
--   2. LIGHTER SOURCE TABLE, ON PURPOSE. book_view_events logs a detail_view or read_start from
--      ANY visit, signed in or anonymous, with no purchase or one-per-day cap behind it — a much
--      lower bar than a verified purchase (Best Sellers) or a once-per-day capped, author-refused
--      read (Most Read, via book_read_events). That's the honest tradeoff this shelf makes for
--      being fast and reactive: it can go up on genuine early interest a verified-purchase signal
--      wouldn't show yet, and it can be nudged by browsing traffic verified activity can't be.
--
-- Still hard to fake outright, same two guards as migration 39 wherever they still apply:
--   a. SELF-VIEWS EXCLUDED. viewer_id = the book's own author is dropped before scoring, same
--      "self-dealing excluded outright" stance as Best Sellers' buyer_id <> author_id.
--   b. A SIGNED-IN FLOOR, not an anonymous one. A book only qualifies at all once at least
--      min_distinct_signed_in_viewers distinct SIGNED-IN viewers have looked at it recently
--      (default 2 — deliberately lower than Best Sellers'/Most Read's 2-3, since this shelf's
--      whole point is surfacing things earlier). Anonymous views can add a small amount to an
--      already-qualifying book's score (see anon_weight below) but can never single-handedly
--      qualify one — a script anonymously refreshing a book's page can inflate its score a little
--      once real signed-in viewers already noticed it, but can't manufacture a Trending listing
--      out of nothing.
--
-- ============================================================================================
-- 1. trending_config — its own singleton, separate from book_ranking_config (migration 39):
--    different units (hours, not days) and a different trust tier of signal to tune.
-- ============================================================================================

create table if not exists trending_config (
  id boolean primary key default true check (id),
  lookback_hours integer not null default 72 check (lookback_hours between 1 and 720),
  half_life_hours numeric not null default 18 check (half_life_hours > 0 and half_life_hours <= 720),
  min_distinct_signed_in_viewers integer not null default 2 check (min_distinct_signed_in_viewers >= 0),
  -- How much one anonymous view event is worth, relative to sqrt(1) = 1.0 for a signed-in
  -- viewer's first event in the window. Deliberately small — see point (b) above.
  anon_weight numeric not null default 0.15 check (anon_weight >= 0 and anon_weight <= 1),
  result_limit integer not null default 8 check (result_limit between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into trending_config (id) values (true) on conflict (id) do nothing;

alter table trending_config enable row level security;
-- Same trust tier as book_ranking_config (migration 39) — moderator-only. The exact floors and
-- weights are part of what makes this shelf hard to game, same reasoning as that table.
create policy "moderators read trending config" on trending_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update trending config" on trending_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- 2. book_view_events gets a 'trending' source bucket, same as migration 63 added 'most_read'
--    for the Most Read shelf — a reader opening a book from the Trending shelf gets its own
--    tracked source rather than falling into 'direct'.
-- ============================================================================================

alter table book_view_events drop constraint if exists book_view_events_source_check;
alter table book_view_events add constraint book_view_events_source_check check (source in (
  'featured', 'new_releases', 'top_rated', 'discover', 'cart',
  'author_profile', 'guild_bookshelf', 'most_read', 'trending', 'direct'
));

-- ============================================================================================
-- 3. compute_trending() — ranked by short-window, fast-decaying view/read-start activity.
-- ============================================================================================

create or replace function compute_trending(p_result_limit integer default null)
returns table (
  book_id text,
  title text,
  author_id uuid,
  author_name text,
  genre text,
  distinct_signed_in_viewers integer,
  view_events integer,
  score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select * from trending_config limit 1
  ),
  params as (
    select
      coalesce((select lookback_hours from cfg), 72)::int as lookback_hours,
      coalesce((select half_life_hours from cfg), 18)::numeric as half_life_hours,
      coalesce((select min_distinct_signed_in_viewers from cfg), 2)::int as min_viewers,
      coalesce((select anon_weight from cfg), 0.15)::numeric as anon_weight,
      greatest(1, least(100, coalesce(p_result_limit, (select result_limit from cfg), 8)))::int as result_limit
  ),
  lookback as (
    select now() - make_interval(hours => (select lookback_hours from params)) as cutoff
  ),
  recent_events as (
    select v.book_id, v.viewer_id, v.created_at, b.author_id as book_author_id
    from book_view_events v, lookback l
    join published_books b on b.id = v.book_id
    where v.created_at >= l.cutoff
      -- Self-views excluded outright, same stance as Best Sellers' buyer_id <> author_id.
      and (v.viewer_id is null or v.viewer_id <> b.author_id)
  ),
  per_signed_in_viewer as (
    select book_id, viewer_id, count(*) as events, max(created_at) as most_recent
    from recent_events
    where viewer_id is not null
    group by book_id, viewer_id
  ),
  signed_in_per_book as (
    select
      book_id,
      count(distinct viewer_id)::integer as distinct_signed_in_viewers,
      sum(events)::integer as signed_in_events,
      sum(
        sqrt(events) * exp(ln(0.5) * (extract(epoch from (now() - most_recent)) / 3600.0) / (select half_life_hours from params))
      ) as signed_in_score
    from per_signed_in_viewer
    group by book_id
  ),
  anon_per_book as (
    select
      book_id,
      count(*)::integer as anon_events,
      sum(
        (select anon_weight from params) * exp(ln(0.5) * (extract(epoch from (now() - created_at)) / 3600.0) / (select half_life_hours from params))
      ) as anon_score
    from recent_events
    where viewer_id is null
    group by book_id
  )
  select
    b.id as book_id, b.title, b.author_id,
    coalesce(p.pen_name, p.display_name, 'A writer') as author_name, b.genre,
    coalesce(s.distinct_signed_in_viewers, 0) as distinct_signed_in_viewers,
    (coalesce(s.signed_in_events, 0) + coalesce(a.anon_events, 0)) as view_events,
    round(coalesce(s.signed_in_score, 0) + coalesce(a.anon_score, 0), 4) as score
  from signed_in_per_book s
  left join anon_per_book a on a.book_id = s.book_id
  join published_books b on b.id = s.book_id
  join profiles p on p.id = b.author_id
  -- Hard floor on SIGNED-IN breadth only — see point (b) above. A book with only anonymous
  -- traffic, however much, never clears this on its own.
  where s.distinct_signed_in_viewers >= (select min_viewers from params)
  order by score desc, view_events desc, b.id
  limit (select result_limit from params);
$$;

revoke all on function compute_trending(integer) from public;
grant execute on function compute_trending(integer) to authenticated;
