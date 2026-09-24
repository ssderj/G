import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GrandLibraryAtmosphere } from '../library/grand-library-cards.jsx';
import { ArchiveDivider } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from './nav-context.jsx';


// ---------- Ink line-icon set ----------
// A small custom SVG icon set standing in for raw emoji glyphs across Home's navigation and
// Quick Access. Emoji render inconsistently across iOS/Android/desktop and read as generic app
// chrome rather than matching the hand-drawn medieval/parchment feel used everywhere else (the
// wooden table, the tree rail, the bookshelf). Every glyph is a plain 24x24 stroke icon that
// uses currentColor for its stroke (and, for the couple of small filled dots, its fill too), so
// it automatically inherits whatever gold/muted tint its parent button already applies for
// active/inactive state — no separate color logic needed at each call site. Add a new key to
// ICON_PATHS to extend the set; InkIcon and its sizing/color props stay the same.
export const ICON_PATHS = {
    home: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,11.5 L12,4.5 L20,11.5" }),
        React.createElement("path", { d: "M6.5,10 V19 A1,1 0 0,0 7.5,20 H16.5 A1,1 0 0,0 17.5,19 V10" }),
        React.createElement("path", { d: "M10,20 V14.5 H14 V20" })),
    guild: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3.5 L18.5,6 V11.5 C18.5,16 15.5,19 12,20.5 C8.5,19 5.5,16 5.5,11.5 V6 Z" }),
        React.createElement("path", { d: "M9,10.5 L12,12.5 L15,10.5" })),
    library: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,19 V5.6 C4,5.3 4.3,5 4.6,5 H7.4 C7.7,5 8,5.3 8,5.6 V19" }),
        React.createElement("path", { d: "M9.5,19 V4.6 C9.5,4.3 9.8,4 10.1,4 H12.9 C13.2,4 13.5,4.3 13.5,4.6 V19" }),
        React.createElement("path", { d: "M15,19 V6.6 C15,6.3 15.3,6 15.6,6 H18.4 C18.7,6 19,6.3 19,6.6 V19" }),
        React.createElement("path", { d: "M3.5,19 H19.5" })),
    universe: React.createElement(React.Fragment, null,
        React.createElement("ellipse", { cx: 12, cy: 12, rx: 8.5, ry: 3.6, transform: "rotate(-20 12 12)" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 1.7, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 18.3, cy: 6.2, r: 0.8, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 5.4, cy: 17.6, r: 0.6, fill: "currentColor", stroke: "none" })),
    inbox: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3.5, y: 6, width: 17, height: 13, rx: 1.4 }),
        React.createElement("path", { d: "M4,7 L12,13.5 L20,7" })),
    lock: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 10.5, width: 13, height: 9, rx: 1.6 }),
        React.createElement("path", { d: "M8,10.5 V7.8 A4,4 0 0,1 16,7.8 V10.5" })),
    unlock: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 10.5, width: 13, height: 9, rx: 1.6 }),
        React.createElement("path", { d: "M8,10.5 V7.8 A4,4 0 0,1 15.7,6.3" })),
    plus: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,5 V19" }),
        React.createElement("path", { d: "M5,12 H19" })),
    download: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 V15" }),
        React.createElement("path", { d: "M7.5,11.5 L12,16 L16.5,11.5" }),
        React.createElement("path", { d: "M4.5,18.5 H19.5" })),
    upload: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,16 V5" }),
        React.createElement("path", { d: "M7.5,9.5 L12,5 L16.5,9.5" }),
        React.createElement("path", { d: "M4.5,18.5 H19.5" })),
    broom: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M16,4 L10,10" }),
        React.createElement("path", { d: "M10,10 L5,18 L15,18 Z" }),
        React.createElement("path", { d: "M9,18 L8.3,20.5" }),
        React.createElement("path", { d: "M12,18 L12,20.5" })),
    tree: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,21 V14" }),
        React.createElement("circle", { cx: 12, cy: 9, r: 6 })),
    package: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,8 L12,4 L20,8 L12,12 Z" }),
        React.createElement("path", { d: "M4,8 V16 L12,20 L20,16 V8" }),
        React.createElement("path", { d: "M12,12 V20" })),
    book: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,6.5 C9.7,5 6.3,4.5 3.8,5 V18 C6.3,17.5 9.7,18 12,19.5" }),
        React.createElement("path", { d: "M12,6.5 C14.3,5 17.7,4.5 20.2,5 V18 C17.7,17.5 14.3,18 12,19.5" }),
        React.createElement("path", { d: "M12,6.5 V19.5" })),
    puzzle: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 5.5, y: 5.5, width: 12, height: 12, rx: 1.6 }),
        React.createElement("circle", { cx: 11.5, cy: 5.5, r: 2 }),
        React.createElement("circle", { cx: 17.5, cy: 12, r: 2 })),
    sparkle: React.createElement("path", {
        d: "M12,2.5 C12.6,7.5 13,9.5 19,10.5 C13,11.5 12.6,13.5 12,18.5 C11.4,13.5 11,11.5 5,10.5 C11,9.5 11.4,7.5 12,2.5 Z",
        fill: "currentColor", stroke: "none",
    }),
    chart: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,17.5 L9.5,11 L13,14 L19.5,6" }),
        React.createElement("path", { d: "M14,6 H19.5 V11.5" })),
    coin: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 5 }),
        React.createElement("path", { d: "M12,9.3 V14.7" })),
    cash: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3, y: 7, width: 18, height: 10, rx: 1.6 }),
        React.createElement("ellipse", { cx: 12, cy: 12, rx: 3, ry: 2.4 })),
    moneybag: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,4 C10.2,4 9,5.6 9,7.2 C7,7.8 4.8,10.5 4.8,14.3 C4.8,18.4 7.6,21 12,21 C16.4,21 19.2,18.4 19.2,14.3 C19.2,10.5 17,7.8 15,7.2 C15,5.6 13.8,4 12,4 Z" }),
        React.createElement("path", { d: "M9.3,7.4 H14.7" })),
    star: React.createElement("path", {
        d: "M12,3.5 L14.6,9.2 L20.8,9.9 L16.2,14 L17.5,20.2 L12,17 L6.5,20.2 L7.8,14 L3.2,9.9 L9.4,9.2 Z",
    }),
    users: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 9, cy: 8.5, r: 3 }),
        React.createElement("path", { d: "M4,20 C4,15.7 6.3,13.5 9,13.5 C11.7,13.5 14,15.7 14,20" }),
        React.createElement("circle", { cx: 17, cy: 9.5, r: 2.4 }),
        React.createElement("path", { d: "M14.3,20 C14.3,16.3 16,14.3 17.3,14.3 C18.9,14.3 20.5,16 20.8,19" })),
    // Added for the Referral Dashboard tab (see src/library/referral-dashboard.jsx) — a plain
    // gift box, same simple-stroke construction as every other glyph above.
    gift: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 4, y: 10, width: 16, height: 9.5, rx: 1.2 }),
        React.createElement("path", { d: "M4,10 H20 V13 H4 Z", fill: "currentColor", stroke: "none" }),
        React.createElement("path", { d: "M12,10 V19.5" }),
        React.createElement("path", { d: "M12,10 C12,6.5 9.5,5 8,5.3 C6.5,5.6 6.3,7.8 8,8.7 C9.2,9.3 11,9.8 12,10 Z" }),
        React.createElement("path", { d: "M12,10 C12,6.5 14.5,5 16,5.3 C17.5,5.6 17.7,7.8 16,8.7 C14.8,9.3 13,9.8 12,10 Z" })),
    // Solid variant of `star` above (filled rather than outlined) — for a "this is starred /
    // already earned" state where an outline read the same as its empty counterpart.
    starFilled: React.createElement("path", {
        d: "M12,3.5 L14.6,9.2 L20.8,9.9 L16.2,14 L17.5,20.2 L12,17 L6.5,20.2 L7.8,14 L3.2,9.9 L9.4,9.2 Z",
        fill: "currentColor", stroke: "none",
    }),
    // ---------- Author Inbox category emblems ----------
    // A small set added specifically so every "sealed letter" in the Inbox (see
    // src/library/inbox-and-living-universe.jsx) carries a proper engraved glyph instead of a
    // platform emoji — same 24x24 plain-stroke construction as every icon above, so they sit
    // comfortably in the same wax-seal roundel this app already uses for GrandLibraryAtmosphere.
    sealedLetter: React.createElement(React.Fragment, null,
        React.createElement("rect", { x: 3.3, y: 6.3, width: 17.4, height: 12, rx: 1.3 }),
        React.createElement("path", { d: "M3.8,7.2 L12,13.4 L20.2,7.2" }),
        React.createElement("circle", { cx: 12, cy: 13.6, r: 2.15, fill: "currentColor", stroke: "none" })),
    hourglass: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M6.5,4 H17.5" }),
        React.createElement("path", { d: "M6.5,20 H17.5" }),
        React.createElement("path", { d: "M7.3,4 C7.3,8.4 12,10.2 12,12 C12,10.2 16.7,8.4 16.7,4" }),
        React.createElement("path", { d: "M7.3,20 C7.3,15.6 12,13.8 12,12 C12,13.8 16.7,15.6 16.7,20" })),
    columns: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.3,8.3 L12,3.6 L20.7,8.3 Z" }),
        React.createElement("path", { d: "M4,20 H20" }),
        React.createElement("path", { d: "M6,9.2 V18.4" }),
        React.createElement("path", { d: "M10,9.2 V18.4" }),
        React.createElement("path", { d: "M14,9.2 V18.4" }),
        React.createElement("path", { d: "M18,9.2 V18.4" }),
        React.createElement("path", { d: "M4.5,18.4 H19.5" })),
    tag: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.5,3.5 H10.6 L20.5,13.4 L13.4,20.5 L3.5,10.6 Z" }),
        React.createElement("circle", { cx: 7.3, cy: 7.3, r: 1.3, fill: "currentColor", stroke: "none" })),
    medal: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.3,3.3 L6.8,10.6" }),
        React.createElement("path", { d: "M14.7,3.3 L17.2,10.6" }),
        React.createElement("circle", { cx: 12, cy: 14.6, r: 5.3 }),
        React.createElement("circle", { cx: 12, cy: 14.6, r: 2.1 })),
    horn: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.3,16.3 C4.3,9.8 10,4.7 17.8,5.2" }),
        React.createElement("circle", { cx: 18.6, cy: 5.9, r: 2.1 }),
        React.createElement("path", { d: "M7.6,13.5 C8.7,12.7 10.1,12 11.7,11.5" }),
        React.createElement("path", { d: "M9.8,17.3 C7.5,17.6 5.7,17.2 4.3,16.3" })),
    search: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 10.3, cy: 10.3, r: 6.3 }),
        React.createElement("path", { d: "M15,15 L20.2,20.2" })),
    archiveBox: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.3,5.2 H20.7 V8.4 H3.3 Z" }),
        React.createElement("path", { d: "M4.5,8.4 V18 C4.5,18.66 5.04,19.2 5.7,19.2 H18.3 C18.96,19.2 19.5,18.66 19.5,18 V8.4" }),
        React.createElement("path", { d: "M9.8,12.4 H14.2" })),
    restore: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.5,5.3 L4.5,9.3 L9.5,13.3" }),
        React.createElement("path", { d: "M4.5,9.3 H14 C17.6,9.3 20.2,11.9 20.2,15.15 C20.2,18.4 17.6,20.5 14,20.5 H8.5" })),
    // ---------- Living Universe emblems ----------
    // Added so every badge, seal, and section mark on the Living Universe screen (see
    // src/library/living-universe-screen.jsx and src/library/inbox-and-living-universe.jsx)
    // carries a proper engraved glyph instead of a platform emoji — same 24x24 plain-stroke
    // construction as every icon above.
    trophy: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M7,4 H17 V8 C17,11 14.8,13 12,13 C9.2,13 7,11 7,8 Z" }),
        React.createElement("path", { d: "M7,5 H4.4 C4.4,8 6,9.6 7.6,9.8" }),
        React.createElement("path", { d: "M17,5 H19.6 C19.6,8 18,9.6 16.4,9.8" }),
        React.createElement("path", { d: "M12,13 V16.2" }),
        React.createElement("path", { d: "M9.6,16.2 H14.4 L15,20 H9 Z" }),
        React.createElement("path", { d: "M8.6,20 H15.4" })),
    castle: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.5,20 V11 H7.2 V8.3 H5.8 V6 H8.6 V8.3 H7.2 V10.2 H10.2 V6.5 H13.8 V10.2 H16.8 V8.3 H15.4 V6 H18.2 V8.3 H16.8 V11 H19.5 V20 Z" }),
        React.createElement("path", { d: "M10,20 V15.5 H14 V20" })),
    flame: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,21 C8.7,21 6.3,18.6 6.3,15.3 C6.3,12.5 8.1,10.5 8.7,8.2 C9,9.5 9.8,10 10.4,9 C11.1,7.5 10.6,5.6 12,3.3 C12.8,6.3 14.6,7.3 15.1,10.1 C15.4,8.9 15.2,8 15.9,7.4 C17,9.3 17.7,11.7 17.7,14.2 C17.7,18 15.3,21 12,21 Z" }),
        React.createElement("path", { d: "M12,18.3 C10.6,18.3 9.7,17.2 9.7,15.8 C9.7,14.4 10.6,13.6 11,12.5 C11.3,13.6 12,13.8 12,12.9 C12.5,13.9 13,14.4 13,15.7 C13,17.1 13.3,18.3 12,18.3 Z", fill: "currentColor", stroke: "none" })),
    crown: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4.3,17 L4.3,9.8 L8.2,13 L12,6.8 L15.8,13 L19.7,9.8 V17 Z" }),
        React.createElement("path", { d: "M4.3,19.4 H19.7" })),
    map: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,7 L9,5 L15,7 L20,5 V18 L15,20 L9,18 L4,20 Z" }),
        React.createElement("path", { d: "M9,5 V18" }),
        React.createElement("path", { d: "M15,7 V20" })),
    target: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 5 }),
        React.createElement("circle", { cx: 12, cy: 12, r: 1.6, fill: "currentColor", stroke: "none" })),
    shield: React.createElement("path", { d: "M12,3.2 L19,6 V11.5 C19,16 16,19.5 12,21 C8,19.5 5,16 5,11.5 V6 Z" }),
    candle: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3 C12.8,4.6 14,5.6 14,7.2 C14,8.35 13.1,9.05 12,9.05 C10.9,9.05 10,8.35 10,7.2 C10,5.6 11.2,4.6 12,3 Z", fill: "currentColor", stroke: "none" }),
        React.createElement("rect", { x: 9.4, y: 9.3, width: 5.2, height: 9.7, rx: 1 }),
        React.createElement("path", { d: "M7.8,19 H16.2" })),
    crossedSwords: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.6,3.6 L13.4,13.4" }),
        React.createElement("path", { d: "M3.6,3.6 V6.7" }),
        React.createElement("path", { d: "M3.6,3.6 H6.7" }),
        React.createElement("circle", { cx: 14.6, cy: 14.6, r: 1.1, fill: "currentColor", stroke: "none" }),
        React.createElement("path", { d: "M20.4,3.6 L10.6,13.4" }),
        React.createElement("path", { d: "M20.4,3.6 V6.7" }),
        React.createElement("path", { d: "M20.4,3.6 H17.3" }),
        React.createElement("circle", { cx: 9.4, cy: 14.6, r: 1.1, fill: "currentColor", stroke: "none" })),
    scroll: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M7,4.3 C5.5,4.3 4.3,5.5 4.3,7 C4.3,8.5 5.5,9.7 7,9.7 H17" }),
        React.createElement("path", { d: "M17,19.7 C18.5,19.7 19.7,18.5 19.7,17 C19.7,15.5 18.5,14.3 17,14.3 H7" }),
        React.createElement("path", { d: "M7,9.7 V14.3 H17" }),
        React.createElement("path", { d: "M7,4.3 V9.7" }),
        React.createElement("path", { d: "M17,14.3 V19.7" })),
    globe: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("path", { d: "M3.7,12 H20.3" }),
        React.createElement("path", { d: "M12,3.7 C15,6.7 15,17.3 12,20.3 C9,17.3 9,6.7 12,3.7 Z" })),
    // Added for the Guild Notice Board (see src/guild/notice-board.jsx) — a plain drawing-pin/
    // thumbtack, same simple-stroke construction as every glyph above, for marking a real
    // announcement as pinned/important.
    pin: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M9.3,4.3 H14.7 L14.2,10 L17.5,13.3 H6.5 L9.8,10 Z" }),
        React.createElement("path", { d: "M12,13.3 V20.3" })),
    // Added for Settings entries across the app (Project Workspace sidebar, Account) — a plain
    // gear, same simple-stroke construction as every glyph above.
    gear: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 3.1 }),
        React.createElement("path", { d: "M12,3.6 V6.1 M12,17.9 V20.4 M20.4,12 H17.9 M6.1,12 H3.6 M17.7,6.3 L15.9,8.1 M8.1,15.9 L6.3,17.7 M17.7,17.7 L15.9,15.9 M8.1,8.1 L6.3,6.3" })),
    // The following four replace the last recurring emoji glyphs used as plain UI chrome across
    // the Grand Library topbar, book cards, and discussion threads (cart, notification bell,
    // discussion bubble, "view" eye) — same 24x24 plain-stroke construction as every icon above.
    cart: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M3.5,4.5 H5.7 L8,15.3 H17.5 L19.5,7.8 H6.6" }),
        React.createElement("circle", { cx: 9.3, cy: 19, r: 1.3, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 16.3, cy: 19, r: 1.3, fill: "currentColor", stroke: "none" })),
    bell: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M6,10.5 C6,6.9 8.7,4.5 12,4.5 C15.3,4.5 18,6.9 18,10.5 C18,15 19.5,16.3 19.5,16.3 H4.5 C4.5,16.3 6,15 6,10.5 Z" }),
        React.createElement("path", { d: "M10,19 C10.3,19.8 11,20.3 12,20.3 C13,20.3 13.7,19.8 14,19" })),
    chat: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M4,5.5 H20 V15.5 H9.5 L5.5,18.7 V15.5 H4 Z" })),
    eye: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M2.5,12 C4.8,7.6 8.1,5.4 12,5.4 C15.9,5.4 19.2,7.6 21.5,12 C19.2,16.4 15.9,18.6 12,18.6 C8.1,18.6 4.8,16.4 2.5,12 Z" }),
        React.createElement("circle", { cx: 12, cy: 12, r: 2.7 })),
    // Added for the Founder Guild emblem set (see guild/guild-hall.jsx's FOUNDER_GUILDS) — one
    // simple glyph per genre, same 24x24 plain-stroke construction as every icon above.
    heart: React.createElement("path", {
        d: "M12,20 C7,16.5 3.5,13.2 3.5,9.3 C3.5,6.6 5.6,4.5 8.2,4.5 C9.8,4.5 11.2,5.3 12,6.6 C12.8,5.3 14.2,4.5 15.8,4.5 C18.4,4.5 20.5,6.6 20.5,9.3 C20.5,13.2 17,16.5 12,20 Z",
    }),
    rocket: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M12,3.5 C15,5.5 16.5,9 16.5,12.5 C16.5,14.7 15.9,16.7 15,18.2 L12,20.5 L9,18.2 C8.1,16.7 7.5,14.7 7.5,12.5 C7.5,9 9,5.5 12,3.5 Z" }),
        React.createElement("circle", { cx: 12, cy: 11, r: 1.8 }),
        React.createElement("path", { d: "M8.5,16 L5.5,17.5 L6.3,14.2" }),
        React.createElement("path", { d: "M15.5,16 L18.5,17.5 L17.7,14.2" })),
    ghost: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M5.5,20 V11 C5.5,7.4 8.4,4.5 12,4.5 C15.6,4.5 18.5,7.4 18.5,11 V20 L16,18 L13.5,20 L11,18 L8.5,20 L6,18 Z" }),
        React.createElement("circle", { cx: 9.7, cy: 11.3, r: 1, fill: "currentColor", stroke: "none" }),
        React.createElement("circle", { cx: 14.3, cy: 11.3, r: 1, fill: "currentColor", stroke: "none" })),
    mask: React.createElement(React.Fragment, null,
        React.createElement("circle", { cx: 12, cy: 12, r: 8.3 }),
        React.createElement("path", { d: "M8.5,10.3 C8.8,9.8 9.4,9.5 10,9.7" }),
        React.createElement("path", { d: "M15.5,10.3 C15.2,9.8 14.6,9.5 14,9.7" }),
        React.createElement("path", { d: "M8.3,14 C9.2,15.5 10.5,16.2 12,16.2 C13.5,16.2 14.8,15.5 15.7,14" })),
    // Added for the Story Health check registry (see writing/health-checks.jsx's HEALTH_CHECKS) —
    // a simple two-link chain, same construction as every glyph above.
    link: React.createElement(React.Fragment, null,
        React.createElement("path", { d: "M10.5,13.5 L13.5,10.5" }),
        React.createElement("path", { d: "M9,15 L6.5,17.5 C5.4,18.6 3.6,18.6 2.5,17.5 C1.4,16.4 1.4,14.6 2.5,13.5 L5,11" }),
        React.createElement("path", { d: "M15,9 L17.5,6.5 C18.6,5.4 20.4,5.4 21.5,6.5 C22.6,7.6 22.6,9.4 21.5,10.5 L19,13" })),
};


export function InkIcon({ name, size = 18, color = 'currentColor', strokeWidth = 1.6, style }) {
    const glyph = ICON_PATHS[name];
    if (!glyph)
        return null;
    return React.createElement("svg", {
        width: size, height: size, viewBox: "0 0 24 24", fill: "none",
        stroke: color, strokeWidth, strokeLinecap: "round", strokeLinejoin: "round",
        style: Object.assign({ display: 'block', flexShrink: 0 }, style),
        "aria-hidden": "true",
    }, glyph);
}


export function HomeNav({ activeTab, onSelect, inboxUnreadCount, hasProjects }) {
    // REMOVED — the Writer-Level-gated lock on Guild/Universe (writerLevel >= GUILD_UNLOCK_LEVEL),
    // its glow/pulse/shimmer build-up as level 10 approached, and the particle-burst "unlock"
    // ceremony (a particle-shatter burst plus a sound effect) when it finally did. Writer Level
    // no longer exists, and gating whole tabs behind a grind — with a full celebration animation
    // for crossing the threshold — is exactly the loud gamification being cut. Guild and Living
    // Universe are just available now, same as Home/Inbox. Library keeps its own gate, which was
    // never a gamification threshold to begin with — it's just "you haven't started anything yet".
    const [expanded, setExpanded] = useState(false);
    const [lockedTooltipKey, setLockedTooltipKey] = useState(null);
    const lockedTooltipTimer = useRef(null);
    const libraryLocked = !hasProjects;
    const LOCK_MESSAGES = {
        library: "Start your first project to unlock the Grand Library.",
    };
    const handleLockedTap = (key) => {
        setLockedTooltipKey(key);
        if (lockedTooltipTimer.current)
            clearTimeout(lockedTooltipTimer.current);
        lockedTooltipTimer.current = setTimeout(() => setLockedTooltipKey(null), 3200);
    };
    useEffect(() => () => {
        if (lockedTooltipTimer.current)
            clearTimeout(lockedTooltipTimer.current);
    }, []);
    const selectTab = (key, locked) => {
        if (locked) {
            handleLockedTap(key);
            return;
        }
        onSelect(key);
        setExpanded(false);
    };
    // Each key doubles as its InkIcon name (see ICON_PATHS above) — home/guild/library/universe/
    // inbox all have a matching glyph, so there's no separate icon field to keep in sync.
    // `caption` is the always-visible word under each icon (see .home-nav-icon-caption) —
    // shorter than `label` where `label` is a longer proper name (title/aria-label still use
    // the full `label`), so "Grand Library" fits its 46px column as plain "Library".
    const TABS = [
        { key: 'home', label: 'Home', caption: 'Home' },
        { key: 'guild', label: 'Guild', caption: 'Guild' },
        { key: 'library', label: 'Grand Library', caption: 'Library' },
        { key: 'universe', label: 'Universe', caption: 'Universe' },
        { key: 'inbox', label: 'Inbox', caption: 'Inbox' },
    ];
    return React.createElement("div", { style: {
            position: 'sticky', top: 0, zIndex: 30, width: '100%',
            background: 'rgba(23,19,14,0.92)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            borderBottom: '1px solid #3A3020',
        } },
        React.createElement("style", null, `
        .home-nav-icon-row { display: flex; align-items: flex-start; gap: 6px; }
        /* Icon + caption pair for one tab. The circle button used to be the whole button with
           only a title/aria-label for a name — real for a screen reader or a mouse hover, but
           invisible to a first-time visitor on a touchscreen, who can't hover and often won't
           think to long-press an icon just to find out what it does. This caption is that name,
           always visible, so nobody has to guess what the crest/eye/envelope glyphs mean. */
        .home-nav-icon-item { display: flex; flex-direction: column; align-items: center; gap: 3px; width: 46px; flex-shrink: 0; }
        .home-nav-icon-caption {
          font-size: 9px; font-weight: 600; letter-spacing: 0.01em; text-align: center;
          line-height: 1.15; max-width: 46px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .home-nav-icon-btn {
          width: 42px; height: 42px; border-radius: 50%; border: 1px solid #3A3020; cursor: pointer;
          background: linear-gradient(160deg, #211C16, #17130E); display: flex; align-items: center; justify-content: center; font-size: 17px;
          color: #9C9280; position: relative; flex-shrink: 0; padding: 0;
          transition: background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease),
            border-color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease);
        }
        .home-nav-icon-btn.active {
          background: linear-gradient(160deg, #241F14, #1A160D); border-color: #4A3D22; color: #E8C468;
          box-shadow: 0 0 14px rgba(232,196,104,0.32), inset 0 1px 0 rgba(255,255,255,0.06);
        }
        .home-nav-icon-btn:hover { border-color: #4A3D22; }
        .home-nav-toggle {
          width: 42px; height: 42px; border-radius: 50%; border: 1px solid #3A3020; cursor: pointer;
          background: linear-gradient(160deg, #211C16, #17130E); display: flex; align-items: center; justify-content: center; color: #C89B3C;
          margin-left: auto; flex-shrink: 0; padding: 0; font-size: 13px;
          transition: transform var(--ink-dur) var(--ink-ease), background var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease);
        }
        .home-nav-toggle:hover { border-color: #4A3D22; }
        .home-nav-toggle.open { transform: rotate(180deg); }
        .home-nav-badge {
          position: absolute; top: -3px; right: -3px; font-size: 9.5px; font-weight: 700; color: #1A1610;
          background: #E8C468; border-radius: 999px; min-width: 15px; text-align: center; padding: 1px 4px;
          line-height: 13px; box-shadow: 0 0 6px rgba(232,196,104,0.5); pointer-events: none;
        }
        .home-nav-lock { font-size: 9px; position: absolute; bottom: -2px; right: -3px; }
        .home-nav-panel {
          overflow: hidden; max-height: 0; opacity: 0;
          transition: max-height var(--ink-dur) var(--ink-ease), opacity var(--ink-dur) var(--ink-ease);
        }
        .home-nav-panel.open { max-height: 320px; opacity: 1; margin-top: 6px; }
        .home-nav-row {
          width: 100%; display: flex; align-items: center; gap: 12px; border: none; cursor: pointer;
          background: transparent; text-align: left; padding: 11px 4px; color: #B8AC90;
          border-top: 1px solid #2A2216;
          transition: background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease);
        }
        .home-nav-row:hover { background: #211C16; }
        .home-nav-row.active { color: #E8C468; }
        .home-nav-row-icon { width: 26px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
        .home-nav-row-label { flex: 1; font-size: 13.5px; font-weight: 600; line-height: 1.3; }
        .home-nav-row-sub { display: block; font-size: 10.5px; color: #9C9280; font-weight: 500; margin-top: 2px; }
      `),
        React.createElement("div", { className: "ink-page-container", style: { padding: '12px 24px', position: 'relative' } },
            React.createElement("div", { className: "home-nav-icon-row" },
                TABS.map((t) => {
                    const isActive = activeTab === t.key;
                    const caption = React.createElement("span", {
                        className: "home-nav-icon-caption", style: { color: isActive ? '#E8C468' : '#8A8172' },
                    }, t.caption);
                    if (t.key === 'library') {
                        return React.createElement("div", { key: t.key, className: "home-nav-icon-item" },
                            React.createElement("div", { style: { position: 'relative' } },
                                React.createElement("button", {
                                    onClick: () => selectTab(t.key, libraryLocked),
                                    title: libraryLocked ? LOCK_MESSAGES.library : t.label, "aria-label": t.label,
                                    className: "home-nav-icon-btn" + (isActive ? ' active' : ''),
                                },
                                    React.createElement(InkIcon, { name: t.key, size: 19 }),
                                    libraryLocked && React.createElement("span", { className: "home-nav-lock" },
                                        React.createElement(InkIcon, { name: "lock", size: 10 }))),
                                lockedTooltipKey === t.key && React.createElement("div", { style: {
                                        position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: 8, width: 200, zIndex: 40,
                                        background: 'linear-gradient(160deg, #201C13, #17140F)', border: '1px solid #4A3D22',
                                        borderRadius: RADIUS_SCALE[10], padding: '11px 13px', fontSize: TYPE_SCALE[12], color: '#D9D2BE', lineHeight: 1.45,
                                        boxShadow: '0 8px 20px rgba(0,0,0,0.4)', textAlign: 'left',
                                    } }, LOCK_MESSAGES.library)),
                            caption);
                    }
                    return React.createElement("div", { key: t.key, className: "home-nav-icon-item" },
                        React.createElement("button", {
                            onClick: () => selectTab(t.key), title: t.label, "aria-label": t.label,
                            className: "home-nav-icon-btn" + (isActive ? ' active' : ''),
                        },
                            React.createElement(InkIcon, { name: t.key, size: 19 }),
                            t.key === 'inbox' && inboxUnreadCount > 0 && React.createElement("span", { className: "home-nav-badge" }, inboxUnreadCount > 99 ? '99+' : inboxUnreadCount)),
                        caption);
                }),
                React.createElement("div", { className: "home-nav-icon-item" },
                    React.createElement("button", {
                        onClick: () => setExpanded((v) => !v), title: expanded ? "Collapse navigation" : "Expand navigation",
                        "aria-label": expanded ? "Collapse navigation" : "Expand navigation", "aria-expanded": expanded,
                        className: "home-nav-toggle" + (expanded ? ' open' : ''),
                    }, "\u25BE"),
                    React.createElement("span", { className: "home-nav-icon-caption", style: { color: '#8A8172' } }, expanded ? "Less" : "More"))),
            React.createElement("div", { className: "home-nav-panel" + (expanded ? ' open' : '') },
                TABS.map((t) => {
                    if (t.key === 'library') {
                        return React.createElement("button", {
                            key: t.key, onClick: () => selectTab(t.key, libraryLocked),
                            className: "home-nav-row" + (activeTab === t.key ? ' active' : ''),
                        },
                            React.createElement("span", { className: "home-nav-row-icon" }, React.createElement(InkIcon, { name: t.key, size: 16 })),
                            React.createElement("span", { className: "home-nav-row-label" }, t.label,
                                libraryLocked && React.createElement("span", { className: "home-nav-row-sub" }, "Locked \u00b7 start a project")),
                            libraryLocked && React.createElement("span", { style: { opacity: 0.8, display: 'flex' } }, React.createElement(InkIcon, { name: "lock", size: 12 })));
                    }
                    return React.createElement("button", {
                        key: t.key, onClick: () => selectTab(t.key),
                        className: "home-nav-row" + (activeTab === t.key ? ' active' : ''),
                    },
                        React.createElement("span", { className: "home-nav-row-icon" }, React.createElement(InkIcon, { name: t.key, size: 16 })),
                        React.createElement("span", { className: "home-nav-row-label" }, t.label),
                        t.key === 'inbox' && inboxUnreadCount > 0 && React.createElement("span", { style: {
                                fontSize: TYPE_SCALE[9.5], fontWeight: 700, color: '#1A1610', background: '#E8C468', borderRadius: RADIUS_SCALE[999],
                                minWidth: 18, textAlign: 'center', padding: '2px 6px', lineHeight: '14px',
                            } }, inboxUnreadCount > 99 ? '99+' : inboxUnreadCount));
                }))));
}


// A small, fixed set of original entrance lines for the Home hero's welcome message — deterministic
// per calendar day (not random per render, so it doesn't flicker between two lines if the writer
// re-renders the page) via day-of-year, and separate from the time-of-day greeting so the two
// combine into something that doesn't repeat the same way every single day.
export const LIBRARY_ENTRANCE_LINES = [
    "The candles are lit, and the shelves are waiting.",
    "Somewhere on these shelves, your next chapter is already taking shape.",
    "The Hall is quiet tonight \u2014 a good night for writing.",
    "Dust drifts in the lamplight. The desk is exactly as you left it.",
    "Every tale in this Hall started the same way yours did: one page at a time.",
    "The ink is fresh and the parchment is patient.",
    "Somewhere above, a chandelier still burns for the writers who never stopped.",
];


export function timeOfDayGreeting() {
    const h = new Date().getHours();
    if (h < 5)
        return 'Burning the midnight oil';
    if (h < 12)
        return 'Good morning';
    if (h < 17)
        return 'Good afternoon';
    if (h < 21)
        return 'Good evening';
    return 'Good evening';
}


export function dayOfYear(d) {
    const start = new Date(d.getFullYear(), 0, 0);
    return Math.floor((d - start) / 86400000);
}


// A small carved brass corner guard, the kind found on an old ledger or a travelling writing
// desk — two straight fillets meeting at a corner plus a single rivet, rendered in line rather
// than as a filled shape so it reads as hardware inlaid into the wood, not a sticker on top of
// it. One shared component, rotated per corner, so all four stay pixel-identical. `id` is
// per-instance because SVG gradient ids are global to the document and LibraryHero mounts four
// of these at once.
function HeroCornerGuard({ corner, id }) {
    const rotation = { tl: 0, tr: 90, br: 180, bl: 270 }[corner];
    const pos = {
        tl: { top: 7, left: 7 }, tr: { top: 7, right: 7 },
        br: { bottom: 7, right: 7 }, bl: { bottom: 7, left: 7 },
    }[corner];
    return React.createElement("div", { style: { position: 'absolute', width: 24, height: 24, zIndex: 2, pointerEvents: 'none', ...pos, transform: `rotate(${rotation}deg)` } },
        React.createElement("svg", { width: 24, height: 24, viewBox: "0 0 24 24", fill: "none" },
            React.createElement("defs", null,
                React.createElement("linearGradient", { id, x1: "0", y1: "0", x2: "24", y2: "24" },
                    React.createElement("stop", { offset: "0%", stopColor: "#F0D48A" }),
                    React.createElement("stop", { offset: "55%", stopColor: "#C89B3C" }),
                    React.createElement("stop", { offset: "100%", stopColor: "#7A5E24" }))),
            React.createElement("path", { d: "M1.5,9 V2.5 A1,1 0 0,1 2.5,1.5 H9", stroke: `url(#${id})`, strokeWidth: 1.6, strokeLinecap: "round" }),
            React.createElement("path", { d: "M1.5,13.5 V2.5 A1,1 0 0,1 2.5,1.5 H13.5", stroke: `url(#${id})`, strokeWidth: 1, strokeLinecap: "round", opacity: 0.45 }),
            React.createElement("circle", { cx: 6.2, cy: 6.2, r: 1.5, fill: `url(#${id})` }),
            React.createElement("circle", { cx: 6.2, cy: 6.2, r: 1.5, fill: "none", stroke: "#3A2A10", strokeWidth: 0.5, opacity: 0.5 })));
}


// Layered gradients standing in for a dark, hand-rubbed walnut frame: a base wood tone, two
// offset repeating-linear-gradients at a slight angle for grain (one dark for the grain lines
// themselves, one warm and near-invisible for the occasional lighter streak real wood has), and
// a soft sheen top-left as if the same window light from GrandLibraryAtmosphere is glancing off
// its varnish. Kept to gradients rather than an image so the frame stays crisp at any size and
// never needs a network asset.
const WOOD_FRAME_BACKGROUND = 'radial-gradient(ellipse at 18% -15%, rgba(255,205,145,0.14), transparent 55%),' +
    'repeating-linear-gradient(91deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 1px, transparent 1px, transparent 5px),' +
    'repeating-linear-gradient(91deg, rgba(255,190,120,0.05) 0px, rgba(255,190,120,0.05) 1px, transparent 1px, transparent 13px),' +
    'linear-gradient(158deg, #4A3016 0%, #33210F 45%, #1E140A 100%)';


// The Grand Library entrance: the writer's actual welcome to the app, before anything else on
// the page. Reuses GrandLibraryAtmosphere (stone wall, arched window light, hanging candle
// chandelier, drifting dust) as its backdrop rather than a separate reimplementation, so the very
// first thing a writer sees already looks like the same Hall the rest of the app lives in — now
// set inside a dark wood frame with a thin brass fillet and carved corner guards, the way that
// Hall's own entrance would be dressed, rather than floating edgeless against the page.
export function LibraryHero({ writerName, writerProfile, onOpenProfile, hasProjects }) {
    const now = useMemo(() => new Date(), []);
    const line = LIBRARY_ENTRANCE_LINES[dayOfYear(now) % LIBRARY_ENTRANCE_LINES.length];
    const greeting = timeOfDayGreeting();
    return React.createElement("div", { style: {
            position: 'relative', borderRadius: RADIUS_SCALE[20], padding: '18px 14px',
            background: WOOD_FRAME_BACKGROUND,
            boxShadow: 'inset 0 1px 0 rgba(255,210,150,0.14), inset 0 -3px 8px rgba(0,0,0,0.6), ' +
                'inset 0 0 0 1px rgba(0,0,0,0.45), 0 22px 44px rgba(0,0,0,0.5), 0 6px 14px rgba(0,0,0,0.35)',
        } },
        ['tl', 'tr', 'br', 'bl'].map((corner) => React.createElement(HeroCornerGuard, { key: corner, corner, id: `heroCornerGuard-${corner}` })),
        React.createElement("div", { style: {
                borderRadius: RADIUS_SCALE[16], padding: 2,
                border: '1px solid rgba(232,196,104,0.28)',
                boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.5)',
            } },
            React.createElement(GrandLibraryAtmosphere, null,
        React.createElement("div", { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 26 } },
            React.createElement("div", { className: "ink-hero-wordmark", style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[20], color: '#C89B3C', opacity: 0.9 } }, "\u2766"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[26], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "Inkroot")),
            React.createElement("button", { onClick: onOpenProfile, title: "Author's Hall", style: {
                    width: 44, height: 44, borderRadius: '50%', flexShrink: 0, cursor: 'pointer', padding: 0,
                    background: writerProfile && writerProfile.avatar ? `center/cover url(${writerProfile.avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                    border: '2px solid #C89B3C', boxShadow: '0 0 0 2px #100E0A, 0 0 14px rgba(200,155,60,0.25)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[17],
                } }, !(writerProfile && writerProfile.avatar) && "\uD83E\uDDD1\u200D\uD83C\uDF93")),
        React.createElement("div", { style: { textAlign: 'center', padding: '10px 6px 4px' } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontStyle: 'italic', color: '#EFE7D2' } },
                greeting, writerName ? `, ${writerName}.` : '.'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#B8AC90', marginTop: 10, maxWidth: 380, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6 } },
                hasProjects ? line : "The Hall stands ready for your first tale."),
            React.createElement(ArchiveDivider, { maxWidth: 200, margin: '20px auto 4px', fontSize: TYPE_SCALE[10], color: '#4A3D22', opacity: 1 })))));
}


// A short, original writing-craft line for "Today's Inspiration" — separate pool from the hero's
// entrance lines above (those greet the writer; these are meant to nudge the actual writing),
// picked the same deterministic day-of-year way so it holds steady for the whole day.
export const TODAYS_INSPIRATION_LINES = [
    "Write the sentence you're avoiding. It's usually the one the scene needs most.",
    "A character wants something, even if it's only a glass of water. What does yours want right now?",
    "Cut the sentence you're proudest of. See if the paragraph is stronger without it.",
    "Give a minor character one specific, unexplained detail today. Let the reader wonder.",
    "Change one scene from day to night, or night to day. Notice what else has to change with it.",
    "Write the ending first, badly, in three sentences. Now you know what you're walking toward.",
    "Let a character lie to another character today \u2014 and let the reader know before anyone else does.",
    "Describe a room using only what a character would notice while upset. Skip everything else.",
];


export function TodaysInspirationCard() {
    const line = useMemo(() => {
        const now = new Date();
        return TODAYS_INSPIRATION_LINES[dayOfYear(now) % TODAYS_INSPIRATION_LINES.length];
    }, []);
    return React.createElement("div", { style: {
            borderRadius: RADIUS_SCALE[14], padding: '22px 24px', marginBottom: 28,
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
            position: 'relative', overflow: 'hidden',
        } },
        React.createElement("div", { style: {
                position: 'absolute', top: -40, left: -40, width: 140, height: 140, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(200,155,60,0.09) 0%, rgba(200,155,60,0) 70%)',
            } }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 12, position: 'relative' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, "\uD83D\uDD6F\uFE0F"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#C89B3C' } }, "Today's Inspiration")),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontStyle: 'italic', color: '#EFE7D2', lineHeight: 1.55, position: 'relative' } }, line));
}


// One tile in the Quick Actions grid below Recent Activity — a small brass medallion (the same
// radial-gradient-circle-in-a-gold-ring vocabulary as the Writer Profile button and the wall
// sconces elsewhere on Home) holding the icon, mounted on a dark wood plaque, rather than a flat
// icon-over-label SaaS tile — so it reads as a fixture in the room, not a dashboard toolbar.
export function HomeQuickActionTile({ icon, label, onClick, disabled }) {
    return React.createElement("button", { onClick, disabled, className: "ghost-btn ink-brass-tile", style: {
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[10],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[12], padding: '18px 10px 14px',
            cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1, textAlign: 'center',
        } },
        React.createElement("span", { className: "ink-brass-medallion" }, icon),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#C9BE8D', fontWeight: 600 } }, label));
}


// One upcoming feature teaser in the "Inkroot News" section — every item here needs a shared
// backend Inkroot doesn't have yet (see ComingSoonNotice's use elsewhere for the same honesty
// about what is and isn't real today), so all of them carry the same gold "Coming Soon" pill
// rather than pretending any are closer than the others.
export function InkrootNewsCard({ icon, title, description }) {
    return React.createElement("div", { style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start', padding: '16px 18px', borderRadius: RADIUS_SCALE[12],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', marginBottom: 10,
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[18], flexShrink: 0, opacity: 0.85, marginTop: 1 } }, icon),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginBottom: 4 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, title),
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#C89B3C',
                        border: '1px dashed #4A3D22', borderRadius: RADIUS_SCALE[20], padding: '2px 8px',
                    } }, "Coming Soon")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#A69C87', lineHeight: 1.5 } }, description)));
}
