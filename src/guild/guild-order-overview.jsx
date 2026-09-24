import React from 'react';
import { InkIcon } from '../shell/ink-icon.jsx';
import { ArchiveDivider } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- Guild Order overview ----------
// The compact directory that replaces the old single generic "The Guild Order" teaser card on
// the Guild Hall home screen. The Guild Order itself (guild-order.jsx) is untouched — this is
// purely a nicer front door onto its six tabs (GO_TABS), one row per area, each carrying its own
// icon, a short live-or-static blurb, and a tap target that opens the Guild Order landed
// straight on that tab (see GuildOrderScreen's initialTab prop and home-screen.jsx's
// pendingGuildOrderTab).
//
// Deliberately a single vertical directory (two columns from tablet width up, via the
// .go-directory CSS grid in app.css) rather than six identical square cards or a horizontal pill
// row — each row reads left-to-right like an entry in a guild ledger: a carved icon medallion,
// the area's name and one line of context, and a small chevron out to it.
export const GUILD_ORDER_AREAS = [
    { key: 'roster', label: 'Roster', icon: 'users', blurb: 'See who stands with you' },
    { key: 'anthology', label: 'Anthology', icon: 'book', blurb: 'The guild\u2019s collaborative book' },
    { key: 'quests', label: 'Quests', icon: 'crossedSwords', blurb: 'Shared goals, tracked together' },
    { key: 'events', label: 'Guild Events', icon: 'horn', blurb: 'Competitions and challenges' },
    { key: 'treasury', label: 'Treasury', icon: 'moneybag', blurb: 'Guild funds and member earnings' },
    { key: 'council', label: 'Council', icon: 'columns', blurb: 'Proposals and guild governance' },
];


function GoDirectoryRow({ area, blurb, onSelect }) {
    return React.createElement("button", {
        onClick: () => onSelect(area.key),
        className: "go-directory-row",
        style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], width: '100%', textAlign: 'left',
            padding: '12px 13px', borderRadius: RADIUS_SCALE[12], cursor: 'pointer',
            background: 'linear-gradient(160deg, rgba(36,31,20,0.55), rgba(23,19,15,0.55))',
            border: '1px solid rgba(74,61,34,0.6)', font: 'inherit', color: 'inherit',
        },
    },
        React.createElement("div", {
            style: {
                width: 40, height: 40, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                background: 'radial-gradient(circle at 34% 30%, #241F14, #17130E 75%)', border: '1px solid rgba(232,196,104,0.4)',
            },
        }, React.createElement(InkIcon, { name: area.icon, size: 18, color: '#E8C468' })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: '#EFE7D2' } }, area.label),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A8680', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, blurb)),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[15], color: '#5C5546', flexShrink: 0, marginLeft: 2 } }, "\u203A"));
}


// `overrides` optionally replaces a specific area's static blurb with a live one-liner (e.g. an
// online-member count for Roster, a completed/total tally for Quests) — anything not present
// there just falls back to GUILD_ORDER_AREAS' own description.
export function GuildOrderOverview({ onSelect, overrides }) {
    return React.createElement("div", {
        style: {
            marginTop: 22, marginBottom: 8, borderRadius: RADIUS_SCALE[16], padding: '22px 18px 18px',
            background: 'linear-gradient(160deg, #211D14 0%, #1A171F 100%)',
            border: '1px solid rgba(232,196,104,0.35)', boxShadow: '0 0 24px 1px rgba(232,196,104,0.12)',
        },
    },
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 4 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[19], marginBottom: 6, color: '#C89B3C', opacity: 0.85 } }, "\u2766"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Guild Order"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8680', marginTop: 6 } }, "Six chambers of the guild, one hall")),
        React.createElement(ArchiveDivider, { maxWidth: 90, margin: '16px auto', fontSize: TYPE_SCALE[11] }),
        React.createElement("div", { className: "go-directory" },
            GUILD_ORDER_AREAS.map((area) => React.createElement(GoDirectoryRow, {
                key: area.key, area, onSelect,
                blurb: (overrides && overrides[area.key]) || area.blurb,
            }))));
}
