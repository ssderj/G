import React from 'react';


// ---------- Icons ----------
export const IconPlus = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", ...props },
    React.createElement("path", { d: "M12 5v14M5 12h14" })));


export const IconTrash = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M3 6h18M8 6V4a1 1 0 011-1h6a1 1 0 011 1v2m2 0-1 14a1 1 0 01-1 1H7a1 1 0 01-1-1L5 6" })));


export const IconAt = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "12", cy: "12", r: "4" }),
    React.createElement("path", { d: "M16 12v1.5a2.5 2.5 0 005 0V12a9 9 0 10-4 7.5" })));


export const IconDots = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "currentColor", ...props },
    React.createElement("circle", { cx: "12", cy: "5", r: "1.6" }),
    React.createElement("circle", { cx: "12", cy: "12", r: "1.6" }),
    React.createElement("circle", { cx: "12", cy: "19", r: "1.6" })));


export const IconSearch = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "11", cy: "11", r: "7" }),
    React.createElement("path", { d: "M21 21l-4.3-4.3" })));


export const IconX = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M18 6L6 18M6 6l12 12" })));


export const IconCompass = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "20", height: "20", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "12", cy: "12", r: "9.25" }),
    React.createElement("path", { d: "M12 2.4v2.1M12 19.5v2.1M2.4 12h2.1M19.5 12h2.1", strokeWidth: "1.3" }),
    React.createElement("path", { d: "M15.3 8.7l-2 5-5 2 2-5z", fill: "currentColor", stroke: "none" })));


export const IconCopy = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("rect", { x: "9", y: "9", width: "12", height: "12", rx: "2" }),
    React.createElement("path", { d: "M5 15V5a2 2 0 012-2h10" })));


export const IconGear = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "12", cy: "12", r: "3.2" }),
    React.createElement("path", { d: "M19.4 13a1.7 1.7 0 000-2l1.1-1.6-1.5-2.6-1.9.4a1.7 1.7 0 00-1.7-1l-.7-1.8h-3l-.7 1.8a1.7 1.7 0 00-1.7 1l-1.9-.4-1.5 2.6L4.6 11a1.7 1.7 0 000 2l-1.1 1.6 1.5 2.6 1.9-.4a1.7 1.7 0 001.7 1l.7 1.8h3l.7-1.8a1.7 1.7 0 001.7-1l1.9.4 1.5-2.6L19.4 13z" })));


export const IconMaximize = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M8 3H5a2 2 0 00-2 2v3M16 3h3a2 2 0 012 2v3M8 21H5a2 2 0 01-2-2v-3M16 21h3a2 2 0 002-2v-3" })));


export const IconDownload = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" })));


// ---------- Guild Event type glyphs: one distinct silhouette per event_type (see
// guild-events-panel.jsx's EVENT_TYPE_LABELS/EVENT_TYPE_COLORS) — same "simple, high-contrast,
// reads at a glance" brief as the map pin glyphs below, but sized for a small inline badge
// instead of a map pin.
export const IconEventTournament = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "12", cy: "8", r: "5" }),
    React.createElement("path", { d: "M9 12.7L7.2 21l4.8-2.8 4.8 2.8-1.8-8.3" }),
    React.createElement("path", { d: "M12 5.3l1 2.1 2.3.3-1.7 1.6.4 2.3-2-1.1-2 1.1.4-2.3-1.7-1.6 2.3-.3z", fill: "currentColor", stroke: "none" })));


export const IconEventWritingContest = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M4.5 19.5l1-4.2L16.3 4.5c1-1 2.7-1 3.7 0s1 2.7 0 3.7L9.2 19l-4.7.5z" }),
    React.createElement("path", { d: "M14 6.8l3.2 3.2" })));


export const IconEventReadingChallenge = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M4.5 19V6.2a1 1 0 011-1h3.4a1 1 0 011 1V19" }),
    React.createElement("path", { d: "M10.5 19V8.4a1 1 0 011-1h3.4a1 1 0 011 1V19" }),
    React.createElement("path", { d: "M4 19h16" })));


export const IconEventGiveaway = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("rect", { x: "4", y: "10.5", width: "16", height: "9", rx: "1.3" }),
    React.createElement("path", { d: "M4 10.5h16M12 10.5V19.5" }),
    React.createElement("path", { d: "M12 10.5c-1.6-3.4-5.3-3.6-5.3-1.4S9 10.5 12 10.5zM12 10.5c1.6-3.4 5.3-3.6 5.3-1.4S15 10.5 12 10.5z" })));


export const IconEventWorkshop = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M9.3 3.2h5.4l-1 3H10.3z" }),
    React.createElement("path", { d: "M7.4 6.2h9.2l-1.4 11.4a2 2 0 01-2 1.75h-2.4a2 2 0 01-2-1.75z" }),
    React.createElement("path", { d: "M12 9.3v5.4M9.6 12h4.8" })));


export const IconEventOther = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M12 3.5v17M4.4 7.7l15.2 8.6M19.6 7.7L4.4 16.3" })));


// ---------- Map pin glyphs: one distinct silhouette per location type ----------
// Deliberately simple, high-contrast shapes (rendered dark-on-color inside a pin badge) so each
// reads at a glance even at small size — a skyline vs. a hut vs. a tower vs. a tree should never
// be confused with each other on a crowded map.
export const IconPinCapital = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M4 20V11l3 2 5-6.5L17 13l3-2v9a1 1 0 01-1 1H5a1 1 0 01-1-1z" })));


export const IconPinCity = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("rect", { x: "3", y: "11", width: "5", height: "10" }),
    React.createElement("rect", { x: "9.5", y: "6", width: "5", height: "15" }),
    React.createElement("rect", { x: "16", y: "12", width: "5", height: "9" })));


export const IconPinTown = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M12 3 4 10v11h16V10L12 3z" }),
    React.createElement("rect", { x: "10", y: "15", width: "4", height: "6", fill: "#17171B" })));


export const IconPinVillage = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M5 21v-8a7 7 0 0114 0v8H5z" })));


export const IconPinKingdom = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M3 19h18l-1.2-9-3.8 3.5-3-6.5-3 6.5-3.8-3.5L3 19z" })));


export const IconPinContinent = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.8", ...props },
    React.createElement("circle", { cx: "12", cy: "12", r: "8.5" }),
    React.createElement("path", { d: "M3.5 12h17M12 3.5c3 3 3 14 0 17-3-3-3-14 0-17z" })));


export const IconPinRegion = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "1.8", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M4 7.5 9 5l6 2.5 5-2v13l-5 2-6-2.5-5 2z" }),
    React.createElement("path", { d: "M9 5v13M15 7.5v13" })));


export const IconPinCastle = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("rect", { x: "4", y: "10", width: "16", height: "11" }),
    React.createElement("rect", { x: "4", y: "6", width: "3.2", height: "4.5" }),
    React.createElement("rect", { x: "10.4", y: "6", width: "3.2", height: "4.5" }),
    React.createElement("rect", { x: "16.8", y: "6", width: "3.2", height: "4.5" }),
    React.createElement("rect", { x: "10", y: "14.5", width: "4", height: "6.5", fill: "#17171B" })));


export const IconPinFortress = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M12 2.5 19 5.5v5.5c0 5.2-3 8.7-7 10.5-4-1.8-7-5.3-7-10.5V5.5L12 2.5z" })));


export const IconPinMine = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("path", { d: "M4 8c3-3.2 7.5-5 11.5-4.3" }),
    React.createElement("path", { d: "M20.5 9.3c-3.3-2.7-7.7-3.7-11.5-2.4" }),
    React.createElement("line", { x1: "13", y1: "6", x2: "5", y2: "21" })));


export const IconPinForest = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("path", { d: "M12 2 6.5 10h3L5.5 16h4L6 22h12l-3.5-6h4L14.5 10h3z" })));


export const IconPinHarbor = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "12", cy: "5", r: "1.8", fill: "currentColor", stroke: "none" }),
    React.createElement("line", { x1: "12", y1: "7", x2: "12", y2: "19" }),
    React.createElement("path", { d: "M6 13c0 4 2.7 6.5 6 6.5s6-2.5 6-6.5" }),
    React.createElement("line", { x1: "7.5", y1: "11.5", x2: "16.5", y2: "11.5" })));


export const IconPinRuin = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("rect", { x: "9", y: "3", width: "6", height: "3" }),
    React.createElement("path", { d: "M9.5 7h3.2L12 17.5h-2z" }),
    React.createElement("path", { d: "M13.6 7H15l1 10-3-1z" }),
    React.createElement("path", { d: "M7.5 21l1.3-2.5h6.4l1.3 2.5z" })));


export const IconPinLandmark = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("line", { x1: "5", y1: "21", x2: "5", y2: "3" }),
    React.createElement("path", { d: "M5 4h13l-3 4 3 4H5", fill: "currentColor", stroke: "none" })));


export const IconPinDefault = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "13", height: "13", fill: "currentColor", ...props },
    React.createElement("circle", { cx: "12", cy: "12", r: "6" })));
