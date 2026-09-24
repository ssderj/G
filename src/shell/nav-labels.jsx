import React from 'react';


// Display names for the breadcrumb trail / Back button label when a Project Workspace tab isn't
// the Hub — kept separate from NAV_GROUPS' per-worldCategory labels since the breadcrumb only
// needs one name per underlying tab, not one per sidebar shortcut into it.
export const TAB_BREADCRUMB_LABELS = {
    manuscript: 'Manuscript', characters: 'Characters', locations: 'Locations', maps: 'Maps',
    timeline: 'Timeline', world: 'World Bible', glossary: 'Glossary', notes: 'Notes',
    health: 'Story Health', progress: 'Progress', achievements: 'Achievement Hall', settings: 'Settings',
    packs: 'Publishing',
};


// The single source of truth for how the sidebar and the Project Home hub group every section.
// Several items point at the 'world' tab with a specific worldCategory — clicking them opens the
// World Bible pre-filtered to that category, so Houses & Clans, Organizations, Magic, Religions,
// and Artifacts each get their own nav entry even though they all live in the same underlying tab.
// icon values are keys into ICON_PATHS (see shell/ink-icon.jsx) — rendered via <InkIcon>, not
// raw emoji, so they inherit the same engraved-line style as the rest of the app's chrome.
export const NAV_GROUPS = [
    { key: 'story', icon: 'book', label: 'Story', items: [
            { key: 'manuscript', icon: 'book', label: 'Manuscript' },
            { key: 'notes', icon: 'scroll', label: 'Notes' },
        ] },
    { key: 'world', icon: 'globe', label: 'World', items: [
            { key: 'world', icon: 'library', label: 'World Bible', worldCategory: 'all' },
            { key: 'locations', icon: 'castle', label: 'Locations' },
            { key: 'maps', icon: 'map', label: 'Maps' },
            { key: 'timeline', icon: 'hourglass', label: 'Timeline' },
            { key: 'glossary', icon: 'tag', label: 'Glossary' },
        ] },
    { key: 'people', icon: 'crown', label: 'People', items: [
            { key: 'characters', icon: 'users', label: 'Characters' },
            { key: 'world', icon: 'crown', label: 'Houses & Clans', worldCategory: 'houses' },
            { key: 'world', icon: 'columns', label: 'Organizations', worldCategory: 'organizations' },
        ] },
    { key: 'lore', icon: 'sparkle', label: 'Lore', items: [
            { key: 'world', icon: 'sparkle', label: 'Magic', worldCategory: 'magic' },
            { key: 'world', icon: 'candle', label: 'Religions', worldCategory: 'religions' },
            { key: 'world', icon: 'archiveBox', label: 'Artifacts', worldCategory: 'artifacts' },
        ] },
    { key: 'project', icon: 'chart', label: 'Project', items: [
            { key: 'health', icon: 'target', label: 'Story Health' },
            { key: 'progress', icon: 'chart', label: 'Progress' },
            { key: 'achievements', icon: 'trophy', label: 'Achievements' },
            { key: 'settings', icon: 'gear', label: 'Settings' },
        ] },
    { key: 'publishing', icon: 'package', label: 'Publishing', items: [
            { key: 'packs', icon: 'package', label: 'Publishing' },
        ] },
];
