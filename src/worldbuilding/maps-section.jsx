import React, { useState } from 'react';
import { inputStyle } from '../shared-ui/form-fields.jsx';
import { IconPlus, IconTrash } from '../shared-ui/icons.jsx';
import { EmptyState, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { ImagePicker, selectStyle } from '../shared-ui/ui-primitives.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InteractiveMapFrame } from './interactive-map-frame.jsx';
import { CoordinateLockToggle } from './location-types.jsx';
import { usePersistedViewState } from '../writing/project-schema-and-backups.jsx';


export function MapsSection({ maps, locations, onAddMap, onRemoveMap, onRenameMap, onAddPin, onMovePin, onRemovePin, onJumpToLocation, onSetDefaultView, askConfirm, coordinatesLocked, onToggleCoordinateLock }) {
    var _a, _b;
    // Persisted per project (not just component state) so reopening the project lands back on
    // whichever map was last open.
    const [selectedId, setSelectedId] = usePersistedViewState('selectedMapId', (_b = (_a = maps[0]) === null || _a === void 0 ? void 0 : _a.id) !== null && _b !== void 0 ? _b : null);
    const [pendingLocation, setPendingLocation] = useState('');
    const [newTitle, setNewTitle] = useState('');
    const [newUrl, setNewUrl] = useState('');
    const map = maps.find((m) => m.id === selectedId) || maps[0];
    return (React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[24], flexWrap: 'wrap' } },
        React.createElement("div", { style: { width: 220, flexShrink: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[8], marginBottom: 6 } },
                React.createElement(SectionLabel, null, "Your maps"),
                React.createElement(CoordinateLockToggle, { locked: coordinatesLocked, onToggle: onToggleCoordinateLock, compact: true })),
            maps.map((m) => (React.createElement("div", { key: m.id, onClick: () => { setSelectedId(m.id); }, className: "hoverable", style: {
                    padding: '8px 10px', borderRadius: RADIUS_SCALE[6], cursor: 'pointer', marginBottom: 2,
                    background: m.id === (map && map.id) ? '#232328' : 'transparent',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[6],
                } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13.5], color: '#D9D2BE' } }, m.title || 'Untitled map'),
                React.createElement("button", { onClick: (e) => {
                        e.stopPropagation();
                        const pinNote = m.pins && m.pins.length ? ` and its ${m.pins.length} pin${m.pins.length === 1 ? '' : 's'}` : '';
                        askConfirm(`Delete "${m.title || 'Untitled map'}"${pinNote}? This cannot be undone.`, () => {
                            onRemoveMap(m.id);
                            if (selectedId === m.id)
                                setSelectedId(null);
                        });
                    }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex' } },
                    React.createElement(IconTrash, null))))),
            React.createElement("div", { style: { marginTop: 10, padding: 10, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8] } },
                React.createElement("input", { placeholder: "Map title", value: newTitle, onChange: (e) => setNewTitle(e.target.value), style: { ...inputStyle(13, 500), marginBottom: 8 } }),
                React.createElement(ImagePicker, { value: newUrl, onChange: setNewUrl, placeholder: "Paste a map image URL\u2026" }),
                // Every other image picker in the app is bound straight to a field that's already
                // visible on the page (a portrait, a crest, a banner), so the picture appears the
                // instant it's uploaded. This one stages into `newUrl` before the map even exists,
                // so without a preview here an upload looks like it silently did nothing.
                newUrl && React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 8 } },
                    React.createElement("img", { src: newUrl, alt: "", style: { width: 44, height: 44, objectFit: 'cover', borderRadius: RADIUS_SCALE[6], border: '1px solid #2A2A30', display: 'block' } }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A9A7F' } }, "Image ready \u2014 add a title and hit Add map")),
                React.createElement("button", { disabled: !newTitle.trim() || !newUrl.trim(), onClick: () => {
                        const id = uuid();
                        onAddMap({ id, title: newTitle.trim(), imageUrl: newUrl.trim(), pins: [], coordinatesLocked: true });
                        setSelectedId(id);
                        setNewTitle('');
                        setNewUrl('');
                    }, style: {
                        marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6],
                        background: (newTitle.trim() && newUrl.trim()) ? '#C89B3C' : '#2A2A30',
                        color: (newTitle.trim() && newUrl.trim()) ? '#17171B' : '#5C5C64',
                        border: 'none', borderRadius: RADIUS_SCALE[6], padding: '7px 10px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                    } },
                    React.createElement(IconPlus, null),
                    " Add map"))),
        React.createElement("div", { style: { flex: 1, minWidth: 300 } }, !map ? (React.createElement(EmptyState, { text: "No maps yet. Upload a map image or paste a link to get started \u2014 a fantasy map, a city plan, anything." })) : (React.createElement(React.Fragment, null,
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 10, flexWrap: 'wrap' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82' } }, "Pin a location:"),
                React.createElement("select", { value: pendingLocation, onChange: (e) => setPendingLocation(e.target.value), style: selectStyle },
                    React.createElement("option", { value: "" }, "Choose location\u2026"),
                    locations.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.name || 'Unnamed'))),
                pendingLocation && React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#C89B3C' } }, "Now click on the map to place it"),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4] } },
                    React.createElement(InkIcon, { name: coordinatesLocked ? "lock" : "unlock", size: 11 }),
                    coordinatesLocked ? "Locked \u2014 existing pins can't be dragged" : "Unlocked \u2014 drag any pin to reposition it")),
            React.createElement(InteractiveMapFrame, { key: map.id, map: map, locations: locations, pendingLocation: pendingLocation, onAddPin: (mapId, pin) => { onAddPin(mapId, pin); setPendingLocation(''); }, onMovePin: onMovePin, onJumpToLocation: onJumpToLocation, onSetDefaultView: onSetDefaultView, locked: coordinatesLocked }))))));
}
