import React, { useState, useRef, useMemo } from 'react';
import { IconCompass } from '../shared-ui/icons.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { LocationLegendModal } from './family-tree-gallery.jsx';
import { getLocationTypeMeta } from './location-types.jsx';
import { usePersistedViewStateDebounced } from '../writing/project-schema-and-backups.jsx';


// ---------- Maps: pin locations onto a reference image ----------
// A pannable, zoomable, rotatable "camera" over a single map image, plus the floating "Jump to
// Map" home button that drives it. The button smoothly animates pan, zoom, and rotation back to
// the default world-overview camera (centered, unrotated, unzoomed) — this is what will later
// serve as the home button for the full interactive world map.
export function InteractiveMapFrame({ map, locations, pendingLocation, onAddPin, onMovePin, onJumpToLocation, onSetDefaultView, locked }) {
    const IDENTITY_CAMERA = { x: 0, y: 0, k: 1, rotation: 0 };
    // Jump to Map returns to this map's saved home view if one has been set (via the 📌 button
    // below), otherwise it falls back to the plain centered/unrotated/unzoomed default.
    const homeCamera = map.defaultCamera || IDENTITY_CAMERA;
    // Persisted per map id so reopening the project restores the exact pan/zoom/rotation you left
    // this map at — writes are debounced (see the hook) so dragging/zooming stays smooth.
    const [camera, setCamera] = usePersistedViewStateDebounced('mapCamera:' + map.id, homeCamera, 400);
    // While actively dragging/wheeling we turn the transition off so panning feels immediate —
    // it only comes back on for the animated "Jump to Map" reset (and the rotate/zoom buttons).
    const [interacting, setInteracting] = useState(false);
    const [imgError, setImgError] = useState(false);
    // Which pin is hovered (enlarge + name/type tooltip) and which is selected (glows/pulses and
    // stays highlighted until a different pin is clicked).
    const [hoveredPinId, setHoveredPinId] = useState(null);
    const [selectedPinId, setSelectedPinId] = useState(null);
    // Hovering an entry in the Nearby Locations panel glows that pin on the map (distinct from
    // hoveredPinId, which is driven by hovering the pin itself, and from selectedPinId's pulse).
    const [panelHighlightId, setPanelHighlightId] = useState(null);
    const [legendOpen, setLegendOpen] = useState(false);
    // Rendered size of the map image, captured on load — used to convert pin positions (stored
    // as % of the unrotated/unzoomed image) into real distances for the Nearby Locations panel,
    // so a wide map and a tall map both report distance relative to their own proportions.
    const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
    // Coordinate Lock gates dragging an existing pin into a new spot. draggingPin holds a live,
    // uncommitted position while a drag is in progress — the real map.pins entry (and every
    // other pin) is untouched until the drag ends, and nothing happens at all while locked.
    const [draggingPin, setDraggingPin] = useState(null); // { id, x, y }
    const pinDragStartRef = useRef(null); // { clientX, clientY }, for the moved-vs-click threshold
    const pinMovedRef = useRef(false);
    // Set true when a drag actually moved the pin, so the click event that follows pointerup
    // doesn't also fire the normal "select + jump to location" behavior.
    const suppressPinClickRef = useRef(false);
    const dragRef = useRef(null);
    // Tracks whether a pointerdown-to-pointerup turned into an actual pan, so a plain click on
    // empty map background (see handleImageClick) can deselect the current pin without every
    // small pan-and-release also deselecting it.
    const dragMovedRef = useRef(false);
    const viewportRef = useRef(null);
    const imgRef = useRef(null);
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const jumpToMap = () => {
        dragRef.current = null;
        setInteracting(false);
        setCamera(map.defaultCamera || IDENTITY_CAMERA);
    };
    const zoomBy = (factor) => setCamera((c) => ({ ...c, k: clamp(c.k * factor, 0.4, 4) }));
    const rotateBy = (deg) => setCamera((c) => ({ ...c, rotation: c.rotation + deg }));
    const onWheel = (e) => {
        e.preventDefault();
        setInteracting(false);
        zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1);
    };
    const onPointerDown = (e) => {
        if (pendingLocation)
            return; // don't start a pan when the next click is meant to drop a pin
        e.currentTarget.setPointerCapture(e.pointerId);
        setInteracting(true);
        dragMovedRef.current = false;
        dragRef.current = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y };
    };
    const onPointerMove = (e) => {
        const drag = dragRef.current;
        if (!drag)
            return;
        if (Math.abs(e.clientX - drag.startX) > 4 || Math.abs(e.clientY - drag.startY) > 4)
            dragMovedRef.current = true;
        const nx = drag.camX + (e.clientX - drag.startX);
        const ny = drag.camY + (e.clientY - drag.startY);
        setCamera((c) => ({ ...c, x: nx, y: ny }));
    };
    const endDrag = () => { dragRef.current = null; setInteracting(false); };
    // Pins are stored as a plain % position within the *unrotated, unzoomed* image. A click or
    // drag lands in screen space, which has already been panned/rotated/scaled by the camera, so
    // we have to undo that transform (in reverse order: un-translate, un-rotate, un-scale) to
    // find where on the actual image the pointer landed — otherwise a pin dropped or dragged
    // while the map is zoomed or rotated ends up in the wrong place.
    const screenToImagePercent = (clientX, clientY) => {
        const viewportRect = viewportRef.current.getBoundingClientRect();
        const imgW = imgRef.current.offsetWidth;
        const imgH = imgRef.current.offsetHeight;
        const screenX = clientX - viewportRect.left;
        const screenY = clientY - viewportRect.top;
        // Undo the centering + pan translate.
        const sx = screenX - (viewportRect.width / 2 - imgW / 2) - camera.x;
        const sy = screenY - (viewportRect.height / 2 - imgH / 2) - camera.y;
        // Undo the rotation.
        const rad = (-camera.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = sx * cos - sy * sin;
        const ry = sx * sin + sy * cos;
        // Undo the zoom, then land back in the image's own local coordinates.
        const localX = imgW / 2 + rx / camera.k;
        const localY = imgH / 2 + ry / camera.k;
        return { x: clamp((localX / imgW) * 100, 0, 100), y: clamp((localY / imgH) * 100, 0, 100) };
    };
    const handleImageClick = (e) => {
        if (!viewportRef.current || !imgRef.current)
            return;
        if (!pendingLocation) {
            // Pins and cluster badges stop propagation before this handler runs, so a click that
            // reaches here landed on empty map background. Treat that as "deselect" — collapsing
            // the Nearby Locations panel — unless it was actually the release of a pan gesture.
            if (!dragMovedRef.current)
                setSelectedPinId(null);
            return;
        }
        const { x, y } = screenToImagePercent(e.clientX, e.clientY);
        onAddPin(map.id, { id: uuid(), locationId: pendingLocation, x, y });
    };
    // Zoom smoothly into a cluster's average position — same forward transform used to place
    // pins on screen, run in reverse (mirrors screenToImagePercent's un-transform) so the point
    // the cluster sits on ends up centered in the viewport once the new camera settles.
    // Shared centering math (mirrors screenToImagePercent's un-transform, run forward): given a
    // pin's stored %-position and a target zoom, re-centers the camera so that point sits in the
    // middle of the viewport. Used both by cluster zoom-in and by "move the camera there" from a
    // pin or a Nearby Locations panel entry.
    const centerOnPoint = (xPercent, yPercent, targetK) => {
        if (!imgRef.current)
            return;
        const imgW = imgRef.current.offsetWidth;
        const imgH = imgRef.current.offsetHeight;
        const localX = (xPercent / 100) * imgW - imgW / 2;
        const localY = (yPercent / 100) * imgH - imgH / 2;
        const kNew = clamp(targetK, 0.4, 4);
        const rad = (camera.rotation * Math.PI) / 180;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const rx = localX * cos - localY * sin;
        const ry = localX * sin + localY * cos;
        setInteracting(false);
        setCamera((c) => ({ ...c, x: -rx * kNew, y: -ry * kNew, k: kNew }));
    };
    const zoomToCluster = (avgXPercent, avgYPercent) => centerOnPoint(avgXPercent, avgYPercent, camera.k * 2.2);
    // Clicking a Nearby Locations entry selects that pin and flies the camera to it, nudging the
    // zoom in a little (but never zooming back out) so the newly-focused location is easy to see.
    const flyToPin = (pin) => {
        setSelectedPinId(pin.id);
        centerOnPoint(pin.x, pin.y, Math.max(camera.k, 1.6));
    };
    // Group pins that sit close together into a single cluster badge. The clustering radius
    // shrinks as you zoom in (divided by camera.k), so at high zoom every pin gets its own full
    // icon, and at low zoom nearby pins collapse into a count badge to cut down on clutter.
    const clusters = useMemo(() => {
        const CLUSTER_BASE_PERCENT = 6;
        const threshold = CLUSTER_BASE_PERCENT / Math.max(camera.k, 0.15);
        const entries = (map.pins || []).map((pin) => ({ pin, loc: locations.find((l) => l.id === pin.locationId) }));
        const used = new Array(entries.length).fill(false);
        const groups = [];
        for (let i = 0; i < entries.length; i++) {
            if (used[i])
                continue;
            const group = [entries[i]];
            used[i] = true;
            // A pin actively being dragged is never merged into a cluster with others — it's
            // rendered solo at its live position until the drag ends, so the group it belonged
            // to doesn't jump around mid-drag.
            const iIsDragging = draggingPin && entries[i].pin.id === draggingPin.id;
            if (!iIsDragging) {
                for (let j = i + 1; j < entries.length; j++) {
                    if (used[j])
                        continue;
                    if (draggingPin && entries[j].pin.id === draggingPin.id)
                        continue;
                    const dx = entries[i].pin.x - entries[j].pin.x;
                    const dy = entries[i].pin.y - entries[j].pin.y;
                    if (Math.sqrt(dx * dx + dy * dy) < threshold) {
                        group.push(entries[j]);
                        used[j] = true;
                    }
                }
            }
            groups.push(group);
        }
        return groups;
    }, [map.pins, locations, camera.k, draggingPin && draggingPin.id]);
    const selectedPin = selectedPinId ? (map.pins || []).find((p) => p.id === selectedPinId) : null;
    // Every other pin on this map, with distance (as a % of the map's diagonal — there's no
    // real-world scale to a fantasy map, so this reports "how far across the map" rather than a
    // fabricated unit) and compass direction from the selected pin. Recomputed whenever the
    // selection, the pins, or the map image's rendered size changes.
    const nearbyList = useMemo(() => {
        if (!selectedPin)
            return [];
        const w = imgSize.w || 1;
        const h = imgSize.h || 1;
        const diag = Math.sqrt(w * w + h * h) || 1;
        const DIRECTIONS = ['North', 'North-East', 'East', 'South-East', 'South', 'South-West', 'West', 'North-West'];
        return (map.pins || [])
            .filter((p) => p.id !== selectedPin.id)
            .map((p) => {
            const loc = locations.find((l) => l.id === p.locationId);
            const dxPx = ((p.x - selectedPin.x) / 100) * w;
            const dyPx = ((p.y - selectedPin.y) / 100) * h; // screen-space: positive y = down
            const distancePercent = (Math.sqrt(dxPx * dxPx + dyPx * dyPx) / diag) * 100;
            const bearing = (Math.atan2(dxPx, -dyPx) * 180 / Math.PI + 360) % 360; // 0° = up = North
            const direction = DIRECTIONS[Math.round(bearing / 45) % 8];
            return { pin: p, meta: getLocationTypeMeta(loc && loc.locationType), name: (loc && loc.name) || 'Unnamed', distancePercent, direction };
        })
            .sort((a, b) => a.distancePercent - b.distancePercent);
    }, [selectedPin && selectedPin.id, selectedPin && selectedPin.x, selectedPin && selectedPin.y, map.pins, locations, imgSize.w, imgSize.h]);
    return (React.createElement("div", { ref: viewportRef, className: "map-viewport", style: {
            position: 'relative', width: '100%', height: 480, maxHeight: '60vh', overflow: 'hidden',
            border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], background: '#0D0D10', touchAction: 'none',
            cursor: interacting ? 'grabbing' : (pendingLocation ? 'crosshair' : 'grab'),
        }, onWheel: onWheel, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: endDrag, onPointerLeave: endDrag, onPointerCancel: endDrag },
        imgError ? (React.createElement("div", { style: { padding: 60, color: '#5C5C64', fontSize: TYPE_SCALE[13], textAlign: 'center' } }, "Couldn't load that image. Check the URL.")) : (React.createElement("div", { style: {
                position: 'absolute', left: '50%', top: '50%', display: 'inline-block',
                transform: `translate(-50%, -50%) translate(${camera.x}px, ${camera.y}px) rotate(${camera.rotation}deg) scale(${camera.k})`,
                transition: interacting ? 'none' : 'transform 1.4s cubic-bezier(0.22, 1, 0.36, 1)',
                transformOrigin: 'center center',
            } },
            React.createElement("img", { ref: imgRef, className: "map-viewport-image", src: map.imageUrl, alt: "", draggable: false, onError: () => setImgError(true), onLoad: (e) => setImgSize({ w: e.currentTarget.offsetWidth, h: e.currentTarget.offsetHeight }), onClick: handleImageClick, style: {
                    display: 'block', maxWidth: 640, maxHeight: 480, width: 'auto', height: 'auto', userSelect: 'none',
                } }),
            clusters.map((group) => {
                if (group.length === 1) {
                    const { pin, loc } = group[0];
                    const meta = getLocationTypeMeta(loc && loc.locationType);
                    const Icon = meta.icon;
                    const isSelected = selectedPinId === pin.id;
                    const isHovered = hoveredPinId === pin.id;
                    const isPanelGlow = panelHighlightId === pin.id;
                    const isDragging = !!draggingPin && draggingPin.id === pin.id;
                    // While this pin is being dragged, render it at the live uncommitted position
                    // instead of its stored one — map.pins itself isn't touched until drop.
                    const dispX = isDragging ? draggingPin.x : pin.x;
                    const dispY = isDragging ? draggingPin.y : pin.y;
                    return (React.createElement("div", { key: pin.id, className: "ink-loc-pin ink-marker-in" + (isSelected ? ' selected' : '') + (isHovered ? ' hovered' : '') + (isPanelGlow ? ' panel-glow' : '') + (isDragging ? ' dragging' : ''), onMouseEnter: () => setHoveredPinId(pin.id), onMouseLeave: () => setHoveredPinId((h) => (h === pin.id ? null : h)), onClick: (e) => {
                            e.stopPropagation();
                            if (suppressPinClickRef.current) {
                                suppressPinClickRef.current = false;
                                setSelectedPinId(pin.id);
                                return;
                            }
                            setSelectedPinId(pin.id);
                            onJumpToLocation(pin.locationId);
                        }, onPointerDown: (e) => {
                            if (locked || pendingLocation)
                                return; // Coordinate Lock is on (or a new pin is about to be dropped) — let this bubble to the normal pan handling instead
                            e.stopPropagation();
                            e.currentTarget.setPointerCapture(e.pointerId);
                            pinDragStartRef.current = { clientX: e.clientX, clientY: e.clientY };
                            pinMovedRef.current = false;
                            setDraggingPin({ id: pin.id, x: pin.x, y: pin.y });
                        }, onPointerMove: (e) => {
                            if (!draggingPin || draggingPin.id !== pin.id)
                                return;
                            const start = pinDragStartRef.current;
                            if (start && (Math.abs(e.clientX - start.clientX) > 3 || Math.abs(e.clientY - start.clientY) > 3))
                                pinMovedRef.current = true;
                            const { x, y } = screenToImagePercent(e.clientX, e.clientY);
                            setDraggingPin({ id: pin.id, x, y });
                        }, onPointerUp: (e) => {
                            if (!draggingPin || draggingPin.id !== pin.id)
                                return;
                            if (pinMovedRef.current) {
                                onMovePin && onMovePin(map.id, pin.id, draggingPin.x, draggingPin.y);
                                suppressPinClickRef.current = true;
                            }
                            setDraggingPin(null);
                        }, onPointerCancel: () => setDraggingPin(null), style: {
                            position: 'absolute', left: dispX + '%', top: dispY + '%', transform: 'translate(-50%, -100%)',
                            zIndex: isSelected || isHovered || isPanelGlow || isDragging ? 6 : 1,
                            cursor: locked ? undefined : (isDragging ? 'grabbing' : 'grab'),
                        } },
                        (isHovered || isSelected || isDragging) && React.createElement("div", { className: "ink-loc-tooltip" },
                            React.createElement("div", { style: { fontWeight: 600 } }, (loc && loc.name) || 'Unnamed'),
                            React.createElement("div", { className: "type" }, isDragging ? 'Repositioning\u2026' : meta.label)),
                        React.createElement("div", { className: "ink-loc-pin-icon", style: { background: meta.color, color: '#17171B' } },
                            React.createElement(Icon, null))));
                }
                const avgX = group.reduce((s, g) => s + g.pin.x, 0) / group.length;
                const avgY = group.reduce((s, g) => s + g.pin.y, 0) / group.length;
                const clusterKey = group.map((g) => g.pin.id).join('-');
                return (React.createElement("div", { key: clusterKey, onClick: (e) => { e.stopPropagation(); zoomToCluster(avgX, avgY); }, title: `${group.length} locations \u2014 click to zoom in`, style: {
                        position: 'absolute', left: avgX + '%', top: avgY + '%', transform: 'translate(-50%, -50%)', zIndex: 2,
                    } },
                    React.createElement("div", { className: "ink-loc-cluster" }, group.length)));
            }))),
        // Legend button — floats top-left so it never competes with the home/zoom/rotate cluster.
        React.createElement("button", { onClick: () => setLegendOpen(true), className: "map-legend-btn", style: { position: 'absolute', left: 12, top: 12, zIndex: 5, display: 'flex', alignItems: 'center', gap: 6 } }, React.createElement(InkIcon, { name: "map", size: 13 }), "Map Legend"),
        legendOpen && React.createElement(LocationLegendModal, { onClose: () => setLegendOpen(false) }),
        // Nearby Locations panel — floats top-right, opens whenever a pin is selected and
        // collapses (via CSS, not unmount, so the close animation can play) once it's deselected.
        React.createElement("div", { className: "ink-nearby-panel" + (selectedPin ? ' open' : '') },
            React.createElement("div", { className: "ink-nearby-header" }, "Nearby Locations"),
            React.createElement("div", { className: "ink-nearby-list" }, nearbyList.length === 0
                ? React.createElement("div", { className: "ink-nearby-empty" }, "No other pinned locations on this map.")
                : nearbyList.map((item) => {
                    const Icon = item.meta.icon;
                    return (React.createElement("div", { key: item.pin.id, className: "ink-nearby-item", onClick: () => flyToPin(item.pin), onMouseEnter: () => setPanelHighlightId(item.pin.id), onMouseLeave: () => setPanelHighlightId((h) => (h === item.pin.id ? null : h)) },
                        React.createElement("div", { className: "ink-nearby-icon", style: { background: item.meta.color } },
                            React.createElement(Icon, null)),
                        React.createElement("div", { className: "ink-nearby-info" },
                            React.createElement("div", { className: "ink-nearby-name" }, item.name),
                            React.createElement("div", { className: "ink-nearby-meta" }, `${item.meta.label} \u00B7 ${Math.round(item.distancePercent)}% away \u00B7 ${item.direction}`))));
                }))),
        // Floating control cluster: the Jump to Map / home button always sits above the
        // zoom + rotate + "save this view" controls beneath it, both in stacking order and visually.
        React.createElement("div", { style: { position: 'absolute', right: 12, bottom: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE_SCALE[10], zIndex: 5 } },
            React.createElement("button", { onClick: jumpToMap, className: "map-home-btn" + (map.defaultCamera ? ' has-custom-home' : ''), "aria-label": "Jump to Map \u2014 reset to the saved overview", title: map.defaultCamera ? "Jump to Map (saved view)" : "Jump to Map" },
                React.createElement(IconCompass, null)),
            React.createElement("div", { className: "map-ctrl-cluster" },
                React.createElement("button", { className: "map-ctrl-btn", onClick: () => zoomBy(1.25), "aria-label": "Zoom in" }, "+"),
                React.createElement("button", { className: "map-ctrl-btn", onClick: () => zoomBy(1 / 1.25), "aria-label": "Zoom out" }, "\u2212"),
                React.createElement("button", { className: "map-ctrl-btn", onClick: () => rotateBy(-15), "aria-label": "Rotate left" }, "\u21BA"),
                React.createElement("button", { className: "map-ctrl-btn", onClick: () => rotateBy(15), "aria-label": "Rotate right" }, "\u21BB"),
                React.createElement("button", { className: "map-ctrl-btn", onClick: () => onSetDefaultView(map.id, camera), "aria-label": "Save current view as Jump to Map's default", title: "Save this view as the Jump to Map default" }, React.createElement(InkIcon, { name: "pin", size: 13 }))))));
}
