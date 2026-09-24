import { supabase, isSupabaseConfigured, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Best Sellers and Most Read are both computed entirely server-side (see
// supabase/history/39_migration_best_sellers_most_read.sql's compute_best_sellers() and
// compute_most_read()) from real, unforgeable tables — verified Paystack purchases for one,
// verified book_read_events (migration 38) for the other — each recency-weighted rather than a
// lifetime total, and neither editable by an author or guild through any column this app
// exposes. Same thin, honestly-failing wrapper shape as rising-stars.js: a failed call never
// blocks anything, it just means Living Universe falls back to its local Chronicle simulation
// for that section.

async function callBookRanking(rpcName, mapRow, { limit } = {}) {
  if (!isSupabaseConfigured) return [];
  try {
    const user = await currentUser();
    if (!user) return []; // both RPCs are authenticated-only, same as every other real RPC in this app
    const { data, error } = await supabase.rpc(rpcName, { p_result_limit: limit || null });
    if (error) throw sanitizeError(error);
    return (data || []).map(mapRow);
  } catch {
    return [];
  }
}

// Ranked by verified, recency-weighted purchase activity — real money, real breadth of buyers,
// never a lifetime sum. See the migration for exactly how "recent performance" is weighted.
export function fetchBestSellers({ limit } = {}) {
  return callBookRanking('compute_best_sellers', (row) => ({
    bookId: row.book_id,
    title: row.title,
    authorId: row.author_id,
    authorName: row.author_name,
    genre: row.genre,
    distinctBuyers: row.distinct_buyers || 0,
    verifiedSalesUnits: row.verified_sales_units || 0,
    verifiedRevenueKobo: Number(row.verified_revenue_kobo) || 0,
    score: Number(row.score) || 0,
  }), { limit });
}

// Ranked by verified, recency-weighted reader-open activity — completely separate signal from
// Best Sellers (a free sample can top this list without a single sale) and from Trending (a
// lighter-weight, unverified buzz indicator over a much shorter window — see fetchTrending below).
export function fetchMostRead({ limit } = {}) {
  return callBookRanking('compute_most_read', (row) => ({
    bookId: row.book_id,
    title: row.title,
    authorId: row.author_id,
    authorName: row.author_name,
    genre: row.genre,
    distinctReaders: row.distinct_readers || 0,
    verifiedReadEvents: row.verified_read_events || 0,
    score: Number(row.score) || 0,
  }), { limit });
}

// Ranked by short-window, fast-decaying view/read-start activity (book_view_events, migration
// 60) — deliberately a lighter, faster signal than Best Sellers/Most Read above (see
// compute_trending / migration 64's own header for the full reasoning): a 72-hour lookback with
// an 18-hour half-life by default, versus their 90-day lookback and 5-day half-life. Replaces
// Living Universe's old simulated "Trending Now" (useLuTrending, inbox-and-living-universe.jsx),
// which never read from a real table at all.
export function fetchTrending({ limit } = {}) {
  return callBookRanking('compute_trending', (row) => ({
    bookId: row.book_id,
    title: row.title,
    authorId: row.author_id,
    authorName: row.author_name,
    genre: row.genre,
    distinctSignedInViewers: row.distinct_signed_in_viewers || 0,
    viewEvents: row.view_events || 0,
    score: Number(row.score) || 0,
  }), { limit });
}
