-- ============================================================================
-- 99_migration_book_view_input_validation_and_direct_insert_lockdown.sql
-- Audit of record_book_view() / book_view_events. Three gaps, all closed here:
--
--   1. DIRECT-INSERT BYPASS (the real hole). The table was first created (before migration 60)
--      with an INSERT policy, "anyone can log a book view", and Supabase's default table grants
--      give anon/authenticated INSERT. So a client could skip record_book_view() entirely and
--      POST rows straight to /rest/v1/book_view_events — no dedupe, no throttle, unlimited fake
--      views (viewer_id = null, or their own id). Migration 60's header says the table has NO
--      client policy at all, which is what was intended; this restores that. The policy is
--      dropped (a no-op if it was never created) and every direct table privilege is revoked
--      from anon/authenticated. record_book_view() and fetch_book_view_summary() are SECURITY
--      DEFINER, so nothing legitimate loses access.
--
--   2. UNVALIDATED INPUT. p_event_type / p_source were only checked by the table's CHECK
--      constraints at insert time — after the dedupe/throttle queries had already run with
--      whatever string the caller sent. They are now validated up front against the approved
--      lists and rejected with an exception. (The lists are the exact values the table's CHECK
--      constraints and src/lib/analytics.js's BOOK_VIEW_SOURCES already allow, so no legitimate
--      call changes. If a value is ever added, update the constraint, this function, and
--      BOOK_VIEW_SOURCES together.) Dedupe is keyed on (book, viewer, event_type) and never on
--      source, and event_type is now an exact-match whitelist, so varying either value cannot
--      produce a second countable row inside the dedupe window.
--
--   3. PER-VIEWER RATE LIMIT + DEDUPE RACE. A signed-in viewer was only deduped per book, so one
--      account could still spray views across every book. Added a per-viewer cap of 120 recorded
--      events/hour (well above real browsing; excess events are silently dropped, same no-op
--      shape as the existing dedupe/anon throttle, since the client call is fire-and-forget). A
--      per-viewer advisory lock now serializes that viewer's calls so two simultaneous identical
--      requests can't both pass the "not seen in the last 5 minutes" check. The count reads
--      book_view_events itself, backed by the index below (already present on the live database;
--      created here with `if not exists` so a fresh replay of schema.sql has it too).
--
-- The anonymous per-(book, event_type) burst throttle is unchanged. Anonymous traffic has no
-- durable identity to limit by (see 60's header), so it stays an approximate signal.
-- ============================================================================

drop policy if exists "anyone can log a book view" on book_view_events;
revoke all on table book_view_events from anon, authenticated;

create index if not exists book_view_events_viewer_created_idx
  on book_view_events (viewer_id, created_at desc) where viewer_id is not null;

create or replace function record_book_view(p_book_id text, p_event_type text, p_source text default 'direct')
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_viewer_id uuid := auth.uid(); -- null when called signed-out; never trusted from the client
  v_source text := coalesce(p_source, 'direct');
  v_viewer_hourly_limit constant int := 120;
  v_viewer_recent_count int;
  v_anon_burst_window constant interval := interval '1 minute';
  v_anon_burst_limit constant int := 30;
  v_anon_recent_count int;
begin
  -- Reject anything outside the approved values before any other work. Exact match only: no
  -- trimming or case-folding, so 'Detail_View' / 'detail_view ' are invalid, not aliases.
  if p_event_type is null or p_event_type not in ('detail_view', 'read_start') then
    raise exception 'Invalid book view event type.';
  end if;
  if v_source not in (
    'featured', 'new_releases', 'top_rated', 'discover', 'cart',
    'author_profile', 'guild_bookshelf', 'most_read', 'trending', 'direct'
  ) then
    raise exception 'Invalid book view source.';
  end if;

  -- Unknown book id: a no-op, not an error (a stale client shouldn't surface a failure).
  if not exists (select 1 from published_books where id = p_book_id) then
    return;
  end if;

  if v_viewer_id is not null then
    -- Serialize this viewer's own calls so concurrent identical requests can't both pass the
    -- dedupe/limit checks below before either has inserted.
    perform pg_advisory_xact_lock(hashtext('book_view:' || v_viewer_id::text));

    -- Dedupe a signed-in viewer's own rapid repeat of the same (book, event_type).
    if exists (
      select 1 from book_view_events
      where book_id = p_book_id and viewer_id = v_viewer_id and event_type = p_event_type
        and created_at > now() - interval '5 minutes'
    ) then
      return;
    end if;

    -- Per-viewer ceiling across all books.
    select count(*) into v_viewer_recent_count
    from book_view_events
    where viewer_id = v_viewer_id and created_at > now() - interval '1 hour';

    if v_viewer_recent_count >= v_viewer_hourly_limit then
      return;
    end if;
  else
    select count(*) into v_anon_recent_count
    from book_view_events
    where book_id = p_book_id
      and viewer_id is null
      and event_type = p_event_type
      and created_at > now() - v_anon_burst_window;

    if v_anon_recent_count >= v_anon_burst_limit then
      return;
    end if;
  end if;

  insert into book_view_events (book_id, viewer_id, event_type, source)
  values (p_book_id, v_viewer_id, p_event_type, v_source);
end;
$$;

revoke all on function record_book_view(text, text, text) from public;
grant execute on function record_book_view(text, text, text) to authenticated, anon;
