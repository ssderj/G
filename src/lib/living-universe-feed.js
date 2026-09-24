import { supabase } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// The Living Universe Feed's real backend (migration 84, fix-tracker item 19) — same thin
// client-wrapper shape as lib/notifications.js: one RPC call, rows already enriched
// server-side (author/reviewer/follower/joiner names, book titles) so the caller never needs a
// second round-trip per row.
//
// Public — no auth.uid() filtering happens here or in the function itself, unlike
// fetchNotifications(). Every source table this reads is already publicly readable in full (see
// the migration's own header), so this works the same whether or not anyone is signed in.
//
// Returns newest-first. `kind` is one of 'release' | 'follow' | 'review' | 'guild' — see
// inbox-and-living-universe.jsx's luAdaptRealFeedEntry() for how each maps onto the Chronicle
// entry shape ({ id, ts, seal, color, title, sub, tag, kind }) the rest of that screen already
// renders.
export async function fetchLivingUniverseFeed({ limit = 60 } = {}) {
  const { data, error } = await supabase.rpc('list_living_universe_feed', { p_result_limit: limit });
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({
    id: row.id,
    kind: row.kind,
    createdAt: row.created_at,
    payload: row.payload || {},
  }));
}
