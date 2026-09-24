import React, { useEffect, useState } from 'react';
import { ArchiveSectionHeading, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { CardList, AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { worldBibleCategoriesForProject, worldExtraFields } from '../worldbuilding/book-cover.jsx';
import { renumberChapters } from './project-schema-and-backups.jsx';
import { fetchDiscoverTemplates, publishTemplateRemote, unpublishTemplateRemote } from '../lib/template-marketplace.js';
import { useSync } from '../shell/sync-context.jsx';


// ---------- Templates: reusable starting points, saved once and used everywhere ----------
// Stored per-device (not per-project) under one key, same read/write-with-fallback shape as
// every other localStorage-backed list in the app (see readLibraryFavorites) — so a template
// made while working on one novel is still there for the next one. Applying a template just
// pushes a new item onto the *current* project through its own update() function, exactly the
// same path every other "+ Add" button in this app already uses — there's no second write path
// to keep in sync. Publishing/sharing a template with other writers (migration 87, fix-tracker
// item 22) is a separate action from any of that — see MarketplaceToggle/TemplateMarketplace-
// Browser below — free-to-use, no purchase step or moderation gate, per the app owner's own call.
export const TEMPLATES_KEY = 'inkroot:templates';


export const TEMPLATE_TYPES = [
    { key: 'book', label: 'Book', icon: 'book' },
    { key: 'chapter', label: 'Chapter', icon: 'library' },
    { key: 'character', label: 'Character', icon: 'guild' },
    { key: 'worldbuilding', label: 'Worldbuilding', icon: 'universe' },
];


export function readTemplates() {
    try {
        const raw = JSON.parse(localStorage.getItem(TEMPLATES_KEY) || '[]');
        return Array.isArray(raw) ? raw : [];
    }
    catch (e) {
        return [];
    }
}


export function writeTemplates(list) {
    try {
        localStorage.setItem(TEMPLATES_KEY, JSON.stringify(list));
    }
    catch (e) { }
}


function emptyTemplate(type) {
    // marketplaceStatus/publishedAt: whether this template has been shared (migration 87,
    // fix-tracker item 22) — same additive, backward-compatible field addon-data.jsx's own
    // emptyAddon() added for the same reason; a template saved before this field existed reads
    // as undefined, treated the same as 'unpublished' everywhere below.
    const base = { id: uuid(), type, name: '', marketplaceStatus: 'unpublished', publishedAt: null };
    if (type === 'book')
        return { ...base, title: '', subtitle: '', seriesName: '', author: '' };
    if (type === 'chapter')
        return { ...base, chapterTitle: '', text: '' };
    if (type === 'character')
        return { ...base, role: '', occupation: '', goals: '', personality: '', biography: '' };
    return { ...base, category: 'houses', topic: '', detail: '' };
}


const FIELD_SETS = {
    book: [
        { key: 'name', placeholder: 'Template name (e.g. "Epic Fantasy Starter")' },
        { key: 'title', placeholder: 'Working title' },
        { key: 'subtitle', placeholder: 'Subtitle (optional)' },
        { key: 'seriesName', placeholder: 'Series name (optional)' },
        { key: 'author', placeholder: 'Author name' },
    ],
    chapter: [
        { key: 'name', placeholder: 'Template name (e.g. "Action Scene Opener")' },
        { key: 'chapterTitle', placeholder: 'Chapter title' },
        { key: 'text', placeholder: 'Starting text\u2026', kind: 'textarea' },
    ],
    character: [
        { key: 'name', placeholder: 'Template name (e.g. "Chosen One Archetype")' },
        { key: 'role', placeholder: 'Role (e.g. Protagonist)' },
        { key: 'occupation', placeholder: 'Occupation' },
        { key: 'goals', placeholder: 'Goals', kind: 'textarea' },
        { key: 'personality', placeholder: 'Personality', kind: 'textarea' },
        { key: 'biography', placeholder: 'Biography', kind: 'textarea' },
    ],
};


// Worldbuilding's category picker needs to offer whichever addons are installed in THIS
// project, so (unlike the three field sets above) it can't be a static module-level array —
// it's built fresh per render from worldBibleCategoriesForProject(project). See
// worldBibleCategoriesForProject in book-cover.jsx.
function worldbuildingFieldSet(project) {
    return [
        { key: 'name', placeholder: 'Template name (e.g. "Border Kingdom")' },
        { key: 'category', placeholder: 'Category', kind: 'select', options: worldBibleCategoriesForProject(project).filter((c) => c.key !== 'all' && c.key !== 'familyTrees').map((c) => ({ value: c.key, label: c.label })) },
        { key: 'topic', placeholder: 'Topic / name' },
        { key: 'detail', placeholder: 'Detail', kind: 'textarea' },
    ];
}


function fieldSetFor(type, project) {
    return type === 'worldbuilding' ? worldbuildingFieldSet(project) : FIELD_SETS[type];
}


// The type-specific fields to publish/reconstruct a template with, stripped of the bits that
// are either identity (id/type/name, kept as their own columns server-side) or purely local
// share-state (marketplaceStatus/publishedAt, which a freshly-added template always starts
// 'unpublished' regardless of whether the author who shared it had it shared).
const TEMPLATE_META_KEYS = ['id', 'type', 'name', 'marketplaceStatus', 'publishedAt'];
function templatePayload(t) {
    return Object.fromEntries(Object.entries(t).filter(([k]) => !TEMPLATE_META_KEYS.includes(k)));
}


// Publish/unpublish a template to the Template Marketplace (migration 87, fix-tracker item 22)
// — mirrors addon-studio.jsx's own MarketplaceToggle exactly; see that one's comment for why
// this is a separate action from anything else on the card, and why signed-out hides it entirely.
// Reliability gap (same bug class as fix-tracker item 27/31, fixed here to match
// addon-studio.jsx's own MarketplaceToggle fix): publishTemplateRemote/unpublishTemplateRemote
// now actually throw on a real Supabase error instead of resolving silently, so
// onUpdateTemplate only fires once the remote call has genuinely succeeded — a failure surfaces
// via this AlertDialog instead of the template quietly showing "Shared to Marketplace" (or
// "unshared") while nothing actually changed server-side.
// Exported so the Creator Dashboard's own Templates tab (creator-dashboard.jsx) can offer the
// exact same share/unshare action against a writer's real local templates, instead of standing
// in front of the real Template Marketplace with a "Coming Soon" placeholder — see that file's
// CreatorTemplatesPanel for the read-only summary view this gets embedded in.
export function MarketplaceToggle({ template, onUpdateTemplate, signedIn }) {
    const [pending, setPending] = useState(false);
    const [notice, setNotice] = useState(null); // { title, message }
    if (!signedIn)
        return null;
    const shared = template.marketplaceStatus === 'published';
    const toggle = async () => {
        setPending(true);
        try {
            if (shared) {
                await unpublishTemplateRemote(template.id);
                onUpdateTemplate({ marketplaceStatus: 'unpublished', publishedAt: null });
            }
            else {
                await publishTemplateRemote({ id: template.id, type: template.type, name: template.name, payload: templatePayload(template) });
                onUpdateTemplate({ marketplaceStatus: 'published', publishedAt: Date.now() });
            }
        }
        catch (e) {
            setNotice({
                title: shared ? "Couldn't unshare" : "Couldn't share",
                message: e.message || "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
        }
        finally {
            setPending(false);
        }
    };
    return React.createElement(React.Fragment, null,
        React.createElement("button", {
            onClick: toggle, disabled: pending,
            style: {
                marginTop: 10, marginLeft: 8, background: 'none', border: shared ? '1px solid #3A3020' : '1px dashed #3A3A42',
                color: shared ? '#8A8272' : '#A6A6AD', borderRadius: RADIUS_SCALE[8],
                padding: '6px 13px', fontSize: TYPE_SCALE[11.5], cursor: pending ? 'default' : 'pointer', fontWeight: 600,
            },
        }, pending ? 'Working\u2026' : (shared ? 'Shared to Marketplace \u2014 Unshare' : 'Share to Marketplace')),
        notice && React.createElement(AlertDialog, { title: notice.title, message: notice.message, onClose: () => setNotice(null) }));
}


// Browse other writers' shared templates (every type together) and add one to this device's own
// local list — mirrors addon-studio.jsx's own AddonMarketplaceBrowser. Reconstructs a normal
// local template object from {type, name, payload}, so it immediately shows up under its own
// TemplateTypeSection below via the existing `templates.filter((t) => t.type === type)`.
function TemplateMarketplaceBrowser({ templates, onChange }) {
    const [remote, setRemote] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchDiscoverTemplates()
            .then((rows) => { if (!cancelled) setRemote(rows); })
            .catch((e) => { console.warn('Inkroot: fetchDiscoverTemplates failed', e); if (!cancelled) setRemote([]); });
        return () => { cancelled = true; };
    }, []);
    const alreadyHave = (id) => templates.some((t) => t.id === id);
    const typeLabel = (type) => (TEMPLATE_TYPES.find((t) => t.key === type) || {}).label || type;
    const handleAdd = (item) => {
        onChange([...templates, { id: item.id, type: item.type, name: item.name, marketplaceStatus: 'unpublished', publishedAt: null, ...item.payload }]);
    };
    return React.createElement("div", { style: { marginBottom: 22 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 } }, "Marketplace \u2014 other writers' templates"),
        remote === null && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, "Loading\u2026"),
        remote !== null && remote.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic' } }, "No shared templates yet \u2014 be the first to share one below."),
        remote && remote.length > 0 && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            remote.map((item) => React.createElement("div", { key: item.id, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '8px 10px',
                    border: '1px solid #26262C', borderRadius: RADIUS_SCALE[8],
                } },
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', fontWeight: 600 } }, item.name || 'Untitled template'),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, `by ${item.author} \u00B7 ${typeLabel(item.type)}`)),
                alreadyHave(item.id)
                    ? React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#8A8272', fontWeight: 600 } }, "Added \u2713")
                    : React.createElement("button", {
                        onClick: () => handleAdd(item),
                        style: {
                            background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        },
                    }, "Add to My Templates")))));
}


// One CRUD list for a single template type, plus an "Apply to this project" action per card
// that writes straight into the current project through the same update() every other tab uses.
function TemplateTypeSection({ type, icon, label, templates, onChange, askConfirm, project, update, signedIn }) {
    const items = templates.filter((t) => t.type === type);
    const updateTemplate = (id, patch) => onChange(templates.map((t) => t.id === id ? { ...t, ...patch } : t));
    const applyLabel = type === 'book' ? 'Apply to Settings'
        : type === 'chapter' ? 'Add as new chapter'
            : type === 'character' ? 'Add as new character'
                : 'Add as new world entry';
    const handleApply = (t) => {
        if (type === 'book') {
            update((p) => {
                if (t.title)
                    p.title = t.title;
                if (t.subtitle)
                    p.subtitle = t.subtitle;
                if (t.seriesName)
                    p.seriesName = t.seriesName;
                if (t.author)
                    p.author = t.author;
            });
        }
        else if (type === 'chapter') {
            update((p) => {
                const number = p.chapters.length + 1;
                p.chapters.push({ id: uuid(), title: t.chapterTitle || `Chapter ${number}`, text: t.text || '', isCopy: false });
                renumberChapters(p.chapters);
            });
        }
        else if (type === 'character') {
            update((p) => {
                p.characters.push({
                    id: uuid(), name: '', alias: '', age: '', birthday: '', race: '', occupation: t.occupation || '',
                    status: '', lifeStatus: '', role: t.role || '', portraitUrl: '', houseId: '', tags: [],
                    goals: t.goals || '', personality: t.personality || '', biography: t.biography || '', notes: '',
                });
            });
        }
        else {
            const defaults = worldExtraFields(t.category || 'houses', project).defaults;
            update((p) => {
                p.world.push({ id: uuid(), topic: t.topic || '', category: t.category || 'houses', detail: t.detail || '', crestUrl: '', bannerUrl: '', ...defaults });
            });
        }
    };
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: icon, size: 14 }), label }),
        React.createElement("div", { style: { marginTop: 14 } },
            React.createElement(CardList, {
                items, fields: fieldSetFor(type, project), anchorPrefix: `tpl-${type}`, askConfirm,
                itemLabel: (item) => item.name || 'this template',
                addLabel: `New ${label.toLowerCase()} template`,
                emptyText: `No ${label.toLowerCase()} templates yet.`,
                onAdd: () => onChange([...templates, emptyTemplate(type)]),
                onRemove: (id) => onChange(templates.filter((t) => t.id !== id)),
                onChange: (id, key, val) => onChange(templates.map((t) => t.id === id ? { ...t, [key]: val } : t)),
                renderFooter: (item) => React.createElement(React.Fragment, null,
                    React.createElement("button", {
                        onClick: () => handleApply(item), style: {
                            marginTop: 10, background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '6px 13px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        },
                    }, applyLabel),
                    React.createElement(MarketplaceToggle, { template: item, signedIn, onUpdateTemplate: (patch) => updateTemplate(item.id, patch) })),
            })));
}


export function TemplatesPanel({ project, update, askConfirm }) {
    const sync = useSync();
    const signedIn = !!(sync && sync.session && sync.session.user);
    const [templates, setTemplates] = useState(readTemplates());
    const onChange = (next) => { setTemplates(next); writeTemplates(next); };
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Templates"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 18, maxWidth: 560, lineHeight: 1.6 } }, "Save reusable starting points for books, chapters, characters, and worldbuilding entries. Templates live on this device and are available from every project."),
        React.createElement(TemplateMarketplaceBrowser, { templates, onChange }),
        TEMPLATE_TYPES.map((t) => React.createElement(TemplateTypeSection, {
            key: t.key, type: t.key, icon: t.icon, label: t.label, templates, onChange, askConfirm, project, update, signedIn,
        })));
}
