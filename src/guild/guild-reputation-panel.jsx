import React from 'react';
import { ArchiveSectionHeading } from '../shared-ui/ui-cards.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- Guild Reputation ----------
// The rank ladder Guild Reputation climbs through, and the honest breakdown of what does (and
// doesn't yet) feed into it — see computeGuildReputation above for the live formula.
export const GUILD_RANK_TIERS = [
    { name: 'Small Fellowship', min: 0, icon: React.createElement(InkIcon, { name: 'tree', size: 13 }), color: '#8A8A92' },
    { name: 'Established Guild', min: 300, icon: React.createElement(InkIcon, { name: 'castle', size: 13 }), color: '#A8916A' },
    { name: 'Royal Guild', min: 1000, icon: React.createElement(InkIcon, { name: 'crown', size: 13 }), color: '#C89B3C' },
    { name: 'Legendary Guild', min: 2500, icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 13 }), color: '#E8C468' },
];


export function guildRankForReputation(rep) {
    let tier = GUILD_RANK_TIERS[0];
    for (const t of GUILD_RANK_TIERS) {
        if (rep >= t.min)
            tier = t;
    }
    return tier;
}


export const GUILD_REPUTATION_SOURCES = [
    { label: 'Members publishing books', live: true },
    { label: 'Books receiving high ratings', live: false },
    { label: 'Winning Guild Quests', live: true },
    { label: 'Writing Events', live: false },
    { label: 'Community participation', live: true },
    { label: 'Helpful reviews', live: false },
];


export function GuildReputationPanel({ reputation, rank }) {
    const tierIndex = GUILD_RANK_TIERS.findIndex((t) => t.name === rank.name);
    const nextTier = GUILD_RANK_TIERS[tierIndex + 1];
    return React.createElement("div", { style: { marginTop: 34, marginBottom: 8 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "medal", size: 20, style: { display: "inline-block" } }), label: "Guild Reputation" }),
        React.createElement("div", { style: {
                textAlign: 'center', marginTop: 16, padding: '26px 20px', borderRadius: RADIUS_SCALE[14],
                background: 'radial-gradient(ellipse at 50% 0%, rgba(200,155,60,0.14), transparent 65%), linear-gradient(160deg, #211C13, #17130E)',
                border: '1px solid #4A3D22',
            } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[38], fontWeight: 700, color: '#E8C468' } }, reputation.toLocaleString()),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.08em', textTransform: 'uppercase', marginTop: 2 } }, "Guild Reputation"),
            React.createElement("div", { style: {
                    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 16, padding: '6px 16px', borderRadius: RADIUS_SCALE[999],
                    border: `1px solid ${rank.color}55`, color: rank.color, fontSize: TYPE_SCALE[13], fontWeight: 600,
                } }, rank.icon, ' ', rank.name),
            nextTier && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 12 } }, `${(nextTier.min - reputation).toLocaleString()} Reputation to ${nextTier.name}`)),
        React.createElement("div", { style: { marginTop: 20 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', textAlign: 'center', marginBottom: 10 } }, "Reputation grows from"),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8], maxWidth: 340, margin: '0 auto' } },
                GUILD_REPUTATION_SOURCES.map((s) => React.createElement("div", { key: s.label, style: {
                        display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], fontSize: TYPE_SCALE[12.5], color: s.live ? '#D9D2BE' : '#5C5C64',
                    } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12] } }, s.live ? "\u2713" : "\u2022"),
                    React.createElement("span", null, s.label),
                    !s.live && React.createElement("span", { style: { fontSize: TYPE_SCALE[10], fontStyle: 'italic', marginLeft: 'auto' } }, "not yet tracked"))))));
}


// REMOVED — GUILD_UNLOCK_LEVEL and GuildLockShatter (a Writer-Level-gated lock on the Guild/
// Universe tabs, with a particle-burst "unlock" animation). Writer Level no longer exists, and a
// level-gated unlock ceremony is exactly the kind of loud gamification being cut — Guild and
// Living Universe are just available now, the same as every other tab. See ink-icon.jsx's
// HomeNav, which used to check writerLevel >= GUILD_UNLOCK_LEVEL for every tab render.
