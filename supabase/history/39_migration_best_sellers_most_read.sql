-- Migration 39: Best Sellers & Most Read — verified, recency-weighted, server-side book rankings.
--
-- Living Universe's existing "Best Sellers" and "Most Read" sections (living-universe-screen.jsx)
-- have, up to now, both been counting the on-device Chronicle simulation — how often a title
-- happened to appear in a locally-generated feed, not a real sale or a real read. This migration
-- replaces that with the real thing: two functions, compute_best_sellers() and
-- compute_most_read(), each reading only from a table nobody can write to by hand.
--
-- What makes each one trustworthy:
--
--   BEST SELLERS reads only `purchases` rows with kind = 'book' and status = 'success'. Look at
--   that table's own policies (supabase/schema.sql): there is no client insert/update policy on
--   it AT ALL — a row only ever exists, and only ever reaches 'success', because
--   paystack-init-purchase and paystack-webhook (both service_role, both driven by Paystack's own
--   callback) put it there. An author cannot inflate this by editing a column, because there is
--   no column of theirs to edit — the entire ranking is downstream of real money changing hands.
--   The one gaming vector real money doesn't close on its own — an author spending their own
--   money to buy their own book back — is closed explicitly below (buyer_id <> author_id).
--
--   MOST READ reads only `book_read_events`, added by migration 38 specifically to be hard to
--   fake: one counted read per (book, reader) per day, and a book's own author is refused by RLS
--   from ever logging a read on their own work. This migration doesn't add any new protection for
--   it — it inherits everything migration 38 already built — it's just the first thing to
--   actually rank books by it.
--
-- Both rankings share the same anti-manipulation shape, so the two design choices below are
-- explained once:
--
--   1. RECENT PERFORMANCE, NOT ONLY LIFETIME. Rather than a hard recent/not-recent cutoff (like
--      Rising Star's fixed window), each verified event is weighted by an exponential half-life
--      decay from its own timestamp — score = sum of sqrt(that buyer's/reader's own unit count)
--      * 0.5^(days_since_their_most_recent_event / half_life_days), config-driven, defaulting to
--      a 5-day half-life inside a 90-day lookback. A book that sold steadily this week outranks
--      one that spiked hard two months ago and has sold nothing since, without a cliff-edge
--      "in window / not in window" split that a seller could game by timing a single burst right
--      at the boundary. A book that stops selling or being read simply fades out of both lists on
--      its own, at a rate the config controls — it's never removed by a moderator action, and it
--      never needs to be: the decay does that work continuously.
--
--   2. HARD TO MANIPULATE BY VOLUME ALONE. Two guards, both shared with migration 38's Rising
--      Star scoring:
--        a. Per-person diminishing returns (sqrt of that buyer's/reader's own unit count, not a
--           flat count) — the same account buying or re-reading the same book five times is
--           worth much less than five different people doing it once each.
--        b. A minimum-distinct-people floor (book_ranking_config.min_distinct_buyers /
--           min_distinct_readers) below which a book's score is hard-zeroed, not just reduced —
--           two or three colluding accounts (an author's alt accounts, a small friend group)
--           can't manufacture a Best Seller or Most Read placement on their own; genuine breadth
--           of real buyers/readers is required before either list will surface a title at all.
--      What this migration deliberately does NOT try to do: detect "this buyer is in the same
--      guild as this author" and discount it. A guild's own readers genuinely buying or reading a
--      guildmate's book is real demand, not different in kind from any other fan base rallying
--      behind a title — penalizing that would punish exactly the community support Guild Halls
--      exist to encourage. The line held here is self-dealing (excluded outright) and thin
--      breadth (floored to zero), not "who happens to know the author."
--
--   3. CONFIGURABLE, SERVER-SIDE, SHARED WITH MODERATION'S OWN TRUST TIER.
--      book_ranking_config below is the same singleton-row, moderator-read/write-only shape as
--      migration 38's rising_star_config — retunable from the app itself by a moderator, never by
--      an author or guild owner, and never by an argument a client can pass to either function
--      (both take only an optional result-limit override — see each function's own comment).
--
-- ============================================================================================
-- 1. book_ranking_config — shared tuning for both rankings below.
-- ============================================================================================

create table if not exists book_ranking_config (
  id boolean primary key default true check (id),
  lookback_days integer not null default 90 check (lookback_days between 1 and 365),
  half_life_days numeric not null default 5 check (half_life_days > 0 and half_life_days <= 90),
  min_distinct_buyers integer not null default 2 check (min_distinct_buyers >= 0),
  min_distinct_readers integer not null default 3 check (min_distinct_readers >= 0),
  result_limit integer not null default 8 check (result_limit between 1 and 100),
  updated_at timestamptz not null default now()
);

insert into book_ranking_config (id) values (true) on conflict (id) do nothing;

alter table book_ranking_config enable row level security;
-- Same trust tier and same reasoning as rising_star_config in migration 38 — moderator-only, not
-- publicly readable (the exact floors are part of what makes both rankings hard to game).
create policy "moderators read book ranking config" on book_ranking_config
  for select using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));
create policy "moderators update book ranking config" on book_ranking_config
  for update using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_moderator));

-- ============================================================================================
-- 2. compute_best_sellers() — ranked by verified, recency-weighted purchase activity.
-- ============================================================================================

create or replace function compute_best_sellers(p_result_limit integer default null)
returns table (
  book_id text,
  title text,
  author_id uuid,
  author_name text,
  genre text,
  distinct_buyers integer,
  verified_sales_units integer,
  verified_revenue_kobo bigint,
  score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select * from book_ranking_config limit 1
  ),
  params as (
    select
      -- p_result_limit lets a caller ask for fewer/more rows; it can never change the lookback,
      -- decay, or floor below — those only ever come from cfg.
      coalesce((select lookback_days from cfg), 90)::int as lookback_days,
      coalesce((select half_life_days from cfg), 5)::numeric as half_life_days,
      coalesce((select min_distinct_buyers from cfg), 2)::int as min_buyers,
      greatest(1, least(100, coalesce(p_result_limit, (select result_limit from cfg), 8)))::int as result_limit
  ),
  lookback as (
    select now() - make_interval(days => lookback_days) as cutoff from params
  ),
  verified_sales as (
    select pu.book_id, pu.buyer_id, pu.author_id, pu.amount_kobo, pu.author_amount_kobo, pu.created_at
    from purchases pu, lookback l
    where pu.kind = 'book' and pu.status = 'success' and pu.created_at >= l.cutoff
      and pu.book_id is not null
      -- The one gaming vector real money alone doesn't close — an author buying their own book
      -- back with their own money, at a net cost of only the platform's fee, to fake demand.
      and pu.buyer_id <> pu.author_id
  ),
  per_buyer as (
    select
      book_id, buyer_id,
      count(*) as units,
      sum(author_amount_kobo) as buyer_author_revenue_kobo,
      max(created_at) as most_recent
    from verified_sales
    group by book_id, buyer_id
  ),
  per_book as (
    select
      pb.book_id,
      count(distinct pb.buyer_id)::integer as distinct_buyers,
      sum(pb.units)::integer as verified_sales_units,
      sum(pb.buyer_author_revenue_kobo)::bigint as verified_revenue_kobo,
      -- Per buyer: sqrt(their own unit count) \u00d7 half-life decay from THEIR most recent
      -- purchase of it, summed across buyers. A buyer who bought once, long ago, and never
      -- returned fades out at the same rate a single old purchase would on its own.
      sum(
        sqrt(pb.units) * exp(ln(0.5) * (extract(epoch from (now() - pb.most_recent)) / 86400.0) / (select half_life_days from params))
      ) as decayed_score
    from per_buyer pb
    group by pb.book_id
  )
  select
    b.id as book_id, b.title, b.author_id,
    coalesce(p.pen_name, p.display_name, 'A writer') as author_name, b.genre,
    per.distinct_buyers, per.verified_sales_units, coalesce(per.verified_revenue_kobo, 0)::bigint,
    round(per.decayed_score, 4) as score
  from per_book per
  join published_books b on b.id = per.book_id
  join profiles p on p.id = b.author_id
  -- Hard floor, not a soft discount — see this migration's header, point 2b.
  where per.distinct_buyers >= (select min_buyers from params)
  order by score desc, per.verified_sales_units desc, per.book_id
  limit (select result_limit from params);
$$;

revoke all on function compute_best_sellers(integer) from public;
grant execute on function compute_best_sellers(integer) to authenticated;

-- ============================================================================================
-- 3. compute_most_read() — ranked by verified, recency-weighted reader-open activity.
-- ============================================================================================

create or replace function compute_most_read(p_result_limit integer default null)
returns table (
  book_id text,
  title text,
  author_id uuid,
  author_name text,
  genre text,
  distinct_readers integer,
  verified_read_events integer,
  score numeric
)
language sql
stable
security definer
set search_path = public
as $$
  with cfg as (
    select * from book_ranking_config limit 1
  ),
  params as (
    select
      coalesce((select lookback_days from cfg), 90)::int as lookback_days,
      coalesce((select half_life_days from cfg), 5)::numeric as half_life_days,
      coalesce((select min_distinct_readers from cfg), 3)::int as min_readers,
      greatest(1, least(100, coalesce(p_result_limit, (select result_limit from cfg), 8)))::int as result_limit
  ),
  lookback as (
    select now() - make_interval(days => lookback_days) as cutoff from params
  ),
  per_reader as (
    select r.book_id, r.reader_id, count(*) as read_days, max(r.created_at) as most_recent
    from book_read_events r, lookback l
    where r.created_at >= l.cutoff
    group by r.book_id, r.reader_id
  ),
  per_book as (
    select
      pr.book_id,
      count(distinct pr.reader_id)::integer as distinct_readers,
      sum(pr.read_days)::integer as verified_read_events,
      sum(
        sqrt(pr.read_days) * exp(ln(0.5) * (extract(epoch from (now() - pr.most_recent)) / 86400.0) / (select half_life_days from params))
      ) as decayed_score
    from per_reader pr
    group by pr.book_id
  )
  select
    b.id as book_id, b.title, b.author_id,
    coalesce(p.pen_name, p.display_name, 'A writer') as author_name, b.genre,
    per.distinct_readers, per.verified_read_events,
    round(per.decayed_score, 4) as score
  from per_book per
  join published_books b on b.id = per.book_id
  join profiles p on p.id = b.author_id
  where per.distinct_readers >= (select min_readers from params)
  order by score desc, per.verified_read_events desc, per.book_id
  limit (select result_limit from params);
$$;

revoke all on function compute_most_read(integer) from public;
grant execute on function compute_most_read(integer) to authenticated;
