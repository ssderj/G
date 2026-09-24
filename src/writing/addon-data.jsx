import { uuid } from '../shared-utils/storage-keys.jsx';


// ---------- Addon Studio: data layer ----------
// Split out from addon-studio.jsx (which holds the AddonStudioPanel UI) on purpose: book-cover.jsx
// and health-checks.jsx both need to read installed-addon data, but neither should have to pull in
// addon-studio.jsx's CardList/React-UI dependencies to do it — and addon-studio.jsx's UI imports
// (via ui-primitives.jsx -> form-fields.jsx -> book-cover.jsx) already loop back around to
// book-cover.jsx, so book-cover.jsx importing addon-studio.jsx directly would be a circular
// import. This file has no UI dependencies at all, so it's safe for book-cover.jsx and
// health-checks.jsx to import from directly. See ADDON_STUDIO_PLAN.md for the fuller design.
//
// An addon is a declarative manifest, not code: name/icon/description/category/version/status
// plus a `contains` block describing what it adds to a project — custom World Bible categories
// and Story Health rules today, templates later. Nothing here executes arbitrary logic; every
// field is data that Inkroot's own existing renderers already know how to read.
export const ADDONS_KEY = 'inkroot:addons';


export const ADDON_CATEGORIES = ['Editor Tools', 'World Bible', 'Writing Aids', 'Themes & Covers', 'Import & Export', 'Guild & Community', 'Other'];


export const ADDON_STATUSES = [
    { value: 'draft', label: 'Draft' },
    { value: 'published', label: 'Published' },
];


export const APPLIES_TO_OPTIONS = [
    { value: 'character', label: 'Characters' },
    { value: 'location', label: 'Locations' },
    { value: 'world', label: 'World Bible entries' },
    { value: 'glossary', label: 'Glossary terms' },
    { value: 'timeline', label: 'Timeline events' },
];


export const HEALTH_RULE_TYPES = [
    { value: 'requiredField', label: 'Flag entries missing a field' },
    { value: 'mentionCount', label: 'Flag entries mentioned fewer than N times' },
];


export function readAddons() {
    try {
        const raw = JSON.parse(localStorage.getItem(ADDONS_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    }
    catch (e) {
        return [];
    }
}


export function writeAddons(list) {
    try {
        localStorage.setItem(ADDONS_KEY, JSON.stringify(list));
    }
    catch (e) { }
}


export function emptyAddon() {
    return {
        id: uuid(), name: '', icon: '\uD83E\uDDE9', description: '', category: ADDON_CATEGORIES[0], version: '0.1.0', status: 'draft',
        manifestVersion: 1,
        // Whether this addon has been shared to the Addon Marketplace for other writers to add
        // (migration 86, fix-tracker item 21) — deliberately separate from `status` above, which
        // is only this addon's own draft/finished label and never meant sharing. An addon
        // created before this field existed reads as undefined here, which every check below
        // treats the same as 'unpublished' — no local migration needed.
        marketplaceStatus: 'unpublished', publishedAt: null,
        // What this addon actually contributes once installed. Empty by default — an addon with
        // nothing here is still a valid, describable addon, it just doesn't change anything yet.
        contains: { worldCategories: [], healthRules: [] },
    };
}


// Every addon this specific project has switched on, hydrated from the device-wide addon list.
// project.installedAddons only stores {addonId, installedVersion, enabledAt} — the addon's own
// record (name, contains, ...) always comes from here, so editing an addon after installing it
// is reflected immediately in every project that has it on, same as a Worldbuilding Pack's
// selection stays live against its source entries instead of copying them.
export function installedAddonManifests(project) {
    const installed = (project && project.installedAddons) || [];
    if (!installed.length)
        return [];
    const ids = new Set(installed.map((a) => a.addonId));
    return readAddons().filter((a) => ids.has(a.id));
}


export function isAddonInstalled(project, addonId) {
    return ((project && project.installedAddons) || []).some((a) => a.addonId === addonId);
}


export function slugify(s) {
    return (s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}


// A stable, collision-resistant category key derived from the addon's id + the category's own
// label — never hand-typed, so two addons (or two categories in the same addon) can't collide.
// Renaming a category's label changes its key, which orphans any world entries already tagged
// with the old one back to a generic/browse-only category — a known trade-off of keeping this
// derived rather than asking authors to manage raw keys themselves.
export function worldCategoryKey(addonId, label) {
    const slug = slugify(label) || 'entry';
    return `addon-${(addonId || '').slice(0, 8)}-${slug}`;
}


// Custom World Bible categories contributed by every addon installed in this project, in the
// same { key, icon, label, fields, quickStats, defaults } shape worldExtraFields already returns
// for the four built-in types — so book-cover.jsx's consumers don't need to know the difference.
export function addonWorldCategoryDefs(project) {
    const defs = [];
    installedAddonManifests(project).forEach((addon) => {
        ((addon.contains && addon.contains.worldCategories) || []).forEach((wc) => {
            if (!wc.label)
                return;
            const fieldKeys = (wc.fieldsCsv || '').split(',').map((f) => f.trim()).filter(Boolean);
            const fields = fieldKeys.map((label) => ({ key: slugify(label) || label, placeholder: label }));
            defs.push({
                key: worldCategoryKey(addon.id, wc.label), icon: wc.icon || '\uD83E\uDDE9', label: wc.label,
                fields, quickStats: fields.length ? fields.map((f) => ({ key: f.key, label: f.placeholder })) : null,
                defaults: Object.fromEntries(fields.map((f) => [f.key, ''])),
                sourceAddonId: addon.id, sourceAddonName: addon.name || 'Addon',
            });
        });
    });
    return defs;
}


// Declarative Story Health rules contributed by every addon installed in this project. See
// runAddonRule in health-checks.jsx for how `rule`/`appliesTo`/`param` get interpreted — this
// function only collects and tags them with where they came from.
export function addonHealthRules(project) {
    const rules = [];
    installedAddonManifests(project).forEach((addon) => {
        ((addon.contains && addon.contains.healthRules) || []).forEach((r) => {
            if (!r.label || !r.rule || !r.appliesTo)
                return;
            rules.push({ ...r, sourceAddonId: addon.id, sourceAddonName: addon.name || 'Addon' });
        });
    });
    return rules;
}
