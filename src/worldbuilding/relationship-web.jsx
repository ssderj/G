import React, { useState, useEffect, useRef, useMemo } from 'react';
import { inputStyle } from '../shared-ui/form-fields.jsx';
import { IconPlus, IconTrash } from '../shared-ui/icons.jsx';
import { EmptyState, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { selectStyle } from '../shared-ui/ui-primitives.jsx';
import { zoomBtnStyle } from '../shared-ui/zoom-btn-style.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { FAMILY_RELATIONSHIP_TYPES, buildFamilyGraph, computeGenerations, familyKindTag, familyTypeMeta } from './family-graph.jsx';


// ---------- Relationship web ----------
export let d3LoadPromise = null;


export function loadD3() {
    if (window.d3)
        return Promise.resolve(window.d3);
    if (!d3LoadPromise) {
        d3LoadPromise = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js';
            s.onload = () => resolve(window.d3);
            s.onerror = () => { d3LoadPromise = null; reject(new Error('d3 failed to load')); };
            document.head.appendChild(s);
        });
    }
    return d3LoadPromise;
}


export function RelationshipWeb({ characters, autoEdges, manualEdges, onSelectCharacter, houses }) {
    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const zoomBehaviorRef = useRef(null);
    const hasFittedRef = useRef(false);
    const prevCountRef = useRef(-1);
    const [size, setSize] = useState({ w: 800, h: 520 });
    const [positions, setPositions] = useState({});
    const [hoverEdge, setHoverEdge] = useState(null);
    const [view, setView] = useState({ x: 0, y: 0, k: 1 });
    const [isPanning, setIsPanning] = useState(false);
    const [d3Status, setD3Status] = useState(window.d3 ? 'ready' : 'loading'); // 'loading' | 'ready' | 'error'
    useEffect(() => {
        let cancelled = false;
        loadD3()
            .then(() => { if (!cancelled)
            setD3Status('ready'); })
            .catch(() => { if (!cancelled)
            setD3Status('error'); });
        return () => { cancelled = true; };
    }, []);
    useEffect(() => {
        const el = containerRef.current;
        if (!el)
            return;
        const ro = new ResizeObserver((entries) => {
            const r = entries[0].contentRect;
            setSize({ w: Math.max(320, r.width), h: Math.max(360, r.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    const combinedLinks = useMemo(() => {
        const manual = manualEdges.map((r) => ({ source: r.fromId, target: r.toId, weight: 2, kind: 'manual', label: r.label }));
        return [...autoEdges, ...manual].filter((e) => characters.some((c) => c.id === e.source) && characters.some((c) => c.id === e.target));
    }, [autoEdges, manualEdges, characters]);
    // Larger casts need more breathing room to stay readable, so the simulation runs in a
    // virtual world that grows with the character count; the fit-to-screen zoom (below) then
    // scales that whole world down to whatever the viewport can show, so nothing ever spills
    // outside the visible canvas regardless of how many characters are in play.
    const n = characters.length;
    const worldScale = Math.max(1, Math.sqrt(n / 9));
    const worldW = size.w * Math.max(1.3, worldScale);
    const worldH = size.h * Math.max(1.3, worldScale);
    const linkDistance = 100 + Math.min(70, n * 2.2);
    const chargeStrength = -240 - Math.min(520, n * 7);
    const collideRadius = 44 + Math.min(28, n * 0.6);
    useEffect(() => {
        if (d3Status !== 'ready')
            return;
        if (characters.length === 0)
            return;
        const nodes = characters.map((c) => ({ id: c.id }));
        const links = combinedLinks.map((l) => ({ ...l }));
        const sim = d3.forceSimulation(nodes)
            .force('link', d3.forceLink(links).id((d) => d.id).distance(linkDistance).strength(0.35))
            .force('charge', d3.forceManyBody().strength(chargeStrength))
            .force('center', d3.forceCenter(worldW / 2, worldH / 2))
            .force('collide', d3.forceCollide(collideRadius))
            .stop();
        for (let i = 0; i < 300; i++)
            sim.tick();
        const pos = {};
        nodes.forEach((n2) => { pos[n2.id] = { x: n2.x, y: n2.y }; });
        setPositions(pos);
    }, [d3Status, characters, combinedLinks, worldW, worldH, linkDistance, chargeStrength, collideRadius]);
    // Computes the pan/zoom transform that fits every node (plus its label) inside the
    // current viewport, with a little breathing room at the edges.
    const computeFitTransform = () => {
        const pts = characters.map((c) => positions[c.id]).filter(Boolean);
        if (pts.length === 0)
            return null;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        pts.forEach((p) => {
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        });
        // Pad for node radius, house crest badge, and the name label rendered below each node.
        minX -= 46; maxX += 46; minY -= 30; maxY += 52;
        const bboxW = Math.max(1, maxX - minX);
        const bboxH = Math.max(1, maxY - minY);
        const margin = 48;
        const rawScale = Math.min((size.w - margin * 2) / bboxW, (size.h - margin * 2) / bboxH);
        const k = Math.max(0.12, Math.min(1.6, rawScale));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        return { k, x: size.w / 2 - cx * k, y: size.h / 2 - cy * k };
    };
    const fitToScreen = (animated) => {
        const zoom = zoomBehaviorRef.current;
        const svgEl = svgRef.current;
        if (!zoom || !svgEl)
            return;
        const fit = computeFitTransform();
        if (!fit)
            return;
        const target = d3.zoomIdentity.translate(fit.x, fit.y).scale(fit.k);
        const sel = d3.select(svgEl);
        if (animated) {
            sel.transition().duration(500).ease(d3.easeCubicOut).call(zoom.transform, target);
        }
        else {
            sel.call(zoom.transform, target);
        }
    };
    // Wire up d3-zoom once (handles wheel zoom, drag-to-pan, and touch pinch-to-zoom out of
    // the box) and keep our own React state in sync with its transform on every event.
    useEffect(() => {
        if (d3Status !== 'ready' || !svgRef.current)
            return;
        const zoom = d3.zoom()
            .scaleExtent([0.1, 3])
            .on('start', () => setIsPanning(true))
            .on('zoom', (event) => { setView({ x: event.transform.x, y: event.transform.y, k: event.transform.k }); })
            .on('end', () => setIsPanning(false));
        zoomBehaviorRef.current = zoom;
        const sel = d3.select(svgRef.current);
        sel.call(zoom);
        // Nodes open a character's profile on tap/click — d3-zoom's built-in double-click (and
        // double-tap) zoom-in would otherwise fight with that, so it's turned off here.
        sel.on('dblclick.zoom', null);
        return () => { sel.on('.zoom', null); };
    }, [d3Status]);
    // Fit to screen automatically the first time the graph loads, and again whenever the
    // cast size changes (new layout), so the whole web is always framed on arrival.
    useEffect(() => {
        if (d3Status !== 'ready')
            return;
        if (Object.keys(positions).length === 0)
            return;
        if (!hasFittedRef.current) {
            fitToScreen(false);
            hasFittedRef.current = true;
            prevCountRef.current = n;
        }
        else if (prevCountRef.current !== n) {
            fitToScreen(true);
            prevCountRef.current = n;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [positions, d3Status, n]);
    if (characters.length === 0) {
        return React.createElement(EmptyState, { text: "No characters yet. Add a few in the Characters tab, then mention them in your manuscript to see how they connect." });
    }
    if (d3Status === 'error') {
        return React.createElement(EmptyState, { text: "Couldn't load the graphing library — check your connection and reopen this tab to retry. Everything else in Inkroot still works fine." });
    }
    if (d3Status === 'loading') {
        return React.createElement(EmptyState, { text: "Loading the relationship graph\u2026" });
    }
    const isolated = characters.filter((c) => !combinedLinks.some((l) => l.source === c.id || l.target === c.id));
    return (React.createElement("div", null,
        React.createElement("div", { ref: containerRef, style: { width: '100%', height: '58vh', minHeight: 360, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], position: 'relative', overflow: 'hidden' } },
            React.createElement("svg", { ref: svgRef, width: size.w, height: size.h, style: { display: 'block', touchAction: 'none', cursor: isPanning ? 'grabbing' : 'grab' } },
                React.createElement("g", { transform: `translate(${view.x},${view.y}) scale(${view.k})` },
                    combinedLinks.map((l, i) => {
                        const a = positions[l.source];
                        const b = positions[l.target];
                        if (!a || !b)
                            return null;
                        const isManual = l.kind === 'manual';
                        return (React.createElement("g", { key: i, onMouseEnter: () => setHoverEdge({ ...l, dataX: (a.x + b.x) / 2, dataY: (a.y + b.y) / 2 }), onMouseLeave: () => setHoverEdge(null) },
                            React.createElement("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: isManual ? '#5BA893' : '#C89B3C', strokeOpacity: isManual ? 0.85 : Math.min(0.85, 0.28 + l.weight * 0.12), strokeWidth: isManual ? 2 : Math.min(5, 1 + l.weight) })));
                    }),
                    characters.map((c) => {
                        const p = positions[c.id];
                        if (!p)
                            return null;
                        const house = c.houseId && houses ? houses.find((h) => h.id === c.houseId) : null;
                        return (React.createElement("g", { key: c.id, transform: `translate(${p.x},${p.y})`, className: "ink-node ink-node-in", style: { cursor: 'pointer' }, onClick: () => onSelectCharacter(c.id) },
                            React.createElement("circle", { r: 22, fill: "#232328", stroke: "#C89B3C", strokeWidth: 1.5 }),
                            React.createElement("text", { textAnchor: "middle", dy: 4, fontSize: TYPE_SCALE[11], fill: "#EFE7D2", fontFamily: "Inter, sans-serif", fontWeight: 600 }, (c.name || '?').slice(0, 2).toUpperCase()),
                            React.createElement("text", { textAnchor: "middle", y: 38, fontSize: TYPE_SCALE[12], fill: "#D9D2BE", fontFamily: "Inter, sans-serif" }, c.name || 'Unnamed'),
                            house && (house.crestUrl
                                ? React.createElement("g", null,
                                    React.createElement("clipPath", { id: `crest-clip-${c.id}` }, React.createElement("circle", { cx: 16, cy: 16, r: 9 })),
                                    React.createElement("circle", { cx: 16, cy: 16, r: 10, fill: "#17171B", stroke: "#C89B3C", strokeWidth: 1 }),
                                    React.createElement("image", { href: house.crestUrl, x: 7, y: 7, width: 18, height: 18, clipPath: `url(#crest-clip-${c.id})` }))
                                : React.createElement("g", null,
                                    React.createElement("circle", { cx: 16, cy: 16, r: 10, fill: "#17171B", stroke: "#C89B3C", strokeWidth: 1 }),
                                    React.createElement("text", { x: 16, y: 20, textAnchor: "middle", fontSize: TYPE_SCALE[10] }, "\u{1F6E1}\uFE0F")))));
                    }))),
            hoverEdge && (React.createElement("div", { style: {
                    position: 'absolute', left: view.x + hoverEdge.dataX * view.k, top: view.y + hoverEdge.dataY * view.k, transform: 'translate(-50%, -130%)',
                    background: '#0F0F12', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '5px 9px',
                    fontSize: TYPE_SCALE[12], color: '#EFE7D2', pointerEvents: 'none', whiteSpace: 'nowrap',
                } }, hoverEdge.kind === 'manual' ? (hoverEdge.label || 'connected') : `mentioned together in ${hoverEdge.weight} chapter${hoverEdge.weight > 1 ? 's' : ''}`)),
            React.createElement("button", {
                onClick: () => fitToScreen(true),
                title: "Recenter and fit the whole web in view",
                style: {
                    position: 'absolute', top: 10, right: 10, zIndex: 2,
                    background: '#232328', color: '#EFE7D2', border: '1px solid #C89B3C',
                    borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                    fontFamily: 'Inter, sans-serif', cursor: 'pointer',
                },
            }, "\u2921 Reset View")),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[18], marginTop: 12, fontSize: TYPE_SCALE[12], color: '#7A7A82', flexWrap: 'wrap' } },
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#C89B3C', marginRight: 6, verticalAlign: 'middle' } }),
                "appear together in text (thicker = more often)"),
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#5BA893', marginRight: 6, verticalAlign: 'middle' } }),
                "relationship you defined"),
            React.createElement("span", null, "scroll or pinch to zoom \u00b7 drag to pan")),
        isolated.length > 0 && (React.createElement("div", { style: { marginTop: 14, fontSize: TYPE_SCALE[12.5], color: '#7A7A82' } },
            "Not yet connected: ",
            isolated.map((c) => c.name || 'Unnamed').join(', ')))));
}


export function RelationshipManager({ characters, relationships, onAdd, onRemove, askConfirm }) {
    const [fromId, setFromId] = useState('');
    const [toId, setToId] = useState('');
    const [relType, setRelType] = useState(''); // '' (custom) or a FAMILY_RELATIONSHIP_TYPES value
    const [label, setLabel] = useState('');
    const canAdd = fromId && toId && fromId !== toId && (label.trim() || relType);
    // Every preset's default label, so switching presets swaps a still-untouched label but never
    // clobbers something the person typed themselves.
    const presetLabels = FAMILY_RELATIONSHIP_TYPES.map((t) => t.label.toLowerCase());
    return (React.createElement("div", { style: { marginTop: 24, maxWidth: 560 } },
        React.createElement(SectionLabel, null, "Define a relationship"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
            React.createElement("select", { value: fromId, onChange: (e) => setFromId(e.target.value), style: selectStyle },
                React.createElement("option", { value: "" }, "Character A\u2026"),
                characters.map((c) => React.createElement("option", { key: c.id, value: c.id }, c.name || 'Unnamed'))),
            React.createElement("select", { value: relType, onChange: (e) => {
                    const rt = e.target.value;
                    setRelType(rt);
                    const meta = familyTypeMeta(rt);
                    if (meta && (!label.trim() || presetLabels.includes(label.toLowerCase())))
                        setLabel(meta.label.toLowerCase());
                }, style: selectStyle },
                React.createElement("option", { value: "" }, "Custom label\u2026"),
                React.createElement("optgroup", { label: "Family relationship" }, FAMILY_RELATIONSHIP_TYPES.map((t) => React.createElement("option", { key: t.value, value: t.value }, t.label)))),
            React.createElement("input", { value: label, onChange: (e) => setLabel(e.target.value), placeholder: "e.g. rival, mentor, ally", style: { ...inputStyle(13.5, 400), background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '8px 10px', width: 180 } }),
            React.createElement("select", { value: toId, onChange: (e) => setToId(e.target.value), style: selectStyle },
                React.createElement("option", { value: "" }, "Character B\u2026"),
                characters.map((c) => React.createElement("option", { key: c.id, value: c.id }, c.name || 'Unnamed'))),
            React.createElement("button", { disabled: !canAdd, onClick: () => {
                    const meta = familyTypeMeta(relType);
                    const rel = { id: uuid(), fromId, toId, label: label.trim() || (meta ? meta.label.toLowerCase() : '') };
                    if (meta)
                        rel.familyKind = meta.familyKind;
                    onAdd(rel);
                    setFromId('');
                    setToId('');
                    setRelType('');
                    setLabel('');
                }, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: canAdd ? '#C89B3C' : '#2A2A30',
                    color: canAdd ? '#17171B' : '#5C5C64', border: 'none', borderRadius: RADIUS_SCALE[6], padding: '8px 12px',
                    fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: canAdd ? 'pointer' : 'default',
                } },
                React.createElement(IconPlus, null),
                " Add")),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 6 } }, "Pick a family relationship (Parent, Spouse, Sibling, Grandparent, Uncle/Aunt, Cousin, Adoptive Parent\u2026) to feed the family trees \u2014 a custom label like Friend, Rival, Mentor, or Enemy only shows on the relationship web."),
        relationships.length > 0 && (React.createElement("div", { style: { marginTop: 14, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } }, relationships.map((r) => {
            const a = characters.find((c) => c.id === r.fromId);
            const b = characters.find((c) => c.id === r.toId);
            const tag = familyKindTag(r);
            return (React.createElement("div", { key: r.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: TYPE_SCALE[13], color: '#D9D2BE', background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '7px 10px' } },
                React.createElement("span", null,
                    React.createElement("strong", { style: { color: '#EFE7D2' } }, (a === null || a === void 0 ? void 0 : a.name) || 'Unnamed'),
                    " \u2014 ",
                    r.label,
                    " \u2014 ",
                    React.createElement("strong", { style: { color: '#EFE7D2' } }, (b === null || b === void 0 ? void 0 : b.name) || 'Unnamed'),
                    tag && React.createElement("span", { style: { color: '#5BA893', fontSize: TYPE_SCALE[11], marginLeft: 8 } }, `\u00B7 ${tag}`)),
                React.createElement("button", { onClick: () => askConfirm(`Remove the "${r.label}" link between ${(a === null || a === void 0 ? void 0 : a.name) || 'Unnamed'} and ${(b === null || b === void 0 ? void 0 : b.name) || 'Unnamed'}?`, () => onRemove(r.id)), style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex' } },
                    React.createElement(IconTrash, null))));
        })))));
}


// ---------- Family tree (shared rendering for the per-character tree and the World Bible house/clan tree) ----------
// Traditional genealogy layout: parents sit directly above their children, spouses sit side by
// side as a "couple unit", and siblings land on the same row automatically because they share a
// generation number. Only family-kind edges are ever passed in here (never autoEdges or custom
// relationship-web labels), so this view always reflects blood, marriage, and adoption only.
export const TREE_NODE_R = 26;


export const TREE_LEAF_W = 168;

 // horizontal pitch between sibling "slots"
export const TREE_ROW_H = 150;

 // vertical pitch between generations
export const TREE_COUPLE_GAP = 68;

 // distance between two spouses' node centers within one couple unit
export function computeFamilyTreeLayout(memberIds, characters, relationships, graph) {
    if (!memberIds || memberIds.length === 0)
        return { persons: [], edges: [], brackets: [], width: 0, height: 0 };
    const idSet = new Set(memberIds);
    const byId = (id) => characters.find((c) => c.id === id);
    const gen = computeGenerations(memberIds, graph);
    const memberIndex = {};
    memberIds.forEach((id, i) => { memberIndex[id] = i; });
    // 1. Union-find spouses into couple units so married partners are laid out as one block.
    const ufParent = {};
    memberIds.forEach((id) => { ufParent[id] = id; });
    const find = (x) => { while (ufParent[x] !== x) { ufParent[x] = ufParent[ufParent[x]]; x = ufParent[x]; } return x; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb)
        ufParent[ra] = rb; };
    memberIds.forEach((id) => (graph.spousesOf[id] || []).forEach((sp) => { if (idSet.has(sp))
        union(id, sp); }));
    const unitMembers = {};
    memberIds.forEach((id) => { const r = find(id); (unitMembers[r] = unitMembers[r] || []).push(id); });
    Object.values(unitMembers).forEach((members) => members.sort((a, b) => memberIndex[a] - memberIndex[b]));
    const unitIds = Object.keys(unitMembers);
    const unitKeyOf = (id) => find(id);
    const unitGen = {};
    unitIds.forEach((u) => { unitGen[u] = Math.min(...unitMembers[u].map((id) => gen[id])); });
    const idxOfUnit = (u) => Math.min(...unitMembers[u].map((id) => memberIndex[id]));
    // 2. Choose one parent-unit per unit: a direct parent/adoptive edge wins; failing that, a
    // grandparent or uncle/aunt edge is used so those relatives still land in a sensible spot
    // (drawn with a lighter "skip a generation" connector rather than a solid parent line).
    const parentUnitOf = {};
    unitIds.forEach((u) => {
        let found = null;
        for (const id of unitMembers[u]) {
            const parents = (graph.parentsOf[id] || []).filter((p) => idSet.has(p) && unitKeyOf(p) !== u);
            if (parents.length) {
                found = { unit: unitKeyOf(parents[0]), style: 'direct' };
                break;
            }
        }
        if (!found)
            for (const id of unitMembers[u]) {
                const gps = (graph.grandparentsOf[id] || []).filter((p) => idSet.has(p) && unitKeyOf(p) !== u);
                if (gps.length) {
                    found = { unit: unitKeyOf(gps[0]), style: 'skip' };
                    break;
                }
            }
        if (!found)
            for (const id of unitMembers[u]) {
                const aunts = (graph.unclesAuntsOf[id] || []).filter((p) => idSet.has(p) && unitKeyOf(p) !== u);
                if (aunts.length) {
                    found = { unit: unitKeyOf(aunts[0]), style: 'skip' };
                    break;
                }
            }
        if (found)
            parentUnitOf[u] = found;
    });
    // Defensively break any accidental cycle so layout can never infinite-loop.
    unitIds.forEach((u) => {
        const seen = new Set();
        let cur = u;
        while (parentUnitOf[cur]) {
            if (seen.has(cur)) {
                delete parentUnitOf[u];
                break;
            }
            seen.add(cur);
            cur = parentUnitOf[cur].unit;
        }
    });
    const childUnitsOf = {};
    unitIds.forEach((u) => { childUnitsOf[u] = []; });
    unitIds.forEach((u) => { const p = parentUnitOf[u]; if (p)
        childUnitsOf[p.unit].push({ unit: u, style: p.style }); });
    unitIds.forEach((u) => childUnitsOf[u].sort((a, b) => idxOfUnit(a.unit) - idxOfUnit(b.unit)));
    const rootUnits = unitIds.filter((u) => !parentUnitOf[u]);
    rootUnits.sort((a, b) => unitGen[a] - unitGen[b] || idxOfUnit(a) - idxOfUnit(b));
    // 3. Tidy-tree style X assignment: leaves get sequential slots, parents center over children.
    let leafCursor = 0;
    const unitX = {};
    const visiting = new Set();
    function layoutUnit(u) {
        if (unitX[u] !== undefined || visiting.has(u))
            return unitX[u] || 0;
        visiting.add(u);
        const children = childUnitsOf[u] || [];
        if (children.length === 0) {
            unitX[u] = leafCursor;
            leafCursor += 1;
        }
        else {
            const xs = children.map((c) => layoutUnit(c.unit));
            unitX[u] = (Math.min(...xs) + Math.max(...xs)) / 2;
        }
        visiting.delete(u);
        return unitX[u];
    }
    rootUnits.forEach((u) => layoutUnit(u));
    unitIds.forEach((u) => { if (unitX[u] === undefined) {
        unitX[u] = leafCursor;
        leafCursor += 1;
    } });
    // 4. Convert unit slot + generation into pixel coordinates, one node per person.
    const persons = [];
    const nodePos = {};
    unitIds.forEach((u) => {
        const members = unitMembers[u];
        const cx = unitX[u] * TREE_LEAF_W;
        const y = unitGen[u] * TREE_ROW_H;
        const totalWidth = (members.length - 1) * TREE_COUPLE_GAP;
        members.forEach((id, i) => {
            const x = cx - totalWidth / 2 + i * TREE_COUPLE_GAP;
            nodePos[id] = { x, y };
            const person = byId(id);
            if (person)
                persons.push({ id, x, y, person });
        });
    });
    // 5. Edges: spouse lines, parent→child elbow connectors (with a shared horizontal "bus" when
    // there's more than one child), and lateral dashed lines for uncle/aunt & cousin links that
    // weren't already used as the hierarchy connector above.
    const edges = [];
    const adoptivePairs = new Set();
    (relationships || []).forEach((r) => {
        if (r.familyKind === 'adoptiveParent')
            adoptivePairs.add(r.fromId + '|' + r.toId);
        if (r.familyKind === 'adoptedChild')
            adoptivePairs.add(r.toId + '|' + r.fromId);
    });
    const unitCenterX = (u) => {
        const members = unitMembers[u];
        return members.reduce((s, id) => s + nodePos[id].x, 0) / members.length;
    };
    unitIds.forEach((u) => {
        const members = unitMembers[u];
        for (let i = 0; i < members.length - 1; i++) {
            const a = nodePos[members[i]], b = nodePos[members[i + 1]];
            edges.push({ kind: 'spouse', x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
    });
    unitIds.forEach((u) => {
        const children = childUnitsOf[u] || [];
        if (children.length === 0)
            return;
        const parentX = unitCenterX(u);
        const parentY = unitGen[u] * TREE_ROW_H;
        const childTops = children.map((c) => ({ unit: c.unit, style: c.style, x: unitX[c.unit] * TREE_LEAF_W, y: unitGen[c.unit] * TREE_ROW_H }));
        const nearestChildY = Math.min(...childTops.map((c) => c.y));
        const busY = parentY + (nearestChildY - parentY) / 2;
        const isAdoptive = children.some((c) => unitMembers[c.unit].some((childId) => unitMembers[u].some((parentId) => adoptivePairs.has(parentId + '|' + childId))));
        edges.push({ kind: 'trunk', dashed: isAdoptive, x1: parentX, y1: parentY + TREE_NODE_R, x2: parentX, y2: busY });
        if (childTops.length > 1) {
            const minX = Math.min(...childTops.map((c) => c.x));
            const maxX = Math.max(...childTops.map((c) => c.x));
            edges.push({ kind: 'bus', dashed: false, x1: minX, y1: busY, x2: maxX, y2: busY });
        }
        childTops.forEach((c) => {
            edges.push({ kind: c.style === 'skip' ? 'skip-branch' : 'branch', dashed: c.style === 'skip', x1: c.x, y1: busY, x2: c.x, y2: c.y - TREE_NODE_R });
        });
    });
    // Cousin links (always lateral) and any uncle/aunt link not already used for hierarchy.
    const hierarchyPairs = new Set();
    unitIds.forEach((u) => { const p = parentUnitOf[u]; if (p && p.style === 'skip')
        unitMembers[u].concat(unitMembers[p.unit]).forEach((a) => unitMembers[u].concat(unitMembers[p.unit]).forEach((b) => { if (a !== b)
            hierarchyPairs.add(a + '|' + b); })); });
    (relationships || []).forEach((r) => {
        if (!nodePos[r.fromId] || !nodePos[r.toId])
            return;
        if (r.familyKind === 'cousin' || (r.familyKind === 'auncle' && !hierarchyPairs.has(r.fromId + '|' + r.toId))) {
            const a = nodePos[r.fromId], b = nodePos[r.toId];
            edges.push({ kind: 'lateral', dashed: true, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
        }
    });
    // 6. Sibling brackets: a short horizontal bar linking root-level siblings that have no shared
    // parent in this tree, so the sibling bond is still visible even without an ancestor node.
    const brackets = [];
    const siblingSeen = new Set();
    rootUnits.forEach((u) => {
        if (unitMembers[u].length !== 1)
            return;
        const id = unitMembers[u][0];
        if (siblingSeen.has(id))
            return;
        const sibIds = (graph.siblingsOf[id] || []).filter((sid) => idSet.has(sid) && rootUnits.includes(unitKeyOf(sid)) && unitMembers[unitKeyOf(sid)].length === 1);
        const groupIds = [id, ...sibIds].filter((sid) => !siblingSeen.has(sid));
        if (groupIds.length > 1) {
            groupIds.forEach((sid) => siblingSeen.add(sid));
            const xs = groupIds.map((sid) => nodePos[sid].x);
            const y = nodePos[id].y - TREE_NODE_R - 16;
            brackets.push({ minX: Math.min(...xs), maxX: Math.max(...xs), y, ids: groupIds });
        }
    });
    const allX = persons.map((p) => p.x);
    const allY = persons.map((p) => p.y);
    const minX = Math.min(...allX) - TREE_LEAF_W / 2, maxX = Math.max(...allX) + TREE_LEAF_W / 2;
    const minY = Math.min(...allY) - TREE_ROW_H / 2, maxY = Math.max(...allY) + TREE_ROW_H / 2;
    return { persons, edges, brackets, minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
}


// Pinch-to-zoom + pan + tap-to-select SVG canvas. Works with mouse (wheel to zoom, drag to pan)
// and touch (one-finger drag to pan, two-finger pinch to zoom); a tap that didn't move the view
// opens that person's profile.
export function FamilyTreeCanvas({ memberIds, characters, relationships, onSelectCharacter, focusId, emptyText, height }) {
    const containerRef = useRef(null);
    const svgRef = useRef(null);
    const [size, setSize] = useState({ w: 800, h: 480 });
    const [transform, setTransform] = useState({ x: 0, y: 0, k: 1 });
    const gestureRef = useRef({ pointers: new Map(), moved: 0, pinch: null });
    const graph = useMemo(() => buildFamilyGraph(relationships), [relationships]);
    const layout = useMemo(() => computeFamilyTreeLayout(memberIds, characters, relationships, graph), [memberIds, characters, relationships, graph]);
    useEffect(() => {
        const el = containerRef.current;
        if (!el)
            return;
        const ro = new ResizeObserver((entries) => {
            const r = entries[0].contentRect;
            setSize({ w: Math.max(280, r.width), h: Math.max(280, r.height) });
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);
    // Center + fit the tree the first time it renders (and whenever the member set changes shape).
    useEffect(() => {
        if (!layout.persons.length)
            return;
        const pad = 60;
        const kx = size.w / (layout.width + pad * 2);
        const ky = size.h / (layout.height + pad * 2);
        const k = Math.min(1, Math.max(0.25, Math.min(kx, ky)));
        const cx = (layout.minX + layout.maxX) / 2;
        const cy = (layout.minY + layout.maxY) / 2;
        setTransform({ x: size.w / 2 - cx * k, y: size.h / 2 - cy * k, k });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layout.persons.length, layout.minX, layout.minY, layout.maxX, layout.maxY, size.w, size.h]);
    const clampK = (k) => Math.min(2.5, Math.max(0.2, k));
    const zoomAround = (screenX, screenY, factor) => {
        setTransform((t) => {
            const newK = clampK(t.k * factor);
            const worldX = (screenX - t.x) / t.k;
            const worldY = (screenY - t.y) / t.k;
            return { k: newK, x: screenX - worldX * newK, y: screenY - worldY * newK };
        });
    };
    useEffect(() => {
        const el = containerRef.current;
        if (!el)
            return;
        const handler = (e) => {
            e.preventDefault();
            const rect = el.getBoundingClientRect();
            zoomAround(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.12 : 1 / 1.12);
        };
        el.addEventListener('wheel', handler, { passive: false });
        return () => el.removeEventListener('wheel', handler);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    const pointFromEvent = (e) => {
        const rect = containerRef.current.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onPointerDown = (e) => {
        containerRef.current.setPointerCapture(e.pointerId);
        gestureRef.current.pointers.set(e.pointerId, pointFromEvent(e));
        gestureRef.current.moved = 0;
        if (gestureRef.current.pointers.size === 2) {
            const pts = Array.from(gestureRef.current.pointers.values());
            gestureRef.current.pinch = {
                dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
                k: transform.k,
            };
        }
    };
    const onPointerMove = (e) => {
        if (!gestureRef.current.pointers.has(e.pointerId))
            return;
        const prev = gestureRef.current.pointers.get(e.pointerId);
        const cur = pointFromEvent(e);
        gestureRef.current.pointers.set(e.pointerId, cur);
        const pointers = Array.from(gestureRef.current.pointers.values());
        if (pointers.length === 2 && gestureRef.current.pinch) {
            const dist = Math.hypot(pointers[0].x - pointers[1].x, pointers[0].y - pointers[1].y);
            const midX = (pointers[0].x + pointers[1].x) / 2, midY = (pointers[0].y + pointers[1].y) / 2;
            const scaleFactor = dist / (gestureRef.current.pinch.dist || dist);
            const newK = clampK(gestureRef.current.pinch.k * scaleFactor);
            setTransform((t) => {
                const worldX = (midX - t.x) / t.k, worldY = (midY - t.y) / t.k;
                return { k: newK, x: midX - worldX * newK, y: midY - worldY * newK };
            });
            gestureRef.current.moved += 4;
        }
        else if (pointers.length === 1) {
            const dx = cur.x - prev.x, dy = cur.y - prev.y;
            gestureRef.current.moved += Math.abs(dx) + Math.abs(dy);
            setTransform((t) => ({ ...t, x: t.x + dx, y: t.y + dy }));
        }
    };
    const endGesture = (e) => {
        const wasTap = gestureRef.current.pointers.size <= 1 && gestureRef.current.moved < 6;
        gestureRef.current.pointers.delete(e.pointerId);
        if (gestureRef.current.pointers.size < 2)
            gestureRef.current.pinch = null;
        if (wasTap) {
            const target = e.target.closest && e.target.closest('[data-person-id]');
            if (target)
                onSelectCharacter(target.getAttribute('data-person-id'));
        }
        gestureRef.current.moved = 0;
    };
    if (!memberIds || memberIds.length === 0) {
        return React.createElement(EmptyState, { text: emptyText || "No family links yet \u2014 mark relationships as Parent of, Spouse of, or Sibling of to build the tree." });
    }
    const edgeColor = { spouse: '#C89B3C', trunk: '#3A3A42', bus: '#3A3A42', branch: '#3A3A42', 'skip-branch': '#5C5C64', lateral: '#5BA893' };
    return React.createElement("div", null,
        React.createElement("div", { ref: containerRef, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: endGesture, onPointerCancel: endGesture, style: {
                width: '100%', height: height || '56vh', minHeight: 320, background: '#1D1D22', border: '1px solid #2A2A30',
                borderRadius: RADIUS_SCALE[10], position: 'relative', overflow: 'hidden', touchAction: 'none', cursor: 'grab',
            } },
            React.createElement("svg", { ref: svgRef, width: size.w, height: size.h, style: { display: 'block' } },
                React.createElement("g", { transform: `translate(${transform.x},${transform.y}) scale(${transform.k})` },
                    layout.edges.map((e, i) => React.createElement("line", { key: i, x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2, stroke: edgeColor[e.kind] || '#3A3A42', strokeWidth: e.kind === 'spouse' ? 2.5 : 1.75, strokeDasharray: e.dashed ? '5,4' : undefined, strokeLinecap: "round" })),
                    layout.brackets.map((b, i) => React.createElement("line", { key: 'bracket-' + i, x1: b.minX, y1: b.y, x2: b.maxX, y2: b.y, stroke: "#5BA893", strokeWidth: 1.75, strokeDasharray: "5,4", strokeLinecap: "round" })),
                    layout.persons.map((p) => React.createElement("g", { key: p.id, "data-person-id": p.id, transform: `translate(${p.x},${p.y})`, className: "ink-node ink-node-in", style: { cursor: 'pointer' } },
                        React.createElement("circle", { r: TREE_NODE_R, fill: "#232328", stroke: p.id === focusId ? '#C89B3C' : '#3A3A42', strokeWidth: p.id === focusId ? 2.5 : 1.5 }),
                        p.person.portraitUrl
                            ? React.createElement("image", { href: p.person.portraitUrl, x: -TREE_NODE_R, y: -TREE_NODE_R, width: TREE_NODE_R * 2, height: TREE_NODE_R * 2, clipPath: "circle(" + TREE_NODE_R + "px)" })
                            : React.createElement("text", { textAnchor: "middle", dy: 5, fontSize: TYPE_SCALE[13], fill: "#EFE7D2", fontFamily: "Inter, sans-serif", fontWeight: 600 }, (p.person.name || '?').slice(0, 2).toUpperCase()),
                        React.createElement("text", { textAnchor: "middle", y: TREE_NODE_R + 18, fontSize: TYPE_SCALE[12.5], fill: "#D9D2BE", fontFamily: "Inter, sans-serif" }, p.person.name || 'Unnamed'))))),
            React.createElement("div", { style: { position: 'absolute', right: 10, bottom: 10, display: 'flex', gap: SPACE_SCALE[6] } },
                React.createElement("button", { onClick: () => zoomAround(size.w / 2, size.h / 2, 1 / 1.3), style: zoomBtnStyle }, "\u2212"),
                React.createElement("button", { onClick: () => zoomAround(size.w / 2, size.h / 2, 1.3), style: zoomBtnStyle }, "+")),
            React.createElement("div", { style: { position: 'absolute', left: 10, bottom: 10, fontSize: TYPE_SCALE[11], color: '#5C5C64', background: 'rgba(15,15,18,0.7)', borderRadius: RADIUS_SCALE[4], padding: '3px 7px' } }, "Drag to pan \u00B7 pinch or scroll to zoom \u00B7 tap a person to open them")),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[16], marginTop: 10, fontSize: TYPE_SCALE[11.5], color: '#7A7A82', flexWrap: 'wrap' } },
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#C89B3C', marginRight: 6, verticalAlign: 'middle' } }),
                "spouses"),
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#3A3A42', marginRight: 6, verticalAlign: 'middle' } }),
                "parent \u2192 child"),
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#5C5C64', marginRight: 6, verticalAlign: 'middle', borderTop: '2px dashed #5C5C64' } }),
                "grandparent / adoptive"),
            React.createElement("span", null,
                React.createElement("span", { style: { display: 'inline-block', width: 10, height: 2, background: '#5BA893', marginRight: 6, verticalAlign: 'middle', borderTop: '2px dashed #5BA893' } }),
                "uncle-aunt / cousin / sibling bracket")));
}


// Kept as the public name every call site already uses (character page, house tree, generated
// tree) so upgrading the rendering here upgrades all three "View Tree" / "Generate Family Tree"
// entry points at once.
export function FamilyTreeView({ memberIds, characters, relationships, onSelectCharacter, emptyText, focusId, height }) {
    return React.createElement(FamilyTreeCanvas, { memberIds, characters, relationships, onSelectCharacter, emptyText, focusId, height });
}


// Full-screen overlay used to present a family tree from either the World Bible or a character's page.
export function FamilyTreeModal({ title, subtitle, crestUrl, memberIds, characters, relationships, onSelectCharacter, onClose, emptyText, focusId }) {
    return React.createElement("div", { className: "ink-modal-backdrop", onMouseDown: (e) => { if (e.target === e.currentTarget)
            onClose(); }, style: {
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)', zIndex: 4000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { className: "ink-modal-panel", style: { background: '#17171B', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], width: '100%', maxWidth: 960, maxHeight: '88vh', display: 'flex', flexDirection: 'column' } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '20px 24px', borderBottom: '1px solid #2A2A30' } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12] } },
                    crestUrl !== undefined && React.createElement(HouseCrest, { url: crestUrl, size: 38 }),
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[21], fontWeight: 600, color: '#EFE7D2' } }, title),
                        subtitle && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 3 } }, subtitle))),
                React.createElement("button", { onClick: onClose, style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[22], cursor: 'pointer', lineHeight: 1, padding: 0 } }, "\u00D7")),
            React.createElement("div", { style: { padding: '22px 24px', flex: 1, minHeight: 0, display: 'flex' } },
                React.createElement(FamilyTreeCanvas, { memberIds, characters, relationships, onSelectCharacter, emptyText, focusId, height: '100%' }))));
}


// A House/Clan's wide banner — used as the header background on its profile page (and in its
// card preview). When no banner has been uploaded, falls back to a themed gold/dark gradient so
// the header still looks intentional rather than blank. The dark overlay atop a real photo keeps
// the title and crest legible regardless of the image underneath.
export function houseBannerBackground(url) {
    if (url) {
        return {
            backgroundImage: `linear-gradient(180deg, rgba(23,23,27,0.25), rgba(23,23,27,0.9)), url("${url}")`,
            backgroundSize: 'cover', backgroundPosition: 'center',
        };
    }
    return {
        background: 'linear-gradient(135deg, rgba(200,155,60,0.22), rgba(23,23,27,0.94) 65%), radial-gradient(circle at 85% 20%, rgba(200,155,60,0.16), transparent 55%)',
    };
}


// A House/Clan's crest — shows the uploaded image or pasted URL wherever the house is
// represented (gallery card, profile header, family tree, relationship web…). Falls back to a
// plain shield glyph when no crest has been set, so every house still reads as a house. A soft
// shadow keeps it reading clearly when overlaid on a banner image.
export function HouseCrest({ url, size, radius }) {
    const r = radius === undefined ? Math.round(size * 0.28) : radius;
    return React.createElement("div", { style: {
            width: size, height: size, borderRadius: r, background: 'rgba(200,155,60,0.14)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            overflow: 'hidden', border: '1px solid rgba(200,155,60,0.3)', boxShadow: '0 6px 16px rgba(0,0,0,0.35)',
        } }, url
        ? React.createElement("img", { src: url, style: { width: '100%', height: '100%', objectFit: 'cover' }, onError: (e) => { e.currentTarget.style.display = 'none'; } })
        : React.createElement("span", { style: { fontSize: Math.round(size * 0.5), lineHeight: 1, opacity: 0.75 } }, "\u{1F6E1}\uFE0F"));
}


// One House & Clan's tile in the Family Trees gallery — its own card, not another row in a list.
export function FamilyTreeCard({ house, crestUrl, memberCount, generationCount, onOpen }) {
    const [hover, setHover] = useState(false);
    return React.createElement("button", { onClick: onOpen, onMouseEnter: () => setHover(true), onMouseLeave: () => setHover(false), style: {
            display: 'flex', flexDirection: 'column', textAlign: 'left', cursor: 'pointer', width: '100%',
            background: hover ? '#232328' : '#1D1D22', border: '1px solid ' + (hover ? '#3A3A42' : '#2A2A30'),
            borderRadius: RADIUS_SCALE[14], padding: '20px 20px 16px', gap: SPACE_SCALE[16], transition: 'background 0.12s, border-color 0.12s',
        } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12] } },
            React.createElement(HouseCrest, { url: crestUrl, size: 44 }),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2', lineHeight: 1.25 } }, house.topic || 'Unnamed house')),
        React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[3] } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD' } },
                React.createElement("span", { style: { color: '#C89B3C', fontWeight: 700 } }, memberCount), " Member", memberCount === 1 ? '' : 's'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD' } },
                React.createElement("span", { style: { color: '#C89B3C', fontWeight: 700 } }, generationCount), " Generation", generationCount === 1 ? '' : 's')),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 4, paddingTop: 14, borderTop: '1px solid #2A2A30', fontSize: TYPE_SCALE[13], fontWeight: 600, color: '#C89B3C' } }, "Open \u2192"));
}
