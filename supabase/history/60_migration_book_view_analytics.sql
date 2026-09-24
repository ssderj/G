-- Migration 60: Creator Dashboard's Analytics tab — "Reader activity, traffic sources, and
-- trends across every published work" — was a CreatorComingSoonPanel (see creator-dashboard.jsx)
-- because there was no events-tracking table, exactly the gap Phase 2's README flagged as
-- deliberately out of scope for that phase ("Readers tab doesn't have traffic sources or page
-- views — that needs a separate events-tracking table, not part of this phase"). This migration
-- is that table.
--
-- Scope, deliberately: two event types only — `detail_view` (a reader opened a book's detail
-- card in the Grand Library) and `read_start` (a reader began reading the full text, from
-- anywhere: Grand Library, Author's Hall, or a Guild Bookshelf). Nothing here tracks reading
-- *progress* (how far into a book someone got, time spent, page turns) — that's a meaningfully
-- bigger scope (needs a durable per-reader reading-position signal, which this app doesn't have
-- even locally for someone else's book) and a separate decision if it's ever worth building.
--
-- Privacy posture: raw rows are never client-readable, by anyone, under any policy — no select
-- policy exists on this table at all, matching guild_treasury_transactions' "no client select
-- policy, everything through a function" stance, but here the reason is privacy rather than
-- money: a raw row ties a specific account (or none) to a specific book at a specific timestamp,
-- and nobody except that book's own author has a legitimate reason to see that traffic, in
-- aggregate, not as a list of who-viewed-what. `fetch_book_view_summary()` below is the only
-- read path, and it only ever returns aggregate counts (never a viewer's identity) to the book's
-- own author.
--
-- Anti-abuse posture, honestly scoped: `record_book_view()` dedupes a signed-in viewer's own
-- repeat views of the same book within a 5-minute window (a page reload or a double-tap
-- shouldn't count twice), the same spirit as this schema's other "a rapid repeat of the same
-- action shouldn't double-count" guards (e.g. 06_migration_guard_guild_member_stats_delta.sql).
-- An anonymous (signed-out) viewer has no durable identity to dedupe against — see
-- shared-utils/device-signal.js's own header for why nothing client-generated survives a cleared
-- browser or a private window — so an anonymous view count is an honest approximate signal, not
-- an abuse-hardened one, same as every other anonymous-traffic count on the open web. Good enough
-- to show a writer roughly how much interest a listing is getting; not something anything else in
-- this schema (payouts, rankings, achievements) ever reads or depends on.

create table if not exists book_view_events (
  id uuid primary key default gen_random_uuid(),
  book_id text not null references published_books(id) on delete cascade,
  -- Null for a signed-out viewer. Never a client-supplied id — record_book_view() always sets
  -- this from auth.uid() itself, the same "never trust what the client reports" stance every
  -- other security-definer write in this schema takes.
  viewer_id uuid references auth.users(id) on delete set null,
  event_type text not null check (event_type in ('detail_view', 'read_start')),
  -- Where the view originated. 'direct' covers every path not worth a dedicated bucket yet (a
  -- shared link, a bookmark, a guild anthology deep-link) — see record_book_view()'s own default.
  source text not null check (source in (
    'featured', 'new_releases', 'top_rated', 'discover', 'cart',
    'author_profile', 'guild_bookshelf', 'direct'
  )),
  created_at timestamptz not null default now()
);

alter table book_view_events enable row level security;
-- No select/insert/update/delete policy at all, for any role — see the privacy note above.
-- Every read goes through fetch_book_view_summary() (author-only, aggregate); every write goes
-- through record_book_view() (validates event_type/source itself via the column checks, sets
-- viewer_id from auth.uid()). Both are security definer functions, so they run with the table
-- owner's privileges regardless of what RLS would otherwise allow a caller directly.

create index if not exists book_view_events_book_id_created_at_idx
  on book_view_events (book_id, created_at desc);
-- Backs record_book_view()'s own dedupe check (book_id, viewer_id, event_type, recent
-- created_at) as well as fetch_book_view_summary()'s per-book aggregation.
create index if not exists book_view_events_book_id_viewer_id_idx
  on book_view_events (book_id, viewer_id, event_type, created_at desc);

-- ================================================================================================
-- record_book_view — the only way a row lands in book_view_events. Callable signed-in OR signed-
-- out (this is the one function in this schema granted to the `anon` role, not just
-- `authenticated` — reading a free book has never required signing in, see grand-library-cards.jsx
-- BookDetailModal, so tracking that a book was viewed can't require it either).
-- ================================================================================================
create or replace function record_book_view(p_book_id text, p_event_type text, p_source text default 'direct')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_viewer_id uuid := auth.uid(); -- null when called signed-out; never trusted from the client
begin
  -- Unknown book id: a no-op, not an error. A stale client (an already-unpublished book still
  -- open in a reader's tab) shouldn't surface a visible failure for something this cosmetic.
  if not exists (select 1 from published_books where id = p_book_id) then
    return;
  end if;

  -- Dedupe a signed-in viewer's own rapid repeat of the same (book, event_type) — see header.
  if v_viewer_id is not null and exists (
    select 1 from book_view_events
    where book_id = p_book_id and viewer_id = v_viewer_id and event_type = p_event_type
      and created_at > now() - interval '5 minutes'
  ) then
    return;
  end if;

  -- p_event_type/p_source are validated by the table's own check constraints below — an invalid
  -- value here raises rather than silently coercing, same as every other constrained-text insert
  -- in this schema.
  insert into book_view_events (book_id, viewer_id, event_type, source)
  values (p_book_id, v_viewer_id, p_event_type, coalesce(p_source, 'direct'));
end;
$$;

revoke all on function record_book_view(text, text, text) from public;
grant execute on function record_book_view(text, text, text) to authenticated, anon;

-- ================================================================================================
-- fetch_book_view_summary — the only read path. Author-only: raises if the caller isn't the
-- book's own author, same shape as save_bank_account's "Not your saved bank account" check.
-- Returns one row: total counts by event_type, a rough unique-viewer count (signed-in viewers
-- only — an anonymous view has no identity to de-duplicate by, counted in total_views but not in
-- unique_viewers), a source breakdown, and a 30-day daily trend — everything the Analytics tab
-- needs in one round trip, same "one summary call, not N" shape as guild_treasury_summary().
-- ================================================================================================
create or replace function fetch_book_view_summary(p_book_id text)
returns table (
  total_detail_views bigint,
  total_read_starts bigint,
  unique_viewers bigint,
  views_by_source jsonb,
  daily_trend jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author_id uuid;
begin
  select author_id into v_author_id from published_books where id = p_book_id;
  if v_author_id is null then
    raise exception 'No published book found with that id.';
  end if;
  if v_author_id <> auth.uid() then
    raise exception 'Only this book''s own author can view its analytics.';
  end if;

  return query
  select
    (select count(*) from book_view_events where book_id = p_book_id and event_type = 'detail_view'),
    (select count(*) from book_view_events where book_id = p_book_id and event_type = 'read_start'),
    (select count(distinct viewer_id) from book_view_events where book_id = p_book_id and viewer_id is not null),
    (select coalesce(jsonb_object_agg(source, cnt), '{}'::jsonb)
       from (select source, count(*) as cnt from book_view_events where book_id = p_book_id group by source) s),
    (select coalesce(jsonb_agg(jsonb_build_object('date', day, 'count', cnt) order by day), '[]'::jsonb)
       from (
         select date_trunc('day', created_at)::date as day, count(*) as cnt
         from book_view_events
         where book_id = p_book_id and created_at > now() - interval '30 days'
         group by 1
       ) d);
end;
$$;

revoke all on function fetch_book_view_summary(text) from public;
grant execute on function fetch_book_view_summary(text) to authenticated;
