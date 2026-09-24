import React from 'react';
import { truncate } from '../shared-utils/truncate.jsx';
import { addonWorldCategoryDefs } from '../writing/addon-data.jsx';


export const WORLD_CATEGORIES = [
    { key: 'houses', icon: '⚜', label: 'Houses & Clans', placeholder: 'House, family, or clan name…' },
    { key: 'organizations', icon: '🏛', label: 'Organizations', placeholder: 'Organization or faction name…' },
    { key: 'artifacts', icon: '🗝', label: 'Artifacts', placeholder: 'Artifact or relic name…' },
    { key: 'magic', icon: '✨', label: 'Magic', placeholder: 'System, spell, or rule of magic…' },
    { key: 'religions', icon: '⛩', label: 'Religions', placeholder: 'Faith, deity, or order…' },
    { key: 'creatures', icon: '🐉', label: 'Creatures', placeholder: 'Species or creature name…' },
];


export function worldCategoryMeta(key) {
    return WORLD_CATEGORIES.find((c) => c.key === key) || { key: '', icon: '🌍', label: 'General', placeholder: 'Topic (custom, faction, rule, history…)' };
}


// Category-specific structured fields for Organizations, Magic, Religions, and Artifacts — each
// returns the extra editable `fields` CardList should render, and the matching `quickStats` rows
// (a subset of those same keys) surfaced in the Quick Stats card at the top of each entry. Houses
// have their own dedicated page (HouseDatabasePage) with a much richer field set, so they're not
// included here.
// `project` is optional and only consulted once none of the four built-in categories match —
// existing callers that don't pass it (e.g. the legacy-backup default-filling pass in
// project-schema-and-backups.jsx) keep working exactly as before, just without addon-category
// defaults backfilled during that specific pass.
export function worldExtraFields(category, project) {
    if (category === 'organizations') {
        return {
            fields: [
                { key: 'leader', placeholder: 'Who leads this organization…' },
                { key: 'orgType', kind: 'select', options: [{ value: '', label: 'Type…' }, ...ORG_TYPES.map((t) => ({ value: t, label: t }))] },
                { key: 'headquarters', placeholder: 'Where it operates from…' },
                { key: 'orgStatus', kind: 'select', options: [{ value: '', label: 'Status…' }, ...ORG_STATUSES.map((s) => ({ value: s, label: s }))] },
            ],
            quickStats: [
                { key: 'leader', label: 'Leader' },
                { key: 'orgType', label: 'Type' },
                { key: 'headquarters', label: 'Headquarters' },
                { key: 'orgStatus', label: 'Status' },
            ],
            defaults: { leader: '', orgType: '', headquarters: '', orgStatus: '' },
        };
    }
    if (category === 'magic') {
        return {
            fields: [
                { key: 'source', placeholder: 'Where its power comes from\u2014bloodline, the Weave, pacts\u2026' },
                { key: 'cost', placeholder: 'The price of using it\u2014life force, memories, sanity\u2026' },
                { key: 'practitioners', placeholder: 'Who can wield it…' },
            ],
            quickStats: [
                { key: 'source', label: 'Source' },
                { key: 'cost', label: 'Cost / Limitation' },
                { key: 'practitioners', label: 'Practitioners' },
            ],
            defaults: { source: '', cost: '', practitioners: '' },
        };
    }
    if (category === 'religions') {
        return {
            fields: [
                { key: 'deity', placeholder: 'Deity or pantheon\u2026' },
                { key: 'domain', placeholder: 'Domain\u2014death, war, harvest\u2026' },
                { key: 'holySite', placeholder: 'Holy site or seat of worship\u2026' },
                { key: 'followers', placeholder: 'Who follows this faith\u2026' },
            ],
            quickStats: [
                { key: 'deity', label: 'Deity / Pantheon' },
                { key: 'domain', label: 'Domain' },
                { key: 'holySite', label: 'Holy Site' },
                { key: 'followers', label: 'Followers' },
            ],
            defaults: { deity: '', domain: '', holySite: '', followers: '' },
        };
    }
    if (category === 'artifacts') {
        return {
            fields: [
                { key: 'power', placeholder: 'What it does…' },
                { key: 'currentOwner', placeholder: 'Who holds it now…' },
                { key: 'artifactStatus', kind: 'select', options: [{ value: '', label: 'Status…' }, ...ARTIFACT_STATUSES.map((s) => ({ value: s, label: s }))] },
            ],
            quickStats: [
                { key: 'power', label: 'Power' },
                { key: 'currentOwner', label: 'Current Owner' },
                { key: 'artifactStatus', label: 'Status' },
            ],
            defaults: { power: '', currentOwner: '', artifactStatus: '' },
        };
    }
    if (project) {
        const addonDef = addonWorldCategoryDefs(project).find((d) => d.key === category);
        if (addonDef)
            return { fields: addonDef.fields, quickStats: addonDef.quickStats, defaults: addonDef.defaults };
    }
    return { fields: [], quickStats: null, defaults: {} };
}


// ---------- World Bible: unified category architecture (V9) ----------
// The World Bible screen's sidebar. Five of these (houses, organizations, magic, religions,
// artifacts) still edit project.world directly via the existing category-tagged CardList.
// Four more (characters, locations, timeline, glossary) surface each database's OWN full tab —
// this screen just browses and jumps to them, since duplicating their editors here would mean
// maintaining two copies of each. Family Trees isn't a new dataset: a "family tree" IS a House &
// Clan entry (its members come from characters tagged with that house) — this category just
// gives that existing view its own front door instead of hiding it as a footer link. "All"
// combines every one of the above into a single searchable list.
export const WORLD_BIBLE_CATEGORIES = [
    { key: 'all', icon: '🌍', label: 'All' },
    { key: 'characters', icon: '👤', label: 'Characters' },
    { key: 'houses', icon: '👑', label: 'Houses & Clans' },
    { key: 'familyTrees', icon: '🌳', label: 'Family Trees', isNew: true },
    { key: 'locations', icon: '📍', label: 'Locations' },
    { key: 'timeline', icon: '📅', label: 'Timeline' },
    { key: 'organizations', icon: '🏛', label: 'Organizations' },
    { key: 'magic', icon: '✨', label: 'Magic' },
    { key: 'religions', icon: '⛩', label: 'Religions' },
    { key: 'artifacts', icon: '🔑', label: 'Artifacts' },
    { key: 'glossary', icon: '📚', label: 'Glossary' },
];


export const NATIVE_WORLD_KEYS = ['houses', 'organizations', 'magic', 'religions', 'artifacts'];

// The full sidebar list for one specific project: the fixed built-ins plus whatever custom
// categories its installed addons contribute (see addonWorldCategoryDefs in addon-data.jsx),
// each tagged isAddon so the sidebar can badge it. Falls back to just the built-ins when no
// project is given (e.g. contexts that only ever show native categories).
export function worldBibleCategoriesForProject(project) {
    if (!project)
        return WORLD_BIBLE_CATEGORIES;
    const addonCats = addonWorldCategoryDefs(project).map((d) => ({ key: d.key, icon: d.icon, label: d.label, isAddon: true, sourceAddonName: d.sourceAddonName }));
    return [...WORLD_BIBLE_CATEGORIES, ...addonCats];
}


// Which category keys get the full CardList editor (vs. the read-only browse list) for one
// specific project — the fixed native ones plus any addon-contributed category installed there.
export function editableWorldCategoryKeys(project) {
    if (!project)
        return NATIVE_WORLD_KEYS;
    return [...NATIVE_WORLD_KEYS, ...addonWorldCategoryDefs(project).map((d) => d.key)];
}
// ---------- Worldbuilding Packs ----------
// Every browsable World Bible category (everything in WORLD_BIBLE_CATEGORIES except the two
// meta-views 'all' and 'familyTrees', which aren't datasets of their own) can be included in a
// Worldbuilding Pack. A pack doesn't copy this data — it stores which entry ids from THIS
// project it includes (pack.selection), so editing an entry later is reflected everywhere the
// pack is shown without needing to "republish".
export const PACK_CATEGORY_KEYS = ['characters', 'locations', 'houses', 'organizations', 'magic', 'religions', 'artifacts', 'timeline', 'glossary'];


// Turns one entry from any source into a common shape for the unified "All" browse view and
// cross-category search. `type` matches the type strings goToCharacter/goToLocation/handleJump
// already understand, so a row can jump straight to wherever that entry actually lives.
export function normalizeWorldBibleEntry(sourceKey, item) {
    if (sourceKey === 'characters')
        return { id: item.id, type: 'character', typeLabel: 'Character', name: item.name || 'Unnamed', snippet: item.role || item.occupation || '' };
    if (sourceKey === 'locations')
        return { id: item.id, type: 'location', typeLabel: 'Location', name: item.name || 'Unnamed', snippet: item.region || '' };
    if (sourceKey === 'timeline')
        return { id: item.id, type: 'timeline', typeLabel: 'Timeline Event', name: item.what || 'Untitled event', snippet: item.when || '' };
    if (sourceKey === 'glossary')
        return { id: item.id, type: 'glossary', typeLabel: 'Glossary Term', name: item.term || 'Unnamed', snippet: truncate(item.definition || '', 60) };
    return { id: item.id, type: 'world', category: item.category, typeLabel: worldCategoryMeta(item.category).label, name: item.topic || 'Unnamed', snippet: truncate(item.detail || '', 60), crestUrl: item.category === 'houses' ? (item.crestUrl || '') : '' };
}


// Returns the normalized, searchable entry list for one World Bible sidebar category. Native
// world categories (houses, organizations, ...) aren't included — those still use the full
// CardList editor, filtered separately.
export function worldBibleEntries(project, key) {
    if (key === 'characters')
        return project.characters.map((c) => normalizeWorldBibleEntry('characters', c));
    if (key === 'locations')
        return project.locations.map((l) => normalizeWorldBibleEntry('locations', l));
    if (key === 'timeline')
        return project.timeline.map((t) => normalizeWorldBibleEntry('timeline', t));
    if (key === 'glossary')
        return project.glossary.map((g) => normalizeWorldBibleEntry('glossary', g));
    if (key === 'familyTrees')
        return project.world.filter((w) => w.category === 'houses').map((w) => normalizeWorldBibleEntry('world', w));
    if (key === 'all') {
        return [
            ...project.characters.map((c) => normalizeWorldBibleEntry('characters', c)),
            ...project.locations.map((l) => normalizeWorldBibleEntry('locations', l)),
            ...project.timeline.map((t) => normalizeWorldBibleEntry('timeline', t)),
            ...project.glossary.map((g) => normalizeWorldBibleEntry('glossary', g)),
            ...project.world.map((w) => normalizeWorldBibleEntry('world', w)),
        ];
    }
    return project.world.filter((w) => w.category === key).map((w) => normalizeWorldBibleEntry('world', w));
}


export function worldBibleCount(project, key) {
    return worldBibleEntries(project, key).length;
}


export function matchesWorldBibleSearch(entry, query) {
    const q = query.trim().toLowerCase();
    if (!q)
        return true;
    return entry.name.toLowerCase().includes(q) || (entry.snippet || '').toLowerCase().includes(q);
}


// Turns one Worldbuilding Pack, live against its source project's current data, into the small
// summary that gets mirrored onto that project's Home-screen index entry (see useMetaReport and
// InkRoot's setPackPublishStatus). This is what lets the Grand Library show a pack's contents —
// and unpublish one — without loading the full project, the same way a book's blurb/genre/price
// already live at the index level rather than inside the project file.
export function packSummaryForIndex(project, pack) {
    const categories = PACK_CATEGORY_KEYS.map((key) => {
        const ids = (pack.selection && pack.selection[key]) || [];
        const entries = worldBibleEntries(project, key).filter((e) => ids.includes(e.id));
        const meta = WORLD_BIBLE_CATEGORIES.find((c) => c.key === key);
        return { key, icon: meta ? meta.icon : '', label: meta ? meta.label : key, entries: entries.map((e) => ({ name: e.name, snippet: e.snippet })) };
    }).filter((c) => c.entries.length > 0);
    return {
        id: pack.id, title: pack.title, subtitle: pack.subtitle || '', description: pack.description || '',
        coverImageUrl: pack.coverImageUrl || '', price: typeof pack.price === 'number' ? pack.price : 0,
        genre: pack.genre || 'Unspecified', tags: pack.tags || [],
        publishStatus: pack.publishStatus || 'none', publishedAt: pack.publishedAt || null, updatedAt: pack.updatedAt || Date.now(),
        categories, totalEntries: categories.reduce((s, c) => s + c.entries.length, 0),
    };
}


export const MENTION_TYPE_LABELS = { character: 'Character', location: 'Location', world: 'World Bible entry', glossary: 'Glossary term', timeline: 'Timeline event' };


export const CHARACTER_ROLES = [
    { key: 'protagonist', label: 'Protagonists' },
    { key: 'supporting', label: 'Supporting' },
    { key: 'villain', label: 'Villains' },
];


export const LOCATION_TYPES = ['Capital', 'City', 'Town', 'Village', 'Kingdom', 'Continent', 'Region', 'Castle', 'Fortress', 'Mine', 'Forest', 'Harbor', 'Ruin', 'Landmark'];


export const LOCATION_STATUSES = ['Prospering', 'Stable', 'Declining', 'At War', 'Under Siege', 'Destroyed', 'Abandoned'];


export const ORG_TYPES = ['Guild', 'Cult', 'Military Order', 'Political Faction', 'Trade Company', 'Secret Society', 'Religious Order', 'Criminal Syndicate'];


export const ORG_STATUSES = ['Active', 'Disbanded', 'Outlawed', 'Dormant'];


export const ARTIFACT_STATUSES = ['Found', 'Lost', 'Destroyed', 'Hidden', 'Sealed'];


// ---------- Generated book covers (Home screen + Settings) ----------
// A cover's color comes from one of these hues, applied differently depending on the chosen
// material (COVER_STYLES below) — e.g. "crimson" reads as a wine-dark dyed leather, a burgundy
// cloth binding, or a deep rose-red painted sky, all from the same three hex stops.
export const COVER_ACCENTS = {
    gold: { light: '#C89B3C', mid: '#8a6a2e', deep: '#3d2f14' },
    crimson: { light: '#c96b6b', mid: '#7a2e2e', deep: '#2c1414' },
    forest: { light: '#7fa98a', mid: '#2e4a3a', deep: '#141f19' },
    navy: { light: '#7c93b8', mid: '#25344c', deep: '#10161f' },
    plum: { light: '#a97cc6', mid: '#4a2e5c', deep: '#1c1220' },
    charcoal: { light: '#9a9aa2', mid: '#3a3a42', deep: '#161619' },
};


export const COVER_ACCENT_ORDER = ['gold', 'crimson', 'forest', 'navy', 'plum', 'charcoal'];


// Each style returns everything BookCover needs to render one material: the surface background,
// a foil/ink border color, an inner hairline color, and text colors legible on that surface.
// subtitle/author used to ride at 56-80% alpha of the accent's `light`/`deep` tone blended
// straight over the cover background — measured against the actual background colors above
// (worst case per style: leather/painted's near-black bottom stop, cloth's own `a.deep` stop
// with no near-black floor beneath it, parchment's light tan base), several of those combos
// landed as low as ~2.6:1 contrast, well under WCAG AA's 4.5:1 for text this size. Dropping the
// alpha channel entirely — full-strength `a.light`/`a.deep` rather than a translucent tint of
// it — checks out at ~4.4:1 or better across every accent (gold/crimson/forest/navy/plum/
// charcoal) and every style, without changing the hue those fields already used; title keeps
// its own separate cream/ink color so the hierarchy (title brightest, subtitle/author in the
// accent color) still reads, just legibly now.
export const COVER_STYLES = {
    leather: (a) => ({
        label: 'Dark Leather',
        background: `radial-gradient(120% 90% at 50% -8%, ${a.light}26 0%, transparent 55%), linear-gradient(160deg, ${a.mid} 0%, ${a.deep} 78%, #100c08 100%)`,
        border: `${a.light}80`,
        hairline: `${a.light}4d`,
        title: '#F3E9CE', subtitle: a.light, author: a.light, motif: `${a.light}59`,
    }),
    cloth: (a) => ({
        label: 'Woven Cloth',
        background: `repeating-linear-gradient(115deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 3px), linear-gradient(170deg, ${a.mid} 0%, ${a.deep} 100%)`,
        border: `${a.light}70`,
        hairline: `${a.light}3d`,
        title: '#F0EAD8', subtitle: a.light, author: a.light, motif: `${a.light}4d`,
    }),
    parchment: (a) => ({
        label: 'Parchment',
        background: `radial-gradient(70% 60% at 25% 20%, rgba(255,255,255,0.25) 0%, transparent 60%), radial-gradient(80% 70% at 80% 90%, ${a.mid}22 0%, transparent 60%), linear-gradient(160deg, #EFE3C4 0%, #E1CE9F 55%, #CBB07E 100%)`,
        border: `${a.deep}80`,
        hairline: `${a.deep}4d`,
        title: '#3B2A18', subtitle: a.deep, author: a.deep, motif: `${a.deep}66`,
    }),
    painted: (a) => ({
        label: 'Painted',
        background: `radial-gradient(110% 70% at 30% 15%, ${a.light}3d 0%, transparent 55%), linear-gradient(200deg, ${a.mid} 0%, ${a.deep} 85%, #0c0a10 100%)`,
        border: `${a.light}77`,
        hairline: `${a.light}45`,
        title: '#F5EEDD', subtitle: a.light, author: a.light, motif: `${a.light}52`,
    }),
};


export const COVER_STYLE_ORDER = ['leather', 'cloth', 'parchment', 'painted'];


// Minimal fantasy-inspired line-art, drawn stroke-only in currentColor so it inherits each
// cover's motif color at low opacity — meant to sit quietly behind the title, not compete with it.
export const COVER_MOTIFS = {
    none: null,
    compass: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("circle", { cx: 50, cy: 50, r: 30 }),
        React.createElement("circle", { cx: 50, cy: 50, r: 2.2, fill: "currentColor", stroke: "none" }),
        React.createElement("path", { d: "M50 14 L55 46 L50 50 L45 46 Z" }),
        React.createElement("path", { d: "M50 86 L55 54 L50 50 L45 54 Z" }),
        React.createElement("path", { d: "M14 50 L46 45 L50 50 L46 55 Z" }),
        React.createElement("path", { d: "M86 50 L54 45 L50 50 L54 55 Z" })),
    moon: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("path", { d: "M58 20a26 26 0 1 0 0 52 32 32 0 0 1 0-52Z" }),
        React.createElement("path", { d: "M30 70c8-2 14-8 16-16" }),
        React.createElement("path", { d: "M34 62c4 2 9 2 13-1" }),
        React.createElement("path", { d: "M40 74c3 1 7 1 10-1" })),
    mountains: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("circle", { cx: 70, cy: 26, r: 9 }),
        React.createElement("path", { d: "M12 68 L34 40 L48 56 L62 34 L88 68 Z" }),
        React.createElement("path", { d: "M12 68 L88 68", strokeWidth: 0.9 })),
    laurel: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("path", { d: "M50 18c-18 8-26 24-22 46" }),
        React.createElement("path", { d: "M50 18c18 8 26 24 22 46" }),
        ...[0, 1, 2, 3, 4].map((i) => React.createElement("path", { key: 'l' + i, d: `M${34 - i * 2} ${30 + i * 8}c-6 1-10 4-12 8` })),
        ...[0, 1, 2, 3, 4].map((i) => React.createElement("path", { key: 'r' + i, d: `M${66 + i * 2} ${30 + i * 8}c6 1 10 4 12 8` }))),
    orbit: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("circle", { cx: 50, cy: 50, r: 11 }),
        React.createElement("ellipse", { cx: 50, cy: 50, rx: 38, ry: 13, transform: "rotate(-18 50 50)" }),
        React.createElement("ellipse", { cx: 50, cy: 50, rx: 38, ry: 13, transform: "rotate(18 50 50)", strokeOpacity: 0.6 }),
        React.createElement("circle", { cx: 82, cy: 42, r: 1.6, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 22, cy: 60, r: 1.2, fill: "currentColor", stroke: "none" })),
    keyhole: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("circle", { cx: 50, cy: 60, r: 34 }),
        React.createElement("circle", { cx: 50, cy: 44, r: 8 }),
        React.createElement("path", { d: "M46 51 L42 70 L58 70 L54 51 Z" })),
    bloom: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("path", { d: "M50 90c0-24 0-40 0-52" }),
        React.createElement("path", { d: "M50 60c-8-4-14-2-18 6" }),
        React.createElement("path", { d: "M50 72c8-3 13-1 17 6" }),
        ...[0, 1, 2, 3, 4].map((i) => {
            const angle = (i / 5) * Math.PI * 2;
            const x = 50 + Math.cos(angle) * 12, y = 30 + Math.sin(angle) * 12;
            return React.createElement("path", { key: 'p' + i, d: `M50 30 Q${x} ${y} 50 30` });
        }),
        React.createElement("circle", { cx: 50, cy: 30, r: 3 })),
    briar: React.createElement("svg", { viewBox: "0 0 100 100", fill: "none", stroke: "currentColor", strokeWidth: 1.1 },
        React.createElement("path", { d: "M20 85C35 65 30 45 45 30S75 15 82 15" }),
        ...[[28, 70], [38, 52], [50, 40], [62, 27], [72, 19]].map(([x, y], i) => React.createElement("path", { key: 't' + i, d: `M${x} ${y}l-7 -5M${x} ${y}l7 -3` }))),
};


// A curated starting point per genre — one tap sets material + accent + ornament together, and
// the granular pickers below stay fully editable afterward for anyone who wants to fine-tune.
export const COVER_THEMES = {
    fantasy: { label: 'Fantasy', style: 'leather', accent: 'gold', motif: 'compass' },
    medieval: { label: 'Medieval', style: 'cloth', accent: 'crimson', motif: 'laurel' },
    darkFantasy: { label: 'Dark Fantasy', style: 'painted', accent: 'charcoal', motif: 'moon' },
    historical: { label: 'Historical', style: 'parchment', accent: 'gold', motif: 'laurel' },
    sciFi: { label: 'Sci-Fi', style: 'painted', accent: 'navy', motif: 'orbit' },
    mystery: { label: 'Mystery', style: 'leather', accent: 'charcoal', motif: 'keyhole' },
    romance: { label: 'Romance', style: 'cloth', accent: 'plum', motif: 'bloom' },
    horror: { label: 'Horror', style: 'painted', accent: 'charcoal', motif: 'briar' },
    minimal: { label: 'Minimal', style: 'parchment', accent: 'charcoal', motif: 'none' },
};


export const COVER_THEME_ORDER = ['fantasy', 'medieval', 'darkFantasy', 'historical', 'sciFi', 'mystery', 'romance', 'horror', 'minimal'];


// Per-size typography/layout for BookCover — 'sm' for shelf thumbnails, 'md' for the Home
// screen's featured card, 'lg' for the live preview in Settings, 'xl' for the dedicated cover
// page a reader lands on before a book's first chapter (PublishedBookReader) — big enough to
// read as an actual front cover, not another thumbnail.
export const COVER_SIZES = {
    xs: { width: 56, radius: 4, pad: 6, title: 8, subtitle: 6, series: 5, author: 5.5, motif: 22 },
    sm: { width: 94, radius: 5, pad: 10, title: 11.5, subtitle: 8.5, series: 7, author: 7.5, motif: 40 },
    md: { width: 172, radius: 9, pad: 18, title: 20, subtitle: 13.5, series: 11, author: 11.5, motif: 74 },
    lg: { width: 200, radius: 9, pad: 20, title: 22, subtitle: 14, series: 10.5, author: 11.5, motif: 84 },
    xl: { width: 'min(340px, 78vw)', radius: 14, pad: 30, title: 27, subtitle: 16, series: 12, author: 13, motif: 120 },
};


// ---------- 3D book shell ----------
// Every gallery/bookshelf cover in the app renders through BookCover, so giving it real
// dimensionality here — thickness, a spine, layered off-white page edges, a soft grounding
// shadow, a gentle idle tilt, and a fuller hover lift/rotate (see the .ink-book3d* rules in
// app.css) — reaches every shelf/gallery that uses this component without touching their code.
// The cover art itself (customImageUrl or the generated palette render below) is passed in
// completely unchanged as `frontFaceEl` and just pushed forward as the front face of a small
// rotating volume; the spine/pages are separate flat layers set back in depth, which reads as
// convincingly 3D at these subtle tilt angles without the cost/fragility of true perpendicular
// cube faces. Depth scales with the cover's own size so a shelf thumbnail and the big reader
// cover both look proportionate.
function coverDepthPx(dims, depthScale) {
    const w = typeof dims.width === 'number' ? dims.width : 200;
    // Ratio/floor raised from 0.085/3 — the old numbers made the spine and page-block read as
    // thin regardless of tilt (see reservePx below for the other half of that fix: this only
    // controls how thick a book LOOKS, not how much room the shelf gives it to look that thick
    // without touching its neighbor).
    return Math.max(4, Math.round(w * 0.11 * (depthScale || 1)));
}


// How much extra, empty horizontal space (split evenly left/right) a shelf-packed book's own
// layout footprint needs beyond its front-cover width, so the page-edge/spine layers below —
// which intentionally extend a little past the front cover to sell real thickness — land inside
// THIS book's own space on the shelf instead of spilling into the gap reserved for its neighbor.
// Every one of those layers is a `position: absolute` child sized/offset purely in px derived
// from `depth`, so it never enlarges the flex item's own box on its own — a shelf's flex `gap`
// was the only thing standing between "looks 3D" and "overlaps the next book", and a `gap` sized
// for a flat rectangle was never going to be enough once depth/tilt/scale varied per book. Sized
// generously (16% of the cover's own width) so it comfortably covers depth's own protrusion, the
// small horizontal shift from the idle rotateY tilt, and the extra couple of percent a caller's
// own per-book scale() (Home, the Browse & Search bookcase) can add on top — all three stack on
// a shelf, none of them affect layout width on their own.
function coverReservePx(w) {
    return Math.round(w * 0.16);
}


// Tiny deterministic string hash, local to this file on purpose (avoids importing across the
// library/worldbuilding boundary just for this) — used only to give a book a stable, natural
// default lean/tilt when its caller doesn't already supply one (see defaultPhysicalVariation
// below), so the same book always tips the same subtle way rather than reshuffling on re-render.
function coverHashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}


// A handful of screens (LibraryBookcase's Browse & Search case) already hand each book its own
// depthScale/tiltDeg/leanDeg so a shelf of them reads as individually different physical volumes
// (see bookPhysicalVariation in grand-library-cards.jsx). Everywhere else — Home's own shelf, the
// Guild Anthology shelf, Author Studio, the cover picker — has always rendered every book at the
// exact same idle angle, which is the one place a row of "real" books still reads as identical
// stamped copies. Rather than teach every one of those call sites its own variation math, give
// BookCover a quiet built-in default: whenever a caller doesn't pass an explicit tiltDeg/leanDeg,
// derive a small one from the book's own title/author instead of falling back to one fixed angle
// for everyone. Kept deliberately narrower than LibraryBookcase's own range so it reads as
// gentle shelf-wear, not a redesign of how any book looks; a caller that already sets these
// props (checked with `!== undefined`, not truthiness, so an intentional 0 still wins) is
// completely unaffected.
function defaultPhysicalVariation(title, author, seriesName) {
    const seed = coverHashSeed(`${title || ''}\u0001${author || ''}\u0001${seriesName || ''}`);
    return {
        tiltDeg: -5.5 - ((seed % 7) / 6) * 3, // ~-5.5 to -8.5deg, vs. the old fixed -7deg for everyone
        leanDeg: (((seed >> 6) % 9) - 4) * 0.4, // ~-1.6 to 1.6deg — most nearly upright, a few leaning either way
        depthScale: 0.88 + (((seed >> 10) % 9) / 8) * 0.28, // ~0.88–1.16 — a slightly thinner or thicker spine
    };
}


// `variation` is optional and only ever passed by a shelf that wants each book to read as a
// distinct physical object (see LibraryBookcase's per-book variation in grand-library-cards.jsx):
// depthScale thickens/thins the spine and page block independently of the cover's own size,
// tiltDeg overrides the shared idle rotateY angle (via the --book-tilt custom property, so the
// existing hover behavior in app.css still applies relative to whatever tilt a book starts at),
// and leanDeg tips the whole book a couple of degrees off-vertical like it's resting slightly
// against its neighbor. Every one of these defaults to a gentle book-specific variation (see
// defaultPhysicalVariation) rather than one fixed look, so every screen that renders a BookCover
// gets at least a little of that same "real object" unevenness for free.
function book3DShell(dims, frontFaceEl, variation, extra) {
    const { depthScale, tiltDeg, leanDeg } = variation || {};
    const { size } = extra || {};
    const w = typeof dims.width === 'number' ? dims.width : 200;
    const depth = coverDepthPx(dims, depthScale);
    // Pages sit recessed just inside the cover's head/tail (real hardcovers are cut a hair
    // larger than the page block), and only peek a couple of px past the fore-edge/tail — a
    // hint of a bound page stack, not a slab spilling out from behind the cover. pageProtrude
    // and pageZ were previously large enough (up to half the book's own depth, pushed straight
    // back by the full depth) that at a tilt the page block visibly separated from the cover
    // into its own floating/torn-looking shape; both are kept small and close to the cover's own
    // z-position now so the two stay visually locked together at every tilt/hover angle.
    const insetY = Math.max(1, Math.round(depth * 0.22));
    const pageProtrude = Math.max(1, Math.round(depth * 0.14));
    const pageW = Math.max(2, Math.round(depth * 0.4));
    const pageH = Math.max(2, Math.round(depth * 0.34));
    const pageZ = Math.round(depth * 0.55);
    const book = React.createElement("div", {
        className: 'ink-book3d',
        style: {
            width: dims.width, aspectRatio: '2 / 3', position: 'relative', flexShrink: 0, perspective: `${Math.round(w * 8)}px`,
            transform: leanDeg ? `rotate(${leanDeg}deg)` : undefined, transformOrigin: leanDeg ? 'bottom center' : undefined,
        },
    },
        // Layered grounding shadow: a wide, very soft ambient pool (existing .ink-book3d-shadow,
        // still the one that widens/softens on hover) plus a tighter, darker contact/AO shadow
        // hugging the book's actual base — the two together read as a book casting real shadow
        // into the space around it rather than one flat blob of darkness under every cover.
        React.createElement("div", { className: 'ink-book3d-shadow' }),
        React.createElement("div", { className: 'ink-book3d-contact' }),
        React.createElement("div", {
            className: 'ink-book3d-vol',
            style: { position: 'absolute', inset: 0, ...(tiltDeg !== undefined ? { '--book-tilt': `${tiltDeg}deg` } : {}) },
        },
            // spine — a shaded strip along the hinge edge, set back in depth; the highlight stop
            // is warmed slightly (was pure white) so it reads as catching the same warm light as
            // the page edges and sheen, rather than a cooler, separately-lit strip.
            React.createElement("div", { style: {
                    position: 'absolute', left: 0, top: 2, bottom: 2, width: Math.max(6, Math.round(w * 0.1)),
                    borderRadius: `${dims.radius}px 0 0 ${dims.radius}px`,
                    background: 'linear-gradient(90deg, rgba(0,0,0,0.62), rgba(0,0,0,0.22) 60%, rgba(255,235,200,0.07))',
                    transform: `translateZ(-${depth}px)`,
                } }),
            // page edges — a thin, tightly-bound strip of layered paper just past the fore-edge,
            // with a faint warm highlight along its top-facing edge (as if a single light from
            // above-left is catching the top sheet of paper) so the stack doesn't read as flat
            // cream fill.
            React.createElement("div", { style: {
                    position: 'absolute', top: insetY, bottom: insetY, right: -pageProtrude, width: pageW,
                    background: 'repeating-linear-gradient(180deg, #f4eeda 0px, #f4eeda 2px, #e7ddc4 2px, #e7ddc4 3px)',
                    borderRadius: '0 2px 2px 0',
                    boxShadow: 'inset -1px 0 1px rgba(0,0,0,0.18), inset 0 1px 0 rgba(255,248,225,0.55), 1px 0 3px rgba(0,0,0,0.25)',
                    transform: `translateZ(-${pageZ}px)`,
                } }),
            // ...and from the bottom, same quiet top-left light catching its near edge
            React.createElement("div", { style: {
                    position: 'absolute', left: insetY, right: pageW + insetY, bottom: -pageProtrude, height: pageH,
                    background: 'repeating-linear-gradient(90deg, #f4eeda 0px, #f4eeda 2px, #e7ddc4 2px, #e7ddc4 3px)',
                    borderRadius: '0 0 2px 2px',
                    boxShadow: 'inset 0 -1px 1px rgba(0,0,0,0.18), inset 1px 0 0 rgba(255,248,225,0.4), 0 1px 3px rgba(0,0,0,0.25)',
                    transform: `translateZ(-${pageZ}px)`,
                } }),
            // the actual, unmodified cover art/render — pushed to the front of the volume, with a
            // faint self-shadow along its hinge edge where it sits closest to the spine (a real
            // cover darkens slightly right at that fold rather than staying uniformly lit).
            React.createElement("div", { style: {
                    position: 'relative', transform: `translateZ(${depth}px)`,
                    boxShadow: `inset ${Math.max(3, Math.round(w * 0.05))}px 0 ${Math.max(6, Math.round(w * 0.07))}px -${Math.max(3, Math.round(w * 0.045))}px rgba(0,0,0,0.35)`,
                    borderRadius: dims.radius,
                } }, frontFaceEl),
            // a warm directional lighting sheen across the front face — one soft light from the
            // upper-left, with a faint complementary darkening in the opposite corner so the
            // highlight reads as coming from somewhere rather than an even overall glow.
            React.createElement("div", { className: 'ink-book3d-sheen', style: { borderRadius: dims.radius, transform: `translateZ(${depth + 1}px)` } })));
    // Only the sizes actually used packed into a horizontal row of other books (the shelf
    // carousels, the Browse & Search bookcase's compartments) get the extra reserved space —
    // 'xs' (Cart rows) and 'sm' (every shelf). 'md'/'lg'/'xl' are always shown solo (the Home
    // hero card, Settings' live preview, the full reader cover) where nothing sits close enough
    // on either side for the overflow to reach, and those solo layouts already choreograph
    // sibling decoration (e.g. Home's hero page-layers/ribbon) against this shell's exact
    // current footprint — leaving them untouched avoids any risk of shifting that alignment.
    if (size !== 'sm' && size !== 'xs')
        return book;
    const reserve = coverReservePx(w);
    return React.createElement("div", { style: { width: w + reserve, display: 'flex', justifyContent: 'center', flexShrink: 0 } }, book);
}


// ---------- Full physical-object book shell (Home's Recent Activity shelf only) ----------
// book3DShell above is a flat-plane illusion: the spine and page edges are just offset,
// gradient-filled strips that read as "3D-ish" at a glance but are still fundamentally a card
// with decoration. This builds an actual six-sided-minus-two box in real CSS 3D space — true
// front/back cover faces and a true spine face (all rotated to their correct perpendicular
// orientation via rotateY, not just shifted in Z), plus true page-block faces on the fore-edge
// and top of the book — so the object reads as a real hardcover from the angles this shelf
// actually shows it at, and the illusion holds up instead of breaking down at a glance. Every
// face is centered on the volume's own origin using the standard CSS cube-face recipe (rotate,
// then translateZ by half of whichever dimension that rotation now points along), so the box's
// real thickness (from depthScale, varying per book — see the Recent Activity map in
// home-screen.jsx) directly controls how far apart the covers sit and how wide the spine/page
// faces are, instead of only nudging a flat gradient a few pixels. A small constant backward
// pitch (.ink-book3d-pitch, new/scoped — not touching .ink-book3d-vol's own hover-driven yaw) is
// the "slight perspective": without any tilt on that second axis the top page-edge face would be
// viewed perfectly edge-on and invisible. Reuses the exact same outer shadow/contact-shadow
// layers and the same .ink-book3d/.ink-book3d-vol hover-lift as book3DShell, so this still looks
// and behaves like a member of the same family of covers, just built as a real object instead of
// a decorated rectangle. `backPalette`, when the caller has one (the generated-cover branch of
// BookCover), tints the back cover the same binding material as the front instead of a generic
// neutral back board.
function book3DShellFull(dims, frontFaceEl, variation, extra) {
    const { depthScale, tiltDeg, leanDeg } = variation || {};
    const { backPalette } = extra || {};
    const w = typeof dims.width === 'number' ? dims.width : 200;
    const h = w * 1.5; // matches the 2:3 aspect-ratio every cover already renders at
    // Depth boost, physical shell only: at the shallow yaw angles used for a natural-looking
    // idle lean (see tiltDeg below / home-screen.jsx's Recent Activity map), a true rotated
    // page-block face is foreshortened by roughly sin(tiltDeg) — the same physical depth that
    // reads fine on the flat-plane approximation (book3DShell, which just offsets a gradient
    // layer with no real perspective) becomes an almost invisible sliver once it's an actual
    // rotated CSS face. Verified by rendering this exact component standalone at production
    // size/tilt: without this boost the page-block and top-edge faces were present in the DOM
    // but not visibly readable on screen. 1.5x brings them back to a clearly legible thickness
    // without making the book read as unrealistically thick.
    const depth = coverDepthPx(dims, depthScale) * 1.5;
    const halfW = w / 2, halfH = h / 2, halfD = depth / 2;
    const pageInsetY = Math.max(2, Math.round(h * 0.018)); // page block a hair shorter than the covers, top/bottom
    // Faces that are exactly the same footprint as the volume itself (front, back, sheen) just
    // fill it via inset:0 — no X/Y offset needed, only the Z-axis transform below moves them.
    // Faces smaller than the volume (spine, page edges) need actual centering, done via the
    // left/top 50% + negative-margin trick in faceCenter further down, since inset:0 wouldn't
    // shrink them to their own width/height.
    const faceFull = { position: 'absolute', inset: 0 };
    const faceCenter = { position: 'absolute', left: '50%', top: '50%' };
    const pageEdgeVert = 'repeating-linear-gradient(180deg, #f4eeda 0px, #f4eeda 2px, #e7ddc4 2px, #e7ddc4 3px)';
    const pageEdgeHoriz = 'repeating-linear-gradient(90deg, #f4eeda 0px, #f4eeda 2px, #e7ddc4 2px, #e7ddc4 3px)';

    const backFace = React.createElement("div", { style: {
            ...faceFull, borderRadius: dims.radius,
            background: backPalette ? backPalette.background : 'linear-gradient(160deg, #2c2519 0%, #1a150f 100%)',
            border: `1px solid ${backPalette ? backPalette.border : 'rgba(0,0,0,0.4)'}`,
            boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.2), inset 0 12px 22px -14px rgba(255,255,255,0.05)',
            transform: `rotateY(180deg) translateZ(${halfD}px)`,
        } });
    const spineFace = React.createElement("div", { style: {
            ...faceCenter, width: depth, height: h, marginLeft: -halfD, marginTop: -halfH,
            background: 'linear-gradient(90deg, rgba(255,235,200,0.1), rgba(0,0,0,0.18) 45%, rgba(0,0,0,0.55) 100%), #221b13',
            boxShadow: 'inset 0 0 5px rgba(0,0,0,0.45)',
            transform: `rotateY(-90deg) translateZ(${halfW}px)`,
        } });
    const rightPageFace = React.createElement("div", { style: {
            ...faceCenter, width: depth, height: h - pageInsetY * 2, marginLeft: -halfD, marginTop: -(h - pageInsetY * 2) / 2,
            background: pageEdgeVert,
            boxShadow: 'inset 2px 0 3px rgba(0,0,0,0.28), inset -1px 0 0 rgba(255,255,255,0.18)',
            transform: `rotateY(90deg) translateZ(${halfW}px)`,
        } });
    const topPageFace = React.createElement("div", { style: {
            ...faceCenter, width: w - pageInsetY * 2, height: depth, marginLeft: -(w - pageInsetY * 2) / 2, marginTop: -halfD,
            background: pageEdgeHoriz,
            boxShadow: 'inset 0 2px 3px rgba(0,0,0,0.28), inset 0 -1px 0 rgba(255,255,255,0.18)',
            transform: `rotateX(90deg) translateZ(${halfH}px)`,
        } });
    // Hinge/spine crease along the front cover's left edge — a thin dark line plus a soft
    // falloff, so the cover reads as bound into a spine even from angles where the true rotated
    // spineFace itself has rotated out of view. This matters because a single yaw rotation can
    // only ever bring one of spineFace/rightPageFace into view at a time (basic box geometry —
    // rotating a rectangular volume around one axis always turns one side face away as it turns
    // the other toward the camera), and this shelf always yaws the same direction to show the
    // page block. Without this crease, verified in an isolated render, a book at production tilt
    // has no spine cue at all; with it, the spine reads clearly regardless of which way that
    // book happens to be tilted.
    const frontFace = React.createElement("div", { style: {
            ...faceFull, borderRadius: dims.radius, overflow: 'hidden',
            boxShadow: [
                `inset ${Math.max(2, Math.round(w * 0.022))}px 0 0 rgba(0,0,0,0.5)`,
                `inset ${Math.max(5, Math.round(w * 0.07))}px 0 ${Math.max(8, Math.round(w * 0.09))}px -${Math.max(3, Math.round(w * 0.045))}px rgba(0,0,0,0.4)`,
            ].join(', '),
            transform: `translateZ(${halfD}px)`,
        } }, frontFaceEl);
    const sheen = React.createElement("div", {
        className: 'ink-book3d-sheen', style: {
            borderRadius: dims.radius, transform: `translateZ(${halfD + 1}px)`,
        },
    });

    const book = React.createElement("div", {
        className: 'ink-book3d ink-book3d-full',
        style: {
            width: dims.width, aspectRatio: '2 / 3', position: 'relative', flexShrink: 0, perspective: `${Math.round(w * 8)}px`,
            transform: leanDeg ? `rotate(${leanDeg}deg)` : undefined, transformOrigin: leanDeg ? 'bottom center' : undefined,
        },
    },
        React.createElement("div", { className: 'ink-book3d-shadow' }),
        React.createElement("div", { className: 'ink-book3d-contact' }),
        React.createElement("div", { className: 'ink-book3d-pitch' },
            React.createElement("div", {
                className: 'ink-book3d-vol',
                style: { position: 'absolute', inset: 0, ...(tiltDeg !== undefined ? { '--book-tilt': `${tiltDeg}deg` } : {}) },
            }, backFace, spineFace, rightPageFace, topPageFace, frontFace, sheen)));
    // book3DShellFull has exactly one caller today (Home's Recent Activity shelf, via
    // BookCover's `physical: true`) and that caller always packs several of these into one
    // horizontal row — so, unlike book3DShell above, this one always reserves the extra space
    // rather than checking `size` first. These are true rotated 3D faces (not flat offset
    // layers), so their on-screen footprint at this shelf's tilt/lean range is exactly the kind
    // of neighbor-encroaching overflow reservePx exists to contain.
    const reserve = coverReservePx(w);
    return React.createElement("div", { style: { width: w + reserve, display: 'flex', justifyContent: 'center', flexShrink: 0 } }, book);
}


export function BookCover({ title, subtitle, seriesName, author, cover, size, depthScale, tiltDeg, leanDeg, physical }) {
    const dims = COVER_SIZES[size] || COVER_SIZES.sm;
    // Resolved, not the raw prop — a caller that omits `size` already gets `dims`'s 'sm' sizing
    // via the fallback above, so it needs to be treated as 'sm' here too (for the shelf-overflow
    // reserve below), not as "no size, skip the reserve".
    const resolvedSize = COVER_SIZES[size] ? size : 'sm';
    // Fill in any of the three a caller didn't specify with this book's own gentle default (see
    // defaultPhysicalVariation) instead of one fixed look shared by every book — checked against
    // undefined specifically so an intentional 0 from a caller (dead level, no lean) still wins.
    const defaults = defaultPhysicalVariation(title, author, seriesName);
    const variation = {
        depthScale: depthScale !== undefined ? depthScale : defaults.depthScale,
        tiltDeg: tiltDeg !== undefined ? tiltDeg : defaults.tiltDeg,
        leanDeg: leanDeg !== undefined ? leanDeg : defaults.leanDeg,
    };
    // `physical` opts a caller into the fuller hardcover-object shell (real front/back cover
    // faces, a true spine face, and page-block faces with actual depth — see book3DShellFull)
    // instead of the default flat-plane approximation below. Defaults to false/undefined so
    // every existing caller (Grand Library, Guild Hall, Author's Hall, the cover picker, every
    // publishing preview...) renders exactly as before; only Home's Recent Activity shelf passes
    // `physical: true` (see home-screen.jsx), so this never touches any other screen.
    const shell = physical ? book3DShellFull : book3DShell;
    if (cover && cover.customImageUrl) {
        return shell(dims, React.createElement("div", {
            style: {
                width: dims.width, aspectRatio: '2 / 3', borderRadius: dims.radius, position: 'relative',
                boxShadow: '0 6px 16px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.15)',
                overflow: 'hidden', flexShrink: 0, backgroundImage: `url(${cover.customImageUrl})`,
                backgroundSize: 'cover', backgroundPosition: 'center',
            }
        }), variation, { size: resolvedSize });
    }
    const styleKey = (cover && COVER_STYLES[cover.style]) ? cover.style : 'leather';
    const accentKey = (cover && COVER_ACCENTS[cover.accent]) ? cover.accent : 'gold';
    const motifKey = cover && Object.prototype.hasOwnProperty.call(COVER_MOTIFS, cover.motif) ? cover.motif : 'compass';
    const palette = COVER_STYLES[styleKey](COVER_ACCENTS[accentKey]);
    const motifEl = COVER_MOTIFS[motifKey];
    const displayTitle = (title && title.trim()) ? title : 'Untitled Novel';
    return shell(dims, React.createElement("div", {
        style: {
            width: dims.width, aspectRatio: '2 / 3', borderRadius: dims.radius, position: 'relative',
            background: palette.background, border: `1px solid ${palette.border}`,
            boxShadow: '0 6px 16px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(0,0,0,0.15), 0 0 0 1px rgba(232,196,104,0.06)',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between', overflow: 'hidden',
            padding: dims.pad, flexShrink: 0,
        }
    },
        React.createElement("div", { style: {
                position: 'absolute', inset: 4, border: '1px solid rgba(232,196,104,0.5)', borderRadius: Math.max(dims.radius - 2, 2), pointerEvents: 'none',
                boxShadow: 'inset 0 0 0 1px rgba(232,196,104,0.12)',
            } }),
        React.createElement("div", { style: {
                position: 'absolute', inset: 8, border: `1px solid ${palette.hairline}`, borderRadius: Math.max(dims.radius - 3, 2), pointerEvents: 'none',
            } }),
        motifEl && React.createElement("div", { style: {
                position: 'absolute', left: '50%', top: '50%', width: dims.motif, height: dims.motif,
                transform: 'translate(-50%, -50%)', color: palette.motif, pointerEvents: 'none',
            } }, motifEl),
        React.createElement("div", { style: { position: 'relative', zIndex: 1, textAlign: 'center' } },
            seriesName && seriesName.trim() && React.createElement("div", { style: {
                    fontSize: dims.series, letterSpacing: '0.14em', textTransform: 'uppercase', color: palette.subtitle,
                    marginBottom: 6, fontFamily: "'Inter', sans-serif",
                } }, seriesName.trim())),
        React.createElement("div", { style: { position: 'relative', zIndex: 1, textAlign: 'center' } },
            React.createElement("div", { style: {
                    fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: dims.title, lineHeight: 1.15,
                    color: palette.title, textShadow: '0 1px 3px rgba(0,0,0,0.35)',
                } }, displayTitle),
            subtitle && subtitle.trim() && React.createElement("div", { style: {
                    fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: dims.subtitle, marginTop: 6,
                    color: palette.subtitle, lineHeight: 1.3,
                } }, subtitle.trim())),
        React.createElement("div", { style: {
                position: 'relative', zIndex: 1, textAlign: 'center', fontSize: dims.author, letterSpacing: '0.1em',
                textTransform: 'uppercase', color: palette.author, fontFamily: "'Inter', sans-serif",
            } }, (author && author.trim()) ? author.trim() : ' ')), variation, { size: resolvedSize, backPalette: palette });
}
