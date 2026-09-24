import { openDB } from 'idb';

const DB_NAME = 'inkroot';
// v3 adds the 'conflictBackups' store (see below) -- openDB's upgrade callback runs for any
// client still on v1/v2, so existing local databases pick up the new store automatically on
// next load without losing their existing 'kv'/'outbox'/'meta'/'versions' data.
const DB_VERSION = 3;

let dbPromise = null;

export function getDb() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Current value for every key — same role as the original single-file app's IndexedDB
        // store. Keyed directly by the storage key string (e.g. 'inkroot:project:<id>').
        if (!db.objectStoreNames.contains('kv')) {
          db.createObjectStore('kv');
        }
        // Pending local changes not yet confirmed pushed to Supabase. Keyed by the same
        // storage key, so a second local edit to the same key before the first sync completes
        // just overwrites the pending entry rather than queuing duplicate pushes.
        if (!db.objectStoreNames.contains('outbox')) {
          db.createObjectStore('outbox');
        }
        // Bookkeeping — e.g. the timestamp of the last successful pull, so incremental syncs
        // only ask Supabase for rows changed since then instead of the whole table every time.
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta');
        }
        // The server-assigned kv_store.version this device last saw for each key -- what a
        // pending local edit's outbox entry records as its own `baseVersion` (see storage.js),
        // and what syncEngine.js's pushOutbox compares against the row's current remote version
        // to detect a real conflict (someone else's push landed first) instead of relying on
        // comparing two devices' wall-clock timestamps against each other. Keyed by the same
        // storage key as kv/outbox. A key with no entry here has never been synced either way.
        if (!db.objectStoreNames.contains('versions')) {
          db.createObjectStore('versions');
        }
        // Safety net for the "remote wins" conflict branch in syncEngine.js's pushOutbox: when
        // a genuine version conflict is detected (another device pushed first), this device's
        // own not-yet-synced local edit would otherwise just be discarded with nothing kept
        // anywhere. Before that overwrite happens, the losing local value is written here first
        // -- autoIncrement id, so the same key can accumulate more than one backup if conflicts
        // happen repeatedly before anyone looks. Included in clearLocalData()'s wipe below like
        // every other store here, for the same reason kv/outbox already are: these can hold
        // another account's private manuscript text, so a different person signing in on this
        // same device must not inherit them.
        if (!db.objectStoreNames.contains('conflictBackups')) {
          db.createObjectStore('conflictBackups', { keyPath: 'id', autoIncrement: true });
        }
      },
    });
  }
  return dbPromise;
}

// Wipes every local store — used when a different account signs in on this device than the one
// whose data is currently sitting in IndexedDB (see switchSyncUser in syncEngine.js). Local data
// isn't tied to a session, so without this a second person signing in on a shared/public device
// would pull the first person's still-unsynced kv/outbox entries into their own account on the
// very next sync.
export async function clearLocalData() {
  const db = await getDb();
  await db.clear('kv');
  await db.clear('outbox');
  await db.clear('meta');
  await db.clear('versions');
  await db.clear('conflictBackups');
}
