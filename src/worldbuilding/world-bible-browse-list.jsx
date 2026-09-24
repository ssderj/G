import React from 'react';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { HouseCrest } from './relationship-web.jsx';
import { chaptersContainingMentionType } from '../writing/health-checks.jsx';


// Read-only rows for the World Bible's browse-only categories (Characters, Locations, Timeline,
// Glossary, and All) — each one jumps to wherever that entry actually lives rather than editing
// in place, since those databases already have their own full editors elsewhere.
export function WorldBibleBrowseList({ entries, hasAnyBeforeSearch, onSelect, emptyText }) {
    if (entries.length === 0)
        return React.createElement(EmptyState, { text: hasAnyBeforeSearch ? 'No matches for your search.' : emptyText });
    return (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } }, entries.map((e) => React.createElement("button", { key: `${e.type}-${e.id}`, onClick: () => onSelect(e), style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], textAlign: 'left', width: '100%',
            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: '10px 14px', cursor: 'pointer',
        } },
        e.category === 'houses' && React.createElement(HouseCrest, { url: e.crestUrl, size: 30, radius: 8 }),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], fontWeight: 600, color: '#7A7A82', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '2px 8px', whiteSpace: 'nowrap' } }, e.typeLabel),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600 } }, e.name),
            e.snippet && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, e.snippet))))));
}


export function charactersAtLocation(chapters, locationId, characters) {
    const relevant = new Set(chaptersContainingMentionType(chapters, locationId, 'location').map((c) => c.id));
    const charIds = new Set();
    chapters.forEach((c) => {
        if (!relevant.has(c.id))
            return;
        const div = document.createElement('div');
        div.innerHTML = c.text || '';
        Array.from(div.querySelectorAll('[data-mention-type="character"]')).forEach((el) => charIds.add(el.getAttribute('data-mention-id')));
    });
    return characters.filter((ch) => charIds.has(ch.id));
}
