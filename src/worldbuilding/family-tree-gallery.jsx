import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Field, TagInput } from '../shared-ui/form-fields.jsx';
import { IconPlus, IconX } from '../shared-ui/icons.jsx';
import { EmptyState, QuickStatsCard, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { selectStyle } from '../shared-ui/ui-primitives.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { buildFamilyGraph, familyTreeStatsForHouse, houseAncestorIds } from './family-graph.jsx';
import { DEFAULT_LOCATION_TYPE_META, LOCATION_TYPE_META } from './location-types.jsx';
import { FamilyTreeCard, HouseCrest, houseBannerBackground } from './relationship-web.jsx';
import { usePersistedViewState } from '../writing/project-schema-and-backups.jsx';


// The Family Trees category's own gallery — replaces the flat browse list every other World Bible
// category uses, so opening it actually feels like stepping into a different kind of screen.
export function FamilyTreeGallery({ houses, characters, relationships, onOpenHouse, allCount }) {
    const graph = useMemo(() => buildFamilyGraph(relationships), [relationships]);
    if (houses.length === 0) {
        return React.createElement(EmptyState, { text: allCount === 0 ? "No Houses & Clans yet. Add one under Houses & Clans to start its family tree." : "No matches for your search." });
    }
    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[18] } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', gap: SPACE_SCALE[10] } },
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13], letterSpacing: '0.1em', textTransform: 'uppercase', color: '#7A7A82', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "tree", size: 14 }), "Family Trees"),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64', fontStyle: 'italic', fontFamily: "'Fraunces', Georgia, serif" } }, "Every generation, one tap away.")),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: SPACE_SCALE[14] } }, houses.map((house) => {
            const stats = familyTreeStatsForHouse(house, characters, graph);
            return React.createElement(FamilyTreeCard, { key: house.id, house, crestUrl: house.crestUrl, memberCount: stats.memberCount, generationCount: stats.generationCount, onOpen: () => onOpenHouse(house.id) });
        })));
}


// ---------- House Database: the page a house card opens into ----------
export const LIFE_STATUS_META = {
    alive: { label: 'Alive', color: '#7FA98A' },
    dead: { label: 'Dead', color: '#B06A6A' },
    '': { label: 'Unknown', color: '#7A7A82' },
};


export const HOUSE_STATUS_META = {
    active: { label: 'Active', color: '#7FA98A' },
    extinct: { label: 'Extinct', color: '#B06A6A' },
    '': { label: 'Unknown', color: '#7A7A82' },
};


// A single collapsible block used to organize a House/Clan's profile into digestible sections
// (Overview, Leadership, Allegiance & Relations, Description, Members, Family Tree…) instead of
// one long scroll of fields.
// Sticky in-page section nav for long profile pages (House / Location / Character, etc).
// `sections` is [{ id, label }] — each id must match an element rendered further down inside
// the same scrollable pane referenced by `scrollRef`. Renders pinned to the top of that pane
// (not the whole viewport), smooth-scrolls to a section on tap, and highlights whichever
// section is currently at the top of the visible area.
export function SectionNav({ sections, scrollRef }) {
    const [active, setActive] = useState((sections[0] && sections[0].id) || null);
    const navRef = useRef(null);
    const sectionKey = sections.map((s) => s.id).join('|');
    useEffect(() => {
        const container = scrollRef.current;
        if (!container || !sections.length)
            return;
        const computeActive = () => {
            const navH = navRef.current ? navRef.current.offsetHeight : 0;
            const containerTop = container.getBoundingClientRect().top;
            let current = sections[0].id;
            for (let i = 0; i < sections.length; i++) {
                const el = document.getElementById(sections[i].id);
                if (!el)
                    continue;
                const relTop = el.getBoundingClientRect().top - containerTop;
                if (relTop - navH <= 12)
                    current = sections[i].id;
                else
                    break;
            }
            setActive(current);
        };
        computeActive();
        container.addEventListener('scroll', computeActive, { passive: true });
        window.addEventListener('resize', computeActive);
        return () => {
            container.removeEventListener('scroll', computeActive);
            window.removeEventListener('resize', computeActive);
        };
    }, [scrollRef.current, sectionKey]);
    const jump = (id) => {
        const container = scrollRef.current;
        const el = document.getElementById(id);
        if (!container || !el)
            return;
        const navH = navRef.current ? navRef.current.offsetHeight : 0;
        const containerTop = container.getBoundingClientRect().top;
        const elTop = el.getBoundingClientRect().top;
        const targetScroll = container.scrollTop + (elTop - containerTop) - navH - 8;
        container.scrollTo({ top: Math.max(0, targetScroll), behavior: 'smooth' });
    };
    return React.createElement("div", { ref: navRef, className: "section-nav" },
        React.createElement("div", { className: "section-nav-inner" }, sections.map((s) => React.createElement("button", {
            key: s.id, type: "button", onClick: () => jump(s.id),
            className: "section-nav-btn" + (active === s.id ? ' active' : ''),
        }, s.label))));
}


export function CollapsibleSection({ id, title, subtitle, defaultOpen, children }) {
    // Keyed by `id` (already required for in-page section-nav anchors), so every collapsible
    // panel anywhere in the app — House, Location, Character profiles, etc. — remembers its own
    // expanded/collapsed state across reopening the project, with no extra wiring per instance.
    const [open, setOpen] = usePersistedViewState(id ? 'panelOpen:' + id : null, defaultOpen !== false);
    return React.createElement("div", { id: id, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], marginBottom: 14, overflow: 'hidden' } },
        React.createElement("button", { onClick: () => setOpen(!open), style: {
                width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10],
                background: 'none', border: 'none', cursor: 'pointer', padding: '14px 16px', textAlign: 'left',
            } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, title),
                subtitle && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginTop: 2 } }, subtitle)),
            React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[12], flexShrink: 0, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform var(--ink-dur) var(--ink-ease)' } }, "\u25BE")),
        // Content always stays mounted — the grid-rows track (0fr closed / 1fr open, see the
        // .ink-accordion-body rule) is what animates, so both opening and closing get a smooth
        // height transition instead of an instant show/hide.
        React.createElement("div", { className: "ink-accordion-body" + (open ? ' open' : ''), "aria-hidden": open ? undefined : "true", inert: open ? undefined : "" },
            React.createElement("div", { style: { padding: '2px 16px 18px' } }, children)));
}


export function HouseMemberCard({ member, onSelect }) {
    const meta = LIFE_STATUS_META[member.lifeStatus || ''] || LIFE_STATUS_META[''];
    return React.createElement("button", { onClick: onSelect, style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[14], width: '100%', textAlign: 'left', cursor: 'pointer',
            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: '14px 16px',
        } },
        React.createElement("div", { style: { width: 52, height: 52, borderRadius: RADIUS_SCALE[10], overflow: 'hidden', flexShrink: 0, background: '#232328', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid #2A2A30' } }, member.portraitUrl
            ? React.createElement("img", { src: member.portraitUrl, style: { width: '100%', height: '100%', objectFit: 'cover' }, onError: (e) => { e.currentTarget.style.display = 'none'; } })
            : React.createElement("span", { style: { fontSize: TYPE_SCALE[15], fontWeight: 700, color: '#C89B3C' } }, (member.name || '?').slice(0, 2).toUpperCase())),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, member.name || 'Unnamed'),
            member.occupation && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 1 } }, member.occupation),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 6 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#A6A6AD' } }, "Generation ", React.createElement("span", { style: { color: '#C89B3C', fontWeight: 700 } }, member.generation + 1)),
                React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[12], color: meta.color, fontWeight: 600 } },
                    React.createElement("span", { style: { width: 6, height: 6, borderRadius: '50%', background: meta.color, display: 'inline-block' } }),
                    meta.label))));
}


// Slim banner shown at the top of a cadet branch's own profile, pointing back to its parent house.
export function ParentHouseBanner({ parent, onOpen, onRemove }) {
    if (!parent)
        return null;
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '10px 14px', marginBottom: 16 } },
        React.createElement(HouseCrest, { url: parent.crestUrl, size: 32, radius: 8 }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } }, "Cadet branch of"),
            React.createElement("button", { onClick: onOpen, style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#C89B3C', textAlign: 'left' } }, parent.topic || 'Unnamed house')),
        React.createElement("button", { onClick: onRemove, style: { background: 'none', border: '1px solid #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', flexShrink: 0 } }, "Remove link"));
}


// One linked cadet branch, shown in the parent house's profile — its own name, crest, member
// count, and an editable note on how it relates to the parent, plus quick navigation into it.
export function CadetBranchCard({ branch, memberCount, onOpen, relationship, onRelationshipChange, onUnlink }) {
    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '12px 14px', marginBottom: 10 } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12] } },
            React.createElement("button", { onClick: onOpen, style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], flex: 1, minWidth: 0, textAlign: 'left' } },
                React.createElement(HouseCrest, { url: branch.crestUrl, size: 40 }),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, branch.topic || 'Unnamed house'),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 1 } }, memberCount, " member", memberCount === 1 ? '' : 's'))),
            React.createElement("button", { onClick: onOpen, style: { background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE', borderRadius: RADIUS_SCALE[6], padding: '7px 12px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer', flexShrink: 0 } }, "Open \u2192"),
            React.createElement("button", { onClick: onUnlink, title: "Remove this branch link", style: { background: 'none', border: 'none', color: '#8A8A92', fontSize: TYPE_SCALE[17], cursor: 'pointer', padding: '4px 8px', flexShrink: 0, lineHeight: 1 } }, "\u00D7")),
        React.createElement("div", { style: { marginTop: 10 } },
            React.createElement(Field, { label: "Relationship to parent house", value: relationship, onChange: onRelationshipChange, placeholder: "e.g. \u201CFounded by the second son after the succession dispute\u2026\u201D" })));
}


// Lets the user attach an existing House/Clan world-bible entry as a cadet branch of the one
// currently open, or spin up a brand new branch from scratch. Houses that would create a cycle
// (this house itself, or one of its own ancestors) are left out of the picker.
export function BranchLinker({ candidates, onLink, onCreate }) {
    const [pickerOpen, setPickerOpen] = useState(false);
    const [selected, setSelected] = useState('');
    return React.createElement("div", { style: { marginTop: 4 } },
        pickerOpen && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 10, flexWrap: 'wrap' } },
            React.createElement("select", { value: selected, onChange: (e) => setSelected(e.target.value), style: { ...selectStyle, minWidth: 200 } },
                React.createElement("option", { value: "" }, "Choose a house\u2026"),
                candidates.map((c) => React.createElement("option", { key: c.id, value: c.id }, c.topic || 'Unnamed house'))),
            React.createElement("button", { disabled: !selected, onClick: () => { onLink(selected); setSelected(''); setPickerOpen(false); }, style: {
                    background: selected ? '#C89B3C' : '#232328', color: selected ? '#17171B' : '#5C5C64', border: 'none',
                    borderRadius: RADIUS_SCALE[6], padding: '8px 14px', fontSize: TYPE_SCALE[12.5], fontWeight: 700, cursor: selected ? 'pointer' : 'default',
                } }, "Link"),
            React.createElement("button", { onClick: () => { setPickerOpen(false); setSelected(''); }, style: {
                    background: 'none', border: '1px solid #2A2A30', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '8px 14px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                } }, "Cancel")),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
            !pickerOpen && React.createElement("button", { onClick: () => setPickerOpen(true), disabled: candidates.length === 0, style: {
                    background: 'none', border: '1px solid #3A3A42', color: candidates.length ? '#D9D2BE' : '#5C5C64', borderRadius: RADIUS_SCALE[8],
                    padding: '9px 14px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: candidates.length ? 'pointer' : 'default',
                } }, "Link Existing House"),
            React.createElement("button", { onClick: onCreate, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE', borderRadius: RADIUS_SCALE[8],
                    padding: '9px 14px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                } }, React.createElement(IconPlus, null), " Create New Branch")),
        candidates.length === 0 && !pickerOpen && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 8 } }, "No other houses available to link \u2014 add one in the World Bible, or create a new branch."));
}


export function HouseDatabasePage({ house, characters, relationships, allHouses, onSelectMember, onAddMember, onViewTree, onUpdateField, onNavigateHouse, onUpdateHouse, onCreateBranch, onClose }) {
    const [search, setSearch] = useState('');
    const [sort, setSort] = useState('generation-asc'); // 'generation-asc' | 'generation-desc' | 'alphabetical'
    const [statusFilter, setStatusFilter] = useState('all'); // 'all' | 'alive' | 'dead'
    const [genFilter, setGenFilter] = useState(new Set()); // empty set = every generation
    const scrollRef = useRef(null);
    const graph = useMemo(() => buildFamilyGraph(relationships), [relationships]);
    const stats = useMemo(() => familyTreeStatsForHouse(house, characters, graph), [house, characters, graph]);
    const housesList = allHouses || [];
    const parentHouse = house.parentHouseId ? housesList.find((h) => h.id === house.parentHouseId) : null;
    const cadetBranches = housesList.filter((h) => h.parentHouseId === house.id);
    const ineligibleIds = useMemo(() => new Set([house.id, ...houseAncestorIds(house.id, housesList)]), [house.id, housesList]);
    const linkCandidates = housesList.filter((h) => !ineligibleIds.has(h.id) && h.parentHouseId !== house.id);
    const members = stats.memberIds
        .map((id) => characters.find((c) => c.id === id))
        .filter(Boolean)
        .map((c) => ({ ...c, generation: stats.genById[c.id] || 0 }));
    const availableGenerations = Array.from(new Set(members.map((m) => m.generation))).sort((a, b) => a - b);
    const q = search.trim().toLowerCase();
    let visible = members.filter((m) => {
        if (q && !(m.name || '').toLowerCase().includes(q) && !(m.occupation || '').toLowerCase().includes(q) && !(m.alias || '').toLowerCase().includes(q))
            return false;
        if (statusFilter === 'alive' && m.lifeStatus !== 'alive')
            return false;
        if (statusFilter === 'dead' && m.lifeStatus !== 'dead')
            return false;
        if (genFilter.size > 0 && !genFilter.has(m.generation))
            return false;
        return true;
    });
    visible = visible.sort((a, b) => {
        if (sort === 'alphabetical')
            return (a.name || '').localeCompare(b.name || '');
        if (sort === 'generation-desc')
            return b.generation - a.generation || (a.name || '').localeCompare(b.name || '');
        return a.generation - b.generation || (a.name || '').localeCompare(b.name || '');
    });
    const toggleGen = (g) => setGenFilter((prev) => {
        const next = new Set(prev);
        if (next.has(g))
            next.delete(g);
        else
            next.add(g);
        return next;
    });
    const chipStyle = (active) => ({
        cursor: 'pointer', borderRadius: RADIUS_SCALE[20], padding: '5px 12px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
        border: '1px solid ' + (active ? '#C89B3C' : '#2A2A30'), background: active ? 'rgba(200,155,60,0.12)' : 'transparent',
        color: active ? '#C89B3C' : '#A6A6AD',
    });
    const set = (key) => (val) => onUpdateField(key, val);
    const statusMeta = HOUSE_STATUS_META[house.status || ''] || HOUSE_STATUS_META[''];
    const factGrid = { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: SPACE_SCALE[14] };
    return React.createElement("div", { style: { position: 'fixed', inset: 0, background: '#17171B', zIndex: 4500, display: 'flex', flexDirection: 'column' } },
        React.createElement("div", { style: { ...houseBannerBackground(house.bannerUrl), borderBottom: '1px solid #2A2A30', padding: '20px 24px 22px', flexShrink: 0, minHeight: 168, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' } },
            React.createElement("button", { onClick: onClose, style: { background: 'none', border: 'none', color: '#D9D2BE', fontSize: TYPE_SCALE[13], cursor: 'pointer', padding: 0, marginBottom: 16, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], textShadow: '0 1px 4px rgba(0,0,0,0.6)' } }, "\u2190 Back to Family Trees"),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[14], flexWrap: 'wrap' } },
                React.createElement(HouseCrest, { url: house.crestUrl, size: 56 }),
                React.createElement("div", { style: { flex: 1, minWidth: 200 } },
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[26], fontWeight: 600, color: '#EFE7D2', textShadow: '0 1px 6px rgba(0,0,0,0.5)' } }, house.topic || 'Unnamed house'),
                        house.status && React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[5], fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: statusMeta.color, background: 'rgba(0,0,0,0.35)', border: '1px solid ' + statusMeta.color, borderRadius: RADIUS_SCALE[12], padding: '2px 9px' } },
                            React.createElement("span", { style: { width: 6, height: 6, borderRadius: '50%', background: statusMeta.color, display: 'inline-block' } }),
                            statusMeta.label)),
                    house.motto && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#D9D2BE', fontStyle: 'italic', fontFamily: "'Fraunces', Georgia, serif", marginTop: 3, textShadow: '0 1px 6px rgba(0,0,0,0.5)' } }, "\u201C", house.motto, "\u201D"),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], marginTop: 6, fontSize: TYPE_SCALE[13], color: '#D9D2BE', flexWrap: 'wrap' } },
                        React.createElement("span", null, React.createElement("span", { style: { color: '#C89B3C', fontWeight: 700 } }, stats.memberCount), " Member", stats.memberCount === 1 ? '' : 's'),
                        React.createElement("span", null, React.createElement("span", { style: { color: '#C89B3C', fontWeight: 700 } }, stats.generationCount), " Generation", stats.generationCount === 1 ? '' : 's'))),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                    stats.memberCount > 0 && React.createElement("button", { onClick: onViewTree, style: {
                            background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE', borderRadius: RADIUS_SCALE[8],
                            padding: '10px 14px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                        } }, React.createElement(InkIcon, { name: "tree", size: 14 }), "View Tree"),
                    React.createElement("button", { onClick: onAddMember, style: {
                            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: '#C89B3C', border: 'none', color: '#17171B',
                            borderRadius: RADIUS_SCALE[8], padding: '10px 16px', fontSize: TYPE_SCALE[13], fontWeight: 700, cursor: 'pointer',
                        } },
                        React.createElement(IconPlus, null),
                        " Add Member")))),
        React.createElement("div", { ref: scrollRef, style: { flex: 1, overflowY: 'auto', padding: '20px 24px 40px' }, className: "scrollbox" },
            React.createElement(SectionNav, { scrollRef: scrollRef, sections: [
                    { id: 'house-sec-overview', label: 'Overview' },
                    { id: 'house-sec-leadership', label: 'Leadership' },
                    { id: 'house-sec-branches', label: 'Branches' },
                    { id: 'house-sec-allegiance', label: 'Relations' },
                    { id: 'house-sec-description', label: 'Description' },
                    { id: 'house-sec-members', label: 'Members' },
                    { id: 'house-sec-tree', label: 'Family Tree' },
                ] }),
            React.createElement(ParentHouseBanner, { parent: parentHouse, onOpen: () => onNavigateHouse(parentHouse.id), onRemove: () => onUpdateField('parentHouseId', '') }),
            React.createElement(QuickStatsCard, { rows: [
                    { label: 'Seat / Capital', value: house.seat },
                    { label: 'Current Leader', value: house.currentLeader },
                    { label: 'Status', value: statusMeta.label !== 'Unknown' ? statusMeta.label : '' },
                    { label: 'Founded', value: house.foundedDate },
                ] }),
            React.createElement(CollapsibleSection, { id: "house-sec-overview", title: "Overview", defaultOpen: true },
                React.createElement("div", { style: { marginBottom: 14 } },
                    React.createElement(Field, { label: "Overview", value: house.overview, onChange: set('overview'), textarea: true, placeholder: "A brief summary of this house or clan\u2026" })),
                React.createElement("div", { style: { ...factGrid, marginTop: 14 } },
                    React.createElement(Field, { label: "Motto", value: house.motto, onChange: set('motto'), placeholder: "A short motto or words to live by\u2026" }),
                    React.createElement(Field, { label: "House Words", value: house.houseWords, onChange: set('houseWords'), placeholder: "e.g. \u201CWinter Is Coming\u201D" }),
                    React.createElement(Field, { label: "Seat / Capital", value: house.seat, onChange: set('seat'), placeholder: "Where this house is based\u2026" }),
                    React.createElement(Field, { label: "Region", value: house.region, onChange: set('region'), placeholder: "The land or territory it holds\u2026" }),
                    React.createElement(Field, { label: "Founded Date", value: house.foundedDate, onChange: set('foundedDate'), placeholder: "e.g. Year 214, Third Age\u2026" }),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Status"),
                        React.createElement("select", { value: house.status || '', onChange: (e) => onUpdateField('status', e.target.value), style: { ...selectStyle, width: '100%' } },
                            React.createElement("option", { value: "" }, "Unknown"),
                            React.createElement("option", { value: "active" }, "Active"),
                            React.createElement("option", { value: "extinct" }, "Extinct"))))),
            React.createElement(CollapsibleSection, { id: "house-sec-leadership", title: "Leadership & Lineage" },
                React.createElement("div", { style: factGrid },
                    React.createElement(Field, { label: "Founder", value: house.founder, onChange: set('founder'), placeholder: "Who founded this house\u2026" }),
                    React.createElement(Field, { label: "Current Leader", value: house.currentLeader, onChange: set('currentLeader'), placeholder: "Who leads it now\u2026" }),
                    React.createElement(Field, { label: "Heir", value: house.heir, onChange: set('heir'), placeholder: "Next in line\u2026" }))),
            React.createElement(CollapsibleSection, { id: "house-sec-branches", title: "Cadet Branches", subtitle: `${cadetBranches.length} branch${cadetBranches.length === 1 ? '' : 'es'}`, defaultOpen: true },
                cadetBranches.length === 0
                    ? React.createElement(EmptyState, { text: "No cadet branches yet \u2014 link an existing house or create a new one below." })
                    : cadetBranches.map((b) => React.createElement(CadetBranchCard, {
                        key: b.id,
                        branch: b,
                        memberCount: familyTreeStatsForHouse(b, characters, graph).memberCount,
                        onOpen: () => onNavigateHouse(b.id),
                        relationship: b.parentRelationship,
                        onRelationshipChange: (val) => onUpdateHouse(b.id, 'parentRelationship', val),
                        onUnlink: () => onUpdateHouse(b.id, 'parentHouseId', ''),
                    })),
                React.createElement("div", { style: { marginTop: 12 } },
                    React.createElement(BranchLinker, {
                        candidates: linkCandidates,
                        onLink: (id) => onUpdateHouse(id, 'parentHouseId', house.id),
                        onCreate: onCreateBranch,
                    }))),
            React.createElement(CollapsibleSection, { id: "house-sec-allegiance", title: "\u2694\uFE0F Allegiance & Relations" },
                React.createElement("div", { style: { marginBottom: 14 } },
                    React.createElement(Field, { label: "Allegiance", value: house.allegiance, onChange: set('allegiance'), placeholder: "Who or what this house is sworn to\u2026" })),
                React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[14] } },
                    React.createElement(TagInput, { tags: house.vassals || [], onChange: set('vassals'), label: "Vassals", placeholder: "Add a vassal house and press Enter\u2026" }),
                    React.createElement(TagInput, { tags: house.allies || [], onChange: set('allies'), label: "Allies", placeholder: "Add an allied house and press Enter\u2026" }),
                    React.createElement(TagInput, { tags: house.rivals || [], onChange: set('rivals'), label: "Rivals", placeholder: "Add a rival house and press Enter\u2026" }))),
            React.createElement(CollapsibleSection, { id: "house-sec-description", title: "Description" },
                React.createElement(Field, { value: house.detail, onChange: set('detail'), textarea: true, placeholder: "The fuller history and lore of this house\u2026", label: "History & Lore" })),
            React.createElement(CollapsibleSection, { id: "house-sec-members", title: "Members", subtitle: `${stats.memberCount} member${stats.memberCount === 1 ? '' : 's'}`, defaultOpen: true },
                React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[10], marginBottom: 16, alignItems: 'center' } },
                    React.createElement("input", { value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search this house\u2026", style: {
                            flex: '1 1 220px', background: '#232328', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8],
                            color: '#EFE7D2', padding: '9px 12px', fontSize: TYPE_SCALE[13.5],
                        } }),
                    React.createElement("select", { value: sort, onChange: (e) => setSort(e.target.value), style: { ...selectStyle, width: 'auto' } },
                        React.createElement("option", { value: "generation-asc" }, "Oldest first"),
                        React.createElement("option", { value: "generation-desc" }, "Newest first"),
                        React.createElement("option", { value: "alphabetical" }, "Alphabetical"))),
                React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8], marginBottom: 20, alignItems: 'center' } },
                    React.createElement("button", { onClick: () => setStatusFilter('all'), style: chipStyle(statusFilter === 'all') }, "All"),
                    React.createElement("button", { onClick: () => setStatusFilter('alive'), style: chipStyle(statusFilter === 'alive') }, "Alive"),
                    React.createElement("button", { onClick: () => setStatusFilter('dead'), style: chipStyle(statusFilter === 'dead') }, "Deceased"),
                    availableGenerations.length > 1 && React.createElement("span", { style: { width: 1, height: 18, background: '#2A2A30', margin: '0 2px' } }),
                    availableGenerations.length > 1 && availableGenerations.map((g) => React.createElement("button", { key: g, onClick: () => toggleGen(g), style: chipStyle(genFilter.has(g)) }, "Gen ", g + 1))),
                members.length === 0
                    ? React.createElement(EmptyState, { text: "No characters are tagged with this house yet \u2014 add a member or open a character's profile and set their House / Clan." })
                    : visible.length === 0
                        ? React.createElement(EmptyState, { text: "No members match your search or filters." })
                        : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 640 } }, visible.map((m) => React.createElement(HouseMemberCard, { key: m.id, member: m, onSelect: () => onSelectMember(m.id) })))),
            React.createElement(CollapsibleSection, { id: "house-sec-tree", title: React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "tree", size: 14 }), "Family Tree"), subtitle: `${stats.generationCount} generation${stats.generationCount === 1 ? '' : 's'}` },
                stats.memberCount > 0
                    ? React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: SPACE_SCALE[12] } },
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#A6A6AD' } }, "See how every tagged member connects, across every generation."),
                        React.createElement("button", { onClick: onViewTree, style: {
                                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE',
                                borderRadius: RADIUS_SCALE[8], padding: '9px 14px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                            } }, React.createElement(InkIcon, { name: "tree", size: 14 }), "Open Family Tree"))
                    : React.createElement(EmptyState, { text: "Add members and mark family relationships (Parent of / Spouse of / Sibling of\u2026) to build this house's family tree." }))));
}


// ---------- Map legend: explains every pin icon/color, opened from the "Map Legend" button ----------
export function LocationLegendModal({ onClose }) {
    return (React.createElement("div", { className: "ink-modal-backdrop", style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 5000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }, onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); } },
        React.createElement("div", { className: "ink-modal-panel", style: {
                background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12],
                padding: 22, maxWidth: 440, width: '100%', maxHeight: '80vh', overflowY: 'auto',
                boxShadow: '0 24px 48px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#EFE7D2' } }, "Map Legend"),
                React.createElement("button", { onClick: onClose, "aria-label": "Close", style: { background: 'none', border: 'none', color: '#7A7A82', cursor: 'pointer', display: 'flex' } },
                    React.createElement(IconX, null))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginBottom: 16 } }, "What each pin on your maps means."),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[10] } }, Object.keys(LOCATION_TYPE_META).map((type) => {
                const meta = LOCATION_TYPE_META[type];
                const Icon = meta.icon;
                return (React.createElement("div", { key: type, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10] } },
                    React.createElement("div", { style: {
                            width: 26, height: 26, borderRadius: '50%', flexShrink: 0, background: meta.color,
                            border: '2px solid #17171B', color: '#17171B', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        } },
                        React.createElement(Icon, null)),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#D9D2BE' } }, meta.label)));
            })),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 14, paddingTop: 14, borderTop: '1px solid #2A2A30' } },
                React.createElement("div", { style: {
                        width: 26, height: 26, borderRadius: '50%', flexShrink: 0, background: DEFAULT_LOCATION_TYPE_META.color,
                        border: '2px solid #17171B', color: '#17171B', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    } },
                    React.createElement(DEFAULT_LOCATION_TYPE_META.icon, null)),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#D9D2BE' } }, "Untyped location")),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 10 } },
                React.createElement("div", { className: "ink-loc-cluster", style: { width: 26, height: 26, fontSize: TYPE_SCALE[11], position: 'static' } }, "N"),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#D9D2BE' } }, "Cluster of nearby locations \u2014 click to zoom in")))));
}
