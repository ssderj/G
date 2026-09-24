import { getDb, clearLocalData } from './idb.js';
import { supabase } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Conflict resolution here is version-based, not clock-based. Each kv_store row carries a
// server-assigned `version` (starts at 1, +1 on every write, stamped by a trigger that ignores
// whatever a client sends -- see schema.sql / 13_migration_server_authoritative_kv_versioning.sql)
// rather than trusting any device's `updated_at` for last-write-wins the way an earlier version of
// this file did. Each local edit records the version it was based on (idb.js's 'versions' store,
// via storage.js's `baseVersion`); pushOutbox below compares that against the row's *current*
// server version to tell a genuine conflict (another device pushed first) from a normal push,
// which two clocks disagreeing about the time can never spuriously trigger or miss.

let userId = null;
let syncing = false;
let pendingRetry = false;

// Keys whose last push was rejected by the server for a reason retrying won't fix on its own (e.g.
// kv_store's 20MB per-row cap). Their edits are safe in IndexedDB and stay in the outbox, but they
// are NOT backed up remotely -- previously that was only a console.warn, and the sync indicator
// stayed green ("Online -- syncing"), so a writer could believe a manuscript was backed up when it
// wasn't. Kept in memory only (it is re-derived on the next push attempt) and announced through a
// DOM event so the indicator can say so.
const rejectedKeys = new Set();
export function getRejectedSyncKeys() {
  return Array.from(rejectedKeys);
}
function announceRejectedChange() {
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('inkroot:sync-rejected', { detail: { count: rejectedKeys.size } }));
  }
}
function noteRejected(key) {
  if (!rejectedKeys.has(key)) {
    rejectedKeys.add(key);
    announceRejectedChange();
  }
}
function noteAccepted(key) {
  if (rejectedKeys.delete(key)) announceRejectedChange();
}

// Sign-out alone deliberately does NOT wipe local data — someone signing out on their own device
// still expects their offline edits to be sitting there if they sign back in, and wiping on every
// sign-out would drop anything still unpushed in the outbox. The actual risk (see README/plan) is
// a *different* account signing in afterwards on the same browser and inheriting the first
// account's still-local data. So local data is tagged with the account that owns it
// ('meta'/'lastSyncedUserId'), and only cleared when a session for a *different* account shows
// up — same device, different person.
//
// switchUserChain serializes calls to switchSyncUser (below) so this whole read-clear-write-
// resync sequence for one call always finishes before the next one starts. sync-context.jsx
// calls this fire-and-forget from an auth listener, so a rapid sign-out-then-sign-in-as-someone-
// else (or a flaky OAuth redirect firing the listener twice) can otherwise start a second call
// while the first is still mid-flight -- e.g. the second call's clearLocalData() landing in the
// middle of the first call's fullResync(), which is exactly the account-data-mixing bug this
// whole lastSyncedUserId scheme exists to prevent. Chaining onto the previous call's promise
// (rather than a plain boolean lock) means a caller's own `await`/`.then()` on switchSyncUser
// still resolves only once its specific call has actually run, not just whenever the queue is
// next free.
let switchUserChain = Promise.resolve();

export function switchSyncUser(newUserId) {
  switchUserChain = switchUserChain
    // A prior call's rejection (e.g. fullResync failing) must not permanently wedge the queue --
    // catch it here so the chain keeps moving; the failure itself was already surfaced from
    // within that call's own runSync(), which already logs and swallows sync errors.
    .catch(() => {})
    .then(() => doSwitchSyncUser(newUserId));
  return switchUserChain;
}

async function doSwitchSyncUser(newUserId) {
  const db = await getDb();
  const lastUserId = await db.get('meta', 'lastSyncedUserId');
  if (lastUserId && lastUserId !== newUserId) {
    // clearLocalData empties the 'meta' store too (along with kv/outbox) — same connection,
    // just emptied, so writing 'lastSyncedUserId' back right after is safe.
    await clearLocalData();
  }
  if (rejectedKeys.size) { rejectedKeys.clear(); announceRejectedChange(); }
  await db.put('meta', newUserId, 'lastSyncedUserId');
  userId = newUserId;
  await fullResync();
}

// Called on sign-out. Only clears the in-memory userId (so scheduleSync stops pushing) — local
// data stays put, tagged with whoever last signed in, until switchSyncUser sees a different
// account and clears it.
export function clearSyncUser() {
  userId = null;
  if (rejectedKeys.size) { rejectedKeys.clear(); announceRejectedChange(); }
}

// Called by storage.js after every local set/delete. Fire-and-forget: if we're offline, signed
// out, or a push is already in flight, the change just sits in the outbox until the next
// successful sync — nothing here blocks the caller or throws, so the app behaves identically
// offline whether or not sync is even configured.
export function scheduleSync() {
  if (!userId) return; // not signed in — sync is opt-in; local-only mode works fully without it
  if (syncing) {
    pendingRetry = true;
    return;
  }
  runSync();
}

async function runSync() {
  syncing = true;
  try {
    await pushOutbox();
    await pullRemote();
  } catch (e) {
    // Network hiccup, Supabase temporarily unreachable, etc. — expected and not fatal. The
    // outbox still holds every unsynced change, so the next scheduleSync() call (the next
    // local edit, a reconnect, or fullResync()) picks up exactly where this left off.
    console.warn('Inkroot sync: attempt failed, will retry on next trigger.', e);
  } finally {
    syncing = false;
    if (pendingRetry) {
      pendingRetry = false;
      runSync();
    }
  }
}

// True if nothing has re-queued this key since `entry` was read -- i.e. it's still safe to treat
// this push as having fully resolved that entry. A push here is a network round trip
// (supabase.from(...).insert/update/select, all awaited), and storage.js's set()/delete() write
// straight into 'outbox' the moment the writer makes their next edit -- with no lock between the
// two, an edit made *during* that round trip lands in 'outbox' while this function is still
// mid-flight for the *previous* edit to the same key. Every call site below used to follow a
// successful push with an unconditional db.delete('outbox', key); if a newer edit had queued
// itself in that gap, that delete discarded it -- still sitting correctly in 'kv' (so the writer
// never saw anything wrong locally, and it survived a refresh), but never pushed to the server,
// so it was gone for good the moment this device's local data was ever cleared (signing into a
// different account here, a fresh install, another device). Comparing the current outbox entry
// against the exact snapshot this push was based on (value/deleted/baseVersion all match) is what
// tells "nothing changed, safe to clear" apart from "a newer edit is already queued behind this
// one" -- see the three call sites below for what happens in the second case.
async function outboxEntryUnchanged(db, key, entry) {
  const current = await db.get('outbox', key);
  return !!current && current.value === entry.value && current.deleted === entry.deleted && current.baseVersion === entry.baseVersion;
}

// Safety net for the genuine-conflict branch below: that branch is "remote wins," meaning this
// device's own not-yet-synced local edit is about to be thrown away with no per-field merge (see
// its own comment for why a full merge is out of scope). Before that overwrite happens, this
// saves the losing local value to idb.js's 'conflictBackups' store so the writer can get it back,
// and fires a DOM event so any part of the app that's listening can surface a warning -- this
// module has no UI of its own, so it can't show one directly, but it also shouldn't silently
// drop the edit just because nothing happens to be listening yet.
async function backupLosingLocalEdit(db, key, entry, remoteVersion) {
  const record = {
    key,
    value: entry.value,
    remoteVersion: remoteVersion == null ? null : remoteVersion,
    timestamp: new Date().toISOString(),
  };
  await db.add('conflictBackups', record);
  console.warn(`Inkroot sync: a local change to "${key}" was overtaken by a newer version from another device. The local version was backed up so it can be recovered.`);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('inkroot:sync-conflict', { detail: { key, timestamp: record.timestamp } }));
  }
}

async function pushOutbox() {
  const db = await getDb();
  const keys = await db.getAllKeys('outbox');
  for (const key of keys) {
    const entry = await db.get('outbox', key);
    if (!entry) continue;

    // Metadata only here -- not `value`. The two outcomes below that actually need the remote
    // value (no row yet, or a genuine conflict) each fetch it themselves where required; the
    // common case (this device's local edit still matches what the server has) never touches
    // `value` at all. For a large project (a full manuscript can be several MB in one kv_store
    // row), the original version of this function pulled that entire value down on every single
    // push just to compare a version number -- doubling the network cost of every autosave for
    // no reason, since the value it fetched was almost always discarded unread.
    const { data: remote, error: remoteErr } = await supabase
      .from('kv_store')
      .select('version, deleted')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    // supabase-js RETURNS network failures ({ data: null, error }) rather than throwing them, and
    // this lookup's error used to be dropped -- so with no connection `remote` came back null and
    // was misread as "never synced before", sending the key into the insert branch below to fail
    // there instead. A failure with no SQLSTATE code (fetch dropped, gateway 5xx -- the same
    // "transient" definition the update branch below uses) means we simply don't know what the
    // server has: abort this pass and leave the whole outbox for the next trigger, exactly like
    // every other transient failure in this file. An error that DOES carry a code is left to the
    // pre-existing behavior below, so nothing that used to be classified as a rejection changes.
    if (remoteErr && !remoteErr.code) throw sanitizeError(remoteErr);

    if (!remote) {
      // Never synced before from any device -- plain insert. The stamp_kv_store trigger (see
      // schema.sql / 13_migration_server_authoritative_kv_versioning.sql) assigns version 1 and
      // today's server timestamp regardless of what's sent here.
      const { error } = await supabase.from('kv_store').insert({
        user_id: userId,
        key,
        value: entry.deleted ? null : entry.value,
        deleted: !!entry.deleted,
      });
      if (error) {
        // No SQLSTATE code = the request never got a real answer (network drop, gateway 5xx) --
        // transient, so it must NOT fall through to noteRejected below (that would flag the key
        // as "rejected by the server" and show the writer a misleading "item may be too large"
        // state for what is only a lost connection). Same rule the update branch applies below:
        // abort the pass, keep the outbox, retry on the next trigger.
        if (!error.code) throw sanitizeError(error);
        // Postgres 23505 (unique_violation) is the expected case here: most likely another
        // device raced this same brand-new key into existence between our select above and
        // this insert. Leave the outbox entry in place -- the next sync pass re-reads `remote`
        // fresh and this key now takes the "remote exists" branch below, which resolves the
        // race properly instead of throwing the whole batch out over one key.
        //
        // Any other error code is not a race and won't resolve itself by retrying -- e.g. 23514
        // (check_violation) from kv_store's per-row size cap (see schema.sql). Retrying that
        // silently, forever, on every future sync would look identical to a healthy sync from
        // the outside while this key never actually syncs. The outbox entry is still left in
        // place either way (this never discards a writer's local edit), but it's surfaced
        // instead of being mistaken for the harmless race case above.
        if (error.code !== '23505') {
          console.warn(`Inkroot sync: "${key}" was rejected by the server and won't sync until it changes.`, error);
          noteRejected(key);
        }
        continue;
      }
      noteAccepted(key);
      // Only clear the outbox if this is still the exact edit that was just inserted -- see
      // outboxEntryUnchanged's comment above. Otherwise a newer edit queued itself while the
      // insert was in flight; rebase it onto the version this key now actually has (1) instead
      // of leaving it pointing at baseVersion 0, so the next pass treats it as a normal push
      // against the row that now exists, rather than misreading it as "no row yet" again (which
      // would attempt a second insert and fail on the same unique-key conflict this branch just
      // resolved) -- the row is never overwritten either way, only the outbox bookkeeping.
      if (await outboxEntryUnchanged(db, key, entry)) {
        await db.put('versions', 1, key);
        await db.delete('outbox', key);
      } else {
        const latest = await db.get('outbox', key);
        if (latest) await db.put('outbox', { ...latest, baseVersion: 1 }, key);
        await db.put('versions', 1, key);
      }
      continue;
    }

    if (remote.version === entry.baseVersion) {
      // Nothing else has changed this key since this device's local edit was based on it --
      // safe to push. The update is conditioned on the version still matching (not just the
      // key), so a concurrent push from another device landing in the gap between the select
      // above and this update can't be silently clobbered: it would have already bumped the
      // version, so this update matches zero rows instead of overwriting that other push.
      const { data: updated, error } = await supabase
        .from('kv_store')
        .update({ value: entry.deleted ? null : entry.value, deleted: !!entry.deleted })
        .eq('user_id', userId)
        .eq('key', key)
        .eq('version', entry.baseVersion)
        .select('version');
      if (error) {
        // A server-side rejection of THIS row (it carries a SQLSTATE / PostgREST code -- e.g.
        // 23514 from kv_store's size cap) will fail identically on every retry. Throwing here, as
        // this used to for every error, aborted the whole batch: every key sorted after the bad
        // one -- other projects included -- never pushed, and pullRemote() (which runs after
        // pushOutbox in runSync) never ran either, so the device also stopped receiving changes
        // from the account's other devices. The insert branch above already skipped such a key;
        // this does the same. A failure with no code (network drop, gateway 5xx) is transient and
        // still aborts the pass as before -- the outbox keeps everything for the next trigger.
        if (error.code) {
          console.warn(`Inkroot sync: "${key}" was rejected by the server and won't sync until it changes.`, error);
          noteRejected(key);
          continue;
        }
        throw sanitizeError(error);
      }
      if (updated && updated.length) {
        noteAccepted(key);
        // Same guard as the insert branch above: only clear the outbox if nothing newer has
        // queued itself behind this push. If it has, rebase that newer entry onto the version
        // just confirmed rather than leaving it on the old baseVersion -- otherwise the next
        // pass would see remote.version ahead of a stale baseVersion and misread this device's
        // own still-unsynced edit as a genuine conflict, pulling the value it just pushed back
        // down over the newer edit sitting in 'kv'.
        if (await outboxEntryUnchanged(db, key, entry)) {
          await db.put('versions', updated[0].version, key);
          await db.delete('outbox', key);
        } else {
          const latest = await db.get('outbox', key);
          if (latest) await db.put('outbox', { ...latest, baseVersion: updated[0].version }, key);
          await db.put('versions', updated[0].version, key);
        }
        continue;
      }
      // 0 rows matched -- another device's push won the race right here. Leave the outbox entry
      // in place; the next sync pass re-reads `remote` fresh and correctly falls into the
      // conflict branch below instead of this one.
      continue;
    }

    // remote.version is ahead of what this device's local edit was based on: another device
    // pushed a change this device hasn't seen yet, detected by a version mismatch rather than by
    // comparing either device's clock. There's no per-field merge for this generic JSON blob, so
    // remote wins here exactly as it would from a normal pull -- see the README for that
    // tradeoff. The difference from before is only in how the conflict is *detected*: a real
    // divergence in server-assigned version numbers, immune to either device's clock being wrong.
    //
    // This is the one outcome that genuinely needs the remote value, so it's fetched here --
    // only for an actual conflict, not on every push. If the row was deleted or changed again in
    // the moment between the metadata check above and this fetch, `full` comes back null/changed
    // accordingly; either way this key still gets resolved (falling back to the delete branch, or
    // simply picking up whatever is current) rather than left stuck retrying the same conflict.
    const { data: full, error: fetchErr } = await supabase
      .from('kv_store')
      .select('value, deleted, version')
      .eq('user_id', userId)
      .eq('key', key)
      .maybeSingle();
    if (fetchErr) throw sanitizeError(fetchErr);
    // Same guard as the two branches above, but here it matters even more: applying `full` to
    // 'kv' below is "remote wins," which is the whole point of this branch for a genuine
    // conflict -- but if a *newer* local edit queued itself while `full` was being fetched, that
    // edit was never part of the conflict this branch is resolving, and overwriting 'kv' with
    // `full` would silently erase it from the writer's own screen, not just from the outbox.
    // Skip applying `full` entirely in that case -- the next sync pass re-reads the remote
    // version fresh and resolves the newer edit correctly against whatever's actually there by
    // then, same as if this pass had never run.
    if (await outboxEntryUnchanged(db, key, entry)) {
      // Only back up when this device's edit actually had content that's about to be
      // overtaken -- if this device's own pending edit was itself a delete, there's no local
      // content to lose (the writer's intent was already "get rid of this"), so there's nothing
      // for a backup to preserve.
      if (!entry.deleted) {
        await backupLosingLocalEdit(db, key, entry, full ? full.version : null);
      }
      if (!full || full.deleted) {
        await db.delete('kv', key);
        if (full) await db.put('versions', full.version, key);
      } else {
        await db.put('kv', full.value, key);
        await db.put('versions', full.version, key);
      }
      await db.delete('outbox', key);
    }
  }
}

async function pullRemote() {
  const db = await getDb();
  const lastSync = (await db.get('meta', 'lastSyncAt')) || '1970-01-01T00:00:00.000Z';

  // Metadata only in this first query -- no `value`. Every row this range query returns is a key
  // that's changed *server-side* since the last pull, but for an actively-syncing single device
  // that includes rows THIS device just pushed itself (pushOutbox already recorded their new
  // version in the local 'versions' store) -- there's nothing to re-download for those; the data
  // is already sitting in 'kv', it's exactly what was just written there. The original version of
  // this function fetched every changed row's full `value` unconditionally, which meant a full
  // round-trip re-download of a project's entire content after every single autosave push,
  // doubling the bandwidth of every save for no reason on top of the push itself. Comparing this
  // row's version against the version already recorded locally tells apart "I already have this
  // exact version" (this device's own push, or an already-applied earlier pull) from "this is
  // genuinely new to me" (another device pushed it) -- only the latter needs `value` at all.
  const { data: rows, error } = await supabase
    .from('kv_store')
    .select('key, updated_at, deleted, version')
    .eq('user_id', userId)
    .gt('updated_at', lastSync);

  if (error) throw sanitizeError(error);
  if (!rows) return;

  let maxUpdatedAt = lastSync;
  const keysNeedingValue = [];
  for (const row of rows) {
    if (row.updated_at > maxUpdatedAt) maxUpdatedAt = row.updated_at;

    // A key with a pending local edit still sitting in the outbox takes priority over this
    // pull — it gets resolved (one way or the other) on the next pushOutbox() pass instead of
    // being silently overwritten here. Its local 'versions' entry is left alone too: pushOutbox
    // re-reads the row's version fresh from the server when it processes that key, so there's no
    // need (and no benefit) to update it here first.
    const pending = await db.get('outbox', row.key);
    if (pending) continue;

    const localVersion = await db.get('versions', row.key);
    if (localVersion === row.version) continue; // already have exactly this version -- nothing to do

    if (row.deleted) {
      // Deletion doesn't need a value to apply -- resolved directly from this metadata-only row.
      await db.delete('kv', row.key);
      await db.put('versions', row.version, row.key);
      continue;
    }
    keysNeedingValue.push(row.key);
  }

  // One batched query for every key genuinely new to this device, rather than one query per key
  // (or, as before, fetching every changed key's value up front regardless of whether it was
  // needed).
  if (keysNeedingValue.length > 0) {
    const { data: fullRows, error: valueErr } = await supabase
      .from('kv_store')
      .select('key, value, deleted, version')
      .eq('user_id', userId)
      .in('key', keysNeedingValue);
    if (valueErr) throw sanitizeError(valueErr);
    for (const row of fullRows || []) {
      if (row.deleted) {
        await db.delete('kv', row.key);
      } else {
        await db.put('kv', row.value, row.key);
      }
      await db.put('versions', row.version, row.key);
    }
  }

  await db.put('meta', maxUpdatedAt, 'lastSyncAt');
}

// Full re-sync — call right after sign-in, when the local device may have none of the
// account's existing data yet: resets the "last synced" bookmark so pullRemote() fetches
// everything instead of only what changed since some earlier point.
export async function fullResync() {
  const db = await getDb();
  await db.delete('meta', 'lastSyncAt');
  await runSync();
}

// The recovery side of backupLosingLocalEdit above. Surfaced by sync-context.jsx's SyncProvider
// (listens for the 'inkroot:sync-conflict' event this file dispatches, and on mount, in case a
// backup was made during a previous session) and rendered via ConflictRecoveryControl on Home
// (see src/shell/conflict-recovery-control.jsx).
export async function listConflictBackups() {
  const db = await getDb();
  return db.getAll('conflictBackups');
}

// Puts a backed-up local value back into 'kv' and re-queues it for push, based on whatever
// version this key is at now (set by the conflict resolution that created the backup, or by
// anything that's synced since) -- so it's re-pushed as a normal edit on top of the current
// remote state rather than reopening the same conflict it was rescued from.
export async function restoreConflictBackup(id) {
  const db = await getDb();
  const backup = await db.get('conflictBackups', id);
  if (!backup) return false;
  const baseVersion = (await db.get('versions', backup.key)) || 0;
  await db.put('kv', backup.value, backup.key);
  await db.put('outbox', { value: backup.value, deleted: false, baseVersion }, backup.key);
  await db.delete('conflictBackups', id);
  scheduleSync();
  return true;
}

// Discards a backup without restoring it -- e.g. the writer looked at it and decided the version
// that won the conflict is the one they want to keep.
export async function dismissConflictBackup(id) {
  const db = await getDb();
  await db.delete('conflictBackups', id);
}
