import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames } from './profile.js';
import { sanitizeError } from './errors.js';

// The Author Inbox's real backend (migration 83, fix-tracker item 18) — same thin
// client-wrapper shape as lib/guild-world-bible.js: fetch + a Realtime subscribe helper, no
// local caching beyond what the caller (AuthorInboxScreen) already does via `storage`.
//
// Returns newest-first, each row enriched with the acting writer's real display name (and, for
// a review, the book's real title) so the Inbox never has to make a second round-trip per item
// to render a letter. `payload` is passed through as-is for anything type-specific the caller
// still needs (guild_type/guild_id to route back to a tab, place/share_bps for a payout, etc).
export async function fetchNotifications() {
  const user = await currentUser();
  if (!user)
    return [];
  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, actor_id, payload, created_at')
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw sanitizeError(error);
  const rows = data || [];
  if (rows.length === 0)
    return [];

  const actorIds = rows.map((r) => r.actor_id).filter(Boolean);
  const names = actorIds.length ? await fetchProfileNames(actorIds) : {};

  const bookIds = [...new Set(
    rows.filter((r) => r.type === 'new_review' && r.payload?.book_id).map((r) => r.payload.book_id)
  )];
  let bookTitles = {};
  if (bookIds.length) {
    const { data: books } = await supabase.from('published_books').select('id, title').in('id', bookIds);
    bookTitles = Object.fromEntries((books || []).map((b) => [b.id, b.title]));
  }

  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    actorName: (r.actor_id && names[r.actor_id]) || 'A writer',
    bookTitle: r.payload?.book_id ? (bookTitles[r.payload.book_id] || 'your book') : undefined,
    payload: r.payload || {},
    createdAt: r.created_at,
  }));
}

// Subscribes to this signed-in writer's own new mail arriving live. onChange is called with no
// arguments, same as subscribeGuildWorldBibleRealtime — the caller re-fetches via
// fetchNotifications() rather than trying to patch one row into place itself. Filtered
// server-side to this recipient (same `filter` pattern subscribeGuildWorldBibleRealtime uses for
// guild_id) rather than relying only on RLS to thin the stream client-side.
export function subscribeNotificationsRealtime(userId, onChange) {
  if (!userId)
    return () => {};
  const channel = supabase
    .channel(`notifications:${userId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${userId}` }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
