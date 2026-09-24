-- Migration 84: list_living_universe_feed() — a real, platform-wide backend for the Living
-- Universe activity Feed (fix-tracker item 19).
--
-- Per the app owner's own call on this item: the Feed is a PUBLIC/cross-user view over the same
-- kind of real events item 18 (Author Inbox / notifications, migration 83) already made real —
-- not a second, separate "platform highlights" concept. It deliberately does NOT read from
-- `notifications` itself: that table is recipient-gated ("your book got reviewed"), which is the
-- wrong shape for a public feed ("a book got reviewed") even before RLS would block it outright.
--
-- Every source table this function reads already has an "anyone can read" policy of its own —
-- follow_events (migration 37), book_publish_events (migration 37), reviews (original schema),
-- guild_join_events (migration 39) — so this is purely a read-side convenience layer (one call,
-- names/titles already resolved) over data a client could already see, exactly the same
-- "returns strictly less than, or the same public shape as, what it reads" posture as
-- list_public_guild_events()/get_public_guild_profile() (migration 51). No existing table,
-- policy, or trigger is touched — this migration only adds a new function.
--
-- Guild Order activity (Council/Manuscript/World Bible) and guild event payouts are deliberately
-- EXCLUDED here even though they're part of item 18's real event set: those tables are
-- member-scoped by their own RLS ("members read their guild's..."), so surfacing them on a public,
-- platform-wide feed would mean showing one guild's internal activity to everyone, which is a
-- privacy regression this migration does not make. If a "real Guild Hall news" feed is ever
-- wanted, that is a new, guild-scoped question, not this one.
--
-- Four real sources, matching the local simulation's own vocabulary (luMakeEntry) where it lines
-- up, so LivingUniverseScreen's Chronicle keeps the shape it already renders:
--   'release' <- book_publish_events   (a book's true first-ever publish)
--   'follow'  <- follow_events         (a genuinely new follow)
--   'review'  <- reviews               (a reader reviewed a book)
--   'guild'   <- guild_join_events     (someone joined a Player Guild)
-- Author/reviewer/follower/joiner names are resolved server-side from `profiles` (display_name,
-- falling back to pen_name) so the client never needs a second round-trip per row, same
-- convenience fetchNotifications() already provides for the Inbox.
--
-- `id` is synthesized as a deterministic uuid (md5 of a per-source-table tag + the row's own
-- primary key) rather than added as a new physical column on any of the four source tables —
-- stable across repeated calls, so a client that de-dupes by id across refetches (same as
-- mergeRealNotifications does for the Inbox) works correctly.

create or replace function list_living_universe_feed(p_result_limit integer default null)
returns table (
  id uuid, kind text, created_at timestamptz, payload jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
  select u.id, u.kind, u.created_at, u.payload from (
    -- Releases: a book's true first-ever publish (book_publish_events already pins this
    -- permanently, independent of unpublish/republish — see that table's own header).
    select
      md5('release:' || e.book_id)::uuid as id,
      'release'::text as kind,
      e.first_published_at as created_at,
      jsonb_build_object(
        'book_id', e.book_id, 'title', b.title, 'genre', b.genre,
        'author_name', coalesce(p.display_name, p.pen_name, 'A writer')
      ) as payload
    from book_publish_events e
    join published_books b on b.id = e.book_id
    left join profiles p on p.id = e.author_id

    union all

    -- Follows: a genuinely new follow (follow_events is already an anti-cycling, insert-only
    -- ledger of first-time follows only — see its own header).
    select
      md5('follow:' || fe.id::text)::uuid,
      'follow'::text,
      fe.created_at,
      jsonb_build_object(
        'follower_name', coalesce(pf.display_name, pf.pen_name, 'A writer'),
        'followee_name', coalesce(pe.display_name, pe.pen_name, 'a writer')
      )
    from follow_events fe
    left join profiles pf on pf.id = fe.follower_id
    left join profiles pe on pe.id = fe.followee_id

    union all

    -- Reviews: a reader reviewed a book (reviews is already publicly readable in full).
    select
      md5('review:' || r.id::text)::uuid,
      'review'::text,
      r.created_at,
      jsonb_build_object(
        'book_id', r.book_id, 'title', b.title, 'rating', r.rating,
        'reviewer_name', coalesce(p.display_name, p.pen_name, 'A reader')
      )
    from reviews r
    join published_books b on b.id = r.book_id
    left join profiles p on p.id = r.reviewer_id

    union all

    -- Guild joins: someone joined a Player Guild (guild_join_events is already the same kind of
    -- anti-cycling, first-join-only ledger as follow_events).
    select
      md5('guildjoin:' || ge.id::text)::uuid,
      'guild'::text,
      ge.created_at,
      jsonb_build_object(
        'guild_id', ge.guild_id, 'guild_name', g.name,
        'user_name', coalesce(p.display_name, p.pen_name, 'A writer')
      )
    from guild_join_events ge
    join player_guilds g on g.id = ge.guild_id
    left join profiles p on p.id = ge.user_id
  ) u
  order by u.created_at desc
  limit coalesce(p_result_limit, 60);
end;
$$;

revoke all on function list_living_universe_feed(integer) from public;
grant execute on function list_living_universe_feed(integer) to authenticated;

-- Safe to run anytime: purely additive (one new function). No existing table, column, policy, or
-- trigger is modified.
