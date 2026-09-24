import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames } from './profile.js';
import { sanitizeError } from './errors.js';

// The Guild Order's real shared World Bible (migration 81) — same thin client-wrapper shape as
// lib/guild-manuscript.js, and the same "callers don't need to check sign-in themselves" safety:
// a signed-out writer just gets an insert rejected by RLS the same way any other write here
// would be. See the migration's own header for why this is one table, not the chapters/passages
// split Manuscript uses.

// guildType is 'founder' or 'player' (matches guild_order_world_entries.guild_type); guildId is
// whichever real id that guild type actually has. Returns entries newest-first, each carrying
// its real author's display name.
export async function fetchGuildWorldEntries(guildType, guildId) {
  if (!guildId)
    return [];
  const { data, error } = await supabase
    .from('guild_order_world_entries')
    .select('id, category, title, blurb, author_id, created_at')
    .eq('guild_type', guildType).eq('guild_id', guildId)
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  if (rows.length === 0)
    return [];
  const names = await fetchProfileNames(rows.map((r) => r.author_id));
  return rows.map((r) => ({ ...r, authorName: names[r.author_id] || 'A writer' }));
}

// Adds a real entry, attributed to whoever's actually signed in.
export async function addGuildWorldEntry(guildType, guildId, { category, title, blurb }) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to add to the World Bible.');
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle)
    return null;
  const { error } = await supabase.from('guild_order_world_entries').insert({
    guild_type: guildType, guild_id: guildId,
    category: (category || '').trim().slice(0, 60),
    title: trimmedTitle.slice(0, 200),
    blurb: (blurb || '').trim().slice(0, 2000),
    author_id: user.id,
  });
  if (error)
    throw sanitizeError(error);
  return true;
}

export async function deleteGuildWorldEntry(entryId) {
  const { error } = await supabase.from('guild_order_world_entries').delete().eq('id', entryId);
  if (error)
    throw sanitizeError(error);
}

// Subscribes to live inserts (and deletes — an author removing their own entry) on this one
// guild's World Bible. Returns an unsubscribe function. onChange is called with no arguments —
// same as subscribeGuildManuscriptRealtime, callers just re-fetch via fetchGuildWorldEntries()
// rather than trying to patch individual rows into place themselves.
//
// Unlike guild_order_passages, every row here already carries its own guild_id column, so
// Postgres can filter the whole stream server-side — no client-side id-tracking needed the way
// subscribeGuildManuscriptRealtime has to for passages.
export function subscribeGuildWorldBibleRealtime(guildType, guildId, onChange) {
  if (!guildId)
    return () => {};
  const channel = supabase
    .channel(`guild-order-world-bible:${guildType}:${guildId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guild_order_world_entries', filter: `guild_id=eq.${guildId}` }, () => onChange())
    .subscribe();
  return () => supabase.removeChannel(channel);
}
