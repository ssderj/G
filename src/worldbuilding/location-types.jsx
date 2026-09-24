import React, { useState, useRef } from 'react';
import { IconCopy, IconPinCapital, IconPinCastle, IconPinCity, IconPinContinent, IconPinDefault, IconPinForest, IconPinFortress, IconPinHarbor, IconPinKingdom, IconPinLandmark, IconPinMine, IconPinRegion, IconPinRuin, IconPinTown, IconPinVillage } from '../shared-ui/icons.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// Single source of truth for "what does this location type look like on the map" — every marker,
// the legend, and (in future) any other map-adjacent UI all read from this one table, so adding a
// new location type only ever means adding one row here.
export const LOCATION_TYPE_META = {
    Capital: { icon: IconPinCapital, color: '#E8C767', label: 'Capital City' },
    City: { icon: IconPinCity, color: '#8FB6D1', label: 'City' },
    Town: { icon: IconPinTown, color: '#CDAB7C', label: 'Town' },
    Village: { icon: IconPinVillage, color: '#9BB884', label: 'Village' },
    Kingdom: { icon: IconPinKingdom, color: '#BB93D6', label: 'Kingdom' },
    Continent: { icon: IconPinContinent, color: '#6FC2B8', label: 'Continent' },
    Region: { icon: IconPinRegion, color: '#A3ACB8', label: 'Region' },
    Castle: { icon: IconPinCastle, color: '#BDB0A2', label: 'Castle' },
    Fortress: { icon: IconPinFortress, color: '#CE6763', label: 'Fortress' },
    Mine: { icon: IconPinMine, color: '#D68F4E', label: 'Mine' },
    Forest: { icon: IconPinForest, color: '#5F9A63', label: 'Forest' },
    Harbor: { icon: IconPinHarbor, color: '#6FA8D6', label: 'Harbor' },
    Ruin: { icon: IconPinRuin, color: '#8E8E94', label: 'Ruin' },
    Landmark: { icon: IconPinLandmark, color: '#DCC369', label: 'Landmark' },
};


export const DEFAULT_LOCATION_TYPE_META = { icon: IconPinDefault, color: '#C89B3C', label: 'Location' };


export const getLocationTypeMeta = (type) => LOCATION_TYPE_META[type] || DEFAULT_LOCATION_TYPE_META;


// ---------- Quick Stats card: a compact label/value summary shown at the top of an entity page ----------
// `rows` is [{ label, value, accent? }] — accent (e.g. 'gold') tints the value like the Population
// figure. Empty/falsy values are dropped by the caller before this renders, so the card just shows
// whatever's actually filled in. The copy icon puts a plain-text version on the clipboard.
// A leading numeral in a travel line ("2 days from ForgeDeep") is highlighted gold, matching the
// Population figure in QuickStatsCard — everything after it stays the muted default color.
export function TravelInfoLine({ text }) {
    const m = /^(\d+)(.*)$/.exec(text);
    if (!m)
        return React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[15], color: '#D9D2BE' } }, text);
    return React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[15], color: '#D9D2BE' } },
        React.createElement("span", { style: { color: '#C89B3C' } }, m[1]), m[2]);
}


// Travel Information card for a location: distance/time lines are derived straight from that
// location's Connected Locations (so they never fall out of sync with the actual connections),
// plus two free-text rows — Road Quality and Travel Dangers — that stay visible even empty, as a
// prompt to fill them in, since unlike QuickStatsCard this card is meant to always show its full
// shape for a location.
export function TravelInfoCard({ lines, roadQuality, travelDangers }) {
    const [copied, setCopied] = useState(false);
    const handleCopy = () => {
        const parts = [...lines];
        if (roadQuality)
            parts.push(`Road Quality\n${roadQuality}`);
        if (travelDangers)
            parts.push(`Travel Dangers\n${travelDangers}`);
        const text = parts.join('\n\n');
        if (navigator.clipboard && navigator.clipboard.writeText && text) {
            navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }).catch(() => { });
        }
    };
    return (React.createElement("div", { style: {
            position: 'relative', background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[14],
            padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[18],
        } },
        React.createElement("button", { onClick: handleCopy, title: copied ? 'Copied!' : 'Copy travel info', style: {
                position: 'absolute', top: 16, right: 16, background: 'none', border: 'none',
                color: copied ? '#C89B3C' : '#7A7A82', cursor: 'pointer', display: 'flex', padding: 4,
            } },
            React.createElement(IconCopy, null)),
        lines.length === 0 && !roadQuality && !travelDangers && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#5C5C64' } }, "Link this place to others below, or fill in road quality and travel dangers, and they'll show up here."),
        lines.map((line, i) => React.createElement(TravelInfoLine, { key: i, text: line })),
        React.createElement("div", null,
            roadQuality && React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 4 } }, "Road quality"),
            React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: roadQuality ? 15 : 15, color: roadQuality ? '#D9D2BE' : '#5C5C64' } }, roadQuality || 'Road quality')),
        React.createElement("div", null,
            travelDangers && React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 4 } }, "Travel dangers"),
            React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[15], color: travelDangers ? '#D9D2BE' : '#5C5C64' } }, travelDangers || 'Travel dangers'))));
}


// ---------- Coordinate Lock ----------
// One project-wide switch that protects every location's permanent world coordinates
// (mapX/mapY) and every map pin's on-image position from being accidentally dragged, clicked,
// or nudged into a new spot. Editing a location's name/description, zooming or resizing a map,
// and saving/reloading never touch these coordinates regardless of the lock — they're stored
// completely separately from everything else about a location — but *repositioning* (a click on
// the World Grid, or dragging a pin on an interactive map) is only allowed while unlocked.
export function CoordinateLockToggle({ locked, onToggle, compact }) {
    return (React.createElement("button", { onClick: onToggle, className: "hoverable", title: locked
            ? "Coordinates are locked \u2014 click to unlock repositioning"
            : "Coordinates are unlocked \u2014 locations can be dragged or clicked into new spots", style: {
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
            background: locked ? 'rgba(200,155,60,0.12)' : 'none',
            border: '1px solid ' + (locked ? 'rgba(200,155,60,0.4)' : '#3A3A42'),
            color: locked ? '#C89B3C' : '#A6A6AD', borderRadius: RADIUS_SCALE[8],
            padding: compact ? '6px 10px' : '7px 12px', fontSize: compact ? 11.5 : 12.5,
            fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
        } }, React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: locked ? "lock" : "unlock", size: 13 }), locked ? 'Lock Coordinates' : 'Coordinates Unlocked')));
}


// Fantasy map coordinates for a location — not real GPS, just a permanent X/Y position (0-100)
// on whatever world map grid the writer imagines. Stored as plain percentages so a future
// interactive world map can place a background image and use these directly, the same way
// MapsSection already positions pins by percentage. Clicking anywhere in the grid sets the
// current location's coordinates — unless Coordinate Lock is on, in which case the grid is
// browse-only: other located locations still show up as small reference dots you can click to
// jump to, but this location's own coordinate can't be moved by a stray click.
export function WorldGridPicker({ x, y, otherPoints, onSet, onJump, locked }) {
    const gridRef = useRef(null);
    const has = x !== '' && x !== undefined && y !== '' && y !== undefined;
    const handleClick = (e) => {
        if (locked)
            return; // Coordinate Lock: a click on the grid must never move this location
        const rect = gridRef.current.getBoundingClientRect();
        const px = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
        const py = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
        onSet(px.toFixed(1), py.toFixed(1));
    };
    return (React.createElement("div", { ref: gridRef, onClick: handleClick, title: locked ? "Coordinates are locked \u2014 unlock to reposition" : undefined, style: {
            position: 'relative', width: '100%', maxWidth: 220, aspectRatio: '1', background: '#17171B',
            border: locked ? '1px dashed #3A3A42' : '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8],
            cursor: locked ? 'not-allowed' : 'crosshair', overflow: 'hidden',
            backgroundImage: 'linear-gradient(#2A2A30 1px, transparent 1px), linear-gradient(90deg, #2A2A30 1px, transparent 1px)',
            backgroundSize: '20% 20%',
        } },
        (otherPoints || []).map((p) => (React.createElement("div", { key: p.id, title: p.name, onClick: (e) => { e.stopPropagation(); onJump(p.id); }, style: {
                position: 'absolute', left: p.x + '%', top: p.y + '%', width: 6, height: 6, borderRadius: '50%',
                background: '#5C5C64', transform: 'translate(-50%, -50%)', cursor: 'pointer',
            } }))),
        has && React.createElement("div", { style: {
                position: 'absolute', left: x + '%', top: y + '%', width: 10, height: 10, borderRadius: '50%',
                background: '#C89B3C', border: '2px solid #17171B', transform: 'translate(-50%, -50%)',
                boxShadow: '0 0 0 1px #C89B3C',
            } }),
        locked && React.createElement("div", { style: {
                position: 'absolute', top: 6, right: 6, lineHeight: 1, display: 'flex',
                background: 'rgba(15,15,18,0.85)', borderRadius: RADIUS_SCALE[5], padding: '3px 5px', pointerEvents: 'none',
            } }, React.createElement(InkIcon, { name: "lock", size: 11, color: "#C89B3C" }))));
}
