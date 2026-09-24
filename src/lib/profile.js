import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// In-memory cache for authorDisplayName() below — avoids a `profiles` round trip on every single
// publish/review/post/feedback write in a session, since the signed-in writer's own name doesn't
// change between those calls. Keyed by user id so switching accounts (or signing out and back in
// as someone else) naturally misses the cache instead of serving a stale name. Cleared here (not
// in supabaseClient.js) since this module is the only thing that reads or writes it.
let cachedNameUserId = null;
let cachedName = null;

// Push the writer's own pen name / display name / avatar / motto to their public profile row.
// Called fire-and-forget from App.jsx's saveProfile, same non-blocking philosophy as everything
// else signed-in-only in this app — a no-op when signed out, so local-only profile editing
// behaves exactly as it always did.
//
// motto added in 54_migration_naira_welcome_and_profile_motto.sql — before that migration, this
// only ever sent name/penName/avatar, so a writer's motto lived purely on-device and could never
// be checked server-side at all (see nairaWelcome's history in health-checks.jsx for why that
// mattered).
//
// Nothing else needs updating after this: published_books/reviews/fireside_posts/
// guild_book_feedback/guild_published_books no longer keep their own author_name/reviewer_name
// copy (see authorDisplayName() and fetchProfileNames() below) — every reader of those tables
// looks the current name up from `profiles` live, via this same row, so a pen name change takes
// effect everywhere the moment this update lands. An earlier version of this function had to
// separately fan a name change out to all five of those tables (propagateDisplayName) precisely
// because each kept its own stale copy; removing the copies removed the need for the fan-out.
export async function syncProfile({ name, penName, avatar, motto }) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('profiles').update({
    display_name: name || null,
    pen_name: penName || null,
    avatar_url: avatar || null,
    motto: motto || null,
    updated_at: new Date().toISOString(),
  }).eq('id', user.id);
  if (error) {
    const safe = sanitizeError(error);
    // A plpgsql `raise exception` on profiles (P0001) is one of the name checks -- a reserved
    // name (migration 141) or a name another writer already holds (migration 142) -- and its
    // message is written to be shown to the writer. Tagged the same way account-deletion.js tags
    // OWNS_PLAYER_GUILD, so saveProfile can show this text instead of the generic sync notice.
    if (error.code === 'P0001') safe.code = 'PROFILE_NAME_REJECTED';
    throw safe;
  }

  const effectiveName = penName || name || `Writer ${user.id.slice(0, 8)}`;
  cachedNameUserId = user.id;
  cachedName = effectiveName;

  return true;
}

// The display name to attribute the signed-in user's own writing to (a published book, a
// review, a Fireside post, guild feedback, ...). Reads from the `profiles` table — the same
// place syncProfile() above actually writes a pen name to — rather than Supabase Auth's
// user_metadata, which nothing in this app ever populates (there is no auth.updateUser() call
// anywhere), so `user.user_metadata?.penName` was always undefined and every writer's pen name
// silently fell back to `Writer <id8>` no matter what they'd set in their profile. Falls back to
// the same `Writer <id8>` pattern only when the profile row itself has no pen name or display
// name set (or doesn't exist yet).
//
// Cached per user id (see cachedNameUserId/cachedName above) — every publish/review/post/
// feedback call in this module used to pay a fresh `profiles` round trip just to re-read a name
// that only actually changes when syncProfile() runs, which also keeps the cache current.
export async function authorDisplayName(user) {
  if (cachedNameUserId === user.id && cachedName) return cachedName;
  const { data } = await supabase
    .from('profiles')
    .select('pen_name, display_name')
    .eq('id', user.id)
    .maybeSingle();
  const name = (data && (data.pen_name || data.display_name)) || `Writer ${user.id.slice(0, 8)}`;
  cachedNameUserId = user.id;
  cachedName = name;
  return name;
}

// Batch name lookup for a list of user ids — e.g. turning a follower list's raw ids into
// something a reader would recognize. Returns a map of id -> the best available display name,
// falling back to a short id fragment for anyone whose profile row hasn't been created yet
// (shouldn't normally happen, since the Phase 4 schema's trigger creates one at signup, but
// accounts created before this migration ran won't have one until they next save their profile).
export async function fetchProfileNames(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return {};
  const { data, error } = await supabase
    .from('profiles')
    .select('id, pen_name, display_name')
    .in('id', ids);
  if (error) throw sanitizeError(error);
  const byId = {};
  for (const row of data || []) {
    byId[row.id] = row.pen_name || row.display_name || null;
  }
  for (const id of ids) {
    if (!byId[id]) byId[id] = `Reader ${id.slice(0, 8)}`;
  }
  return byId;
}

// Batch verified-badge lookup for a list of user ids — anti-impersonation piece 2 (see
// schema.sql's `profiles.verified` column and shared-utils/identity-safety.js for piece 1).
// Returns a Set of the ids among `userIds` whose profile is verified, so a caller can do
// `verifiedIds.has(someId)` next to wherever it renders that person's name. Mirrors
// fetchProfileNames' shape/fallback philosophy (best-effort, never throws into the caller) since
// both are used the same way — right next to a name in a list.
export async function fetchVerifiedIds(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, verified')
    .in('id', ids);
  if (error) throw sanitizeError(error);
  return new Set((data || []).filter((row) => row.verified).map((row) => row.id));
}

// Full public profile for ONE specific account, by id — anti-impersonation piece 5. This is
// what makes AuthorsHallScreen's "viewing someone else's Hall" honest for the surfaces that
// carry a real author id (Fireside, Guild Bookshelf — see fireside-board.jsx's and
// guild-book-feedback-modal.jsx's onOpenAuthor calls, threaded through shell/ink-root.jsx's
// openAuthorHall): instead of guessing at who "Jonathan Reed" is from this device's own local
// project list (which could be anyone — that's the whole impersonation problem), it fetches the
// one specific account that id actually belongs to.
//
// Distinct from fetchProfileNames/fetchVerifiedIds above (which batch-fetch just the one field
// each already needs) because AuthorsHallScreen needs the full identity — name, avatar, and
// verified status — for a single author, in one round trip. Returns null for an id with no
// profile row (shouldn't normally happen — see authorDisplayName's comment above) or when
// `userId` itself is falsy, so callers can treat "no real account known" and "lookup failed" the
// same way: fall back to whatever local/name-based info they already had.
export async function fetchPublicProfile(userId) {
  if (!userId) return null;
  const { data, error } = await supabase
    .from('profiles')
    .select('id, pen_name, display_name, avatar_url, verified')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw sanitizeError(error);
  if (!data) return null;
  return {
    id: data.id,
    name: data.pen_name || data.display_name || `Writer ${data.id.slice(0, 8)}`,
    avatar: data.avatar_url || null,
    verified: !!data.verified,
  };
}

