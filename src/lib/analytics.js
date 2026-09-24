import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// See supabase/history/60_migration_book_view_analytics.sql — the events table this wraps, and
// the two RPCs it defines. Backs the Creator Dashboard's Analytics tab (previously an honest
// Coming Soon panel, since there was no events-tracking table — see Phase 2's README note on
// this exact gap).

// Every value record_book_view() below is ever called with. Kept here (not just enforced by the
// table's own check constraint) so a call site typos into a compile-time reference error instead
// of a silent, swallowed RPC failure at runtime.
export const BOOK_VIEW_SOURCES = {
  FEATURED: 'featured',
  NEW_RELEASES: 'new_releases',
  TOP_RATED: 'top_rated',
  DISCOVER: 'discover',
  CART: 'cart',
  AUTHOR_PROFILE: 'author_profile',
  GUILD_BOOKSHELF: 'guild_bookshelf',
  MOST_READ: 'most_read',
  TRENDING: 'trending',
  DIRECT: 'direct',
};

// Fire-and-forget, same non-blocking philosophy as every other remote call in this app (the
// sync engine, publishBookWithDetails, guild membership pushes, etc.) — a reader opening a book
// or starting to read it must never wait on, or be blocked by, this call. Safe to call signed
// out (record_book_view() is granted to the anon role too, since reading a free book has never
// required an account) — callers don't need to check auth state first.
function recordBookView(bookId, eventType, source) {
  if (!bookId) return;
  try {
    supabase.rpc('record_book_view', {
      p_book_id: bookId,
      p_event_type: eventType,
      p_source: source || BOOK_VIEW_SOURCES.DIRECT,
    }).then(({ error }) => {
      if (error) console.warn('Inkroot: recordBookView failed', error.message);
    });
  } catch (e) {
    // Offline, unconfigured Supabase client, etc. — same defensive shape as every other
    // fire-and-forget call in this codebase; a missed view count is never worth surfacing.
  }
}

// A reader opened a book's detail card (BookDetailModal) — see grand-library-screen.jsx's
// openBook, the single choke point every "view a book's details" entry already goes through.
export function recordBookDetailView(bookId, source) {
  recordBookView(bookId, 'detail_view', source);
}

// A reader began reading a book's full text — from the Grand Library, an Author's Hall page, or
// a Guild Bookshelf. Source granularity here is coarser than detail views on purpose: unlike
// BookDetailModal (one shared component with one open path), "start reading" is triggered from
// several independent screens (see ink-root.jsx's openReaderBook), so only the screens that
// bothered to tag their own call get anything other than the 'direct' default — still an honest
// signal, just not a fully broken-out one everywhere yet.
export function recordBookReadStart(bookId, source) {
  recordBookView(bookId, 'read_start', source);
}

// The Creator Dashboard Analytics tab's one call per book. Returns null when signed out,
// offline, or the summary RPC itself fails (e.g. the caller isn't this book's own author) — same
// fallback contract as every other fetchX in this codebase; the panel's own loading/error states
// are what a caller renders around that.
export async function fetchBookViewSummary(bookId) {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.rpc('fetch_book_view_summary', { p_book_id: bookId }).maybeSingle();
    if (error) throw sanitizeError(error);
    if (!data) return null;
    return {
      totalDetailViews: Number(data.total_detail_views || 0),
      totalReadStarts: Number(data.total_read_starts || 0),
      uniqueViewers: Number(data.unique_viewers || 0),
      viewsBySource: data.views_by_source || {},
      dailyTrend: (data.daily_trend || []).map((d) => ({ date: d.date, count: Number(d.count) })),
    };
  } catch (e) {
    console.warn('Inkroot: fetchBookViewSummary failed', e);
    return null;
  }
}
