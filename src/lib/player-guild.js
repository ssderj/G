import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames } from './profile.js';
import { sanitizeError } from './errors.js';

// Creates the row on first sync (id is generated once by the caller — see App.jsx's
// enterOwnGuild — and kept in local guildProfile.playerGuild.id from then on, the same
// reuse-the-app's-own-id pattern as Phase 2's published_books) or updates it on every later
// save. Returns the row, including invite_code, so the caller can persist the code into local
// state the first time the guild is created.
//
// Goes through the create_or_get_own_guild() RPC rather than a direct upsert on player_guilds —
// "one Player Guild per owner" needs a check across rows (does this owner already have a guild
// under a *different* id, e.g. from another device or a cleared local profile) that a plain
// insert policy can't express, same reasoning joinPlayerGuildByCode's RPC call already documents
// for joining. The RPC also folds in the player_guild_members "owner is a member too" row this
// used to insert as a separate call, so founding a guild is one atomic step.
export async function syncPlayerGuild(id, { name, motto, crestUrl }) {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc('create_or_get_own_guild', {
    p_id: id, p_name: name, p_motto: motto || null, p_crest_url: crestUrl || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

export async function joinPlayerGuildByCode(code) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to join a guild.');
  const cleanCode = code.trim().toLowerCase();
  // Goes through the join_player_guild_by_code() RPC rather than a direct select on
  // player_guilds — that table's select policy is now scoped to owners/members only (see
  // 03_migration_restrict_player_guild_invite_code.sql), so a plain select-by-invite-code from a
  // non-member would just return nothing. The RPC looks the guild up server-side instead and
  // inserts the membership row in the same call.
  const { data, error } = await supabase.rpc('join_player_guild_by_code', { p_code: cleanCode }).single();
  if (error) throw sanitizeError(error, 'No guild found with that invite code.');
  return data;
}

export async function leavePlayerGuildRemote(guildId) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('player_guild_members').delete().eq('guild_id', guildId).eq('user_id', user.id);
  if (error) throw sanitizeError(error);
  return true;
}

// Real roster with real names, same profiles-backed pattern as Phase 4's fetchFollowers(). role
// is 'treasurer' | 'officer' | 'member' — see 44_migration_guild_treasury_roles_and_approvals.sql.
// It does not reflect leadership: the guild's actual leader is player_guilds.owner_id, not a
// value in this column, so compare each row's user_id against the guild's owner_id separately if
// the caller needs to know who the leader is.
export async function fetchPlayerGuildMembers(guildId) {
  const { data, error } = await supabase.from('player_guild_members').select('user_id, joined_at, role').eq('guild_id', guildId).order('joined_at', { ascending: true });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const names = await fetchProfileNames(rows.map((r) => r.user_id));
  return rows.map((r) => ({ ...r, name: names[r.user_id] }));
}

// Fetches a guild's current public data by id — used to refresh a joined (non-owner) member's
// local copy of the guild's name/motto/crest, since only the owner's device otherwise has it.
export async function fetchPlayerGuild(guildId) {
  const { data, error } = await supabase.from('player_guilds').select('*').eq('id', guildId).maybeSingle();
  if (error) throw sanitizeError(error);
  return data;
}

// Live "who's online" for a Player Guild's Hall. Deliberately a Supabase Realtime Presence
// channel, not a stored/polled column: presence is session state, not guild data — a writer is
// online for exactly as long as some tab of theirs has this channel's socket open, and the
// moment that socket closes (tab closed, app backgrounded and killed, connection dropped)
// Realtime's own heartbeat expires their entry and every other subscriber's next 'sync' event
// reflects that automatically. There's nothing to poll, nothing to write, and nothing that can
// go stale the way a last-seen timestamp can.
//
// guildId scopes the channel (one channel per guild, named so two different guilds' presence
// never cross), selfName is what this device tracks about itself once subscribed (just enough
// for a future "who's online" list to show something nicer than a bare id, though today's UI
// only reads presence keys, not payloads), and onSync is called with a fresh Set of online user
// ids every time the channel's presence state changes — including once, synchronously-ish, right
// after the initial subscribe. Returns an unsubscribe function; call it on unmount or whenever
// guildId changes, or a stale channel keeps this device tracked in a guild it's no longer
// viewing.
//
// Signed-out callers get a single onSync(new Set()) and no channel at all — same "no real signal,
// don't fake one" honesty every other lib/*.js wrapper in this app follows for a signed-out
// writer, rather than opening a channel that can never track anyone.
export function subscribeGuildPresence(guildId, selfName, onSync) {
  let channel = null;
  let cancelled = false;
  currentUser().then((user) => {
    if (cancelled)
      return;
    if (!user) {
      onSync(new Set());
      return;
    }
    channel = supabase
      .channel(`guild-presence:${guildId}`, { config: { presence: { key: user.id } } })
      .on('presence', { event: 'sync' }, () => {
        onSync(new Set(Object.keys(channel.presenceState())));
      })
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          channel.track({ name: selfName || 'A writer', online_at: new Date().toISOString() });
        }
      });
  });
  return () => {
    cancelled = true;
    if (channel)
      supabase.removeChannel(channel);
  };
}
