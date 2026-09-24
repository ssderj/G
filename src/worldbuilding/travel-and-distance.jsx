import React, { useState, useMemo } from 'react';
import { IconPlus } from '../shared-ui/icons.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { selectStyle } from '../shared-ui/ui-primitives.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { CONNECTION_KINDS, LOCATION_CONNECTION_LABELS } from './family-graph.jsx';
import { TravelInfoLine } from './location-types.jsx';


// Breadcrumb at the top of a location's profile — the full chain of parent locations (World →
// Continent → Kingdom …), each a clickable jump up the hierarchy, ending with the current
// location shown in place (not a link).
export function LocationBreadcrumb({ chain, current, onSelect }) {
    if (chain.length === 0)
        return null;
    return React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: SPACE_SCALE[6], marginBottom: 4, fontSize: TYPE_SCALE[13] } },
        chain.map((loc) => React.createElement(React.Fragment, { key: loc.id },
            React.createElement("button", { onClick: () => onSelect(loc.id), style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#A6A6AD', fontSize: TYPE_SCALE[13] } }, loc.name || 'Unnamed'),
            React.createElement("span", { style: { color: '#5C5C64' } }, "\u203A"))),
        React.createElement("span", { style: { color: '#EFE7D2', fontWeight: 600 } }, current.name || 'Unnamed'));
}


// One entry in a location's Connected Locations list — the other place, an inline-editable
// label describing the link, and an arrow showing which way the label reads (this location was
// the subject when the link was created, or the other one was).
export function LocationConnectionCard({ otherName, label, direction, kind, onOpen, onLabelChange, onKindChange, onRemove }) {
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '10px 14px', marginBottom: 10, flexWrap: 'wrap' } },
        React.createElement("span", { title: direction === 'out' ? 'Defined from this location' : 'Defined from the other location', style: { color: '#7A7A82', fontSize: TYPE_SCALE[15], flexShrink: 0 } }, direction === 'out' ? '\u2192' : '\u2190'),
        React.createElement("button", { onClick: onOpen, style: { background: 'none', border: 'none', padding: 0, cursor: 'pointer', flex: '1 1 140px', minWidth: 0, textAlign: 'left', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, otherName),
        React.createElement("input", { value: label, onChange: (e) => onLabelChange(e.target.value), placeholder: "Label (optional)", style: { background: '#232328', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '6px 8px', color: '#D9D2BE', fontSize: TYPE_SCALE[12.5], width: 170, flexShrink: 0 } }),
        React.createElement("select", { value: kind || 'road', onChange: (e) => onKindChange(e.target.value), title: "Which travel network the Distance Calculator routes this through", style: { background: '#232328', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '6px 8px', color: '#A6A6AD', fontSize: TYPE_SCALE[12], flexShrink: 0 } },
            CONNECTION_KINDS.map((k) => React.createElement("option", { key: k.value, value: k.value }, k.label))),
        React.createElement("button", { onClick: onOpen, style: { background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE', borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer', flexShrink: 0 } }, "Open \u2192"),
        React.createElement("button", { onClick: onRemove, title: "Remove this connection", style: { background: 'none', border: 'none', color: '#8A8A92', fontSize: TYPE_SCALE[16], cursor: 'pointer', padding: '4px 6px', flexShrink: 0, lineHeight: 1 } }, "\u00D7"));
}


// Lets the user connect the current location to any other location in the World Bible, with an
// optional label picked from a preset list (Nearby, Borders, North of, Capital of…) or typed
// freely. Locations already connected to this one are left out, since each pair links once.
export function LocationConnectionLinker({ candidates, onLink }) {
    const [otherId, setOtherId] = useState('');
    const [preset, setPreset] = useState('');
    const [label, setLabel] = useState('');
    const [kind, setKind] = useState('road');
    return React.createElement("div", { style: { marginTop: 4 } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
            React.createElement("select", { value: otherId, onChange: (e) => setOtherId(e.target.value), style: selectStyle },
                React.createElement("option", { value: "" }, "Choose a location\u2026"),
                candidates.map((c) => React.createElement("option", { key: c.id, value: c.id }, c.name || 'Unnamed'))),
            React.createElement("select", { value: preset, onChange: (e) => {
                    const p = e.target.value;
                    setPreset(p);
                    if (p && (!label.trim() || LOCATION_CONNECTION_LABELS.includes(label)))
                        setLabel(p);
                }, style: selectStyle },
                React.createElement("option", { value: "" }, "Custom label\u2026"),
                LOCATION_CONNECTION_LABELS.map((l) => React.createElement("option", { key: l, value: l }, l))),
            React.createElement("input", { value: label, onChange: (e) => setLabel(e.target.value), placeholder: "Label (optional)", style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 10px', color: '#EFE7D2', fontSize: TYPE_SCALE[13.5], width: 180 } }),
            React.createElement("select", { value: kind, onChange: (e) => setKind(e.target.value), title: "Which travel network the Distance Calculator routes this through", style: selectStyle },
                CONNECTION_KINDS.map((k) => React.createElement("option", { key: k.value, value: k.value }, k.label))),
            React.createElement("button", { disabled: !otherId, onClick: () => { onLink(otherId, label.trim(), kind); setOtherId(''); setPreset(''); setLabel(''); setKind('road'); }, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: otherId ? '#C89B3C' : '#232328', color: otherId ? '#17171B' : '#5C5C64',
                    border: 'none', borderRadius: RADIUS_SCALE[6], padding: '8px 14px', fontSize: TYPE_SCALE[13], fontWeight: 700, cursor: otherId ? 'pointer' : 'default',
                } }, React.createElement(IconPlus, null), " Link")),
        candidates.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 8 } }, "No other locations to connect \u2014 add another location first."));
}


// ---------- Distance Calculator: world-grid geometry, road/sea/portal graphs, travel times ----------
// Everything below is driven entirely by data already on the project (location coordinates,
// tagged connections, the project's km-per-grid-unit scale) — there is no per-location or
// per-kingdom code to maintain. A new location becomes routable the moment it has coordinates; a
// new road, sea lane, or portal becomes part of the network the moment it's linked and tagged.
// Kingdoms, regions, and continents need nothing special at all — they're just locations with
// coordinates like any other, so distances to/from them fall out of the same math for free.
// Standard fantasy travel-fatigue speeds, in km/day, shared by every location pair in the
// project — this is what makes the numbers consistent no matter which two places are picked.
export const TRAVEL_SPEEDS_KM_PER_DAY = { horse: 52, walking: 28, ship: 130 };


export function locationCoords(loc) {
    if (!loc || loc.mapX === '' || loc.mapX === undefined || loc.mapY === '' || loc.mapY === undefined)
        return null;
    const x = Number(loc.mapX), y = Number(loc.mapY);
    return (isNaN(x) || isNaN(y)) ? null : { x, y };
}


// Straight-line ("as the crow flies") distance between two located points, in the project's own
// km scale. The world grid is a flat 0-100 square on both axes, not a globe, so plain Pythagoras
// scaled by kmPerUnit is all this needs.
export function gridDistanceKm(a, b, kmPerUnit) {
    return Math.hypot(a.x - b.x, a.y - b.y) * kmPerUnit;
}


// One connection's real-world length: an author-supplied override if they set one (a switchback
// mountain road is longer than its straight line), otherwise derived straight from both
// locations' coordinates.
export function connectionDistanceKm(conn, locationsById, kmPerUnit) {
    if (typeof conn.distanceKm === 'number' && conn.distanceKm > 0)
        return conn.distanceKm;
    const a = locationCoords(locationsById.get(conn.fromId));
    const b = locationCoords(locationsById.get(conn.toId));
    return (a && b) ? gridDistanceKm(a, b, kmPerUnit) : null;
}


// Builds an adjacency list for one travel network (road, sea, or portal) out of every connection
// tagged with that kind. Undirected — a link routes both ways regardless of which location it was
// defined from. Any location without world coordinates is simply never reachable through it,
// rather than breaking the whole graph.
export function buildTravelGraph(locations, connections, kind, kmPerUnit) {
    const locationsById = new Map(locations.map((l) => [l.id, l]));
    const graph = new Map();
    locations.forEach((l) => graph.set(l.id, []));
    connections.filter((c) => c.kind === kind).forEach((c) => {
        const dist = connectionDistanceKm(c, locationsById, kmPerUnit);
        if (dist === null || !graph.has(c.fromId) || !graph.has(c.toId))
            return;
        graph.get(c.fromId).push({ to: c.toId, dist });
        graph.get(c.toId).push({ to: c.fromId, dist });
    });
    return graph;
}


// Plain Dijkstra over one of the graphs above. Returns { distanceKm, path: [locationId, ...] } for
// the shortest route between two locations through that network, or null when they aren't linked
// at all, directly or through any number of hops. This is how a route "goes around" a mountain
// range or coastline: it simply follows whichever chain of existing connections avoids it — no
// terrain special-casing required, and a newly added connecting road or lane is picked up
// automatically the next time this runs.
export function shortestPath(graph, fromId, toId) {
    if (!graph.has(fromId) || !graph.has(toId))
        return null;
    if (fromId === toId)
        return { distanceKm: 0, path: [fromId] };
    const dist = new Map(), prev = new Map(), visited = new Set();
    graph.forEach((_, id) => dist.set(id, Infinity));
    dist.set(fromId, 0);
    while (true) {
        let u = null, best = Infinity;
        dist.forEach((d, id) => { if (!visited.has(id) && d < best) {
            best = d;
            u = id;
        } });
        if (u === null || u === toId)
            break;
        visited.add(u);
        (graph.get(u) || []).forEach((edge) => {
            const nd = best + edge.dist;
            if (nd < dist.get(edge.to)) {
                dist.set(edge.to, nd);
                prev.set(edge.to, u);
            }
        });
    }
    if (dist.get(toId) === Infinity)
        return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) {
        cur = prev.get(cur);
        if (cur === undefined)
            return null;
        path.unshift(cur);
    }
    return { distanceKm: dist.get(toId), path };
}


// Whole-number days, by ordinary rounding rather than a strict ceiling — a well-provisioned
// journey isn't always rounded up, and this is what lines the numbers up with familiar fantasy
// travel math (e.g. ~421km reading as 8 days on horseback, 15 on foot). Minimum of 1 day for any
// nonzero distance so a trip never reports "0 days".
export function travelDays(km, speedKmPerDay) {
    if (km === null || km === undefined)
        return null;
    if (km <= 0)
        return 0;
    return Math.max(1, Math.round(km / speedKmPerDay));
}


// Full computed summary for one location pair — every number the Distance Calculator card and the
// glowing map route both need, derived entirely from stored coordinates and tagged connections.
export function computeRoute(fromLoc, toLoc, locations, connections, kmPerUnit) {
    const a = locationCoords(fromLoc), b = locationCoords(toLoc);
    if (!a || !b)
        return { unlocated: true };
    const straightKm = gridDistanceKm(a, b, kmPerUnit);
    const road = shortestPath(buildTravelGraph(locations, connections, 'road', kmPerUnit), fromLoc.id, toLoc.id);
    const sea = shortestPath(buildTravelGraph(locations, connections, 'sea', kmPerUnit), fromLoc.id, toLoc.id);
    const portal = shortestPath(buildTravelGraph(locations, connections, 'portal', kmPerUnit), fromLoc.id, toLoc.id);
    // Overland travel (horse/walking) prefers the road network when one connects the two places —
    // it's the route a traveler on the ground would actually take — and only falls back to the
    // straight-line distance (implying open, roadless country) when no road path exists at all.
    const overlandKm = road ? road.distanceKm : straightKm;
    return {
        unlocated: false, straightKm, road, sea, portal, overlandKm,
        horseDays: travelDays(overlandKm, TRAVEL_SPEEDS_KM_PER_DAY.horse),
        walkingDays: travelDays(overlandKm, TRAVEL_SPEEDS_KM_PER_DAY.walking),
        shipDays: sea ? travelDays(sea.distanceKm, TRAVEL_SPEEDS_KM_PER_DAY.ship) : null,
    };
}


// One label/value pair in the Distance Calculator result card — a small muted label followed by a
// larger line where the leading figure is picked out in gold, matching the number styling used
// everywhere else in the app (QuickStatsCard, TravelInfoLine).
export function DistanceStatRow({ label, value, muted }) {
    return React.createElement("div", null,
        React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 4 } }, label),
        React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: TYPE_SCALE[17], color: muted ? '#5C5C64' : '#D9D2BE' } }, muted ? value : React.createElement(TravelInfoLine, { text: value })));
}


// The Distance Calculator's result card: straight-line distance, road distance (if any road links
// the two places), sea route (if any sea/river lane does), portal route (if any portal does), and
// travel time on horse, on foot, and by ship. Every figure is recomputed live from whatever
// locations, coordinates, and connections currently exist in the project.
export function DistanceResultCard({ fromLoc, toLoc, route }) {
    if (!fromLoc || !toLoc)
        return React.createElement(EmptyState, { text: "Choose a destination above to calculate the distance and travel time." });
    if (route.unlocated)
        return React.createElement(EmptyState, { text: "One or both locations don't have world coordinates yet \u2014 place them on the World Grid above to calculate distance." });
    const days = (n) => n === null ? 'Unavailable' : `${n} day${n === 1 ? '' : 's'}`;
    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[14], padding: '22px 26px', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[18] } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } }, fromLoc.name || 'Unnamed', React.createElement("span", { style: { color: '#5C5C64' } }, "\u2192"), toLoc.name || 'Unnamed'),
        React.createElement(DistanceStatRow, { label: "Straight-Line Distance", value: `${Math.round(route.straightKm).toLocaleString()} km` }),
        React.createElement(DistanceStatRow, { label: "Estimated Road Distance", value: route.road ? `${Math.round(route.road.distanceKm).toLocaleString()} km` : 'No connected road route', muted: !route.road }),
        React.createElement(DistanceStatRow, { label: "Estimated Sea Route", value: route.sea ? `${Math.round(route.sea.distanceKm).toLocaleString()} km` : 'Unavailable', muted: !route.sea }),
        route.portal && React.createElement(DistanceStatRow, { label: "Portal Route", value: "Instant" }),
        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#C89B3C', textTransform: 'uppercase', letterSpacing: '0.1em', fontWeight: 600, marginBottom: 12 } }, "Travel Time"),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: SPACE_SCALE[16] } },
                React.createElement(DistanceStatRow, { label: "Horse", value: days(route.horseDays), muted: route.horseDays === null }),
                React.createElement(DistanceStatRow, { label: "Walking", value: days(route.walkingDays), muted: route.walkingDays === null }),
                React.createElement(DistanceStatRow, { label: "Ship", value: days(route.shipDays), muted: route.shipDays === null }))));
}


// Read-only preview map for the Distance Calculator: the map image with a glowing line drawn
// across it, following the same location-to-location hops the calculator's road route actually
// takes (or a straight line between the two pins when no road connects them). Pin positions are
// already stored as 0-100% of the image, which is exactly what an SVG viewBox="0 0 100 100" wants,
// so no coordinate conversion is needed here.
export function RoutePreviewMap({ map, hopLocationIds }) {
    const pins = map.pins || [];
    const points = hopLocationIds.map((id) => pins.find((p) => p.locationId === id)).filter(Boolean);
    if (points.length < 2)
        return null;
    const endpointIds = [hopLocationIds[0], hopLocationIds[hopLocationIds.length - 1]];
    return React.createElement("div", { style: { position: 'relative', width: '100%', borderRadius: RADIUS_SCALE[10], overflow: 'hidden', border: '1px solid #2A2A30', background: '#101013', lineHeight: 0 } },
        React.createElement("img", { src: map.imageUrl, alt: "", style: { width: '100%', display: 'block' } }),
        React.createElement("svg", { style: { position: 'absolute', inset: 0, width: '100%', height: '100%' }, viewBox: "0 0 100 100", preserveAspectRatio: "none" },
            React.createElement("defs", null,
                React.createElement("filter", { id: "ink-route-glow", x: "-60%", y: "-60%", width: "220%", height: "220%" },
                    React.createElement("feGaussianBlur", { stdDeviation: "1.3", result: "blur" }),
                    React.createElement("feMerge", null,
                        React.createElement("feMergeNode", { in: "blur" }),
                        React.createElement("feMergeNode", { in: "blur" }),
                        React.createElement("feMergeNode", { in: "SourceGraphic" })))),
            React.createElement("polyline", { className: "ink-route-glow-line", points: points.map((p) => `${p.x},${p.y}`).join(' '), fill: "none", stroke: "#C89B3C", strokeWidth: 0.55, strokeLinecap: "round", strokeLinejoin: "round", filter: "url(#ink-route-glow)", vectorEffect: "non-scaling-stroke" })),
        points.map((p, i) => {
            const isEndpoint = endpointIds.includes(p.locationId);
            const size = isEndpoint ? 11 : 6;
            return React.createElement("div", { key: p.locationId + i, style: {
                    position: 'absolute', left: p.x + '%', top: p.y + '%', width: size, height: size, borderRadius: '50%',
                    background: '#C89B3C', border: '2px solid #17171B', transform: 'translate(-50%, -50%)',
                    boxShadow: '0 0 8px 2px rgba(200,155,60,0.75)',
                } });
        }));
}


// Full Distance Calculator: a destination picker plus the result card and (when the two places
// happen to share a pinned map) the glowing route preview. `fromLocationId` is fixed by wherever
// this is embedded (a location's own profile) — only the destination is chosen here.
export function DistanceCalculatorPanel({ project, fromLocationId, toLocationId, onChangeTo, candidates }) {
    const fromLoc = project.locations.find((l) => l.id === fromLocationId);
    const toLoc = project.locations.find((l) => l.id === toLocationId);
    const kmPerUnit = project.worldScaleKmPerUnit || 10;
    const route = useMemo(() => (fromLoc && toLoc) ? computeRoute(fromLoc, toLoc, project.locations, project.locationConnections, kmPerUnit) : null, [fromLoc, toLoc, project.locations, project.locationConnections, kmPerUnit]);
    const previewMap = useMemo(() => {
        if (!route || route.unlocated || !fromLoc || !toLoc)
            return null;
        const roadHops = (route.road && route.road.path.length > 1) ? route.road.path : null;
        for (const m of project.maps) {
            const pins = m.pins || [];
            if (roadHops && roadHops.every((id) => pins.some((p) => p.locationId === id)))
                return { map: m, hopLocationIds: roadHops };
        }
        for (const m of project.maps) {
            const pins = m.pins || [];
            if (pins.some((p) => p.locationId === fromLoc.id) && pins.some((p) => p.locationId === toLoc.id))
                return { map: m, hopLocationIds: [fromLoc.id, toLoc.id] };
        }
        return null;
    }, [route, fromLoc, toLoc, project.maps]);
    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[16] } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], alignItems: 'center', flexWrap: 'wrap' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#A6A6AD', fontWeight: 600 } }, (fromLoc && fromLoc.name) || 'Unnamed', " \u2192"),
            React.createElement("select", { value: toLocationId || '', onChange: (e) => onChangeTo(e.target.value), style: selectStyle },
                React.createElement("option", { value: "" }, "Choose a destination\u2026"),
                candidates.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.name || 'Unnamed')))),
        candidates.length === 0 && React.createElement(EmptyState, { text: "No other locations to measure against yet \u2014 add another location first." }),
        toLoc && route && React.createElement(DistanceResultCard, { fromLoc: fromLoc, toLoc: toLoc, route: route }),
        toLoc && previewMap && React.createElement(RoutePreviewMap, { map: previewMap.map, hopLocationIds: previewMap.hopLocationIds }));
}
