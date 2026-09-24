import React from 'react';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { EmptyState, QuickStatsCard, SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { Field, TagInput, inputStyle } from '../../shared-ui/form-fields.jsx';
import { IconPlus, IconTrash } from '../../shared-ui/icons.jsx';
import { ImageAdder, selectStyle } from '../../shared-ui/ui-primitives.jsx';
import { InkIcon } from '../../shell/ink-icon.jsx';
import { LOCATION_STATUSES, LOCATION_TYPES } from '../../worldbuilding/book-cover.jsx';
import { HouseCrest } from '../../worldbuilding/relationship-web.jsx';
import { SectionNav } from '../../worldbuilding/family-tree-gallery.jsx';
import { CoordinateLockToggle, TravelInfoCard, WorldGridPicker } from '../../worldbuilding/location-types.jsx';
import { DistanceCalculatorPanel, LocationBreadcrumb, LocationConnectionCard, LocationConnectionLinker } from '../../worldbuilding/travel-and-distance.jsx';
import { chapterLabel } from '../project-schema-and-backups.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'locations' block — only the
// state it read is now passed in as props instead of closed over.
export function LocationsTab({ activeLocation, askConfirm, chapters, distanceToId, jumpToChapter, location, locationAppearsIn, locationBreadcrumb, locationChildren, locationConnectionCandidates, locationConnections, locationImportantCharacters, locationPaneRef, locationParentCandidates, newPoiName, project, setActiveCharacter, setActiveLocation, setCharView, setDistanceToId, setNewPoiName, setSubNavOpen, setTab, status, subNavOpen, unitTerm, update }) {
    return (React.createElement("div", { className: "tab-fade", style: { display: 'flex', flex: 1, minHeight: 0, position: 'relative' } },
                subNavOpen && React.createElement("div", { className: "subnav-backdrop open", onClick: () => setSubNavOpen(false) }),
                React.createElement("div", { className: "scrollbox sub-sidebar" + (subNavOpen ? ' open' : ''), style: { width: 230, borderRight: '1px solid #2A2A30', padding: 16, overflowY: 'auto', flexShrink: 0 } },
                    React.createElement(SectionLabel, null, "Locations"),
                    project.locations.map((l) => (React.createElement("div", { key: l.id, onClick: () => { setActiveLocation(l.id); setSubNavOpen(false); }, className: "hoverable", style: {
                            padding: '9px 10px', borderRadius: RADIUS_SCALE[6], cursor: 'pointer', marginBottom: 2,
                            background: l.id === activeLocation ? '#232328' : 'transparent',
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[13.5], color: '#D9D2BE' } }, l.name || 'Unnamed'),
                        React.createElement("button", { onClick: (e) => {
                                e.stopPropagation();
                                const label = l.name && l.name.trim() ? `"${l.name.trim()}"` : 'this location';
                                askConfirm(`Delete ${label}? Its profile will be permanently lost.`, () => {
                                    update((p) => {
                                        p.locations = p.locations.filter((x) => x.id !== l.id);
                                        p.locations.forEach((x) => { if (x.parentLocationId === l.id)
                                            x.parentLocationId = ''; });
                                        p.locationConnections = p.locationConnections.filter((c) => c.fromId !== l.id && c.toId !== l.id);
                                    });
                                    if (activeLocation === l.id)
                                        setActiveLocation(null);
                                });
                            }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex' } },
                            React.createElement(IconTrash, null))))),
                    React.createElement("button", { onClick: () => update((p) => {
                            const nl = { id: uuid(), name: '', region: '', description: '', government: '', climate: '', population: '', knownFor: '', tags: [], images: [], parentLocationId: '', rulingHouseId: '', occupyingFactionId: '', previousOwner: '', locationType: '', status: '', roadQuality: '', travelDangers: '', mapX: '', mapY: '' };
                            p.locations.push(nl);
                            setActiveLocation(nl.id);
                        }), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 8, background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '7px 10px', fontSize: TYPE_SCALE[13], cursor: 'pointer', width: '100%' } },
                        React.createElement(IconPlus, null),
                        " New location")),
                React.createElement("div", { ref: locationPaneRef, style: { flex: 1, padding: '28px 40px', overflowY: 'auto', maxWidth: 640 }, className: "scrollbox" }, location ? (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[22] } },
                    React.createElement(SectionNav, { scrollRef: locationPaneRef, sections: [
                            { id: 'loc-sec-overview', label: 'Overview' },
                            { id: 'loc-sec-map', label: 'Map' },
                            { id: 'loc-sec-connections', label: 'Connections' },
                            { id: 'loc-sec-distance', label: 'Distance' },
                            { id: 'loc-sec-characters', label: 'Characters' },
                            { id: 'loc-sec-events', label: 'Events' },
                            { id: 'loc-sec-appears', label: 'Appears In' },
                            { id: 'loc-sec-images', label: 'Images' },
                        ] }),
                    React.createElement("div", { id: "loc-sec-overview", style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[22] } },
                    React.createElement(LocationBreadcrumb, { chain: locationBreadcrumb, current: location, onSelect: (id) => setActiveLocation(id) }),
                    React.createElement(QuickStatsCard, { rows: [
                            { label: 'Type', value: location.locationType },
                            { label: 'Population', value: location.population, accent: 'gold' },
                            { label: 'Controlled By', value: (project.world.find((w) => w.id === location.occupyingFactionId) || {}).topic
                                    || (project.world.find((w) => w.id === location.rulingHouseId) || {}).topic
                                    || location.government },
                            { label: 'Climate', value: location.climate },
                            { label: 'Status', value: location.status },
                        ] }),
                    React.createElement(Field, { label: "Name", value: location.name, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).name = v; }), large: true }),
                    React.createElement(TagInput, { tags: location.tags || [], onChange: (tags) => update((p) => { p.locations.find((x) => x.id === location.id).tags = tags; }) }),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Parent Location"),
                        React.createElement("select", { value: location.parentLocationId || '', onChange: (e) => update((p) => { p.locations.find((x) => x.id === location.id).parentLocationId = e.target.value; }), style: { ...selectStyle, width: '100%', maxWidth: 320 } },
                            React.createElement("option", { value: "" }, "None \u2014 top of its own hierarchy"),
                            locationParentCandidates.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.name || 'Unnamed'))),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 6 } }, "Nest this place under a larger one \u2014 a Kingdom under a Continent, a City under a Kingdom, a Castle under a City\u2026")),
                    React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: SPACE_SCALE[14] } },
                        React.createElement("div", null,
                            React.createElement(SectionLabel, null, "Type"),
                            React.createElement("select", { value: location.locationType || '', onChange: (e) => update((p) => { p.locations.find((x) => x.id === location.id).locationType = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                React.createElement("option", { value: "" }, "Unspecified"),
                                LOCATION_TYPES.map((t) => React.createElement("option", { key: t, value: t }, t)))),
                        React.createElement("div", null,
                            React.createElement(SectionLabel, null, "Status"),
                            React.createElement("select", { value: location.status || '', onChange: (e) => update((p) => { p.locations.find((x) => x.id === location.id).status = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                React.createElement("option", { value: "" }, "Unspecified"),
                                LOCATION_STATUSES.map((s) => React.createElement("option", { key: s, value: s }, s)))),
                        React.createElement(Field, { label: "Region", value: location.region, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).region = v; }) }),
                        React.createElement(Field, { label: "Government", value: location.government, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).government = v; }) }),
                        React.createElement(Field, { label: "Climate", value: location.climate, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).climate = v; }) }),
                        React.createElement(Field, { label: "Population", value: location.population, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).population = v; }) })),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Ownership"),
                        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: SPACE_SCALE[14] } },
                            React.createElement("div", null,
                                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 6 } }, "Ruling House"),
                                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                                    (location.rulingHouseId) && React.createElement(HouseCrest, { url: (project.world.find((w) => w.id === location.rulingHouseId) || {}).crestUrl || '', size: 26, radius: 7 }),
                                    React.createElement("select", { value: location.rulingHouseId || '', onChange: (e) => update((p) => { p.locations.find((x) => x.id === location.id).rulingHouseId = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                        React.createElement("option", { value: "" }, "None"),
                                        project.world.filter((w) => w.category === 'houses').map((w) => React.createElement("option", { key: w.id, value: w.id }, w.topic || 'Unnamed house')))),
                                project.world.filter((w) => w.category === 'houses').length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 4 } }, "Add a house in the World Bible first.")),
                            React.createElement("div", null,
                                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 6 } }, "Occupying Faction"),
                                React.createElement("select", { value: location.occupyingFactionId || '', onChange: (e) => update((p) => { p.locations.find((x) => x.id === location.id).occupyingFactionId = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                    React.createElement("option", { value: "" }, "None"),
                                    project.world.filter((w) => w.category === 'organizations').map((w) => React.createElement("option", { key: w.id, value: w.id }, w.topic || 'Unnamed organization'))),
                                project.world.filter((w) => w.category === 'organizations').length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 4 } }, "Add an organization in the World Bible first."))),
                        React.createElement("div", { style: { marginTop: 14 } },
                            React.createElement(Field, { label: "Previous Owner", value: location.previousOwner, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).previousOwner = v; }), placeholder: "Who held this before the current ruling house/faction\u2026" })),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 6 } }, "Track who actually holds this place \u2014 richer than a single Government label when a kingdom, occupying army, and deposed dynasty all have a claim.")),
                    React.createElement(Field, { label: "Description", value: location.description, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).description = v; }), textarea: true }),
                    React.createElement(Field, { label: "Known For", value: location.knownFor, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).knownFor = v; }), textarea: true, placeholder: "Trade, magic, a famous ruin, a legend\u2026" })),
                    React.createElement("div", { id: "loc-sec-map" },
                    React.createElement("div", null,
                        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                            React.createElement(SectionLabel, null, "Map Coordinates"),
                            React.createElement(CoordinateLockToggle, { locked: project.coordinatesLocked, onToggle: () => update((p) => { p.coordinatesLocked = !p.coordinatesLocked; }), compact: true })),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[20], flexWrap: 'wrap', alignItems: 'flex-start' } },
                            React.createElement(WorldGridPicker, {
                                x: location.mapX, y: location.mapY,
                                otherPoints: project.locations.filter((l) => l.id !== location.id && l.mapX !== '' && l.mapX !== undefined && l.mapY !== '' && l.mapY !== undefined).map((l) => ({ id: l.id, name: l.name || 'Unnamed', x: Number(l.mapX), y: Number(l.mapY) })),
                                onSet: (nx, ny) => update((p) => { const loc = p.locations.find((x) => x.id === location.id); loc.mapX = nx; loc.mapY = ny; }),
                                onJump: (id) => setActiveLocation(id),
                                locked: project.coordinatesLocked,
                            }),
                            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], minWidth: 140 } },
                                React.createElement(Field, { label: "X (0\u2013100)", value: location.mapX, disabled: project.coordinatesLocked, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).mapX = v; }) }),
                                React.createElement(Field, { label: "Y (0\u2013100)", value: location.mapY, disabled: project.coordinatesLocked, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).mapY = v; }) }))),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 8, display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[6] } }, project.coordinatesLocked
                            ? React.createElement(React.Fragment, null,
                                React.createElement(InkIcon, { name: "lock", size: 11, style: { marginTop: 2, flexShrink: 0 } }),
                                React.createElement("span", null, "Coordinates are locked \u2014 this and every other location's spot on the grid is protected from accidental clicks or edits. Unlock above to reposition."))
                            : "Not real GPS \u2014 just a spot on your own world map grid. Click inside the box or type numbers directly. Grey dots are other located places; click one to jump there. This is what the interactive world map uses to open a location on click."),
                        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 12 } },
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82' } }, "World scale: 100 grid units ="),
                            React.createElement("input", { type: "number", min: "1", value: (project.worldScaleKmPerUnit || 10) * 100, onChange: (e) => { const total = Number(e.target.value); if (total > 0)
                                    update((p) => { p.worldScaleKmPerUnit = total / 100; }); }, style: { width: 80, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '5px 8px', color: '#D9D2BE', fontSize: TYPE_SCALE[12] } }),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82' } }, "km \u2014 sets the Distance Calculator's scale for every location."))),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Points of Interest"),
                        locationChildren.length === 0
                            ? React.createElement(EmptyState, { text: "No points of interest yet \u2014 add the market, keep, temple, or harbor that makes up this place below. Each becomes its own Location." })
                            : React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8], marginBottom: 10 } }, locationChildren.map((l) => React.createElement("button", { key: l.id, onClick: () => setActiveLocation(l.id), style: {
                                    background: '#1D1D22', border: '1px solid #2A2A30', color: '#D9D2BE',
                                    borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                                } }, l.name || 'Unnamed'))),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                            React.createElement("input", { value: newPoiName, onChange: (e) => setNewPoiName(e.target.value), placeholder: "e.g. Iron Market, Great Forge, Royal Keep\u2026", onKeyDown: (e) => {
                                    if (e.key !== 'Enter' || !newPoiName.trim())
                                        return;
                                    update((p) => { p.locations.push({ id: uuid(), name: newPoiName.trim(), region: '', description: '', government: '', climate: '', population: '', knownFor: '', tags: [], images: [], parentLocationId: location.id, rulingHouseId: '', occupyingFactionId: '', previousOwner: '', locationType: '', status: '', roadQuality: '', travelDangers: '', mapX: '', mapY: '' }); });
                                    setNewPoiName('');
                                }, style: { ...inputStyle(13.5, 500), flex: 1 } }),
                            React.createElement("button", { disabled: !newPoiName.trim(), onClick: () => {
                                    if (!newPoiName.trim())
                                        return;
                                    update((p) => { p.locations.push({ id: uuid(), name: newPoiName.trim(), region: '', description: '', government: '', climate: '', population: '', knownFor: '', tags: [], images: [], parentLocationId: location.id, rulingHouseId: '', occupyingFactionId: '', previousOwner: '', locationType: '', status: '', roadQuality: '', travelDangers: '', mapX: '', mapY: '' }); });
                                    setNewPoiName('');
                                }, style: {
                                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: newPoiName.trim() ? '#C89B3C' : '#2A2A30',
                                    color: newPoiName.trim() ? '#17171B' : '#5C5C64', border: 'none', borderRadius: RADIUS_SCALE[6],
                                    padding: '0 14px', fontSize: TYPE_SCALE[13], fontWeight: 700, cursor: newPoiName.trim() ? 'pointer' : 'default',
                                } },
                                React.createElement(IconPlus, null),
                                " Add")))),
                    React.createElement("div", { id: "loc-sec-connections" },
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Connected Locations"),
                        locationConnections.length === 0
                            ? React.createElement(EmptyState, { text: "No connections yet \u2014 link this to any other location below, with an optional label like Nearby, Borders, North of, or Connected by Road." })
                            : locationConnections.map((c) => {
                                const outgoing = c.fromId === location.id;
                                const other = project.locations.find((l) => l.id === (outgoing ? c.toId : c.fromId));
                                return React.createElement(LocationConnectionCard, {
                                    key: c.id,
                                    otherName: (other && other.name) || 'Unnamed',
                                    label: c.label || '',
                                    direction: outgoing ? 'out' : 'in',
                                    kind: c.kind || 'road',
                                    onOpen: () => other && setActiveLocation(other.id),
                                    onLabelChange: (val) => update((p) => { const conn = p.locationConnections.find((x) => x.id === c.id); if (conn)
                                        conn.label = val; }),
                                    onKindChange: (val) => update((p) => { const conn = p.locationConnections.find((x) => x.id === c.id); if (conn)
                                        conn.kind = val; }),
                                    onRemove: () => update((p) => { p.locationConnections = p.locationConnections.filter((x) => x.id !== c.id); }),
                                });
                            }),
                        React.createElement("div", { style: { marginTop: 10 } },
                            React.createElement(LocationConnectionLinker, {
                                candidates: locationConnectionCandidates,
                                onLink: (otherId, label, kind) => update((p) => { p.locationConnections.push({ id: uuid(), fromId: location.id, toId: otherId, label, kind, distanceKm: null }); }),
                            }))),
                    React.createElement("div", { id: "loc-sec-distance" },
                        React.createElement(SectionLabel, null, "Distance Calculator"),
                        React.createElement(DistanceCalculatorPanel, {
                            project: project,
                            fromLocationId: location.id,
                            toLocationId: distanceToId,
                            onChangeTo: setDistanceToId,
                            candidates: project.locations.filter((l) => l.id !== location.id),
                        })),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Travel Information"),
                        React.createElement(TravelInfoCard, {
                            lines: locationConnections.map((c) => {
                                const outgoing = c.fromId === location.id;
                                const other = project.locations.find((l) => l.id === (outgoing ? c.toId : c.fromId));
                                const name = (other && other.name) || 'Unnamed';
                                const label = (c.label || '').trim();
                                if (!label)
                                    return `Connected to ${name}`;
                                return outgoing ? `${label} to ${name}` : `${label} from ${name}`;
                            }),
                            roadQuality: location.roadQuality,
                            travelDangers: location.travelDangers,
                        }),
                        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: SPACE_SCALE[14], marginTop: 12 } },
                            React.createElement(Field, { label: "Road Quality", value: location.roadQuality, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).roadQuality = v; }), placeholder: "Paved, muddy in autumn, impassable in winter\u2026" }),
                            React.createElement(Field, { label: "Travel Dangers", value: location.travelDangers, onChange: (v) => update((p) => { p.locations.find((x) => x.id === location.id).travelDangers = v; }), placeholder: "Bandits, wolves, a cursed forest\u2026" })),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 6 } }, "Distances and travel times come straight from Connected Locations above \u2014 set a label there like \"2 days\" or \"1 hour\" and it shows up here automatically."))),
                    React.createElement("div", { id: "loc-sec-characters" },
                        React.createElement(SectionLabel, null, "Important Characters"),
                        (() => {
                            const chars = locationImportantCharacters;
                            return chars.length === 0 ? (React.createElement(EmptyState, { text: "No characters linked yet. Mention this place and a character in the same chapter to connect them." })) : (React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8] } }, chars.map((c) => (React.createElement("button", { key: c.id, onClick: () => { setTab('characters'); setCharView('list'); setActiveCharacter(c.id); }, style: {
                                    background: '#1D1D22', border: '1px solid #2A2A30', color: '#D9D2BE',
                                    borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                                } }, c.name || 'Unnamed')))));
                        })()),
                    React.createElement("div", { id: "loc-sec-events" },
                        React.createElement(SectionLabel, null, "Events"),
                        (() => {
                            // Every timeline event tagged with this location shows up here automatically —
                            // tag an event from here, from a character's Life Events, or from the full
                            // Timeline tab, and it appears in all three places since they all read from
                            // the same project.timeline array.
                            const events = project.timeline.filter((ev) => ev.locationId === location.id);
                            return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
                                events.length === 0 ? React.createElement(EmptyState, { text: "No events here yet. Tag a timeline event with this location and it'll show up automatically." }) : events.map((ev) => React.createElement("div", { key: ev.id, style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'flex-start', background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: 10 } },
                                    React.createElement("div", { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
                                        React.createElement("input", { placeholder: "When (e.g. 'Year 3, dry season')", value: ev.when, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).when = e.target.value; }), style: inputStyle(12.5, 600) }),
                                        React.createElement("input", { placeholder: "What happened", value: ev.what, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).what = e.target.value; }), style: inputStyle(13, 400) })),
                                    React.createElement("button", { onClick: () => {
                                            const label = ev.when && ev.when.trim() ? `"${ev.when.trim()}"` : 'this event';
                                            askConfirm(`Delete ${label}? This cannot be undone.`, () => update((p) => { p.timeline = p.timeline.filter((x) => x.id !== ev.id); }));
                                        }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex', paddingTop: 4 } },
                                        React.createElement(IconTrash, null)))),
                                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 2 } },
                                    React.createElement("button", { onClick: () => update((p) => { p.timeline.push({ id: uuid(), when: '', what: '', characterId: '', locationId: location.id }); }), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '7px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer' } },
                                        React.createElement(IconPlus, null),
                                        " Add event"),
                                    React.createElement("button", { onClick: () => setTab('timeline'), style: { background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12.5], cursor: 'pointer' } }, "View full timeline \u2192")));
                        })()),
                    React.createElement("div", { id: "loc-sec-appears" },
                        React.createElement(SectionLabel, null, "Appears In"),
                        (() => {
                            const inChapters = locationAppearsIn;
                            return inChapters.length === 0 ? (React.createElement(EmptyState, { text: "Not mentioned in any chapter yet. Use @ in the manuscript to link it in." })) : (React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8] } }, inChapters.map((c) => (React.createElement("button", { key: c.id, onClick: () => jumpToChapter(c.id), style: {
                                    background: '#1D1D22', border: '1px solid #2A2A30', color: '#D9D2BE',
                                    borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                                } }, chapterLabel(project.chapters, c.id, unitTerm))))));
                        })()),
                    React.createElement("div", { id: "loc-sec-images" },
                        React.createElement(SectionLabel, null, "Images"),
                        (location.images || []).length > 0 && (React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[10], marginBottom: 10 } }, location.images.map((img) => (React.createElement("div", { key: img.id, style: { position: 'relative' } },
                            React.createElement("img", { src: img.url, alt: "", style: { width: 96, height: 96, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], border: '1px solid #2A2A30', display: 'block' } }),
                            React.createElement("button", { onClick: () => update((p) => {
                                    const loc = p.locations.find((x) => x.id === location.id);
                                    loc.images = loc.images.filter((i) => i.id !== img.id);
                                }), style: {
                                    position: 'absolute', top: -6, right: -6, background: '#1D1D22', border: '1px solid #2A2A30',
                                    borderRadius: '50%', width: 20, height: 20, color: '#A6A6AD', cursor: 'pointer',
                                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[12], lineHeight: 1,
                                } }, "\u00D7")))))),
                        React.createElement(ImageAdder, { onAdd: (url) => update((p) => {
                                const loc = p.locations.find((x) => x.id === location.id);
                                loc.images = [...(loc.images || []), { id: uuid(), url }];
                            }) })))) : React.createElement(EmptyState, { text: "No location selected. Add one to start mapping your world." }))));
}
