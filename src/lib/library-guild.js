import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Same self-checking-auth philosophy as library.js (Phase 2): every function here is safe to
// call regardless of sign-in state. The difference from Phase 2 is that these functions also
// need a guildId (the writer's founderGuildId) — there's no meaningful "post to the Fireside"
// without knowing which Founder Guild's Fireside. Callers (FiresideBoard, GuildBookshelf) fall
// back to the original local-only storage when either signed out or not in a Founder Guild —
// see the fallback logic where each is used in App.jsx.

// ---------- Founder Guild membership race guard ----------
// Founder Guild membership only lives in founder_guild_members once syncFounderGuildMembership
// (below) has actually completed — and every caller of it (ink-root.jsx's load-time effect,
// sync-context.jsx's post-sign-in effect, joinFounderGuild) fires it off without waiting, same
// non-blocking philosophy as the rest of this module. That's fine for the write itself, but every
// guild-scoped read/write below (fetchFiresidePosts, postFiresideMessage, ...) is gated by RLS on
// that exact row already existing — so a legitimate member who opens the Fireside/Bookshelf
// moments after app load or sign-in, before that backfill upsert has actually landed, would see
// an empty board (select silently filtered by RLS) or a rejected post, even though they are a
// real member and the backfill is already in flight for their own guild.
//
// pendingMembership tracks the in-flight upsert promise per guild id so every function below can
// await the *same* in-flight call before running its own request, instead of either racing ahead
// of it or firing a redundant second upsert. Once syncFounderGuildMembership resolves, its own
// entry is cleared — later calls into these functions for a guild with no pending entry proceed
// immediately, exactly as before.
//
// Every guild-scoped function below (fetchGuildPublishedBooks, publishBookToGuildRemote, ...)
// calls this unconditionally, including for a Player Guild id (92_migration_player_guild_book_
// publishing.sql) — it's a harmless no-op there. A Player Guild's own membership row is written
// synchronously, inline, by create_or_get_own_guild()/join_player_guild_by_code() themselves
// (see schema.sql), not backfilled asynchronously on load the way a Founder Guild's is, so there
// is no equivalent race to guard for that guild type — this map simply never has a pending entry
// for a Player Guild id, so the await below resolves immediately.
const pendingMembership = new Map();

async function ensureFounderGuildMembership(guildId) {
  const pending = guildId && pendingMembership.get(guildId);
  if (!pending) return;
  try {
    await pending;
  } catch (e) {
    // Already logged where syncFounderGuildMembership itself was kicked off — a failed backfill
    // just means the read/write below proceeds and gets whatever RLS was always going to give it.
  }
}

// Returns { posts, reactionsByPost } — posts is the flat list (top-level + replies, same shape
// FiresideBoard already expects to filter/sort locally), reactionsByPost maps postId -> array of
// { reaction, user_id } so the caller can compute both counts and "did I react with this" per
// post without a second round trip per post.
export async function fetchFiresidePosts(guildId) {
  await ensureFounderGuildMembership(guildId);
  const { data: rawPosts, error: postsErr } = await supabase
    .from('fireside_posts')
    .select('id, parent_id, author_id, category, body, pinned, created_at')
    .eq('guild_id', guildId)
    .order('created_at', { ascending: true });
  if (postsErr) throw sanitizeError(postsErr);

  // author_name is looked up live from `profiles` here rather than stored on the post — see
  // publishBookRemote's comment in library.js for why. FiresideBoard already reads this field
  // directly off each post, so the output shape (`author_name` present on every post) is
  // unchanged; only where it comes from is. author_verified is new — anti-impersonation piece 2
  // (schema.sql's `profiles.verified`, see lib/profile.js's fetchVerifiedIds) — this is exactly
  // the kind of surface (real people, real messages, real accounts) that badge is meant for.
  const authorIds = (rawPosts || []).map((p) => p.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  const posts = (rawPosts || []).map((p) => ({ ...p, author_name: names[p.author_id], author_verified: verifiedIds.has(p.author_id) }));

  const postIds = posts.map((p) => p.id);
  const reactionsByPost = {};
  if (postIds.length > 0) {
    const { data: reactions, error: reactErr } = await supabase
      .from('fireside_reactions')
      .select('post_id, user_id, reaction')
      .in('post_id', postIds);
    if (reactErr) throw sanitizeError(reactErr);
    for (const r of reactions || []) {
      if (!reactionsByPost[r.post_id]) reactionsByPost[r.post_id] = [];
      reactionsByPost[r.post_id].push(r);
    }
  }
  return { posts: posts || [], reactionsByPost };
}

export async function postFiresideMessage(guildId, category, body, parentId) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to post to the Fireside.');
  await ensureFounderGuildMembership(guildId);
  const { data, error } = await supabase.from('fireside_posts').insert({
    guild_id: guildId,
    parent_id: parentId || null,
    author_id: user.id,
    category: category || 'discussion',
    body,
  }).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// Author-only, per the schema's RLS — see the comment in schema_phase3.sql for why this can't
// be opened up to any guild member in this phase.
export async function toggleFiresidePin(postId, pinned) {
  const { error } = await supabase.from('fireside_posts').update({ pinned }).eq('id', postId);
  if (error) throw sanitizeError(error);
}

export async function toggleFiresideReaction(postId, reaction, currentlyActive) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to react.');
  if (currentlyActive) {
    const { error } = await supabase.from('fireside_reactions').delete().eq('post_id', postId).eq('user_id', user.id).eq('reaction', reaction);
    if (error) throw sanitizeError(error);
  } else {
    const { error } = await supabase.from('fireside_reactions').insert({ post_id: postId, user_id: user.id, reaction });
    if (error) throw sanitizeError(error);
  }
}

// Subscribes to live inserts on both tables for one guild's Fireside. Returns an unsubscribe
// function. onChange is called with no arguments — callers just re-fetch via
// fetchFiresidePosts() on any change rather than trying to patch individual rows in, since the
// Fireside's own view (pinned-first, threaded replies) is cheap to recompute and much simpler
// than merging partial realtime payloads into that structure correctly.
//
// fireside_posts has its own guild_id column, so Postgres can filter that stream server-side.
// fireside_reactions doesn't (see schema.sql: membership is checked by joining back to the post
// reacted to), so there's no server-side filter to scope that stream to just this guild — a
// member of several Founder Guilds watching this one's Fireside would otherwise get a refetch
// triggered by a reaction on a completely different guild's post, just because RLS lets them see
// both. postIds tracks this guild's own known post ids client-side and gates the reactions
// handler against it, so only a reaction on a post that actually belongs here causes a refetch.
export function subscribeFiresideRealtime(guildId, onChange) {
  const postIds = new Set();

  // Seed with the guild's current posts so reactions on already-loaded posts are recognized
  // immediately, rather than only after a fireside_posts event has populated the set. A reaction
  // arriving before this resolves just gets missed once (falls back to whatever the caller's own
  // next fetchFiresidePosts() picks up) rather than firing an incorrect refetch.
  supabase
    .from('fireside_posts')
    .select('id')
    .eq('guild_id', guildId)
    .then(({ data }) => {
      for (const row of data || []) postIds.add(row.id);
    });

  const channel = supabase
    .channel(`fireside:${guildId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fireside_posts', filter: `guild_id=eq.${guildId}` }, (payload) => {
      // Keep postIds in sync with this guild's actual posts as they're added/removed, so the
      // reactions filter below stays accurate without a full re-query on every change.
      if (payload.eventType === 'DELETE') {
        if (payload.old?.id) postIds.delete(payload.old.id);
      } else if (payload.new?.id) {
        postIds.add(payload.new.id);
      }
      onChange();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'fireside_reactions' }, (payload) => {
      const postId = payload.new?.post_id || payload.old?.post_id;
      if (postId && postIds.has(postId)) onChange();
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}

export async function fetchGuildBookFeedback(guildId, bookId) {
  await ensureFounderGuildMembership(guildId);
  const { data, error } = await supabase
    .from('guild_book_feedback')
    .select('id, author_id, stars, note, created_at')
    .eq('guild_id', guildId)
    .eq('book_id', bookId)
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  // author_name/author_verified looked up live from `profiles` — see fetchFiresidePosts' comment
  // above. GuildBookFeedbackModal reads both fields directly off each row.
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({ ...r, author_name: names[r.author_id], author_verified: verifiedIds.has(r.author_id) }));
}

export async function addGuildBookFeedback(guildId, bookId, stars, note) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to leave guild feedback.');
  await ensureFounderGuildMembership(guildId);
  // upsert, not insert -- guild_book_feedback has a unique (guild_id, book_id, author_id)
  // constraint (see schema.sql), same one-entry-per-reader-per-book shape as reviews.
  // submitReview in library.js. A member revising their feedback on a book updates their
  // existing row instead of adding a second one alongside it.
  const { error } = await supabase.from('guild_book_feedback').upsert({
    guild_id: guildId, book_id: bookId, author_id: user.id, stars, note: note || '',
  }, { onConflict: 'guild_id,book_id,author_id' });
  if (error) throw sanitizeError(error);
}

// ---------- Guild Bookshelf listing (Phase 7) ----------
// Pushes (or updates) a book's guild-only listing — the guild-scoped counterpart to
// publishBookRemote in library.js. Called whenever a project's publishStatus is set to 'guild',
// alongside (not instead of) the existing published_books upsert, since that table is what
// backs ratings/reviews/follows regardless of destination. guild_published_books is what lets
// every OTHER guildmate actually see the book on the shared shelf.
// See the matching note above publishBookRemote in lib/library.js — the query builder here
// resolves rather than rejects on a database-level error, so this now throws explicitly on
// `error` instead of letting a failed guild-shelf write masquerade as a success.
export async function publishBookToGuildRemote(guildId, { id, title, subtitle, seriesName, cover, genre, blurb, tags, wordCount, storyFormat, publishedAt, downloadable }) {
  const user = await currentUser();
  if (!user) return null; // not signed in — the shelf just stays local-only, same as before this phase
  await ensureFounderGuildMembership(guildId);
  const { error } = await supabase.from('guild_published_books').upsert({
    guild_id: guildId,
    book_id: id,
    author_id: user.id,
    title,
    subtitle: subtitle || '',
    series_name: seriesName || '',
    cover: cover || null,
    genre: genre || '',
    blurb: blurb || '',
    tags: tags || [],
    word_count: wordCount || 0,
    story_format: storyFormat || 'book',
    published_at: new Date(publishedAt || Date.now()).toISOString(),
    updated_at: new Date().toISOString(),
    downloadable: !!downloadable,
  }, { onConflict: 'guild_id,book_id' });
  if (error) throw sanitizeError(error);
  return true;
}

// Removes a book's guild listing — called whenever a project's publishStatus moves away from
// 'guild' (unpublished entirely, or promoted on to Inkroot), regardless of which guild it was
// under, since a book can only be under one at a time in the app's own local model. Scoped to
// book_id + author_id (the RLS policy above already restricts deletes to the author's own rows,
// so there's no need to also know or pass the guild_id here).
export async function unpublishBookFromGuildRemote(bookId) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('guild_published_books').delete().eq('book_id', bookId).eq('author_id', user.id);
  if (error) throw sanitizeError(error);
  return true;
}

// ---------- Founder Guild membership (Phase 8) ----------
// Founder Guild membership used to be tracked only on the writer's own device
// (guildProfile.founderGuildId in local storage) — nothing here or in the schema knew who was
// actually in which guild, which is why fireside_posts/fireside_reactions/guild_book_feedback/
// guild_published_books could previously only enforce "signed in," not "actually a member of
// this guild" (see schema_phase8.sql). These two calls are the missing piece: pushed on
// joinFounderGuild and leaveCurrentGuild in ink-root.jsx, and used to backfill existing local
// membership on app load / sign-in (see ink-root.jsx and sync-context.jsx).

export async function syncFounderGuildMembership(guildId) {
  const user = await currentUser();
  if (!user || !guildId) return null; // not signed in, or not currently in a Founder Guild — no-op
  // Registered in pendingMembership *before* the request goes out (not after), so a call into
  // fetchFiresidePosts/postFiresideMessage/etc. that starts on the very next tick already sees
  // this promise and waits on it — see ensureFounderGuildMembership above.
  const promise = supabase.from('founder_guild_members').upsert({ guild_id: guildId, user_id: user.id }, { onConflict: 'guild_id,user_id', ignoreDuplicates: true })
    .then(({ error }) => {
      if (error) throw sanitizeError(error);
      return true;
    });
  pendingMembership.set(guildId, promise);
  try {
    return await promise;
  } finally {
    // Only clear this guild's entry if it's still the exact call we set — guards against an
    // overlapping second call for the same guild (e.g. the load-time backfill and a quick
    // rejoin) having its own still-in-flight promise wiped out early by an earlier one settling.
    if (pendingMembership.get(guildId) === promise) pendingMembership.delete(guildId);
  }
}

export async function leaveFounderGuildMembership(guildId) {
  const user = await currentUser();
  if (!user || !guildId) return null;
  const { error } = await supabase.from('founder_guild_members').delete().eq('guild_id', guildId).eq('user_id', user.id);
  if (error) throw sanitizeError(error);
  return true;
}

// Real roster for a Founder Guild — same profiles-backed pattern as Phase 5's
// fetchPlayerGuildMembers (player-guild.js), reading founder_guild_members instead of
// player_guild_members. This existed purely as an RLS gate (see the race-guard note above: it's
// what lets fireside_posts/guild_published_books tell "signed in" apart from "actually a member
// of this guild") until now — nothing in the UI ever read the table back as an actual member
// list, which is why the Guild Hall's Members Online plaque and roster still only ever showed the
// current writer for a Founder Guild. role isn't tracked here the way a Player Guild's is
// (founder_guild_members has no role column — every Founder Guild member stands equal; only a
// Player Guild has treasurer/officer distinctions, see 44_migration_guild_treasury_roles_and_
// approvals.sql), so callers get plain membership rows, not roles.
export async function fetchFounderGuildMembers(guildId) {
  const { data, error } = await supabase.from('founder_guild_members').select('user_id, joined_at').eq('guild_id', guildId).order('joined_at', { ascending: true });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const names = await fetchProfileNames(rows.map((r) => r.user_id));
  return rows.map((r) => ({ ...r, name: names[r.user_id] }));
}

// Every book currently published to one guild, from every member who's pushed one — this is
// what turns the shelf from "what this device published" into "what the guild published".
// Shaped to match what GuildBookshelf's own local `books` array already builds, so the caller
// can merge the two without a separate mapping step.
export async function fetchGuildPublishedBooks(guildId) {
  await ensureFounderGuildMembership(guildId);
  const { data, error } = await supabase
    .from('guild_published_books')
    .select('book_id, author_id, title, subtitle, series_name, cover, genre, blurb, word_count, updated_at')
    .eq('guild_id', guildId)
    .order('updated_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  // author/authorVerified looked up live from `profiles` — see fetchFiresidePosts' comment
  // above.
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({
    id: r.book_id, title: r.title, subtitle: r.subtitle || '', seriesName: r.series_name || '',
    cover: r.cover || null, author: names[r.author_id] || 'Unnamed Writer', authorVerified: verifiedIds.has(r.author_id), authorId: r.author_id, wordCount: r.word_count || 0,
    updatedAt: new Date(r.updated_at).getTime(), genre: r.genre || 'Unspecified', blurb: r.blurb || '',
  }));
}
