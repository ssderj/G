import React from 'react';


// ---------- Persistent storage (works fully offline, no account needed) ----------
// Project data (manuscripts, characters, maps, embedded images, the project index, the writer
// profile, and per-project backup history) lives in IndexedDB, not localStorage. Browsers cap
// localStorage at roughly 5-10MB *total* per site, which a project with a handful of embedded
// map or portrait images can exceed on its own; IndexedDB's quota is tied to available disk space
// instead, so there's real headroom before this becomes a problem again. Small device-local
// preferences that were never the source of that quota problem — reading theme/font (see
// loadReadingSettings) and each project's "where you left off" view state (see loadViewState) —
// are deliberately left in localStorage, unchanged.
export const LEGACY_KEY = 'inkroot:project:v1';

 // pre-multi-project save, used only for migration
export const INDEX_KEY = 'inkroot:projects:index';


export const PROFILE_KEY = 'inkroot:writer:profile';

 // the writer's identity — lives outside every project
export const GUILD_KEY = 'inkroot:writer:guild';

 // the writer's Guild — also lives outside every project
export const INBOX_KEY = 'inkroot:writer:inbox:v1';

 // the Author Inbox — reviews, letters, notices; outside every project
export const projectKey = (id) => 'inkroot:project:' + id;


export function uuid() {
    if (window.crypto && window.crypto.randomUUID) {
        try {
            return window.crypto.randomUUID();
        }
        catch (e) { }
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}
