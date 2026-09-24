import React from 'react';
import { NavScrollBox } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { MapsSection } from '../../worldbuilding/maps-section.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'maps' block — only the
// state it read is now passed in as props instead of closed over.
export function MapsTab({ askConfirm, handleJump, project, projectId, update }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-maps`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Maps"),
                React.createElement(MapsSection, { maps: project.maps, locations: project.locations, onAddMap: (m) => update((p) => { p.maps.push(m); }), onRemoveMap: (id) => update((p) => { p.maps = p.maps.filter((x) => x.id !== id); }), onAddPin: (mapId, pin) => update((p) => { p.maps.find((x) => x.id === mapId).pins.push(pin); }), onMovePin: (mapId, pinId, x, y) => update((p) => { const m = p.maps.find((x) => x.id === mapId); const pin = m && m.pins.find((pn) => pn.id === pinId); if (pin) { pin.x = x; pin.y = y; } }), onRemovePin: (mapId, pinId) => update((p) => { const m = p.maps.find((x) => x.id === mapId); m.pins = m.pins.filter((pn) => pn.id !== pinId); }), onSetDefaultView: (mapId, camera) => update((p) => { p.maps.find((x) => x.id === mapId).defaultCamera = camera; }), onJumpToLocation: (id) => handleJump('location', id), askConfirm: askConfirm, coordinatesLocked: project.coordinatesLocked, onToggleCoordinateLock: () => update((p) => { p.coordinatesLocked = !p.coordinatesLocked; }) })));
}
