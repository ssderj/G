import { getDb } from './idb.js';
import { scheduleSync } from './syncEngine.js';

// Same public shape as the original single-file app's `storage` object (get/set/delete/list),
// so the existing ~16,000 lines of component code can eventually keep calling this exactly as
// they do today — see README.md's migration note. The only behavioral addition: every set/
// delete also records the change in an outbox and asks the sync engine to push it, so the app
// keeps working identically offline and just picks up sync for free once signed in.

export const storage = {
  async get(key) {
    const db = await getDb();
    const value = await db.get('kv', key);
    return value === undefined ? null : { key, value };
  },

  async set(key, value) {
    const db = await getDb();
    await db.put('kv', value, key);
    // baseVersion is the server kv_store.version this key was at the last time this device
    // synced it (0 if it's never been synced at all) -- what syncEngine.js's pushOutbox compares
    // against the row's *current* remote version to tell a real conflict (another device pushed
    // in the meantime) from a normal push, without relying on comparing wall-clock timestamps
    // between devices. See idb.js's 'versions' store and syncEngine.js for the full picture.
    const baseVersion = (await db.get('versions', key)) || 0;
    await db.put('outbox', { value, deleted: false, baseVersion }, key);
    scheduleSync();
    return { key, value };
  },

  async delete(key) {
    const db = await getDb();
    await db.delete('kv', key);
    const baseVersion = (await db.get('versions', key)) || 0;
    await db.put('outbox', { value: null, deleted: true, baseVersion }, key);
    scheduleSync();
  },

  async list(prefix) {
    const db = await getDb();
    const allKeys = await db.getAllKeys('kv');
    return prefix ? allKeys.filter((k) => k.startsWith(prefix)) : allKeys;
  },
};
