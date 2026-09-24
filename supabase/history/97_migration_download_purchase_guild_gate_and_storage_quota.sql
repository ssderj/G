-- Closes three gaps found in a follow-up audit:
--   1. compute_best_sellers/compute_most_read/compute_trending/list_living_universe_feed are all
--      SECURITY DEFINER and were joining published_books with no destination filter — since they
--      bypass RLS entirely, a Guild-only book with enough sales/reads/views/reviews could surface
--      its title in the public rankings and Living Universe feed regardless of guild membership.
--   2. download-book and paystack-init-purchase had no Guild-membership check at all — either
--      let anyone download/buy a Guild-destination book regardless of membership, defeating the
--      entire point of publishing to a Guild instead of the Grand Library.
--   3. Uploads (mediaStorage.js -> Storage directly, no Edge Function in between) had no
--      server-side cap of any kind — a compromised or scripted client could upload without limit.
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
    round(per.decayed_score::numeric, 4) as score
  from per_book per
  -- destination = 'inkroot' only: this function is SECURITY DEFINER, so it bypasses
  -- published_books' own RLS entirely (Migration 90's guild-membership read policy never
  -- applies here) — without this filter, a guild-only book that sold copies would surface its
  -- title/author to every signed-in user through the public Best Sellers ranking, regardless of
  -- guild membership. Fixed as part of the security audit that also added rate limiting to
  -- several Edge Functions — see 96_migration_security_audit_fixes.sql.
  join published_books b on b.id = per.book_id and b.destination = 'inkroot'
  join profiles p on p.id = b.author_id
  -- Hard floor, not a soft discount — see this migration's header, point 2b.
  where per.distinct_buyers >= (select min_buyers from params)
  order by score desc, per.verified_sales_units desc, per.book_id
  limit (select result_limit from params);
$$;
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
    round(per.decayed_score::numeric, 4) as score
  from per_book per
  -- destination = 'inkroot' only — same reasoning as compute_best_sellers() above: this function
  -- is SECURITY DEFINER and bypasses published_books' own guild-membership RLS, so without this
  -- filter a guild-only book with enough reads would leak its title into the public Most Read
  -- ranking. See 96_migration_security_audit_fixes.sql.
  join published_books b on b.id = per.book_id and b.destination = 'inkroot'
  join profiles p on p.id = b.author_id
  where per.distinct_readers >= (select min_readers from params)
  order by score desc, per.verified_read_events desc, per.book_id
  limit (select result_limit from params);
$$;
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
    -- destination = 'inkroot' only, applied at the source: every downstream CTE derives its
    -- book_id set from this one, so filtering here is enough to keep a guild-only book out of
    -- the whole pipeline. Same reasoning as compute_best_sellers()/compute_most_read() above —
    -- this function is SECURITY DEFINER and bypasses published_books' guild RLS entirely. See
    -- 96_migration_security_audit_fixes.sql.
    select v.book_id, v.viewer_id, v.created_at, b.author_id as book_author_id
    from book_view_events v
    join published_books b on b.id = v.book_id and b.destination = 'inkroot'
    cross join lookback l
    where v.created_at >= l.cutoff
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
    round((coalesce(s.signed_in_score, 0) + coalesce(a.anon_score, 0))::numeric, 4) as score
  from signed_in_per_book s
  left join anon_per_book a on a.book_id = s.book_id
  join published_books b on b.id = s.book_id and b.destination = 'inkroot'
  join profiles p on p.id = b.author_id
  where s.distinct_signed_in_viewers >= (select min_viewers from params)
  order by score desc, view_events desc, b.id
  limit (select result_limit from params);
$$;
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
    -- destination = 'inkroot' only: this function is SECURITY DEFINER and bypasses
    -- published_books' guild-membership RLS, so a guild-only book's release would otherwise
    -- announce its title to every signed-in user in the public Living Universe feed. See
    -- 96_migration_security_audit_fixes.sql.
    join published_books b on b.id = e.book_id and b.destination = 'inkroot'
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
    -- destination = 'inkroot' only — same reasoning as the release branch above: a review left
    -- on a guild-only book would otherwise leak that book's title into the public feed too.
    join published_books b on b.id = r.book_id and b.destination = 'inkroot'
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

-- Closes three gaps found in a follow-up audit:
--   1. download-book and paystack-init-purchase had no Guild-membership check at all — either
--      let anyone download/buy a Guild-destination book regardless of membership, defeating the
--      entire point of publishing to a Guild instead of the Grand Library.
--   2. Uploads (mediaStorage.js -> Storage directly, no Edge Function in between) had no
--      server-side cap of any kind — a compromised or scripted client could upload without limit.
-- ============================================================================

-- Callable from a service-role Edge Function (where auth.uid() is unavailable — unlike
-- is_guild_member() above, which is fine relying on auth.uid() because it's only ever called
-- from a request that still carries the caller's own JWT). Mirrors the exact join pattern
-- "player/founder guild members read their guild's book listings" already use on
-- published_books/published_book_content, just parameterized by p_user_id instead of auth.uid()
-- so download-book and paystack-init-purchase (both running as the service role) can ask
-- "is THIS user a member of the guild THIS book belongs to" directly.
create or replace function is_guild_book_member(p_book_id text, p_user_id uuid)
returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from guild_published_books g
    join founder_guild_members m on m.guild_id = g.guild_id and m.user_id = p_user_id
    where g.book_id = p_book_id
  ) or exists (
    select 1 from guild_published_books g
    join player_guild_members m on m.guild_id::text = g.guild_id and m.user_id = p_user_id
    where g.book_id = p_book_id
  );
$$;

revoke all on function is_guild_book_member(text, uuid) from public;
grant execute on function is_guild_book_member(text, uuid) to authenticated;

-- Per-user storage quota + upload rate limit, enforced at the one point every upload actually
-- passes through regardless of app version or client bugs: the Storage API's own insert into
-- storage.objects. mediaStorage.js uploads straight to Storage with no Edge Function in the
-- middle, so a Postgres trigger here is the only real server-side enforcement point available —
-- a client-side check alone is trivially skippable.
create or replace function enforce_user_storage_quota()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_quota_bytes bigint := 209715200; -- 200 MB per user, combined across media + media-private
  v_current_bytes bigint;
  v_new_size bigint;
  v_owner uuid;
begin
  if new.bucket_id not in ('media', 'media-private') then
    return new;
  end if;

  v_owner := coalesce(new.owner, nullif(new.owner_id, '')::uuid);
  if v_owner is null then
    -- No identifiable uploader — shouldn't happen for a real client upload (both buckets'
    -- storage policies already require auth.uid() to match the folder's own user-id segment),
    -- but fail closed rather than let an unattributable row skip the quota check entirely.
    raise exception 'Upload rejected: could not identify the uploading user.';
  end if;

  -- Rate limit: the same per-user counter every rate-limited Edge Function already uses (see
  -- 96_migration_security_audit_fixes.sql) — 60 uploads/hour is well above normal cover/avatar
  -- usage while blocking a scripted upload loop. auth.uid() resolves correctly here because a
  -- Storage upload runs as a real authenticated request under the uploader's own JWT, not a
  -- service-role bypass.
  perform check_and_bump_rate_limit('storage_upload', 60, 3600);

  -- Quota: total bytes this user already has stored across both buckets, serialized with an
  -- advisory lock so two uploads racing right at the boundary can't both read the same
  -- pre-insert total and both slip through.
  perform pg_advisory_xact_lock(hashtext('storage_quota:' || v_owner::text));

  v_new_size := coalesce((new.metadata->>'size')::bigint, 0);

  select coalesce(sum((metadata->>'size')::bigint), 0) into v_current_bytes
  from storage.objects
  where bucket_id in ('media', 'media-private') and owner = v_owner;

  if v_current_bytes + v_new_size > v_quota_bytes then
    raise exception 'Storage quota exceeded (200MB total) — delete some uploads to free up space.';
  end if;

  return new;
end;
$$;

drop trigger if exists enforce_user_storage_quota_trigger on storage.objects;
create trigger enforce_user_storage_quota_trigger
  before insert on storage.objects
  for each row execute function enforce_user_storage_quota();
