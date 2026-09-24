import React, { useEffect, useState } from 'react';
import { SectionLabel } from '../shared-ui/ui-cards.jsx';
import { CardList, selectStyle, AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import {
    ADDON_CATEGORIES, ADDON_STATUSES, APPLIES_TO_OPTIONS, HEALTH_RULE_TYPES,
    emptyAddon, isAddonInstalled, readAddons, writeAddons,
} from './addon-data.jsx';
import { fetchDiscoverAddons, publishAddonRemote, unpublishAddonRemote } from '../lib/addon-marketplace.js';
import { useSync } from '../shell/sync-context.jsx';


// ---------- Addon Studio: UI ----------
// The data model, installed-project resolution, and World Bible / Story Health integration all
// live in addon-data.jsx — this file is just the authoring screen: the addon CardList, the
// Install/Uninstall toggle, and the small nested editors for contains.worldCategories /
// contains.healthRules. See addon-data.jsx's header for why the split exists, and
// ADDON_STUDIO_PLAN.md for the fuller design.
//
// Installing a Draft addon into your own project IS the "test run" the old Coming Soon notice
// was waiting on, so that notice is gone; the marketplace one stays, since publishing to other
// writers still needs the moderation pipeline Worldbuilding Packs already use.
const ADDON_FIELDS = [
    { key: 'name', placeholder: 'Addon name' },
    { key: 'icon', placeholder: 'Icon (emoji, e.g. \uD83E\uDDE9)' },
    { key: 'description', placeholder: 'What does this addon do\u2026', kind: 'textarea' },
    { key: 'category', placeholder: 'Category', kind: 'select', options: ADDON_CATEGORIES.map((c) => ({ value: c, label: c })) },
    { key: 'version', placeholder: 'Version (e.g. 1.0.0)' },
    { key: 'status', placeholder: 'Status', kind: 'select', options: ADDON_STATUSES },
];


// Same shape as shared-ui/form-fields.jsx's inputStyle() but defined locally rather than
// imported from there — form-fields.jsx imports from book-cover.jsx, which (via
// addonWorldCategoryDefs) imports addon-data.jsx, and ui-primitives.jsx (imported just above)
// already imports form-fields.jsx too, so pulling inputStyle in directly here would risk the
// same kind of circular chain addon-data.jsx was split out to avoid. Small enough to duplicate.
function miniInputStyle() {
    return { background: 'transparent', border: 'none', borderBottom: '1px solid #2A2A30', color: '#EFE7D2', fontSize: TYPE_SCALE[13], fontFamily: "'Inter', sans-serif", padding: '4px 2px' };
}


function miniRowStyle() {
    return { display: 'flex', gap: SPACE_SCALE[6], alignItems: 'center', flexWrap: 'wrap', padding: '8px 0', borderBottom: '1px solid #26262C' };
}


function MiniRemoveButton({ onClick }) {
    return React.createElement("button", { onClick, style: { background: 'none', border: 'none', color: '#8A5A5A', cursor: 'pointer', fontSize: TYPE_SCALE[13], padding: '0 4px' } }, "\u00D7");
}


function MiniAddButton({ onClick, label }) {
    return React.createElement("button", { onClick, style: {
            marginTop: 8, background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6],
            padding: '5px 10px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
        } }, `+ ${label}`);
}


function AddonStatusBadge({ status }) {
    const published = status === 'published';
    return React.createElement("span", { style: {
            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
            padding: '3px 9px', borderRadius: RADIUS_SCALE[999],
            background: published ? 'rgba(200,155,60,0.12)' : 'rgba(122,122,130,0.12)',
            color: published ? '#C89B3C' : '#8A8272',
        } }, published ? 'Published' : 'Draft');
}


function WorldCategoryMiniEditor({ addon, onUpdateContains }) {
    const list = (addon.contains && addon.contains.worldCategories) || [];
    const setList = (next) => onUpdateContains({ ...addon.contains, worldCategories: next });
    return React.createElement("div", { style: { marginTop: 14 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 } }, "Custom World Bible categories"),
        list.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic' } }, "None yet \u2014 add one to give installed projects a new World Bible category."),
        list.map((wc, i) => React.createElement("div", { key: i, style: miniRowStyle() },
            React.createElement("input", { value: wc.icon || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, icon: e.target.value } : x)), placeholder: "\uD83E\uDDE9", style: { ...miniInputStyle(), width: 40 } }),
            React.createElement("input", { value: wc.label || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, label: e.target.value } : x)), placeholder: "Category name (e.g. Bloodlines)", style: { ...miniInputStyle(), flex: '1 1 160px' } }),
            React.createElement("input", { value: wc.fieldsCsv || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, fieldsCsv: e.target.value } : x)), placeholder: "Fields, comma-separated (e.g. founder, motto)", style: { ...miniInputStyle(), flex: '2 1 220px' } }),
            React.createElement(MiniRemoveButton, { onClick: () => setList(list.filter((_, j) => j !== i)) }))),
        React.createElement(MiniAddButton, { label: "Add category", onClick: () => setList([...list, { icon: '\uD83E\uDDE9', label: '', fieldsCsv: '' }]) }));
}


function HealthRuleMiniEditor({ addon, onUpdateContains }) {
    const list = (addon.contains && addon.contains.healthRules) || [];
    const setList = (next) => onUpdateContains({ ...addon.contains, healthRules: next });
    return React.createElement("div", { style: { marginTop: 14 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 } }, "Story Health rules"),
        list.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic' } }, "None yet \u2014 add one to run a check of your own alongside the built-in Story Health checks."),
        list.map((r, i) => React.createElement("div", { key: i, style: miniRowStyle() },
            React.createElement("input", { value: r.label || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, label: e.target.value } : x)), placeholder: "Check name (e.g. \u201CHouses need a motto\u201D)", style: { ...miniInputStyle(), flex: '1 1 180px' } }),
            React.createElement("select", { value: r.appliesTo || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, appliesTo: e.target.value } : x)), style: selectStyle },
                React.createElement("option", { value: "" }, "Applies to\u2026"),
                APPLIES_TO_OPTIONS.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label))),
            React.createElement("select", { value: r.rule || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, rule: e.target.value } : x)), style: selectStyle },
                React.createElement("option", { value: "" }, "Rule\u2026"),
                HEALTH_RULE_TYPES.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label))),
            React.createElement("input", {
                value: r.param || '', onChange: (e) => setList(list.map((x, j) => j === i ? { ...x, param: e.target.value } : x)),
                placeholder: r.rule === 'mentionCount' ? 'Minimum mentions (e.g. 2)' : 'Field name (e.g. motto)',
                style: { ...miniInputStyle(), flex: '1 1 160px' },
            }),
            React.createElement(MiniRemoveButton, { onClick: () => setList(list.filter((_, j) => j !== i)) }))),
        React.createElement(MiniAddButton, { label: "Add rule", onClick: () => setList([...list, { label: '', appliesTo: '', rule: '', param: '' }]) }));
}


// Publish/unpublish an addon to the Addon Marketplace (migration 86, fix-tracker item 21) —
// deliberately separate from AddonStatusBadge's draft/published label above, which only ever
// meant "is this addon finished," never "is it shared." Not signed in → not shown at all,
// same "stays a purely local feature without an account" posture the rest of the app takes.
// Reliability gap (same bug class as fix-tracker item 27/31): publishAddonRemote/
// unpublishAddonRemote now actually throw on a real Supabase error instead of resolving
// silently, so onUpdateAddon only fires once the remote call has genuinely succeeded — a
// failure surfaces via this AlertDialog instead of the addon quietly showing "Shared to
// Marketplace" (or "unshared") while nothing actually changed server-side.
// Exported so the Creator Dashboard's own Add-ons tab (creator-dashboard.jsx) can offer the
// exact same share/unshare action against a writer's real local addons, instead of standing in
// front of the real Addon Marketplace with a "Coming Soon" placeholder — see that file's
// CreatorAddonsPanel for the read-only summary view this gets embedded in.
export function MarketplaceToggle({ addon, onUpdateAddon, signedIn }) {
    const [pending, setPending] = useState(false);
    const [notice, setNotice] = useState(null); // { title, message }
    if (!signedIn)
        return null;
    const shared = addon.marketplaceStatus === 'published';
    const toggle = async () => {
        setPending(true);
        try {
            if (shared) {
                await unpublishAddonRemote(addon.id);
                onUpdateAddon({ marketplaceStatus: 'unpublished', publishedAt: null });
            }
            else {
                await publishAddonRemote(addon);
                onUpdateAddon({ marketplaceStatus: 'published', publishedAt: Date.now() });
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
                background: 'none', border: shared ? '1px solid #3A3020' : '1px dashed #3A3A42',
                color: shared ? '#8A8272' : '#A6A6AD', borderRadius: RADIUS_SCALE[8],
                padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: pending ? 'default' : 'pointer', fontWeight: 600,
            },
        }, pending ? 'Working\u2026' : (shared ? 'Shared to Marketplace \u2014 Unshare' : 'Share to Marketplace')),
        notice && React.createElement(AlertDialog, { title: notice.title, message: notice.message, onClose: () => setNotice(null) }));
}


// Browse other writers' shared addons and add one to this device's own local list (migration 86,
// fix-tracker item 21). "Add" writes the addon's manifest straight into readAddons()/
// writeAddons() under its published id — once it's there, the existing per-project
// InstallToggle above already works unchanged, same as authoring one locally.
function AddonMarketplaceBrowser({ addons, onChange }) {
    const [remote, setRemote] = useState(null); // null while loading
    const [addingId, setAddingId] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchDiscoverAddons()
            .then((rows) => { if (!cancelled) setRemote(rows); })
            .catch((e) => { console.warn('Inkroot: fetchDiscoverAddons failed', e); if (!cancelled) setRemote([]); });
        return () => { cancelled = true; };
    }, []);
    const alreadyHave = (id) => addons.some((a) => a.id === id);
    const handleAdd = (item) => {
        setAddingId(item.id);
        onChange([...addons, {
            id: item.id, name: item.name, icon: item.icon, description: item.description,
            category: item.category, version: item.version, status: 'published',
            manifestVersion: item.manifestVersion, marketplaceStatus: 'unpublished', publishedAt: null,
            contains: item.contains,
        }]);
        setAddingId(null);
    };
    return React.createElement("div", { style: { marginBottom: 22 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 } }, "Marketplace \u2014 other writers' addons"),
        remote === null && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, "Loading\u2026"),
        remote !== null && remote.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic' } }, "No shared addons yet \u2014 be the first to share one below."),
        remote && remote.length > 0 && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            remote.map((item) => React.createElement("div", { key: item.id, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '8px 10px',
                    border: '1px solid #26262C', borderRadius: RADIUS_SCALE[8],
                } },
                React.createElement("span", { style: { fontSize: 18 } }, item.icon || '\uD83E\uDDE9'),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', fontWeight: 600 } }, item.name || 'Untitled addon'),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, `by ${item.author} \u00B7 v${item.version || '0.1.0'} \u00B7 ${item.category}`)),
                alreadyHave(item.id)
                    ? React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#8A8272', fontWeight: 600 } }, "Added \u2713")
                    : React.createElement("button", {
                        onClick: () => handleAdd(item), disabled: addingId === item.id,
                        style: {
                            background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        },
                    }, "Add to My Addons")))));
}


function InstallToggle({ addon, project, update }) {
    if (!project || !update)
        return null;
    const installed = isAddonInstalled(project, addon.id);
    return React.createElement("button", {
        onClick: () => update((p) => {
            p.installedAddons = p.installedAddons || [];
            if (installed) {
                p.installedAddons = p.installedAddons.filter((a) => a.addonId !== addon.id);
            }
            else {
                p.installedAddons.push({ addonId: addon.id, installedVersion: addon.version || '0.1.0', enabledAt: Date.now() });
            }
        }),
        style: {
            background: installed ? 'none' : 'linear-gradient(160deg, #241F14, #1A160D)',
            border: installed ? '1px solid #3A3020' : '1px solid #4A3D22',
            color: installed ? '#8A8272' : '#E8C468', borderRadius: RADIUS_SCALE[8],
            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
        },
    }, installed ? 'Installed \u2713 \u2014 Uninstall' : 'Install into this project');
}


export function AddonStudioPanel({ askConfirm, project, update }) {
    const sync = useSync();
    const signedIn = !!(sync && sync.session && sync.session.user);
    const [addons, setAddons] = useState(readAddons());
    const onChange = (next) => { setAddons(next); writeAddons(next); };
    const updateContains = (addonId, contains) => onChange(addons.map((a) => a.id === addonId ? { ...a, contains } : a));
    const updateAddon = (addonId, patch) => onChange(addons.map((a) => a.id === addonId ? { ...a, ...patch } : a));
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Addon Studio"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 18, maxWidth: 560, lineHeight: 1.6 } }, "Create addons that add a custom World Bible category, a Story Health rule, or both \u2014 then install them into this project to see them live in Story Health and the World Bible."),
        React.createElement(AddonMarketplaceBrowser, { addons, onChange }),
        React.createElement(CardList, {
            items: addons, fields: ADDON_FIELDS, anchorPrefix: "addon", askConfirm: askConfirm,
            itemLabel: (item) => item.name || 'this addon',
            addLabel: "New addon", emptyText: "No addons yet. Create one to start sketching what it should do.",
            onAdd: () => onChange([...addons, emptyAddon()]),
            onRemove: (id) => onChange(addons.filter((a) => a.id !== id)),
            onChange: (id, key, val) => onChange(addons.map((a) => a.id === id ? { ...a, [key]: val } : a)),
            renderFooter: (item) => React.createElement("div", { style: { marginTop: 10 } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                    React.createElement(AddonStatusBadge, { status: item.status }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, `v${item.version || '0.1.0'} \u00B7 ${item.category || 'Other'}`),
                    React.createElement(InstallToggle, { addon: item, project, update }),
                    React.createElement(MarketplaceToggle, { addon: item, signedIn, onUpdateAddon: (patch) => updateAddon(item.id, patch) })),
                React.createElement(WorldCategoryMiniEditor, { addon: item, onUpdateContains: (c) => updateContains(item.id, c) }),
                React.createElement(HealthRuleMiniEditor, { addon: item, onUpdateContains: (c) => updateContains(item.id, c) })),
        }));
}
