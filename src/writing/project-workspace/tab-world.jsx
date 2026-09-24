import React from 'react';
import { NavScrollBox, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { CardList } from '../../shared-ui/ui-primitives.jsx';
import { InkIcon } from '../../shell/ink-icon.jsx';
import { WORLD_CATEGORIES, editableWorldCategoryKeys, worldBibleCategoriesForProject, worldBibleCount, worldBibleEntries, worldCategoryMeta, worldExtraFields } from '../../worldbuilding/book-cover.jsx';
import { FamilyTreeGallery } from '../../worldbuilding/family-tree-gallery.jsx';
import { WorldBibleBrowseList } from '../../worldbuilding/world-bible-browse-list.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'world' block — only the
// state it read is now passed in as props instead of closed over.
export function WorldTab({ askConfirm, jumpToWorldBibleEntry, project, projectId, setHouseDbId, setWorldBibleSearch, setWorldCategory, update, worldBibleAllHouses, worldBibleFilteredBrowseEntries, worldBibleFilteredHouses, worldBibleNativeItems, worldBibleNativeUnfilteredCount, worldBibleSearch, worldCategory }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-world`, style: { flex: 1, padding: '28px 0', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement("div", { className: "reading-container" },
                React.createElement(SectionLabel, null, "World Bible"),
                React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[6], marginBottom: 14 } }, worldBibleCategoriesForProject(project).map((c) => {
                    const count = worldBibleCount(project, c.key);
                    const active = worldCategory === c.key;
                    return React.createElement("button", { key: c.key, onClick: () => setWorldCategory(c.key), style: {
                            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], cursor: 'pointer', borderRadius: RADIUS_SCALE[20],
                            padding: '6px 12px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, border: '1px solid ' + (active ? '#C89B3C' : '#2A2A30'),
                            background: active ? 'rgba(200,155,60,0.12)' : 'transparent', color: active ? '#C89B3C' : '#A6A6AD',
                        } }, c.icon, " ", c.label, " ", React.createElement("span", { style: { color: '#5C5C64' } }, count), c.isNew && React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, color: '#7FA98A', border: '1px solid #2E4A38', borderRadius: RADIUS_SCALE[8], padding: '1px 5px', marginLeft: 4 } }, "NEW"), c.isAddon && React.createElement("span", { title: `Added by ${c.sourceAddonName || 'an addon'}`, style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, color: '#C89B3C', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[8], padding: '1px 5px', marginLeft: 4 } }, "ADDON"));
                })),
                React.createElement("input", { value: worldBibleSearch, onChange: (e) => setWorldBibleSearch(e.target.value), placeholder: "Search everything in your World Bible\u2026", style: {
                        width: '100%', maxWidth: 420, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8],
                        color: '#EFE7D2', padding: '9px 12px', fontSize: TYPE_SCALE[13.5], marginBottom: 18, display: 'block',
                    } }),
                editableWorldCategoryKeys(project).includes(worldCategory) ? React.createElement(CardList, {
                    items: worldBibleNativeItems,
                    fields: [
                        { key: 'topic', placeholder: worldCategoryMeta(worldCategory).placeholder },
                        { key: 'category', kind: 'select', options: [{ value: '', label: 'General' }, ...WORLD_CATEGORIES.map((cc) => ({ value: cc.key, label: cc.label }))] },
                        ...worldExtraFields(worldCategory, project).fields,
                        { key: 'detail', placeholder: 'Details worth remembering…', kind: 'textarea' },
                    ],
                    quickStatsFields: worldExtraFields(worldCategory, project).quickStats,
                    onAdd: () => update((p) => { p.world.push({ id: uuid(), topic: '', category: worldCategory, detail: '', crestUrl: '', bannerUrl: '', ...worldExtraFields(worldCategory, project).defaults }); }),
                    onRemove: (id) => update((p) => { p.world = p.world.filter((x) => x.id !== id); }),
                    onChange: (id, key, val) => update((p) => { p.world.find((x) => x.id === id)[key] = val; }),
                    anchorPrefix: "world",
                    addLabel: `Add ${worldCategoryMeta(worldCategory).label.toLowerCase().replace(/s$/, '')}`,
                    emptyText: worldBibleNativeUnfilteredCount > 0 ? "No matches for your search." : `No ${worldCategoryMeta(worldCategory).label.toLowerCase()} yet.`,
                    askConfirm: askConfirm,
                    imageField: worldCategory === 'houses' ? 'crestUrl' : undefined,
                    imageLabel: worldCategory === 'houses' ? 'Crest' : undefined,
                    bannerField: worldCategory === 'houses' ? 'bannerUrl' : undefined,
                    bannerLabel: worldCategory === 'houses' ? 'Banner' : undefined,
                    renderFooter: (item) => item.category === 'houses' && React.createElement("button", { onClick: () => setHouseDbId(item.id), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 10, background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12.5], cursor: 'pointer', padding: 0 } }, React.createElement(InkIcon, { name: "tree", size: 13 }), "View Family Tree \u2192"),
                }) : worldCategory === 'familyTrees' ? React.createElement(FamilyTreeGallery, {
                    houses: worldBibleFilteredHouses,
                    characters: project.characters,
                    relationships: project.relationships,
                    onOpenHouse: setHouseDbId,
                    allCount: worldBibleAllHouses.length,
                }) : React.createElement(WorldBibleBrowseList, {
                    entries: worldBibleFilteredBrowseEntries,
                    hasAnyBeforeSearch: worldBibleEntries(project, worldCategory).length > 0,
                    onSelect: jumpToWorldBibleEntry,
                    emptyText: worldCategory === 'all' ? "Nothing in your World Bible yet. Start adding characters, locations, lore, and more." : `No ${(worldBibleCategoriesForProject(project).find((c) => c.key === worldCategory) || { label: 'entries' }).label.toLowerCase()} yet.`,
                }))));
}
