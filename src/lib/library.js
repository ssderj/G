import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Every function here is safe to call whether or not the reader is signed in — publishing,
// reviewing, and following are all opt-in account features layered on top of an app that fully
// works without one (same philosophy as syncEngine.js in Phase 1). Each function checks for a
// session itself rather than expecting the caller to track auth state, so App.jsx's publish/
// unpublish handlers don't need to know anything about sign-in status to call these safely.

// Pushes (or updates) a book's public listing. Called after a local publish/re-publish — the
// project's full content never leaves kv_store; this only sends the subset that's meant to be
// public (title, subtitle, seriesName, cover, blurb, genre, tags, wordCount, price, destination).
//
// subtitle/seriesName/cover/wordCount exist so a real author's public books (see
// lib/profile.js's fetchPublicProfile and authors-hall-screen.jsx's publicBooks) can render as
// full display cards on someone else's device, not just a title/blurb/genre stub — see
// 26_migration_published_books_richer_metadata.sql for why these weren't here originally, and
// publishBookToGuildRemote in library-guild.js for the guild-scoped counterpart this mirrors.
//
// No author_name here — the author's display name is looked up live from `profiles` by
// author_id whenever a listing is read (fetchAuthorRatingsSummary's callers, follow-based
// screens), instead of being copied onto this row at write time. See profile.js's syncProfile
// for why: a denormalized copy here would go stale the next time the writer changes their pen
// name, and nothing left in this file re-syncs it.
// NOTE ON ERROR PROPAGATION (fix-tracker item 26 follow-up, publishing reliability pass): the
// Supabase JS client's query builder is a thenable that always *resolves* to `{ data, error }` —
// it never rejects on its own for a normal database error (RLS denial, constraint violation,
// etc.), only for a genuine network/transport exception. Every mutation below therefore awaits
// its own call and explicitly throws when `error` comes back set, so a `.catch()` anywhere
// upstream (see lib/publish-flow.js) actually fires for a real failure instead of only for a
// dropped connection. Before this, `publishBookRemote(...).catch(...)` call sites could — and
// silently did — treat a rejected RLS write as a success.
export async function publishBookRemote({ id, title, subtitle, seriesName, cover, blurb, genre, tags, wordCount, price, destination, publishedAt, downloadable }) {
  const user = await currentUser();
  if (!user) return null; // not signed in — stays a local-only publish, same as before Phase 2
  const { error } = await supabase.from('published_books').upsert({
    id,
    author_id: user.id,
    title,
    subtitle: subtitle || '',
    series_name: seriesName || '',
    cover: cover || null,
    blurb: blurb || '',
    genre: genre || '',
    tags: tags || [],
    word_count: wordCount || 0,
    price: price || 0,
    destination,
    published_at: new Date(publishedAt || Date.now()).toISOString(),
    updated_at: new Date().toISOString(),
    downloadable: !!downloadable,
  });
  if (error) throw sanitizeError(error);
  return true;
}

// Whether this author already has a listing for `id` (live or unlisted). Used by publish-flow.js
// to decide whether a failed content step may roll the listing back: rolling back a listing that
// ALREADY existed (a re-publish) would take a live book away from its readers (and, before
// migration 118, a real delete also nulled purchases.book_id on every past sale, permanently
// severing buyers from what they paid for). Fails toward
// "exists" (true) on any error or when signed out, because the safe outcome of a wrong guess is
// merely leaving a listing in place, never deleting one.
export async function publishedBookExists(id) {
  const user = await currentUser();
  if (!user) return true;
  const { data, error } = await supabase.from('published_books').select('id').eq('id', id).eq('author_id', user.id).maybeSingle();
  if (error) return true;
  return !!data;
}

// Goes through the unpublish_book() RPC (migration 118) rather than a plain DELETE. A book nobody
// has paid for is deleted, as before; a book that already has paying readers is kept and hidden
// (destination 'unlisted') so they don't lose what they bought — purchases.book_id is `on delete
// set null` and the manuscript row cascades, so a real DELETE used to cut buyers off permanently.
// Resolves `{ mode }` with mode 'deleted' | 'hidden' | 'none' (no such listing of this author's),
// or null when signed out. Throws on a real failure, like every mutation in this file.
export async function unpublishBookRemote(id) {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc('unpublish_book', { p_book_id: id });
  if (error) throw sanitizeError(error);
  return { mode: data || 'none' };
}

// Mirrors a book's actual reader-facing content (chapters plus the display fields
// PublishedBookReader needs — see author-reputation.jsx) into published_book_content, so a
// device that isn't the author's own has something to fetch when it opens the book. Called
// alongside publishBookRemote on every publish/re-publish (see ink-root.jsx's
// publishBookWithDetails) — published_books itself never carries manuscript text, only the
// public listing fields, on purpose (see 70_migration_published_book_content.sql).
//
// `content` is intentionally the full shape PublishedBookReader consumes, not just chapters —
// title/subtitle/seriesName/author/cover/storyFormat — so openReaderBook can hand this straight
// to patchProjectDefaults() without a second round trip to reconstruct display fields from
// published_books + a profile lookup.
export async function publishBookContentRemote(id, content) {
  const user = await currentUser();
  if (!user) return null; // not signed in — stays local-only, same as publishBookRemote above
  const { error } = await supabase.from('published_book_content').upsert({
    book_id: id,
    content,
  });
  if (error) throw sanitizeError(error);
  return true;
}

// The read side of the mirror above — what openReaderBook (ink-root.jsx) and the Grand
// Library's "Peek at the opening" sample (grand-library-cards.jsx's loadSample) both fall back
// to once local IndexedDB comes back empty, which in practice is every device but the
// author's own. Safe to call while signed out (RLS on published_book_content is open-read,
// same as published_books) — returns null on any failure or missing row rather than throwing,
// so callers can treat "no content yet" and "network error" the same way (an unavailable-book
// state), without needing their own try/catch.
export async function fetchPublishedBookContent(bookId) {
  try {
    const { data, error } = await supabase
      .from('published_book_content')
      .select('content')
      .eq('book_id', bookId)
      .maybeSingle();
    if (error) throw sanitizeError(error);
    return data ? data.content : null;
  } catch (e) {
    console.warn('Inkroot: fetchPublishedBookContent failed', e);
    return null;
  }
}

// Whether the current device/reader may open a book's FULL content — the price-gating half of
// the read path that publishBookContentRemote/fetchPublishedBookContent above never actually
// enforced (that pair only fixed *whether* a non-author device could fetch a book's content at
// all; nothing afterward ever checked whether the reader had paid for it, so every priced book
// ended up readable in full for free — see ink-root.jsx's openReaderBook for the other half of
// this fix). A book with no price (free — the writer's own choice in the publishing wizard,
// project-workspace.jsx's priceMode), the book's own author, or a reader with a matching
// status:'success' row in `purchases` (see lib/payments.js's checkoutBook / the paystack-webhook
// Edge Function that's the only thing allowed to write that status) are all allowed; anyone else
// facing a priced book is not.
//
// Deliberately fails CLOSED (not allowed) on any lookup error — an offline or failed check has
// no way to tell a free book from a priced one it can't reach, and fetchPublishedBookContent's
// own fallback already shows an honest "book unavailable" state for a genuine network problem,
// so failing open here would just be a silent paywall bypass instead. Never throws.
export async function checkBookReadAccess(bookId) {
  try {
    const { data: book, error: bookError } = await supabase
      .from('published_books')
      .select('price, author_id, downloadable, destination')
      .eq('id', bookId)
      .maybeSingle();
    if (bookError) throw sanitizeError(bookError);
    const price = (book && book.price) || 0;
    const downloadable = !!(book && book.downloadable);
    if (price <= 0) return { allowed: true, price: 0, downloadable };
    // Production-readiness audit: a Guild-destination book is gated by Guild membership, not by a
    // purchase — that's what published_book_content's own read policies (migration 90/92) and
    // download-book both enforce, and Guild-only listings aren't sold in the Grand Library at all
    // (see the publishing wizard's own note). The wizard still lets a Guild book carry a price, so
    // without this a Guild member opening one hit the "buy it from the Grand Library" screen for a
    // book that isn't in the Grand Library — a dead end for the very readers it was published for.
    // This only lifts the client-side gate: the row is only visible here to the author, a real
    // member, or a moderator (published_books' RLS), and the manuscript fetch right after is still
    // enforced server-side, so a non-member still gets nothing.
    if (book && book.destination === 'guild') return { allowed: true, price: 0, downloadable };
    const user = await currentUser();
    if (user && book && user.id === book.author_id) return { allowed: true, price, downloadable };
    if (!user) return { allowed: false, price, downloadable }; // can't have purchased anything signed out
    const { data: purchase, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('book_id', bookId)
      .eq('buyer_id', user.id)
      .eq('status', 'success')
      .limit(1)
      .maybeSingle();
    if (purchaseError) throw sanitizeError(purchaseError);
    return { allowed: !!purchase, price, downloadable };
  } catch (e) {
    console.warn('Inkroot: checkBookReadAccess failed', e);
    return { allowed: false, price: null, downloadable: false };
  }
}

// Calls the download-book Edge Function, which re-checks access (and the author's downloadable
// opt-in) server-side and generates the file fresh each time — see that function's own header
// comment for why this isn't done client-side from fetchPublishedBookContent's result instead.
// Returns the raw bytes (as a Blob) plus the filename the server chose; throws with a message
// safe to show the reader directly (the Edge Function's own error responses are short and
// user-facing, e.g. "You haven't purchased this book").
export async function downloadBookFile(bookId, format) {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData && sessionData.session && sessionData.session.access_token;
  if (!token) throw new Error('Sign in to download this book.');
  const res = await fetch(`${supabase.supabaseUrl}/functions/v1/download-book`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      apikey: supabase.supabaseKey,
    },
    body: JSON.stringify({ bookId, format }),
  });
  if (!res.ok) {
    let message = 'Could not download this book.';
    try { message = (await res.json()).error || message; } catch (e) { /* non-JSON error body */ }
    throw new Error(message);
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const filename = match ? match[1] : `book.${format}`;
  const blob = await res.blob();
  return { blob, filename };
}

// The "peek at the opening" sample fetch — the public counterpart to checkBookReadAccess/
// fetchPublishedBookContent above. Reads published_book_samples (89_migration_paid_book_content_
// access.sql), a small always-public mirror the database itself keeps in sync with a book's real
// content via a trigger, never fetchPublishedBookContent's full manuscript. Used by
// BookDetailModal's loadSample (grand-library-cards.jsx) for every reader who isn't the book's
// own author (the author's own device already has the full project locally and can build its own
// sample from that, same as before) — this is what lets a priced, unpurchased book still show a
// short preview without published_book_content's now-gated RLS getting in the way, and without
// ever pulling that book's full text over the wire just to truncate it client-side. Safe to call
// while signed out (RLS is open-read, same as published_books); returns '' on any failure or
// missing row, same fail-honest shape as fetchPublishedBookContent.
export async function fetchPublishedBookSample(bookId) {
  try {
    const { data, error } = await supabase
      .from('published_book_samples')
      .select('sample')
      .eq('book_id', bookId)
      .maybeSingle();
    if (error) throw sanitizeError(error);
    return data ? (data.sample || '') : '';
  } catch (e) {
    console.warn('Inkroot: fetchPublishedBookSample failed', e);
    return '';
  }
}

// Every distinct author_id with at least one published book, paired with their current display
// name. Feeds the lookalike-name warning in shared-utils/identity-safety.js (part of Inkroot's
// anti-impersonation protection — see shell/ink-root.jsx's saveProfile) — comparing a name a
// writer is about to save against real published authors is the whole point of that check, so
// only published authors (not every signed-up account) belong in this list. Safe to call while
// signed out (published_books is publicly readable); returns [] on any failure so a lookalike
// check that can't reach the network just skips silently rather than blocking profile edits.
export async function fetchPublishedAuthorNames() {
  try {
    const { data, error } = await supabase.from('published_books').select('author_id');
    if (error) throw sanitizeError(error);
    const ids = [...new Set((data || []).map((r) => r.author_id))];
    if (ids.length === 0) return [];
    const names = await fetchProfileNames(ids);
    return ids.map((id) => ({ id, name: names[id] })).filter((e) => e.name);
  } catch (e) {
    console.warn('Inkroot: fetchPublishedAuthorNames failed', e);
    return [];
  }
}

// Every real published_books row for ONE specific author — anti-impersonation piece 5, paired
// with lib/profile.js's fetchPublicProfile (see that function's comment for the full picture).
// Used by AuthorsHallScreen once it knows a real account id, so the "published books" shown on
// someone else's Hall are their actual published_books rows rather than a guess built from
// matching this device's own local project list by author-name text.
//
// Now returns the same display metadata publishBookRemote writes (subtitle, seriesName, cover,
// wordCount — see 26_migration_published_books_richer_metadata.sql), so a real author's books
// render as full cards here, same as anything else in the Library.
export async function fetchPublishedBooksByAuthor(authorId) {
  if (!authorId) return [];
  const { data, error } = await supabase
    .from('published_books')
    .select('id, title, subtitle, series_name, cover, blurb, genre, word_count, price, published_at')
    .eq('author_id', authorId)
    .eq('destination', 'inkroot')
    .order('published_at', { ascending: false });
  if (error) throw sanitizeError(error);
  return (data || []).map((r) => ({
    id: r.id, title: r.title, subtitle: r.subtitle || '', seriesName: r.series_name || '', cover: r.cover || null,
    blurb: r.blurb || '', genre: r.genre || 'Unspecified', wordCount: r.word_count || 0,
    price: typeof r.price === 'number' ? r.price : 0, publishedAt: new Date(r.published_at).getTime(),
  }));
}

// Every publicly published book across every author (destination: 'inkroot') — the Grand
// Library Discover feed itself. Backs grand-library-screen.jsx's Search box, Genre filter chips,
// and New Releases shelf, which used to be built from this device's own local `projects` list
// (so a reader only ever discovered their own work). Same public, no-auth-required read as
// fetchPublishedBookById/fetchPublishedBooksByAuthor above — published_books' "anyone can read
// published books" policy (schema.sql) makes this safe to call whether or not the reader is
// signed in — just unfiltered by author_id so it returns the whole catalog instead of one book
// or one writer's shelf. Sorted newest-first server-side so New Releases (built by the caller by
// simply taking the first N of this list) doesn't need its own separate query.
//
// One bounded query rather than true pagination: Search/Genre/New Releases all filter and sort
// this same in-memory list client-side (as they already did for the local list), so fetching the
// current catalog once per Library visit is enough to keep that logic unchanged. `limit` is a
// generous cap (a few thousand listings), not a page size.
export async function fetchDiscoverBooks({ limit } = {}) {
  const { data, error } = await supabase
    .from('published_books')
    .select('id, author_id, title, subtitle, series_name, cover, blurb, genre, word_count, price, published_at')
    .eq('destination', 'inkroot')
    .order('published_at', { ascending: false })
    .limit(limit || 2000);
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({
    id: r.id, title: r.title, subtitle: r.subtitle || '', seriesName: r.series_name || '', cover: r.cover || null,
    author: names[r.author_id] || 'Unnamed Writer', authorVerified: verifiedIds.has(r.author_id), authorId: r.author_id,
    blurb: r.blurb || '', genre: r.genre || 'Unspecified', wordCount: r.word_count || 0,
    price: typeof r.price === 'number' ? r.price : 0, updatedAt: new Date(r.published_at).getTime(), guildName: null,
  }));
}

// A single published_books row by id, whatever its destination — unlike fetchPublishedBooksByAuthor
// above (deliberately restricted to destination: 'inkroot', an author's own storefront), this is
// used to open one specific KNOWN book regardless of how it got published, e.g. "View in the
// Grand Library" on a just-published Guild Anthology (see guild-order.jsx) linking straight into
// the same BookDetailModal every other book already opens in, rather than a second book-detail
// view built just for anthologies. published_books is fully public (see schema.sql's "anyone can
// read published books"), so this is safe to call whether or not the reader is signed in.
export async function fetchPublishedBookById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from('published_books')
    .select('id, author_id, title, subtitle, series_name, cover, blurb, genre, word_count, price, published_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw sanitizeError(error);
  if (!data) return null;
  const [names, verifiedIds] = await Promise.all([fetchProfileNames([data.author_id]), fetchVerifiedIds([data.author_id])]);
  return {
    id: data.id, title: data.title, subtitle: data.subtitle || '', seriesName: data.series_name || '', cover: data.cover || null,
    author: names[data.author_id] || 'Unnamed Writer', authorVerified: verifiedIds.has(data.author_id), authorId: data.author_id,
    blurb: data.blurb || '', genre: data.genre || 'Unspecified', wordCount: data.word_count || 0,
    price: typeof data.price === 'number' ? data.price : 0, updatedAt: new Date(data.published_at).getTime(), guildName: null,
  };
}

// Attaches `reviewer_name` and `reviewer_verified` fields to each review row, looked up live
// from `profiles` by reviewer_id rather than trusting a copy stored on the review itself — see
// publishBookRemote's comment above for why. Both callers below already return rows shaped with
// `reviewer_name` (the UI reads that field directly — see grand-library-cards.jsx); this adds
// `reviewer_verified` alongside it for the anti-impersonation badge (schema.sql's
// `profiles.verified` column — see lib/profile.js's fetchVerifiedIds).
async function withReviewerNames(reviewRows) {
  const reviewerIds = reviewRows.map((r) => r.reviewer_id);
  const [names, verifiedIds] = await Promise.all([
    fetchProfileNames(reviewerIds),
    fetchVerifiedIds(reviewerIds),
  ]);
  return reviewRows.map((r) => ({ ...r, reviewer_name: names[r.reviewer_id], reviewer_verified: verifiedIds.has(r.reviewer_id) }));
}

// Aggregate rating + full review list for one book — used by both the individual book card
// (average only) and a book's own reviews view (the full list).
export async function fetchBookStats(bookId) {
  const { data: reviewRows, error } = await supabase
    .from('reviews')
    .select('id, reviewer_id, rating, body, created_at')
    .eq('book_id', bookId)
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const reviews = await withReviewerNames(reviewRows || []);
  const avgRating = reviews.length ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length : null;
  return { reviews, avgRating, reviewCount: reviews.length };
}

// One call per author, covering every book they've published — this is what backs the Creator
// Dashboard's Ratings tab, so it doesn't need one request per book.
export async function fetchAuthorRatingsSummary(bookIds) {
  if (!bookIds || bookIds.length === 0) return [];
  const { data, error } = await supabase
    .from('reviews')
    .select('id, book_id, reviewer_id, rating, body, created_at')
    .in('book_id', bookIds)
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  // One name lookup across every book's reviews combined, rather than one per book — same
  // batching principle as fetchFollowers' use of fetchProfileNames.
  const withNames = await withReviewerNames(data || []);
  const byBook = {};
  for (const row of withNames) {
    if (!byBook[row.book_id]) byBook[row.book_id] = [];
    byBook[row.book_id].push(row);
  }
  return Object.entries(byBook).map(([bookId, reviews]) => ({
    bookId,
    reviews,
    avgRating: reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length,
  }));
}

export async function submitReview(bookId, rating, body) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to leave a review.');
  const { error } = await supabase.from('reviews').upsert({
    book_id: bookId,
    reviewer_id: user.id,
    rating,
    body: body || '',
  }, { onConflict: 'book_id,reviewer_id' });
  if (error) throw sanitizeError(error);
  return true;
}

export async function followAuthor(authorId) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to follow an author.');
  const { error } = await supabase.from('follows').upsert({ follower_id: user.id, followee_id: authorId }, { onConflict: 'follower_id,followee_id', ignoreDuplicates: true });
  if (error) throw sanitizeError(error);
  return true;
}

// A book's real Discussion Hall (migration 67) — every reader's post, not just this device's
// own. Mirrors withReviewerNames' name-resolution above; unlike reviews there's no rating/avg to
// compute, just the thread itself, oldest first (a conversation, not a ranked list).
export async function fetchBookDiscussion(bookId) {
  const { data, error } = await supabase
    .from('book_discussion_posts')
    .select('id, author_id, body, created_at')
    .eq('book_id', bookId)
    .order('created_at', { ascending: true });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const names = await fetchProfileNames(rows.map((r) => r.author_id));
  return rows.map((r) => ({ ...r, author_name: names[r.author_id] || 'A reader' }));
}

export async function postBookDiscussion(bookId, body) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to post in the Discussion Hall.');
  const trimmed = (body || '').trim();
  if (!trimmed) return null;
  const { error } = await supabase.from('book_discussion_posts').insert({
    book_id: bookId, author_id: user.id, body: trimmed.slice(0, 500),
  });
  if (error) throw sanitizeError(error);
  return true;
}

export async function deleteBookDiscussionPost(postId) {
  const { error } = await supabase.from('book_discussion_posts').delete().eq('id', postId);
  if (error) throw sanitizeError(error);
}

// Live sync for one book's Discussion Hall — same shape as subscribeFiresideRealtime
// (lib/library-guild.js): book_discussion_posts carries its own book_id, so Postgres filters the
// stream server-side and there's no join-based second table to gate client-side the way
// fireside_reactions/guild_order_passages need. onChange is called with no arguments; the caller
// re-fetches via fetchBookDiscussion() rather than patching a row in.
export function subscribeBookDiscussionRealtime(bookId, onChange) {
  const channel = supabase
    .channel(`book-discussion:${bookId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'book_discussion_posts', filter: `book_id=eq.${bookId}` }, onChange)
    .subscribe();
  return () => supabase.removeChannel(channel);
}

// Backs the Grand Library's "Book Discussion Halls" shelf — ranked ids only (book_id/post_count),
// same shape as fetchBestSellers/fetchMostRead/fetchTrending (book-rankings.js); the caller
// hydrates each id via fetchPublishedBookById the same way those three already do, rather than
// this joining book metadata server-side too.
export async function fetchMostDiscussedBooks({ limit } = {}) {
  const { data, error } = await supabase.rpc('most_discussed_books', { p_result_limit: limit || null });
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({ bookId: row.book_id, postCount: Number(row.post_count) || 0 }));
}

export async function unfollowAuthor(authorId) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('follows').delete().eq('follower_id', user.id).eq('followee_id', authorId);
  if (error) throw sanitizeError(error);
  return true;
}

// Real follower count for a given author — not just "does THIS device currently follow them",
// which is all the local everFollowedMap/followingMap (author-reputation.jsx) can ever answer,
// since that's only ever this device's own follow history. Backs the public Reputation score
// (see REPUTATION_SOURCES/`reputation` in authors-hall-screen.jsx and `writerRank` in
// ink-root.jsx) with the real total instead of a binary 0/1. `head: true` so Postgres only
// returns the count, not the rows; filters on followee_id, the same column follows_followee_idx
// already indexes (see schema.sql's comment on that index, and fetchFollowers above, which
// filters the same column for the signed-in user's own followers).
export async function fetchFollowerCount(authorId) {
  if (!authorId) return 0;
  const { count, error } = await supabase
    .from('follows')
    .select('follower_id', { count: 'exact', head: true })
    .eq('followee_id', authorId);
  if (error) throw sanitizeError(error);
  return count || 0;
}

export async function isFollowing(authorId) {
  const user = await currentUser();
  if (!user) return false;
  const { data } = await supabase
    .from('follows')
    .select('follower_id')
    .eq('follower_id', user.id)
    .eq('followee_id', authorId)
    .maybeSingle();
  return !!data;
}

// Backs the Creator Dashboard's Readers tab — the honest version of "who's reading your work"
// this phase can actually deliver: real followers, not page-view/traffic-source analytics
// (that would need a separate events-tracking table, which isn't part of this phase).
export async function fetchFollowers() {
  const user = await currentUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('follows')
    .select('follower_id, created_at')
    .eq('followee_id', user.id)
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  // Phase 4's profiles table is what makes real names possible here — before it existed, this
  // could only return raw ids (see the Phase 3 README note this replaces).
  const names = await fetchProfileNames(rows.map((r) => r.follower_id));
  return rows.map((r) => ({ ...r, name: names[r.follower_id] }));
}
