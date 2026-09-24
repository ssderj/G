import React, { useState, useEffect, useRef } from 'react';
import { storage } from '../lib/storage.js';
import { formatBytes } from '../shared-utils/format-bytes.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { TYPE_SCALE } from '../shell/nav-context.jsx';
import { COVER_ACCENTS, COVER_MOTIFS, COVER_STYLES, PACK_CATEGORY_KEYS, packSummaryForIndex, worldExtraFields } from '../worldbuilding/book-cover.jsx';
import { ProjectWorkspace } from './project-workspace.jsx';


// Bump this whenever the project schema changes in a way that needs a migration step (a field
// renamed/restructured, a section split up, etc.) — then add a corresponding entry to
// SCHEMA_MIGRATIONS below. Every project, new or restored, ends up stamped with this version.
export const SCHEMA_VERSION = 1;


export const emptyProject = () => ({
    schemaVersion: SCHEMA_VERSION,
    title: 'Untitled Novel',
    subtitle: '',
    seriesName: '',
    author: '',
    // The generated book-cover's look. style picks the material (see COVER_STYLES); accent
    // picks the hue within that material (see COVER_ACCENTS); motif picks the minimal line-art
    // ornament (see COVER_MOTIFS, 'none' omits it).
    cover: { style: 'leather', accent: 'gold', motif: 'compass', customImageUrl: '' },
    // Book Premiere format: 'book' is a traditional full-length manuscript told in Chapters;
    // 'series' is a shorter, serialized story told in Episodes released one at a time. Both use
    // the exact same `chapters` array below — a Book Premiere never needed two data structures,
    // just a different label and a reader-facing episode list (see PublishedBookReader,
    // storyFormatTerms). Defaults to 'book' so nothing about an existing manuscript changes
    // until an author deliberately opts into the episodic structure, in Settings or Step 1 of
    // the Publishing Wizard (see PublishingWizard).
    storyFormat: 'book',
    chapters: [{ id: uuid(), title: 'Chapter 1', text: '', number: 1, isCopy: false }],
    characters: [],
    timeline: [],
    world: [],
    relationships: [],
    locations: [],
    locationConnections: [],
    // Km represented by one unit of a location's mapX/mapY grid (that grid runs 0-100 on each
    // axis) — the single scale factor the Distance Calculator uses to turn grid positions into
    // real distances. Default of 10 makes the full 100-unit width of the grid 1000km, a
    // reasonable continent-sized span; editable per-project since worlds vary wildly in scale.
    worldScaleKmPerUnit: 10,
    maps: [],
    glossary: [],
    notes: [],
    // Worldbuilding Packs: bundles of this project's own World Bible entries the author has
    // chosen to package and publish on their own, separately from the book. See PACK_CATEGORY_KEYS.
    worldbuildingPacks: [],
    // Addon Studio: which addons (see inkroot:addons in addon-studio.jsx) this specific project
    // has installed, and at what version. The addon records themselves stay device-wide — this
    // is just the per-project on/off switch, plus the version installed at (so an addon update
    // could one day be flagged instead of silently changing an already-open project). A fresh
    // project starts with none installed; nothing about an addon is active until this list says
    // so. See installedAddonManifests/addonWorldCategoryDefs in addon-studio.jsx.
    installedAddons: [],
    stats: { log: {}, dailyGoal: 500, weeklyGoal: 3000 },
    // Coordinate Lock: while true, a location's permanent world coordinates (mapX/mapY) and any
    // map pin's on-image position can't be dragged or clicked into a new spot — only explicit,
    // deliberate unlocking allows repositioning. Defaults on so a growing world map stays stable
    // by default; someone actively placing locations for the first time can switch it off.
    coordinatesLocked: true,
});


// Deep-merges a loaded/imported object against the current default schema (emptyProject(), or
// any nested piece of it). Anything the loaded object already has is kept exactly as-is —
// this never overwrites real data. Anything the *current* schema has that the loaded object is
// missing (a field added in a later app version, a whole new section, a newly added setting)
// is filled in with that field's default value. This is what makes older backups — and backups
// from before some feature existed — keep working after the app gains new features, instead of
// the restore just replacing the schema outright and leaving new fields undefined.
export function mergeWithDefaults(loaded, defaults) {
    if (Array.isArray(defaults)) {
        // Arrays are lists of records (chapters, characters, …), not keyed structures — if the
        // backup has its own array, keep it entirely (per-item field migration happens
        // separately, below); only fall back to the schema's array when the field is absent.
        return Array.isArray(loaded) ? loaded : structuredClone(defaults);
    }
    if (defaults && typeof defaults === 'object') {
        const base = (loaded && typeof loaded === 'object' && !Array.isArray(loaded)) ? loaded : {};
        const merged = { ...base };
        Object.keys(defaults).forEach((key) => {
            merged[key] = mergeWithDefaults(base[key], defaults[key]);
        });
        return merged;
    }
    // Primitive default: keep whatever the backup has unless the field is genuinely absent.
    return (loaded === undefined || loaded === null) ? defaults : loaded;
}


// Ordered migration steps. Each upgrades a project from schema version `from` to `from + 1`.
// A step may ONLY add or transform fields — never delete or overwrite existing user data — since
// "don't discard user data" is the one rule a restore can't break. Add new steps here as the
// schema evolves; nothing else needs to change to pick them up.
export const SCHEMA_MIGRATIONS = [
    {
        from: 0, // no schemaVersion field at all — every backup made before versioning existed
        describe: (v) => `Legacy backup (no schema version) upgraded to schema v${v}.`,
        // The structural defaults a legacy backup needs are filled in by mergeWithDefaults right
        // after this runs, so there's nothing to transform here — this step just marks the jump.
        migrate: (data) => data,
    },
    // Future example:
    // {
    //     from: 1,
    //     describe: (v) => `Schema v1 \u2192 v${v}: split "notes" into general notes and research notes.`,
    //     migrate: (data) => { data.researchNotes = data.researchNotes || []; return data; },
    // },
];


// Detects a loaded project's schema version and walks it forward, one migration step at a time,
// to SCHEMA_VERSION. Returns the migrated data plus a human-readable log of what happened (empty
// if the backup was already current). Never throws away data — each step only adds/transforms.
export function migrateProjectSchema(data) {
    const startVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;
    const log = [];
    let version = startVersion;
    while (version < SCHEMA_VERSION) {
        const step = SCHEMA_MIGRATIONS.find((m) => m.from === version);
        if (!step) {
            // No explicit step for this jump — default-filling right after this (mergeWithDefaults
            // plus the field-level checks below) still brings the data up to the current shape, so
            // nothing is lost, but note it since it means a migration step is missing.
            log.push(`No explicit migration step for schema v${version} \u2192 v${version + 1}; fell back to default-filling.`);
            version += 1;
            continue;
        }
        data = step.migrate(data);
        version += 1;
        log.push(step.describe(version));
    }
    if (log.length) {
        console.info('[Inkroot] Backup schema migration for "' + (data.title || 'Untitled') + '": ' + log.join(' '));
    }
    data.schemaVersion = SCHEMA_VERSION;
    return { data, log };
}


export function restoreProject(rawData) {
    // Step 1: detect the backup's schema version (a missing field means it predates versioning)
    // and run whatever migration steps are needed to bring it up to SCHEMA_VERSION. Logged so any
    // upgrade of an older backup is visible.
    const { data: migratedData, log } = migrateProjectSchema(rawData);
    // Step 2: reconcile against the current schema so nothing added since this backup was made is
    // left missing. Every field-specific check below still runs after this and continues to
    // handle type-correction and per-item migration for existing data. Nothing here — or above —
    // ever deletes a field the backup already had; it only fills in what's missing.
    let data = mergeWithDefaults(migratedData, emptyProject());
    if (!data.relationships)
        data.relationships = [];
    data.relationships = data.relationships.filter(Boolean);
    if (!data.locations)
        data.locations = [];
    data.locations = data.locations.filter(Boolean);
    data.locations.forEach((l) => { if (!Array.isArray(l.tags))
        l.tags = [];
        if (typeof l.parentLocationId !== 'string')
            l.parentLocationId = '';
        if (typeof l.rulingHouseId !== 'string')
            l.rulingHouseId = '';
        if (typeof l.occupyingFactionId !== 'string')
            l.occupyingFactionId = '';
        if (typeof l.previousOwner !== 'string')
            l.previousOwner = '';
        if (typeof l.locationType !== 'string')
            l.locationType = '';
        if (typeof l.status !== 'string')
            l.status = '';
        if (typeof l.roadQuality !== 'string')
            l.roadQuality = '';
        if (typeof l.travelDangers !== 'string')
            l.travelDangers = '';
        if (typeof l.mapX !== 'string')
            l.mapX = '';
        if (typeof l.mapY !== 'string')
            l.mapY = ''; });
    if (!data.locationConnections)
        data.locationConnections = [];
    data.locationConnections = data.locationConnections.filter(Boolean).filter((c) => data.locations.some((l) => l.id === c.fromId) && data.locations.some((l) => l.id === c.toId));
    // Every connection needs a travel `kind` for the Distance Calculator's road/sea/portal
    // networks to route through. Backups made before this existed get a best-guess kind inferred
    // from their free-text label, so old data lights up in the calculator immediately instead of
    // needing every connection re-tagged by hand.
    data.locationConnections.forEach((c) => {
        if (c.kind !== 'road' && c.kind !== 'sea' && c.kind !== 'portal') {
            const label = c.label || '';
            c.kind = /sea|river|ship|boat|harbor/i.test(label) ? 'sea' : (/portal|teleport/i.test(label) ? 'portal' : 'road');
        }
        if (typeof c.distanceKm !== 'number' || !(c.distanceKm > 0))
            c.distanceKm = null; // null = derive distance from the two locations' coordinates
    });
    if (typeof data.worldScaleKmPerUnit !== 'number' || !(data.worldScaleKmPerUnit > 0))
        data.worldScaleKmPerUnit = 10;
    if (!data.maps)
        data.maps = [];
    data.maps = data.maps.filter(Boolean);
    data.maps.forEach((m) => {
        if (!m.defaultCamera || typeof m.defaultCamera !== 'object')
            m.defaultCamera = null;
    });
    if (typeof data.coordinatesLocked !== 'boolean')
        data.coordinatesLocked = true;
    if (!data.glossary)
        data.glossary = [];
    data.glossary = data.glossary.filter(Boolean);
    if (!data.notes)
        data.notes = [];
    data.notes = data.notes.filter(Boolean);
    if (!data.worldbuildingPacks)
        data.worldbuildingPacks = [];
    data.worldbuildingPacks = data.worldbuildingPacks.filter(Boolean);
    data.worldbuildingPacks.forEach((pack) => {
        if (typeof pack.title !== 'string')
            pack.title = '';
        if (typeof pack.subtitle !== 'string')
            pack.subtitle = '';
        if (typeof pack.description !== 'string')
            pack.description = '';
        if (typeof pack.coverImageUrl !== 'string')
            pack.coverImageUrl = '';
        if (typeof pack.price !== 'number')
            pack.price = 0;
        if (typeof pack.publishStatus !== 'string')
            pack.publishStatus = 'none';
        if (typeof pack.publishedAt !== 'number')
            pack.publishedAt = null;
        if (typeof pack.genre !== 'string')
            pack.genre = 'Unspecified';
        if (!Array.isArray(pack.tags))
            pack.tags = [];
        if (typeof pack.createdAt !== 'number')
            pack.createdAt = Date.now();
        if (typeof pack.updatedAt !== 'number')
            pack.updatedAt = pack.createdAt;
        if (!pack.selection || typeof pack.selection !== 'object')
            pack.selection = {};
        PACK_CATEGORY_KEYS.forEach((k) => { if (!Array.isArray(pack.selection[k]))
            pack.selection[k] = []; });
    });
    if (!data.stats)
        data.stats = { log: {} };
    if (typeof data.stats.dailyGoal !== 'number' || !(data.stats.dailyGoal > 0))
        data.stats.dailyGoal = 500;
    if (typeof data.stats.weeklyGoal !== 'number' || !(data.stats.weeklyGoal > 0))
        data.stats.weeklyGoal = 3000;
    if (!data.chapters)
        data.chapters = [{ id: uuid(), title: '', text: '', number: 1, isCopy: false }];
    data.chapters = data.chapters.filter(Boolean);
    if (data.chapters.length === 0)
        data.chapters = [{ id: uuid(), title: '', text: '', number: 1, isCopy: false }];
    data.chapters.forEach((c, idx) => {
        if (typeof c.title !== 'string')
            c.title = '';
        if (c.title.trim() === `Chapter ${idx + 1}`)
            c.title = '';
        if (typeof c.isCopy !== 'boolean')
            c.isCopy = false;
    });
    // Chapter numbers are derived from array position, not stored as an independent value —
    // see renumberChapters() below for why. Every load re-derives them, which also self-heals
    // any project saved under the old scheme (where two chapters could carry the same `number`
    // after a duplicate — see git history on renumberChapters for that story).
    renumberChapters(data.chapters);
    if (!data.characters)
        data.characters = [];
    data.characters = data.characters.filter(Boolean);
    data.characters.forEach((c) => {
        if (typeof c.role !== 'string')
            c.role = '';
        if (typeof c.portraitUrl !== 'string')
            c.portraitUrl = '';
        if (typeof c.houseId !== 'string')
            c.houseId = '';
        if (!Array.isArray(c.tags))
            c.tags = [];
    });
    if (!data.timeline)
        data.timeline = [];
    data.timeline = data.timeline.filter(Boolean);
    data.timeline.forEach((ev) => {
        if (typeof ev.characterId !== 'string')
            ev.characterId = '';
        if (typeof ev.locationId !== 'string')
            ev.locationId = '';
    });
    if (!data.world)
        data.world = [];
    data.world = data.world.filter(Boolean);
    data.world.forEach((w) => {
        if (typeof w.category !== 'string')
            w.category = '';
        if (typeof w.crestUrl !== 'string')
            w.crestUrl = '';
        if (typeof w.bannerUrl !== 'string')
            w.bannerUrl = '';
        if (typeof w.overview !== 'string')
            w.overview = '';
        if (typeof w.motto !== 'string')
            w.motto = '';
        if (typeof w.founder !== 'string')
            w.founder = '';
        if (typeof w.currentLeader !== 'string')
            w.currentLeader = '';
        if (typeof w.heir !== 'string')
            w.heir = '';
        if (typeof w.seat !== 'string')
            w.seat = '';
        if (typeof w.region !== 'string')
            w.region = '';
        if (typeof w.foundedDate !== 'string')
            w.foundedDate = '';
        if (typeof w.status !== 'string')
            w.status = '';
        if (typeof w.houseWords !== 'string')
            w.houseWords = '';
        if (typeof w.allegiance !== 'string')
            w.allegiance = '';
        if (!Array.isArray(w.vassals))
            w.vassals = [];
        if (!Array.isArray(w.allies))
            w.allies = [];
        if (!Array.isArray(w.rivals))
            w.rivals = [];
        if (typeof w.parentHouseId !== 'string')
            w.parentHouseId = '';
        if (typeof w.parentRelationship !== 'string')
            w.parentRelationship = '';
        const extra = worldExtraFields(w.category).defaults;
        Object.keys(extra).forEach((key) => { if (typeof w[key] !== 'string')
            w[key] = extra[key]; });
    });
    if (typeof data.title !== 'string')
        data.title = 'Untitled Novel';
    if (data.storyFormat !== 'series' && data.storyFormat !== 'book')
        data.storyFormat = 'book';
    return { data, log };
}


// ---------- Book Premiere format terms ----------
// The one place that decides whether a project's chapters read as "Chapters" (a traditional
// full-length book) or "Episodes" (a shorter, serialized story) — see the storyFormat field on
// emptyProject. Every screen that shows that word (the manuscript sidebar, chapterLabel, the
// Publishing Wizard, library cards, PublishedBookReader) calls this instead of hardcoding
// "Chapter", so switching a project's format in Settings relabels everywhere at once.
export function isSerialFormat(projectOrBook) {
    return !!projectOrBook && projectOrBook.storyFormat === 'series';
}


export function storyFormatTerm(projectOrBook, plural) {
    const serial = isSerialFormat(projectOrBook);
    if (serial)
        return plural ? 'Episodes' : 'Episode';
    return plural ? 'Chapters' : 'Chapter';
}


// Backward-compatible wrapper for call sites that only need the migrated project, not the log.
export function patchProjectDefaults(rawData) {
    return restoreProject(rawData).data;
}


// A backup is only worth taking if the project actually changed since the last one — comparing
// serialized content (cheap for typical project sizes) avoids piling up identical snapshots while
// someone is just reading, not editing.
export const MAX_BACKUPS = 5;


export const MIN_BACKUP_INTERVAL_MS = 2 * 60 * 1000;

 // at most one new backup per 2 minutes of active editing
export const backupsKey = (storageKey) => storageKey + ':backups';


export async function readBackups(storageKey) {
    try {
        const res = await storage.get(backupsKey(storageKey));
        return res ? JSON.parse(res.value) : [];
    }
    catch (e) {
        return [];
    }
}


// Projects can get large — map images and character portraits are stored as embedded data URLs,
// sometimes several MB each — and the browser's total storage quota for this site is shared across
// the live project, its backups, and everything else this app keeps. Duplicating those images
// several times over in backup history was exactly what caused real data loss: once the quota
// filled up, the *live* autosave itself started failing, silently leaving whatever was last saved
// before that point as the only thing there on reload. Backups now omit large embedded media —
// they exist to protect structure and text (a location, a house, a paragraph) which is
// irreplaceable, not pixel data which can be re-uploaded — so they stay small and can never crowd
// out the save that actually matters.
export function stripHeavyMediaForBackup(value) {
    if (typeof value === 'string')
        return (value.startsWith('data:') && value.length > 2000) ? '[image omitted from backup to save space]' : value;
    if (Array.isArray(value))
        return value.map(stripHeavyMediaForBackup);
    if (value && typeof value === 'object') {
        const out = {};
        for (const k in value)
            out[k] = stripHeavyMediaForBackup(value[k]);
        return out;
    }
    return value;
}


// If even a trimmed backup list can't fit, drop the oldest snapshot and retry rather than losing
// backup coverage entirely.
export async function writeBackups(storageKey, list) {
    let attempt = list;
    for (let i = 0; i < MAX_BACKUPS; i++) {
        try {
            await storage.set(backupsKey(storageKey), JSON.stringify(attempt));
            return;
        }
        catch (e) {
            if (attempt.length <= 1)
                return;
            attempt = attempt.slice(1);
        }
    }
}


export async function maybeSnapshotBackup(storageKey, project) {
    const list = await readBackups(storageKey);
    const last = list[list.length - 1];
    const now = Date.now();
    if (last && now - last.savedAt < MIN_BACKUP_INTERVAL_MS)
        return;
    const lightData = JSON.stringify(stripHeavyMediaForBackup(project));
    if (last && last.data === lightData)
        return;
    await writeBackups(storageKey, [...list, { id: uuid(), savedAt: now, data: lightData }].slice(-MAX_BACKUPS));
}


// Clears this project's backup history to free up quota — used as a last resort when the live
// save itself fails, since the live project always takes priority over its own backups.
export async function clearBackups(storageKey) {
    try {
        await storage.delete(backupsKey(storageKey));
    }
    catch (e) { }
}


// Strips heavy embedded media from any backup snapshots already sitting in storage for one
// project. Backups made before that stripping was added to maybeSnapshotBackup still hold full
// images, which otherwise sit there counting against the shared quota forever with no way to
// shrink again — this is what actually reclaims that space. Returns bytes freed.
export async function reclaimBackupSpace(storageKey) {
    const list = await readBackups(storageKey);
    if (list.length === 0)
        return 0;
    let freed = 0, changed = false;
    const cleaned = list.map((b) => {
        try {
            const parsed = JSON.parse(b.data);
            const stripped = JSON.stringify(stripHeavyMediaForBackup(parsed));
            if (stripped.length < b.data.length) {
                freed += b.data.length - stripped.length;
                changed = true;
                return Object.assign({}, b, { data: stripped });
            }
        }
        catch (e) { }
        return b;
    });
    if (changed)
        await writeBackups(storageKey, cleaned);
    return freed;
}


export function formatBackupTime(ts) {
    return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}


// Rough estimate of total storage used by this site (IndexedDB + localStorage combined), via the
// browser's Storage API. IndexedDB's quota is tied to available disk space rather than the old
// fixed ~5-10MB localStorage cap, so this is mainly a "how much room is left" indicator now,
// rather than something a normal project is likely to approach.
export async function estimateStorageUsage() {
    if (navigator.storage && navigator.storage.estimate) {
        try {
            const { usage, quota } = await navigator.storage.estimate();
            return { usage: usage || 0, quota: quota || 0, supported: true };
        }
        catch (e) { }
    }
    return { usage: 0, quota: 0, supported: false };
}


// ---------- Storage usage note (Settings \u2192 Backup Versions) ----------
export function StorageUsageNote() {
    const [estimate, setEstimate] = useState(null);
    useEffect(() => {
        let cancelled = false;
        estimateStorageUsage().then((res) => { if (!cancelled)
            setEstimate(res); });
        return () => { cancelled = true; };
    }, []);
    if (!estimate)
        return null;
    if (!estimate.supported) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 12 } }, "Projects are stored in this browser's IndexedDB, which has much more room than the old save did \u2014 if you're relying on many large map or portrait images, exporting a backup (above) and trimming unused ones still helps avoid a save failing.");
    }
    const pct = estimate.quota ? Math.round((estimate.usage / estimate.quota) * 100) : null;
    return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 12 } }, `\u2248 ${formatBytes(estimate.usage)} used in this browser across all Inkroot projects` +
        (estimate.quota ? ` of about ${formatBytes(estimate.quota)} available${pct !== null ? ` (${pct}%)` : ''}` : '') +
        ". If you're relying on many large map or portrait images, exporting a backup (above) and trimming unused ones still helps avoid a save failing.");
}


// ---------- Persisted view state (per project) ----------
// "Where you left off" — the selected location, map camera/zoom, active filters, which panels are
// expanded — isn't manuscript content, so it's kept in its own localStorage slot per project
// instead of inside the autosaved project JSON. Every change is written straight through
// (uncoupled from the debounced project autosave) so even a mid-drag camera position or a filter
// picked seconds before a crash is still there on next launch.
// Set once by ProjectWorkspace as soon as a project id is known, so any component anywhere in the
// tree can read/write its own slice of view state via the hook below without needing the project
// id threaded down to it as a prop.
export let activeViewProjectId = null;


export function setActiveViewProject(projectId) { activeViewProjectId = projectId; }


export function viewStateKey() { return 'inkroot:viewState:' + (activeViewProjectId || 'none'); }


export function loadViewState() {
    try {
        return JSON.parse(localStorage.getItem(viewStateKey()) || '{}');
    }
    catch (e) {
        return {};
    }
}


export function patchViewState(patch) {
    try {
        localStorage.setItem(viewStateKey(), JSON.stringify({ ...loadViewState(), ...patch }));
    }
    catch (e) { }
}


// A useState-like hook whose value is seeded from, and immediately written back to, the current
// project's persisted view state under `key`. `defaultValue` only applies the very first time a
// project has nothing saved yet for that key. Reused for the active location, filters, map camera
// per map, selected map, and (via CollapsibleSection) every expandable panel in the app.
export function usePersistedViewState(key, defaultValue) {
    const [value, setValue] = useState(() => {
        const saved = loadViewState();
        return Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : defaultValue;
    });
    const setAndPersist = (next) => {
        setValue((prev) => {
            const resolved = typeof next === 'function' ? next(prev) : next;
            patchViewState({ [key]: resolved });
            return resolved;
        });
    };
    return [value, setAndPersist];
}


// Same idea as usePersistedViewState, but the write to storage is debounced rather than
// immediate — for state that can change many times per second (dragging/zooming the map) so
// persisting doesn't add jank to the interaction. The in-memory value still updates instantly;
// only the localStorage write is delayed and coalesced, so the very last position still lands.
export function usePersistedViewStateDebounced(key, defaultValue, delay = 400) {
    const [value, setValue] = useState(() => {
        const saved = loadViewState();
        return Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : defaultValue;
    });
    const timer = useRef(null);
    useEffect(() => () => { if (timer.current)
        clearTimeout(timer.current); }, []);
    const setAndPersist = (next) => {
        setValue((prev) => {
            const resolved = typeof next === 'function' ? next(prev) : next;
            if (timer.current)
                clearTimeout(timer.current);
            timer.current = setTimeout(() => patchViewState({ [key]: resolved }), delay);
            return resolved;
        });
    };
    return [value, setAndPersist];
}


export function useAutosave(project, ready, storageKey) {
    const timer = useRef(null);
    const [status, setStatus] = useState('idle');
    // Mirrors the latest values so the unmount-flush effect below (which only ever runs once,
    // with an empty dependency array) can still reach the most recent project/key without
    // needing them in its own dependency list.
    const latestRef = useRef({ project, storageKey, ready });
    latestRef.current = { project, storageKey, ready };
    useEffect(() => {
        if (!ready)
            return;
        setStatus('saving');
        if (timer.current)
            clearTimeout(timer.current);
        timer.current = setTimeout(async () => {
            timer.current = null;
            const serialized = JSON.stringify(project);
            try {
                // The live save always takes priority over its own backup history. If this fails
                // (almost always a storage-quota error), free up space by dropping this project's
                // backups and retry once immediately, rather than leaving the previous saved
                // version as the only thing that survives.
                try {
                    await storage.set(storageKey, serialized);
                }
                catch (quotaErr) {
                    await clearBackups(storageKey);
                    await storage.set(storageKey, serialized);
                }
                setStatus('saved');
                // Backups are best-effort and must never be allowed to affect the status shown for
                // the live save above, so any failure here (including running out of room even
                // after the retry above) is swallowed rather than reported as a save error.
                try {
                    await maybeSnapshotBackup(storageKey, project);
                }
                catch (e) { }
            }
            catch (e) {
                setStatus('error');
            }
        }, 500);
        return () => clearTimeout(timer.current);
    }, [project, ready, storageKey]);
    // Without this, leaving the project (onBack, deleting it, closing the tab) within that 500ms
    // debounce window would just clearTimeout the pending save via the cleanup above and the very
    // last edit — e.g. the action that just unlocked an achievement — would never reach storage.
    // That silently stale project is exactly what let the Profile page's lifetime level-up
    // animation go missing: it recomputes everything straight from storage, so a save that never
    // landed there looks, from the Profile screen's side, like the level-up never happened. A
    // second effect with an empty dependency array (so its cleanup fires only on true unmount, not
    // on every project edit like the one above) flushes any still-pending save immediately instead
    // of discarding it.
    useEffect(() => {
        return () => {
            if (timer.current) {
                clearTimeout(timer.current);
                timer.current = null;
                const { project: pendingProject, storageKey: pendingKey, ready: wasReady } = latestRef.current;
                if (wasReady) {
                    storage.set(pendingKey, JSON.stringify(pendingProject)).catch(() => { });
                }
            }
        };
    }, []);
    return status;
}


// Keeps the home-screen project list (title, word count) in sync as you write,
// without writing to storage on every keystroke.
export function useMetaReport(project, ready, projectId, onMeta, activeChapterId) {
    const timer = useRef(null);
    useEffect(() => {
        if (!ready || !project)
            return;
        if (timer.current)
            clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            const total = project.chapters.reduce((s, c) => s + wordCount(c.text), 0);
            const idx = project.chapters.findIndex((c) => c.id === activeChapterId);
            const current = idx >= 0 ? project.chapters[idx] : project.chapters[project.chapters.length - 1];
            onMeta(projectId, {
                title: project.title,
                subtitle: project.subtitle || '',
                seriesName: project.seriesName || '',
                author: project.author || '',
                cover: project.cover || null,
                wordCount: total,
                updatedAt: Date.now(),
                // Book Premiere format ('book' | 'series') mirrored onto the index so the Grand
                // Library, Author Studio, and search results can tell a serialized story apart
                // from a traditional book without loading the full project (see storyFormatTerm).
                storyFormat: project.storyFormat === 'series' ? 'series' : 'book',
                chapterLabel: current ? chapterLabel(project.chapters, current.id, storyFormatTerm(project)) : '',
                chapterNumber: current && typeof current.number === 'number' ? current.number : (idx >= 0 ? idx + 1 : project.chapters.length),
                chapterCount: project.chapters.length,
                completed: !!project.completed,
                completedAt: project.completedAt || null,
                // Mirrors this project's own publish state onto the index too, the same way
                // worldbuildingPacks are mirrored just below — so a Publish/Unpublish made from
                // this project's own Settings tab (see ProjectWorkspace's handleSetPublishStatus)
                // shows up immediately in the Grand Library's Author Studio without reopening it,
                // just like a Publish made from Author Studio itself shows up here.
                publishStatus: project.publishStatus || 'none',
                publishedAt: project.publishedAt || null,
                // Mirrors the book's own marketplace listing fields onto the index too — same
                // reasoning as publishStatus just above — so editing them via the Publishing
                // Wizard from this project's Settings tab (see ProjectWorkspace's
                // handleWizardPublishBook) reaches the Grand Library the same way editing them
                // from Author Studio does (see publishBookWithDetails).
                genre: project.genre || 'Unspecified',
                blurb: project.blurb || '',
                price: typeof project.price === 'number' ? project.price : 0,
                tags: project.tags || [],
                // Mirrors each Worldbuilding Pack as a small, self-contained summary (see
                // packSummaryForIndex) so the Grand Library can list, browse, and unpublish packs
                // without loading this project's full file — the same reason blurb/genre/price
                // already live at the index level for books.
                worldbuildingPacks: (project.worldbuildingPacks || []).map((pack) => packSummaryForIndex(project, pack)),
            });
        }, 500);
        return () => clearTimeout(timer.current);
    }, [project, ready, projectId, activeChapterId]);
}


// A chapter's display number is DERIVED from its position in the `chapters` array — it is never
// a value the user or a caller invents independently. `renumberChapters` (below) is the only
// function that assigns `.number`, and it is called after every structural change to a project's
// chapters (add, delete, insert, duplicate, reorder/move) so array order and displayed/exported
// numbering can never drift apart. This replaces an earlier design where `.number` was set once
// at creation and kept forever: that made reordering impossible to express (nothing recomputed
// the numbers), and duplicating a chapter had to fake it by copying the source's number and
// leaning on Array.sort's stability — two chapters sharing one number, disambiguated only by an
// `isCopy` label. Position-derived numbering removes the need for that entirely.
//
// `.number` is still stored on each chapter object (rather than computed on every read) so
// existing call sites that read `ch.number` directly — the four export formats (pdf-export.js,
// docx-export.js, epub-export.js, the plain-text builder in import-export.jsx) plus
// useMetaReport's live word-count panel — keep working unmodified; renumberChapters just
// guarantees that stored value is always kept in sync with position.
export function chapterLabel(chapters, chapterId, term) {
    const unit = term || 'Chapter';
    const idx = chapters.findIndex((c) => c.id === chapterId);
    if (idx < 0)
        return `${unit} ?`;
    const ch = chapters[idx];
    const num = typeof ch.number === 'number' ? ch.number : idx + 1;
    const custom = ch.title ? ch.title.trim() : '';
    const base = custom ? `${unit} ${num}: ${custom}` : `${unit} ${num}`;
    return ch.isCopy ? `${base} (Copy)` : base;
}


// Re-stamps every chapter's `.number` to match its current array index (1-based), in place.
// Call this — mutating the draft inside an `update()` producer — after ANY change to a project's
// chapter order or membership: push (add), splice (insert/delete/duplicate), or a swap
// (move up/down, drag-reorder). It's O(n) over chapters, which is cheap even for a very long
// manuscript, and it's the single place that decides what a chapter's number is, so no call site
// needs its own numbering logic (see the removed `highestChapterNumber` usages this replaced).
export function renumberChapters(chapters) {
    chapters.forEach((c, idx) => { c.number = idx + 1; });
    return chapters;
}


export function getTextBeforeCaret(container) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0)
        return '';
    const range = sel.getRangeAt(0);
    if (!container.contains(range.startContainer))
        return '';
    const pre = document.createRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString();
}


// Builds a Range spanning [start, end) characters into `container`'s flattened text, by walking
// every text node rather than trusting one specific node/offset. A Range tied to a single node
// captured earlier can go stale if the browser reshapes text nodes while the user keeps typing
// (e.g. mobile autocorrect splitting or replacing a node mid-word); counting characters fresh
// across whatever nodes currently exist sidesteps that entirely.
export function createRangeFromCharOffsets(container, start, end) {
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
    const range = document.createRange();
    let charCount = 0;
    let startSet = false;
    let endSet = false;
    let node;
    while ((node = walker.nextNode())) {
        const nextCount = charCount + node.length;
        if (!startSet && start <= nextCount) {
            range.setStart(node, Math.max(0, start - charCount));
            startSet = true;
        }
        if (!endSet && end <= nextCount) {
            range.setEnd(node, Math.max(0, end - charCount));
            endSet = true;
            break;
        }
        charCount = nextCount;
    }
    if (!startSet || !endSet)
        return null;
    return range;
}


// ---------- Co-mention detection ----------
export function extractCoMentionEdges(chapters) {
    const counts = new Map();
    chapters.forEach((c) => {
        const div = document.createElement('div');
        div.innerHTML = c.text || '';
        const ids = Array.from(new Set(Array.from(div.querySelectorAll('[data-mention-type="character"]')).map((el) => el.getAttribute('data-mention-id'))));
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const key = [ids[i], ids[j]].sort().join('|');
                counts.set(key, (counts.get(key) || 0) + 1);
            }
        }
    });
    return Array.from(counts.entries()).map(([key, weight]) => {
        const [a, b] = key.split('|');
        return { source: a, target: b, weight, kind: 'auto' };
    });
}
