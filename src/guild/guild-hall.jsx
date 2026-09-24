import React, { useState, useEffect } from 'react';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { CrestCornerFlourish, FounderGuildCrest, GuildBuildingArtStyles, GuildBuildingScene, GuildMoodCaption } from './guild-building-art.jsx';

import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ArchiveDivider, ArchiveSectionHeading, ProgressBar } from '../shared-ui/ui-cards.jsx';
import { ConfirmDialog } from '../shared-ui/ui-primitives.jsx';
import { IconPlus } from '../shared-ui/icons.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// REMOVED — GuildLevelPanel, the Guild Level Up ceremony (GuildLevelUpOverlay,
// GuildConstructionSequence, GUILD_LEVEL_UP_DURATION_MS/_SEEN_KEY, readSeenGuildLevel/
// writeSeenGuildLevel) and GUILD_LEVEL_REWARDS' level-gated cosmetic unlocks. Guild Level/XP
// no longer exists — see guild-progression.jsx. Guild standing is Guild Reputation only now,
// shown by GuildReputationPanel (guild-reputation-panel.jsx), same as Writer Rank/Reputation
// replaced Writer Level.


// A single engraved plaque used by both the Writer Identity Card and the Guild Banner — one stat,
// given the same quiet carved-medallion treatment as everything else in the writer's chamber
// (RankCrest, AchievementMedal).
export function IdentityPlaque({ icon, label, value, valueColor, caption }) {
    return React.createElement("div", { style: { flex: '1 1 0', minWidth: 0, textAlign: 'center', padding: '0 6px' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[17], marginBottom: 5, opacity: 0.92 } }, icon),
        React.createElement("div", {
            style: {
                fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600,
                color: valueColor || '#E8C468', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
            },
        }, value),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 3 } }, label),
        caption && React.createElement("div", { style: { fontSize: TYPE_SCALE[9], color: '#5C5C64', fontStyle: 'italic', marginTop: 2 } }, caption));
}


// ---------- Founder Guilds ----------
// The ten permanent, official guilds Inkroot itself stands up so no writer ever faces an empty
// Guild Hall. They can never be deleted and always exist — every new writer must take a seat in
// one before they're able to found a Guild of their own. Each is led by the Founder of Inkroot;
// there is no per-guild leader roster yet since Founder Guilds (unlike Player Guilds) have no
// real guild_members table backing them.
// backendGuildId is this Founder Guild's real row in player_guilds (see
// supabase/history/69_migration_founder_guild_parity.sql) — pass it wherever a Player Guild
// would pass its guild.id: guild-treasury.js, guild-anthologies.js, guild-events.js. Founder
// Guild membership/roster is still read from founder_guild_members by the text id below, not
// from this uuid — the two are bridged server-side by is_guild_member()/is_guild_officer().
export const FOUNDER_GUILDS = [
    { id: 'fantasy', backendGuildId: '00000000-f01d-4000-8000-000000000001', icon: React.createElement(InkIcon, { name: 'castle', size: 22 }), name: 'The Fantasy Guild', motto: 'Where dragons rise and kingdoms are born.' },
    { id: 'romance', backendGuildId: '00000000-f01d-4000-8000-000000000002', icon: React.createElement(InkIcon, { name: 'heart', size: 22 }), name: 'The Romance Guild', motto: 'Every heart has a story worth telling.' },
    { id: 'scifi', backendGuildId: '00000000-f01d-4000-8000-000000000003', icon: React.createElement(InkIcon, { name: 'rocket', size: 22 }), name: 'The Science Fiction Guild', motto: 'Chart the unknown, one page at a time.' },
    { id: 'historical', backendGuildId: '00000000-f01d-4000-8000-000000000004', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 22 }), name: 'The Historical Guild', motto: 'The past deserves an eloquent witness.' },
    { id: 'horror', backendGuildId: '00000000-f01d-4000-8000-000000000005', icon: React.createElement(InkIcon, { name: 'ghost', size: 22 }), name: 'The Horror Guild', motto: 'Fear is just another kind of honesty.' },
    { id: 'mystery', backendGuildId: '00000000-f01d-4000-8000-000000000006', icon: React.createElement(InkIcon, { name: 'search', size: 22 }), name: 'The Mystery Guild', motto: 'Every clue leads somewhere.' },
    { id: 'comedy', backendGuildId: '00000000-f01d-4000-8000-000000000007', icon: React.createElement(InkIcon, { name: 'mask', size: 22 }), name: 'The Comedy Guild', motto: 'Laughter is the plot twist we all need.' },
    { id: 'worldbuilders', backendGuildId: '00000000-f01d-4000-8000-000000000008', icon: React.createElement(InkIcon, { name: 'globe', size: 22 }), name: 'The Worldbuilders Guild', motto: 'Maps, myths, and the bones of new worlds.' },
    { id: 'poetry', backendGuildId: '00000000-f01d-4000-8000-000000000009', icon: React.createElement(InkIcon, { name: 'scroll', size: 22 }), name: 'The Poetry Guild', motto: 'Say more with less.' },
    { id: 'general', backendGuildId: '00000000-f01d-4000-8000-00000000000a', icon: React.createElement(InkIcon, { name: 'chat', size: 22 }), name: 'The General Writers Guild', motto: 'For stories that defy a single shelf.' },
];


export const FOUNDER_GUILD_LEADER = 'Founder of Inkroot';


export function founderGuildById(id) {
    return FOUNDER_GUILDS.find((g) => g.id === id) || null;
}


// A writer belongs to only one Guild at a time. Leaving one — Founder or Player — starts this
// cooldown before another can be joined (including re-entering a Player Guild they'd already
// founded). Joining a Founder Guild itself is always free.
export const GUILD_LEAVE_COOLDOWN_HOURS = 24;
export const GUILD_LEAVE_COOLDOWN_MINUTES = 2;


export const GUILD_LEAVE_COOLDOWN_MS = GUILD_LEAVE_COOLDOWN_MINUTES * 60 * 1000;


export function freshGuildMembership() {
    return { guildType: null, founderGuildId: null, founderJoinedDate: null, playerGuild: null, joinedGuild: null, leftAt: null };
}


export function guildCooldownRemainingMs(membership) {
    if (!membership || !membership.leftAt)
        return 0;
    const elapsed = Date.now() - new Date(membership.leftAt).getTime();
    return Math.max(0, GUILD_LEAVE_COOLDOWN_MS - elapsed);
}


export function formatCooldownRemaining(ms) {
    const totalMinutes = Math.ceil(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0)
        return `About ${hours}h ${minutes}m remain.`;
    return `About ${minutes}m remain.`;
}


// Migrates whatever's stored under GUILD_KEY into the current { guildType, founderGuildId,
// founderJoinedDate, playerGuild, leftAt } shape. Two older shapes are handled: the very first
// Founder-Guild save (which let a writer sit in a Founder Guild and a Player Guild at once, with
// no leftAt/cooldown), and the original pre-Founder-Guild save (a single self-founded guild profile
// directly at the top level). Either way, migration never assumes a writer is currently "in" a
// guild — guildType only ever comes from an explicit, current-shape membership.
export function normalizeGuildMembership(parsed) {
    if (parsed && typeof parsed === 'object' && 'guildType' in parsed) {
        return {
            guildType: parsed.guildType || null,
            founderGuildId: parsed.founderGuildId || null,
            founderJoinedDate: parsed.founderJoinedDate || null,
            playerGuild: parsed.playerGuild || null,
            joinedGuild: parsed.joinedGuild || null,
            leftAt: parsed.leftAt || null,
        };
    }
    if (parsed && typeof parsed === 'object' && ('founderGuildId' in parsed || 'playerGuild' in parsed)) {
        return {
            guildType: parsed.founderGuildId ? 'founder' : null,
            founderGuildId: parsed.founderGuildId || null,
            founderJoinedDate: parsed.founderJoinedDate || null,
            playerGuild: parsed.playerGuild || null,
            joinedGuild: null,
            leftAt: null,
        };
    }
    const wasCustomized = !!(parsed && (parsed.name || parsed.crest || parsed.motto));
    return {
        guildType: null,
        founderGuildId: null,
        founderJoinedDate: null,
        playerGuild: wasCustomized ? {
            name: parsed.name || '', crest: parsed.crest || null, motto: parsed.motto || '',
            createdDate: parsed.createdDate || new Date().toISOString(),
        } : null,
        joinedGuild: null,
        leftAt: null,
    };
}


// The very first thing a writer sees on opening the Guild Hall, before they've taken a seat
// anywhere — a welcome, and a choice of the ten permanent Founder Guilds. There is no "skip":
// every writer settles into an established Guild before they're able to found one of their own.
export function JoinGuildByCode({ onJoinByCode, joinCodeError }) {
    const [code, setCode] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const handleSubmit = async () => {
        if (!code.trim() || submitting)
            return;
        setSubmitting(true);
        await onJoinByCode(code.trim());
        setSubmitting(false);
    };
    return React.createElement("div", { style: { margin: '18px auto 0', maxWidth: 320 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginBottom: 8, fontStyle: 'italic' } }, "Have an invite code for a friend's guild?"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("input", {
                value: code, onChange: (e) => setCode(e.target.value), placeholder: "Invite code",
                onKeyDown: (e) => { if (e.key === 'Enter')
                    handleSubmit(); },
                style: {
                    flex: 1, borderRadius: RADIUS_SCALE[9], border: '1px solid #3A3020', background: '#1D1A14', color: '#EFE7D2',
                    padding: '9px 12px', fontSize: TYPE_SCALE[12.5], textAlign: 'center', letterSpacing: '0.04em', fontFamily: 'inherit',
                },
            }),
            React.createElement("button", {
                onClick: handleSubmit, disabled: submitting || !code.trim(), style: {
                    background: 'none', border: '1px solid #4A3D22', color: '#C89B3C', borderRadius: RADIUS_SCALE[9],
                    padding: '0 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: submitting ? 'default' : 'pointer',
                    opacity: submitting || !code.trim() ? 0.6 : 1,
                },
            }, submitting ? "Joining\u2026" : "Join")),
        joinCodeError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 6 } }, joinCodeError),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 6, fontStyle: 'italic' } }, "Sign in first \u2014 joining a guild is an account feature."));
}
export function GuildWelcomeScreen({ mode, cooldownLabel, hasPlayerGuild, playerGuildName, onJoin, onEnterOwnGuild, onJoinByCode, joinCodeError }) {
    // Founding a Player Guild for the first time needs a name up front — there is no such thing
    // as an unnamed guild now (see ink-root.jsx's enterOwnGuild, which refuses a first founding
    // with no name too, as the real backstop). Returning to a guild already founded skips this
    // entirely: it already has whatever name it has, and re-entering doesn't touch that.
    const [founding, setFounding] = useState(false);
    const [draftName, setDraftName] = useState('');
    const startFounding = () => { setDraftName(''); setFounding(true); };
    const confirmFounding = () => {
        const cleanName = draftName.trim();
        if (!cleanName) return;
        setFounding(false);
        onEnterOwnGuild(cleanName);
    };
    const headline = mode === 'cooldown'
        ? "Between Guilds"
        : "The Guild Hall";
    const body = mode === 'cooldown'
        ? `You've stepped back from a guild \u2014 a cooldown stands before you can settle into another. ${cooldownLabel || ''}`.trim()
        : mode === 'return'
            ? "You're between guilds. Take a seat in a Founder Guild again, or return to the guild you founded yourself."
            : "Every great storyteller begins their journey within an established Guild. Learn, write, build your reputation, and one day establish a Guild worthy of your own legend.";
    return React.createElement("div", { style: { textAlign: 'center' } },
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, headline),
            React.createElement("div", {
                style: {
                    fontSize: TYPE_SCALE[13.5], color: '#B8AF95', marginTop: 18, marginBottom: 8, lineHeight: 1.6,
                    maxWidth: 460, marginLeft: 'auto', marginRight: 'auto', fontStyle: 'italic',
                    fontFamily: "'Fraunces', Georgia, serif",
                },
            }, body)),
        (mode === 'return' || mode === 'cooldown') && !(founding && !hasPlayerGuild) && React.createElement("button", {
            onClick: mode === 'cooldown' ? undefined : (hasPlayerGuild ? onEnterOwnGuild : startFounding),
            disabled: mode === 'cooldown',
            style: {
                margin: '10px auto 0', display: 'block', background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22',
                color: mode === 'cooldown' ? '#5C5C64' : '#E8C468', borderRadius: RADIUS_SCALE[9], padding: '10px 20px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                cursor: mode === 'cooldown' ? 'default' : 'pointer', opacity: mode === 'cooldown' ? 0.55 : 1,
            },
        }, "\u2694\uFE0F ", hasPlayerGuild ? `Return to ${playerGuildName || 'My Guild'}` : "Establish Your Own Guild"),
        (founding && !hasPlayerGuild) && React.createElement("div", { style: { margin: '10px auto 0', maxWidth: 300, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("input", {
                autoFocus: true, value: draftName, placeholder: "Name your guild\u2026",
                onChange: (e) => setDraftName(e.target.value),
                onKeyDown: (e) => { if (e.key === 'Enter') confirmFounding(); },
                style: {
                    background: '#17140F', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[9],
                    color: '#EFE7D2', fontSize: TYPE_SCALE[12.5], padding: '9px 12px', textAlign: 'center',
                },
            }),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center' } },
                React.createElement("button", {
                    onClick: () => setFounding(false),
                    style: {
                        background: 'none', border: '1px solid #4A3D22', color: '#8A8680', borderRadius: RADIUS_SCALE[9],
                        padding: '8px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer',
                    },
                }, "Cancel"),
                React.createElement("button", {
                    onClick: confirmFounding,
                    disabled: !draftName.trim(),
                    style: {
                        background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22',
                        color: draftName.trim() ? '#E8C468' : '#5C5C64', borderRadius: RADIUS_SCALE[9],
                        padding: '8px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600,
                        cursor: draftName.trim() ? 'pointer' : 'default', opacity: draftName.trim() ? 1 : 0.55,
                    },
                }, "Found Guild")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic' } }, "A guild needs a name before it can be founded.")),
        mode === 'cooldown' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } },
            hasPlayerGuild ? "Unlocks once the cooldown above ends." : "Unlocks once the cooldown above ends \u2014 that includes founding a Guild of your own for the first time, not just rejoining a Founder Guild."),
        mode !== 'cooldown' && React.createElement(JoinGuildByCode, { onJoinByCode, joinCodeError }),
        mode !== 'cooldown' && React.createElement(React.Fragment, null,
            React.createElement(ArchiveDivider, { maxWidth: 320, margin: '26px auto 22px', fontSize: TYPE_SCALE[11], color: '#4A3D22', opacity: 1 }),
            React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "castle", size: 20, style: { display: "inline-block" } }), label: "Founder Guilds" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 8, marginBottom: 22 } }, "Permanent guilds raised by Inkroot itself \u2014 every one led by the ", FOUNDER_GUILD_LEADER, "."),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: SPACE_SCALE[16], textAlign: 'left' } },
                FOUNDER_GUILDS.map((fg) => React.createElement("div", {
                    key: fg.id, style: {
                        background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
                        borderRadius: RADIUS_SCALE[14], overflow: 'hidden', display: 'flex', flexDirection: 'column',
                    },
                },
                    React.createElement(GuildBuildingScene, { guildId: fg.id, compact: true }),
                    React.createElement("div", { style: { padding: '16px 18px 20px', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, fg.name),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8390', fontStyle: 'italic', lineHeight: 1.4, minHeight: 30 } }, "\u201C", fg.motto, "\u201D"),
                        React.createElement(GuildMoodCaption, { guildId: fg.id }),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#6C6C74', letterSpacing: '0.03em', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } }, React.createElement(InkIcon, { name: "crown", size: 10 }), "Led by ", FOUNDER_GUILD_LEADER),
                        React.createElement("button", {
                            onClick: () => onJoin(fg.id), style: {
                                marginTop: 4, background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22',
                                color: '#E8C468', borderRadius: RADIUS_SCALE[9], padding: '10px 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                            },
                        }, "Join this Guild"))))),
            React.createElement(GuildBuildingArtStyles, null),
            React.createElement(GuildBenefitsPanel, null)));
}


// A static, non-clickable roster entry representing the Founder of Inkroot — every Founder Guild's
// permanent leader. Deliberately plainer than MemberCard (no avatar upload, no click-through)
// since it isn't a real writer account, just Inkroot's own standing presence in the Hall.
export function FounderLeaderCard({ guildName }) {
    return React.createElement("div", {
        className: "member-card", style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start',
            background: 'linear-gradient(160deg, #241F14, #17130E)', border: '1px solid #4A3D22',
            borderRadius: RADIUS_SCALE[14], padding: 18, marginBottom: 12,
        },
    },
        React.createElement("div", { style: {
                width: 52, height: 52, borderRadius: '50%', flexShrink: 0,
                background: 'radial-gradient(circle at 34% 28%, #3A2F18, #17140F 72%)',
                border: '2px solid #C89B3C', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[22],
            } }, React.createElement(InkIcon, { name: "crown", size: 22 })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, FOUNDER_GUILD_LEADER),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: GUILD_ROLES[0].color, border: `1px solid ${GUILD_ROLES[0].color}55`, borderRadius: RADIUS_SCALE[5], padding: '2px 6px' } }, GUILD_ROLES[0].icon, ' ', GUILD_ROLES[0].name)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8390', marginTop: 5, lineHeight: 1.4 } }, "Presiding permanently over ", guildName || 'this guild', " on behalf of Inkroot.")));
}


// What a writer earns simply by holding a seat in a Founder Guild. None of these are guild-specific
// mechanics yet (they're the same lifetime systems Inkroot already tracks — XP, reputation,
// achievements, streaks), but while inside a Founder Guild they all count toward that guild.
export const FOUNDER_GUILD_BENEFITS = [
    { icon: React.createElement(InkIcon, { name: 'medal', size: 17 }), label: 'Guild XP' },
    { icon: React.createElement(InkIcon, { name: 'starFilled', size: 17 }), label: 'Writer XP' },
    { icon: React.createElement(InkIcon, { name: 'hourglass', size: 17 }), label: 'Reputation' },
    { icon: React.createElement(InkIcon, { name: 'tag', size: 17 }), label: 'Guild Titles' },
    { icon: React.createElement(InkIcon, { name: 'trophy', size: 17 }), label: 'Guild Achievements' },
    { icon: React.createElement(InkIcon, { name: 'library', size: 17 }), label: 'Publishing achievements' },
    { icon: React.createElement(InkIcon, { name: 'flame', size: 17 }), label: 'Writing streaks' },
    { icon: React.createElement(InkIcon, { name: 'eye', size: 17 }), label: "Readers' recognition" },
];


export function GuildBenefitsPanel() {
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "sparkle", size: 20, style: { display: "inline-block" } }), label: "While Inside This Founder Guild, Writers Earn" }),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: SPACE_SCALE[12], marginTop: 16 } },
            FOUNDER_GUILD_BENEFITS.map((b) => React.createElement("div", {
                key: b.label, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], background: 'linear-gradient(160deg, #211C13, #17130E)',
                    border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[11], padding: '12px 14px',
                },
            },
                React.createElement("span", { style: { display: 'inline-flex' } }, b.icon),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#D9D2BE', fontWeight: 500 } }, b.label)))));
}


// Level 20 reward: a trophy shelf celebrating the guild's own standing (Guild Rank, Guild Level,
// Guild Quests won) — a display case, not a new stat. Nothing shown here is computed differently
// than it already is elsewhere in the Hall.
export function GuildTrophyDisplay({ guildRank, questsCompleted, totalQuests }) {
    const trophies = [
        { icon: guildRank.icon, label: guildRank.name, caption: 'Guild Rank', color: guildRank.color },
        { icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 22 }), label: `${questsCompleted} / ${totalQuests}`, caption: 'Guild Quests Won', color: '#C89B3C' },
    ];
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "trophy", size: 20, style: { display: "inline-block" } }), label: "Guild Trophy Display" }),
        React.createElement("div", { style: { display: 'flex', justifyContent: 'center', gap: SPACE_SCALE[16], flexWrap: 'wrap', marginTop: 16 } },
            trophies.map((t) => React.createElement("div", { key: t.caption, style: {
                    textAlign: 'center', minWidth: 130, padding: '18px 16px', borderRadius: RADIUS_SCALE[12],
                    background: 'linear-gradient(160deg, #211C13, #17130E)', border: `1px solid ${t.color}44`,
                } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'center' } }, t.icon),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: t.color, marginTop: 6 } }, t.label),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#7A7A82', letterSpacing: '0.05em', textTransform: 'uppercase', marginTop: 3 } }, t.caption)))));
}


// Level 25 reward: purely decorative trim — an ornamental flourish and gilded rule that appear
// around the Hall once a guild has reached that level. No content, no function, just adornment.
export function GuildHallDecorFlourish() {
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], margin: '8px auto 30px', maxWidth: 360 } },
        React.createElement("div", { style: { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, #8B5CCE88, transparent)' } }),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[14], color: '#8B5CCE' } }, "\u2766 \u2765 \u2766"),
        React.createElement("div", { style: { flex: 1, height: 1, background: 'linear-gradient(90deg, transparent, #8B5CCE88, transparent)' } }));
}


// The large Guild Banner at the top of the Guild Hall — the writers'-fortress counterpart to the
// Writer Identity Card. A Founder Guild's banner (isFounder: true) is read-only — its name, motto,
// and crest are fixed, since it's a permanent Inkroot institution — but a writer can still leave
// their seat in it (leaving always starts the cooldown before joining anywhere else). A writer's
// own Player Guild keeps the original editable banner: they're its sole real member and its only
// possible officer, which is why the Invite button always shows. Guild Level rewards (new banner
// backdrop, animated crest, exclusive theme, golden name) layer on here purely cosmetically once
// earned; Members Online is now a real Presence-backed count passed down from home-screen.jsx
// (see onlineCount below and subscribeGuildPresence in lib/player-guild.js) rather than something
// this component derives itself.
// An empty, stable default so a caller that hasn't wired presence yet (or a signed-out writer,
// per subscribeGuildPresence's own honesty note) gets "nobody online" rather than every member
// rendering with a fresh, identity-changing empty Set on every render.
const NOBODY_ONLINE = new Set();

// Real members of a Player Guild — owned or joined — fetched once per guild id. Kept separate
// from GuildBanner's own "Total Members" plaque (which still just defaults to 1) rather than
// threading a loading member count back up into a preceding sibling component; this renders its
// own compact list right below the banner instead. onlineUserIds is the same Presence Set
// GuildBanner's Members Online plaque counts from (subscribed once, up in home-screen.jsx, and
// passed to both rather than each opening its own channel for the same guild) — each pill gets a
// live green/grey dot exactly like MemberCard's own avatar dot uses.
//
// Shared pill-row rendering lives in GuildMemberPills below — this and FounderGuildRoster differ
// only in which table backs the fetch (player_guild_members vs founder_guild_members), not in
// how the roster itself is drawn.
function GuildMemberPills({ members, onlineUserIds }) {
    const online = onlineUserIds || NOBODY_ONLINE;
    return React.createElement("div", { style: { marginTop: -14, marginBottom: 26, textAlign: 'center' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 8 } },
            `${members.length} Member${members.length === 1 ? '' : 's'}`),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', justifyContent: 'center' } },
            members.map((m) => React.createElement("span", {
                key: m.user_id, style: {
                    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                    fontSize: TYPE_SCALE[11], color: '#D9D2BE', background: '#1D1D22', border: '1px solid #2A2417',
                    borderRadius: RADIUS_SCALE[999], padding: '4px 10px 4px 8px',
                },
            },
                React.createElement("span", { style: {
                        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                        background: online.has(m.user_id) ? '#5FBF6E' : '#5C5C64',
                    } }),
                m.name))));
}

export function PlayerGuildRoster({ guildId, onlineUserIds }) {
    const [state, setState] = useState({ loading: true, error: null, members: [] });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, error: null, members: [] });
        fetchPlayerGuildMembers(guildId)
            .then((members) => { if (!cancelled) setState({ loading: false, error: null, members }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, members: [] }); });
        return () => { cancelled = true; };
    }, [guildId]);
    if (state.loading || state.error || state.members.length === 0)
        return null; // quiet by default — MembersHall below already shows the current writer regardless
    return React.createElement(GuildMemberPills, { members: state.members, onlineUserIds });
}

// Founder Guild counterpart to PlayerGuildRoster above — real as of this fix, not simulated:
// founder_guild_members has held every Founder Guild's actual join/leave history since Phase 8
// (see syncFounderGuildMembership/leaveFounderGuildMembership in lib/library-guild.js), but until
// fetchFounderGuildMembers (also library-guild.js) nothing in the UI ever read it back as a
// member list — it existed purely to gate Fireside/Bookshelf RLS. This is a different roster
// from Guild Order's own (see guild-order.jsx's own HONESTY NOTE) — that deeper roles/
// manuscript/anthology system is also real for Founder Guilds now (fix-tracker items 15-17), and
// Guild Reputation followed the same fix (see founder_guild_member_stats,
// 88_migration_founder_guild_member_stats.sql) — this component just predates all of that and
// was never a stand-in for any of it, so nothing here needed to change once they landed.
export function FounderGuildRoster({ guildId, onlineUserIds }) {
    const [state, setState] = useState({ loading: true, error: null, members: [] });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, error: null, members: [] });
        fetchFounderGuildMembers(guildId)
            .then((members) => { if (!cancelled) setState({ loading: false, error: null, members }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, members: [] }); });
        return () => { cancelled = true; };
    }, [guildId]);
    if (state.loading || state.error || state.members.length === 0)
        return null; // quiet by default — MembersHall below already shows the current writer regardless
    return React.createElement(GuildMemberPills, { members: state.members, onlineUserIds });
}

export function GuildBanner({ guild, fileInputRef, handleCrestFile, crestError, onSaveGuild, onLeave, onInvite, inviteStatus, reputation, isFounder, isJoinedMember, founderIcon, founderGuildId, guildLevel, memberCount, onlineCount }) {
    // onlineCount comes from home-screen.jsx's subscribeGuildPresence subscription — real for
    // both guild types now (Founder Guilds included, since founder_guild_members backs a real
    // roster too — see FounderGuildRoster's own comment). null only before the first presence
    // sync has arrived, which the notYet check below reads as "not yet chronicled" rather than a
    // fabricated 0.
    const online = typeof onlineCount === 'number' ? onlineCount : null;
    const notYet = (v) => v === null || v === undefined;
    // "Leave Guild" is destructive and immediate once confirmed, so it asks first — same
    // confirm-dialog pattern as deleting a project on the Home screen — rather than acting on
    // the first tap.
    const [confirmingLeave, setConfirmingLeave] = useState(false);
    // A guild is read-only to the person viewing it whenever they don't own it — that's true for
    // every Founder Guild (nobody "owns" those) and now also true for a Player Guild joined via
    // invite code rather than founded. Kept as its own derived flag rather than overloading
    // isFounder everywhere, since a couple of spots (the crest icon, the footer disclaimer) still
    // need to tell the two read-only cases apart.
    const readOnly = isFounder || isJoinedMember;
    // Founder Guilds get the full engraved heraldic seal (crown, wreath, banner cloth, shield —
    // see FounderGuildCrest in guild-building-art.jsx); a Player Guild (owned or joined) keeps
    // its original uploadable hexagon crest exactly as before. Guild Level's cosmetic reward
    // tiers (new banner backdrop, animated crest, exclusive theme, golden name) are gone along
    // with the rest of the Level UI below — Guild Reputation is the only standing a guild has now.
    const accentBorder = '#4A3D22';
    const accentGlow = 'rgba(200,155,60,0.16)';
    const bannerBackground = `radial-gradient(ellipse at 50% 0%, ${accentGlow}, transparent 68%), linear-gradient(160deg, #211C13, #17130E)`;
    return React.createElement("div", {
        style: {
            textAlign: 'center', padding: '38px 26px 28px', borderRadius: RADIUS_SCALE[16], marginBottom: 30, position: 'relative',
            background: bannerBackground,
            border: `1px solid ${accentBorder}`, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 12px 34px rgba(0,0,0,0.4)',
        },
    },
        React.createElement(CrestCornerFlourish, { style: { position: 'absolute', left: 10, bottom: 10, opacity: 0.6, pointerEvents: 'none' } }),
        React.createElement(CrestCornerFlourish, { style: { position: 'absolute', right: 10, bottom: 10, opacity: 0.6, pointerEvents: 'none', transform: 'scaleX(-1)' } }),
        isFounder
            ? React.createElement("div", { style: { width: 176, margin: '0 auto 10px', filter: 'drop-shadow(0 6px 18px rgba(0,0,0,0.5))' } },
                React.createElement(FounderGuildCrest, { guildId: founderGuildId, size: 176 }))
            : React.createElement("div", { onClick: readOnly ? undefined : (() => fileInputRef.current && fileInputRef.current.click()), style: {
                    width: 128, height: 128, margin: '0 auto 18px', cursor: readOnly ? 'default' : 'pointer', position: 'relative',
                    clipPath: 'polygon(50% 0%, 95% 24%, 95% 74%, 50% 100%, 5% 74%, 5% 24%)',
                    background: guild.crest ? `center/cover url(${guild.crest})` : 'radial-gradient(circle at 34% 24%, #2A2620, #17140F 72%)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    filter: 'drop-shadow(0 4px 16px rgba(0,0,0,0.5))',
                } },
                React.createElement("div", { style: {
                        position: 'absolute', inset: 0,
                        clipPath: 'polygon(50% 0%, 95% 24%, 95% 74%, 50% 100%, 5% 74%, 5% 24%)',
                        border: '3px solid #C89B3C', pointerEvents: 'none',
                    } }),
                !guild.crest && React.createElement(InkIcon, { name: "shield", size: readOnly ? 46 : 42, color: "#8A8272", style: { opacity: readOnly ? 0.9 : 0.5 } }),
                !readOnly && React.createElement("span", { style: {
                        position: 'absolute', bottom: 2, right: 2, width: 30, height: 30, borderRadius: '50%',
                        background: '#C89B3C', border: '2px solid #17140F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[13],
                    } }, "\u270E")),
        !isFounder && !readOnly && React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", onChange: handleCrestFile, style: { display: 'none' } }),
        crestError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97757', marginBottom: 10 } }, crestError),
        readOnly
            ? React.createElement("div", { style: {
                    textAlign: 'center', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[25], fontWeight: 600, color: '#EFE7D2',
                } }, guild.name)
            : React.createElement("input", { value: guild.name, onChange: (e) => onSaveGuild({ name: e.target.value }), placeholder: "Name your guild\u2026", maxLength: 60, style: {
                    display: 'block', margin: '0 auto', textAlign: 'center', background: 'none', border: 'none', outline: 'none',
                    fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[25], fontWeight: 600, color: '#EFE7D2', width: '100%', maxWidth: 340,
                } }),
        readOnly
            ? (guild.motto && React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], marginTop: 10, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201C"),
                React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[12.5], color: '#C9BE8D' } }, guild.motto),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201D")))
            : React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], marginTop: 10, maxWidth: 360, marginLeft: 'auto', marginRight: 'auto' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201C"),
                React.createElement("input", { value: guild.motto || '', onChange: (e) => onSaveGuild({ motto: e.target.value }), placeholder: "A motto worth rallying behind\u2026", maxLength: 200, style: {
                        flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', textAlign: 'center',
                        fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[12.5], color: '#C9BE8D',
                    } }),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201D")),
        isFounder && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A7355', marginTop: 10, letterSpacing: '0.02em', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } }, React.createElement(InkIcon, { name: "crown", size: 11 }), "Led by ", FOUNDER_GUILD_LEADER),
        React.createElement(ArchiveDivider, { maxWidth: 320, margin: '22px auto 18px', fontSize: TYPE_SCALE[11], color: '#4A3D22', opacity: 1 }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'stretch', flexWrap: 'wrap', rowGap: 16 } },
            React.createElement(IdentityPlaque, { icon: "\u231B", label: "Reputation", value: notYet(reputation) ? "\u2014" : reputation, valueColor: notYet(reputation) ? '#7A7A82' : undefined, caption: notYet(reputation) ? 'not yet chronicled' : null }),
            React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            React.createElement(IdentityPlaque, { icon: React.createElement(InkIcon, { name: "users", size: 15, style: { display: "inline-block" } }), label: "Total Members", value: memberCount == null ? 1 : memberCount }),
            React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            React.createElement(IdentityPlaque, { icon: React.createElement("span", { style: { display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: "#5FBF6E" } }), label: "Members Online", value: notYet(online) ? "\u2014" : online, valueColor: notYet(online) ? '#7A7A82' : undefined, caption: notYet(online) ? 'not yet chronicled' : null })),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], justifyContent: 'center', marginTop: 26, flexWrap: 'wrap' } },
            // Only shown to a Founder Guild member or a Player Guild joined by invite code —
            // both have somewhere to actually leave to server-side (founder_guild_members /
            // player_guild_members). The owner of their own Player Guild (readOnly is false
            // here, same as the editable-name-input case above) has no leave/disband/transfer
            // flow at all yet, so the button is hidden rather than looking like it works —
            // see leaveCurrentGuild in ink-root.jsx for the matching guard.
            readOnly && React.createElement("button", { onClick: () => setConfirmingLeave(true), style: {
                    background: 'linear-gradient(160deg, #201B12, #14110B)', border: '1px solid #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[9],
                    padding: '11px 24px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
                    boxShadow: 'inset 0 0 0 1px rgba(200,155,60,0.12)',
                } }, "Leave Guild"),
            !isJoinedMember && React.createElement("button", { onClick: onInvite, style: {
                    background: 'linear-gradient(160deg, #201B12, #14110B)', border: '1px solid #4A3D22', color: '#C89B3C', borderRadius: RADIUS_SCALE[9],
                    padding: '11px 24px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    clipPath: 'polygon(8px 0, 100% 0, 100% calc(100% - 8px), calc(100% - 8px) 100%, 0 100%, 0 8px)',
                    boxShadow: 'inset 0 0 0 1px rgba(200,155,60,0.22)',
                } }, "\u2709 Invite")),
        confirmingLeave && React.createElement(ConfirmDialog, {
            message: "Are you sure you want to leave this Guild?", confirmLabel: "Leave",
            onCancel: () => setConfirmingLeave(false),
            onConfirm: async () => { setConfirmingLeave(false); await onLeave(); },
        }),
        React.createElement(ArchiveDivider, { maxWidth: 200, margin: '22px auto 14px', fontSize: TYPE_SCALE[10], color: '#4A3D22', opacity: 0.9 }),
        isFounder
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10, fontStyle: 'italic' } }, "A permanent Founder Guild \u2014 official, always open, and never deleted. Leaving starts a cooldown before you can join another \u2014 or found (or return to) a Guild of your own from there.")
            : isJoinedMember
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10, fontStyle: 'italic' } }, "You joined this guild \u2014 its founder can edit its name, motto, and crest, and holds the Invite. Leaving starts a cooldown before you can join another.")
                : React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10, fontStyle: 'italic' } }, "You founded this guild \u2014 as its only officer, you hold the Invite. Leaving starts a cooldown before you can join another."),
        inviteStatus && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#C89B3C', marginTop: 8 } }, inviteStatus));
}


// REMOVED — the old NoticeBoard here (six seeded/evergreen parchment notices — a welcome, a
// founding-date card, and four permanently-generic filler notices, none of them anything a real
// officer ever wrote). Replaced by the real, permission-gated one in guild/notice-board.jsx,
// which reads real fireside_posts rows tagged category = 'announcement' by an actual Guild
// Leader/Treasurer/Officer (Player Guild) or Inkroot admin (Founder Guild) — see that file's own
// header for the full picture. `.notice-board`/`.notice-card`/`.notice-pin` (this file's own
// injected styles in home-screen.jsx) are unchanged and still used by the new version.


// The five Guild Role tiers, for the legend beneath the roster — only Guild Master is ever
// actually held right now (by the founder), but the ladder is shown in full since it's part of
// what the Guild Hall is building toward.
export const GUILD_ROLES = [
    { name: 'Guild Master', icon: React.createElement(InkIcon, { name: 'crown', size: 11 }), color: '#E8C468' },
    { name: 'Officer', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 11 }), color: '#C89B3C' },
    { name: 'Veteran', icon: React.createElement(InkIcon, { name: 'medal', size: 11 }), color: '#A8916A' },
    { name: 'Member', icon: React.createElement(InkIcon, { name: 'book', size: 11 }), color: '#8A8A92' },
    { name: 'Apprentice', icon: React.createElement(InkIcon, { name: 'scroll', size: 11 }), color: '#6C6C74' },
];


// One labeled value inside a Member Card — plainer than IdentityPlaque (no icon, left-aligned,
// built for a 2-column grid rather than a row) since a member card holds more fields in less width.
export function MemberStat({ label, value }) {
    return React.createElement("div", { style: { minWidth: 0 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9], color: '#7A7A82', letterSpacing: '0.05em', textTransform: 'uppercase' } }, label),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, value));
}


// A single member's card in the Members' Hall — real data throughout, since Inkroot's only
// possible member (for now) is the writer themself, founder and Guild Master of their own guild.
// Clicking it opens their Author Hall, the same destination as the profile-avatar shortcut
// elsewhere in the app.
export function MemberCard({ profile, rank, role, reputation, currentProject, online, publishedCount, memberSinceLabel, onOpen }) {
    const notYet = (v) => v === null || v === undefined;
    return React.createElement("div", {
        onClick: onOpen, className: "member-card", style: {
            display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start', cursor: 'pointer',
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
            borderRadius: RADIUS_SCALE[14], padding: 18,
        },
    },
        React.createElement("div", { style: { position: 'relative', flexShrink: 0 } },
            React.createElement("div", { style: {
                    width: 52, height: 52, borderRadius: '50%',
                    background: profile.avatar ? `center/cover url(${profile.avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                    border: '2px solid #C89B3C', display: 'flex', alignItems: 'center', justifyContent: 'center',
                } }, !profile.avatar && React.createElement(InkIcon, { name: "users", size: 18, color: "#8A8272" })),
            React.createElement("span", { style: {
                    position: 'absolute', bottom: -1, right: -1, width: 13, height: 13, borderRadius: '50%',
                    background: online ? '#5FBF6E' : '#5C5C64', border: '2px solid #17140F',
                } })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, profile.name || 'Unnamed Writer'),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: role.color, border: `1px solid ${role.color}55`, borderRadius: RADIUS_SCALE[5], padding: '2px 6px' } }, role.icon, ' ', role.name)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: rank.color, marginTop: 3 } }, rank.icon, ' ', rank.name),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 14px', marginTop: 14 } },
                React.createElement(MemberStat, { label: "Reputation", value: notYet(reputation) ? "\u2014" : reputation }),
                React.createElement(MemberStat, { label: "Current Project", value: currentProject || 'Not currently writing' }),
                React.createElement(MemberStat, { label: "Published Books", value: publishedCount }),
                React.createElement(MemberStat, { label: "Member Since", value: memberSinceLabel || "\u2014" }))));
}


// The Members' Hall: the roster of everyone in the guild. This panel itself always shows just the
// current writer — the real, multi-member roster for a Player Guild lives in the separate
// PlayerGuildRoster component, and a Founder Guild's in the sibling FounderGuildRoster (both
// above, both rendered in home-screen.jsx alongside this panel), since MembersHall's own
// single-entry-plus-role-legend layout is shared across both guild types.
export function MembersHall({ profile, rank, guild, reputation, currentProject, publishedCount, memberSinceLabel, onOpen, isFounder }) {
    return React.createElement("div", null,
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "columns", size: 20, style: { display: "inline-block" } }), label: "The Members' Hall" }),
        React.createElement("div", { style: { marginTop: 16 } },
            isFounder && React.createElement(FounderLeaderCard, { guildName: guild.name }),
            React.createElement(MemberCard, {
                profile, rank, role: isFounder ? GUILD_ROLES[3] : GUILD_ROLES[0], reputation, currentProject, online: true,
                publishedCount, memberSinceLabel, onOpen,
            })),
        React.createElement(GuildRoleLegend, null));
}


export function GuildRoleLegend() {
    return React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8], marginTop: 20, justifyContent: 'center' } },
        GUILD_ROLES.map((r) => React.createElement("span", {
            key: r.name, style: {
                fontSize: TYPE_SCALE[10.5], color: r.color, border: `1px solid ${r.color}40`, borderRadius: RADIUS_SCALE[6], padding: '4px 9px',
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[5],
            },
        }, r.icon, ' ', r.name)));
}




// ---------- Guild Quests ----------
// Five cooperative objectives. Three are wired to real lifetime totals (words, chapters,
// completed/published projects) that Inkroot already tracks — for a guild of one, everything the
// writer writes counts toward them alone until other writers can join. The other two (Recruit,
// Review) have no backing system yet, so their progress is honestly zero rather than invented;
// statKey is null for those, which QuestCard reads as "no system for this yet."
export const GUILD_QUEST_DEFS = [
    { id: 'words2m', icon: React.createElement(InkIcon, { name: 'scroll', size: 18 }), title: 'Write 2,000,000 Words Together', target: 2000000, unit: 'words', guildXP: 5000, reputationReward: 250, statKey: 'totalWords' },
    { id: 'chapters300', icon: React.createElement(InkIcon, { name: 'book', size: 18 }), title: 'Complete 300 Chapters', target: 300, unit: 'chapters', guildXP: 3000, reputationReward: 150, statKey: 'chapters' },
    { id: 'publish25', icon: React.createElement(InkIcon, { name: 'library', size: 18 }), title: 'Publish 25 Books', target: 25, unit: 'books', guildXP: 8000, reputationReward: 400, statKey: 'completedCount' },
    { id: 'recruit15', icon: React.createElement(InkIcon, { name: 'users', size: 18 }), title: 'Recruit 15 New Writers', target: 15, unit: 'writers', guildXP: 4000, reputationReward: 200, statKey: null },
    { id: 'review100', icon: React.createElement(InkIcon, { name: 'search', size: 18 }), title: 'Review 100 Published Stories', target: 100, unit: 'reviews', guildXP: 2500, reputationReward: 120, statKey: null },
];


// REMOVED — GUILD_QUESTS_SEEN_KEY / readQuestsSeenMap / writeQuestSeen tracked which quests had
// already played their completion celebration. QuestCard no longer has one to guard (see above).


// One quest's card: a progress bar, its Reputation reward, and a status pill. Used to also play a
// particle-shatter ceremony plus a sound effect the moment progress first reached target (reusing
// GuildLockShatter and playGuildUnlockSound, both removed along with the rest of the loud
// unlock/level-up machinery — see guild-progression.jsx and guild-reputation-panel.jsx). A
// completed quest still gets a quiet, clearly-visible acknowledgment (the pill turning to
// "Completed"), just not a fanfare.
export function QuestCard({ def, progress }) {
    const target = def.target;
    const pct = Math.max(0, Math.min(100, Math.round((progress / target) * 100)));
    const complete = progress >= target;
    const noSystemYet = def.statKey === null;
    return React.createElement("div", {
        style: {
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[12],
            padding: 16, position: 'relative', textAlign: 'left',
        },
    },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 10 } },
            React.createElement("span", { style: { display: 'inline-flex' } }, def.icon),
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2', flex: 1 } }, def.title),
            React.createElement("span", { style: {
                    fontSize: TYPE_SCALE[9.5], fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', borderRadius: RADIUS_SCALE[5], padding: '3px 7px',
                    color: complete ? '#8FCB8F' : '#C89B3C', border: `1px solid ${complete ? '#8FCB8F55' : '#C89B3C55'}`,
                } }, complete ? "\u2713 Completed" : "In Progress")),
        React.createElement("div", { style: { height: 8, borderRadius: RADIUS_SCALE[5], background: '#100E0A', overflow: 'hidden', border: '1px solid #2A2416' } },
            React.createElement("div", { style: { height: '100%', width: `${pct}%`, background: 'linear-gradient(90deg, #8A6B25, #E8C468)', transition: 'width 600ms ease' } })),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 6 } }, `${progress.toLocaleString()} / ${target.toLocaleString()} ${def.unit}`),
        noSystemYet && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', fontStyle: 'italic', marginTop: 3 } }, "no system for this yet \u2014 progress starts at zero"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], flexWrap: 'wrap', marginTop: 12, fontSize: TYPE_SCALE[11] } },
            React.createElement("span", { style: { color: '#A8916A' } }, `\u231B +${def.reputationReward} Reputation`)));
}


// The Guild Quests board — cooperative objectives, framed honestly for a guild of one until real
// multi-writer participation exists.
export function GuildQuestBoard({ lifetimeStats }) {
    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: "\u2694\uFE0F", label: "Guild Quests" }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginTop: 6, marginBottom: 18, fontStyle: 'italic' } }, "Cooperative objectives for the whole guild \u2014 for now, everything you write counts toward them alone"),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: SPACE_SCALE[14] } },
            GUILD_QUEST_DEFS.map((def) => React.createElement(QuestCard, { key: def.id, def, progress: def.statKey ? (lifetimeStats[def.statKey] || 0) : 0 }))));
}


// ---------- The Fireside ----------
// Inkroot's guild-discussion space — a real, functioning local message board (not a placeholder),
// since posting to it, replying, pinning, and reacting are all things a single writer can
// meaningfully do on their own device without any accounts or networking. Persisted under its own
// key rather than inside guildProfile, since it grows unboundedly while the guild record itself
// stays small.
export const FIRESIDE_KEY = 'inkroot:guild:fireside';


export const FIRESIDE_CATEGORIES = [
    { key: 'discussion', icon: React.createElement(InkIcon, { name: 'chat', size: 15 }), label: 'Guild Discussion' },
    { key: 'advice', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), label: 'Writing Advice' },
    { key: 'worldbuilding', icon: React.createElement(InkIcon, { name: 'map', size: 15 }), label: 'Worldbuilding Ideas' },
    { key: 'feedback', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), label: 'Chapter Feedback' },
    { key: 'announcement', icon: React.createElement(InkIcon, { name: 'horn', size: 15 }), label: 'Announcement' },
];


// Reaction emblems, deliberately not a single "like" — each names a specific kind of appreciation,
// so reacting reads as a considered response rather than a tally.
export const FIRESIDE_REACTIONS = [
    { key: 'fire', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), label: 'Inspired' },
    { key: 'sword', icon: "\u2694\uFE0F", label: 'Well Argued' },
    { key: 'scroll', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), label: 'Noted' },
    { key: 'spark', icon: "\u2728", label: 'Brilliant' },
];


// ---------- The Guild Anthology shelf ----------
// A real, wired-up bookshelf for this guild's anthologies — see
// supabase/history/35_migration_guild_anthologies.sql and src/lib/guild-anthologies.js. Every
// row here is a real guild_anthologies record fetched over RLS; nothing here is invented or
// locally simulated. Reuses the exact wooden-shelf markup/CSS (.shelf-stage/.shelf-wood/
// .shelf-bookend/.shelf-scroll/.shelf-item-cover/.shelf-label/.shelf-add-cover/.shelf-add-label,
// all defined once in home-screen.jsx's injected <style>) that the Home dashboard's own "Recent
// Activity" shelf already uses, so an anthology reads as one more row of real books on a real
// shelf rather than a second, differently-dressed list. Player Guilds only (remoteGuildId is
// null for a Founder Guild — see guild-anthologies.js's own header for that scope cut), so this
// renders nothing at all for a Founder Guild rather than showing an empty or fake shelf.
const ANTHOLOGY_STATUS_LABEL = { open: 'Open for submissions', reviewing: 'Reviewing', published: 'Published', cancelled: 'Cancelled' };
const ANTHOLOGY_STATUS_COLOR = { open: '#5FBF6B', reviewing: '#E8C468', published: '#C89B3C', cancelled: '#9C9280' };


export function GuildAnthologyShelf({ remoteGuildId, onOpenPublished, onManage }) {
    // null = not loaded yet (or nothing to load); [] = loaded, genuinely none yet.
    const [anthologies, setAnthologies] = useState(null);
    useEffect(() => {
        setAnthologies(null);
        if (!remoteGuildId)
            return;
        let cancelled = false;
        fetchGuildAnthologies(remoteGuildId)
            .then((rows) => { if (!cancelled) setAnthologies(rows); })
            .catch((e) => { console.warn('Inkroot: guild anthology shelf fetch failed', e); if (!cancelled) setAnthologies([]); });
        return () => { cancelled = true; };
    }, [remoteGuildId]);
    if (!remoteGuildId || anthologies === null)
        return null; // Founder Guild, or still loading — nothing honest to show yet.
    const tiles = anthologies.map((a) => {
        const badge = React.createElement("div", { style: {
                position: 'absolute', top: 6, left: 6, zIndex: 2, fontSize: TYPE_SCALE[8.5], fontWeight: 700,
                letterSpacing: '0.03em', textTransform: 'uppercase', color: '#100E0A',
                background: ANTHOLOGY_STATUS_COLOR[a.status] || '#9C9280', borderRadius: RADIUS_SCALE[100],
                padding: '2px 6px', boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            } }, ANTHOLOGY_STATUS_LABEL[a.status] || a.status);
        const coverWrap = React.createElement("div", { className: "shelf-item-cover", style: { borderRadius: RADIUS_SCALE[5] } },
            React.createElement(BookCover, { title: a.title, cover: a.cover, size: 'sm' }),
            badge);
        return React.createElement("div", {
            key: a.id,
            onClick: () => (a.status === 'published' && a.published_book_id) ? onOpenPublished(a.published_book_id) : onManage(),
            className: "proj-row shelf-item", style: {
                cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
                flexShrink: 0, scrollSnapAlign: 'start',
            },
        }, coverWrap, React.createElement("div", { className: "shelf-label", style: { width: 94 } }, a.title));
    });
    const newTile = React.createElement("div", {
        key: "__new_anthology__", onClick: onManage, className: "proj-row shelf-item", style: {
            cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
            flexShrink: 0, scrollSnapAlign: 'start',
        },
    }, React.createElement("div", { className: "shelf-item-cover", style: { borderRadius: RADIUS_SCALE[5] } },
        React.createElement("div", { className: "shelf-add-cover" },
            React.createElement(IconPlus, { width: 17, height: 17 }),
            React.createElement("div", { className: "shelf-add-label" }, "New", React.createElement("br", null), "anthology"))));
    return React.createElement(React.Fragment, null,
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } }), label: "The Guild Anthology" }),
        React.createElement("div", { className: "shelf-stage" },
            React.createElement("div", { className: "shelf-ambient" }),
            React.createElement("div", { className: "shelf-wood" }),
            React.createElement("div", { className: "shelf-bookend shelf-bookend-left" }),
            React.createElement("div", { className: "shelf-bookend shelf-bookend-right" }),
            React.createElement("div", { className: "shelf-scroll" }, ...tiles, newTile)));
}
