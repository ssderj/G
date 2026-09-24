import React, { useState, useEffect, useMemo } from 'react';
import { storage } from '../lib/storage.js';
import { InkIcon } from '../shell/ink-icon.jsx';
import { formatNaira } from '../lib/payments.js';
import { fetchGuildTreasuryLedger, fetchGuildTreasuryRole, fetchGuildTreasurySummary } from '../lib/guild-treasury.js';
import { GoMemberEarningsPanel } from './guild-member-earnings.jsx';
import { GoTreasuryAdminSection } from './guild-treasury-admin.jsx';
import { addGuildPassage, deleteGuildChapter, fetchGuildManuscript, proposeGuildChapter, setGuildChapterStatus, subscribeGuildManuscriptRealtime } from '../lib/guild-manuscript.js';
import { addGuildWorldEntry, fetchGuildWorldEntries, subscribeGuildWorldBibleRealtime } from '../lib/guild-world-bible.js';
import { castGuildVote, closeGuildProposal, fetchGuildProposals, openGuildProposal, subscribeGuildCouncilRealtime } from '../lib/guild-order-council.js';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchPublishedBooksByAuthor } from '../lib/library.js';
import { computeAuthorReputation, REPUTATION_QUALITY_MIN_WORDS, reputationTitleFor } from '../library/author-reputation.jsx';
import { currentUser } from '../lib/supabaseClient.js';
import { GuildQuestBoard } from './guild-hall.jsx';
import { LU_AUTHORS } from '../library/inbox-and-living-universe.jsx';
import { ProgressBar, StatCard } from '../shared-ui/ui-cards.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
// Reused, not reinvented: the anthology's cover is the exact same structured object
// (style/accent/motif) a solo book's cover already is (see 35_migration_guild_anthologies.sql's
// header) — so its picker is the same three selects + the same BookCover render everywhere else
// in Inkroot uses, not a second cover system just for anthologies.
import { BookCover, COVER_ACCENTS, COVER_MOTIFS, COVER_STYLES } from '../worldbuilding/book-cover.jsx';
import { GoGuildEventsSection } from './guild-events-section.jsx';
// The redesigned Guild Anthology landing page + workspace (list of anthologies, Start an
// Anthology, and a tabbed Overview/Manuscript/World Bible workspace per anthology) \u2014 built
// entirely on the anthology backend calls imported above, plus GoManuscriptTab/GoWorldBibleTab
// below, reused rather than reinvented. See guild-anthology.jsx's own header for the full picture.
import { GuildAnthologyScreen } from './guild-anthology.jsx';


// ---------- The Guild Order ----------
// A prestigious creative-organization layer on top of the existing Guild Hall: roles, a shared
// manuscript, a shared World Bible, a seasonal anthology, workshops, the same real Guild Quests
// board, a calendar, a treasury, a library, Council voting, and a monthly competition.
//
// HONESTY NOTE (same policy as the Living Universe screen): this note used to say Inkroot had no
// backend at all for the Guild Order, so every OTHER member was a simulated presence. That's no
// longer true for any tab:
//   - Roster is real — every OTHER member shown is a real writer, fetched from
//     founder_guild_members or player_guild_members (whichever backs this guild type), with a
//     real role/rung: a Player Guild's owner/treasurer/officer roles are already RLS-authoritative
//     (see 44_migration_guild_treasury_roles_and_approvals.sql); a Founder Guild member's rung is
//     derived from the same public Reputation signal AuthorsHallScreen already uses for someone
//     else's Hall (their quality-length published book count — see goRealFounderRung below).
//   - Manuscript is real — chapters and passages genuinely written and saved by real guild
//     members via guild_order_chapters/guild_order_passages (migration 65), not this device's own
//     local `storage` — and live (migration 66, Realtime Postgres Changes, same mechanism the
//     Fireside already uses — see subscribeGuildManuscriptRealtime in lib/guild-manuscript.js).
//   - World Bible is real too (migration 81) — same shape as Manuscript: real entries via
//     guild_order_world_entries, live (subscribeGuildWorldBibleRealtime in
//     lib/guild-world-bible.js), one row per entry rather than a chapters/passages split since an
//     entry has no separate multi-contributor document to protect (see the migration's own header).
//   - Treasury and Anthology are real too (migration 69, "Founder Guild parity") — for BOTH guild
//     types now, not just a Player Guild the way this note used to say: GoTreasuryTabReal/the real
//     GuildAnthologyScreen render whenever remoteGuildId is set, which migration 69 made true for a
//     Founder Guild as well (its own fixed backendGuildId — see FOUNDER_GUILDS in guild-hall.jsx).
//   - Council is real too (migration 82) — real proposals and real one-vote-per-member tallies via
//     guild_order_proposals/guild_order_votes, live (subscribeGuildCouncilRealtime in
//     lib/guild-order-council.js), same document/contribution split as Manuscript for the same
//     reason (a vote is a contribution to a proposal, not its own guild-scoped document).
// None of these six are split real-for-Player/simulated-for-Founder anymore — every one of them
// is real for both guild types, with no simulated fallback EXCEPT for a genuinely signed-out or
// offline session (see each tab's own GoXTabSimulated/GuildAnthologyWorkshopSimulated for that
// one remaining honest fallback role — Council has none, since GoCouncilTab has always rendered
// the same real-fetch component regardless of session state, same as Roster) — a
// real-but-possibly-empty state (open the tab as the first real member, see mostly just yourself)
// is the honest choice there rather than papering over emptiness with a rich fake one; see
// fetchGuildManuscript's own comment in lib/guild-manuscript.js and goBuildRoster below for the
// fuller rationale. The Guild Quests tab doesn't duplicate anything; it just renders the real
// GuildQuestBoard defined in guild-hall.jsx.
//
// goBuildRoster below is what still generates the simulated Roster-flavor pulse-line text and
// Anthology's own seed helper further down (goBuildAnthologySeed) — the real tabs no longer read
// from it for their actual content, only for that flavor text. GO_ACTIVE_PROPOSAL/
// GO_HISTORICAL_PROPOSALS further down are likewise no longer read by anything — left in place
// rather than deleted, same as GO_WORLD_SEED was when World Bible went real.
export const GO_ROLES = [
    { key: 'guildmaster', label: 'Guild Master', icon: React.createElement(InkIcon, { name: 'crown', size: 12 }), color: '#E8C468', rung: 6 },
    { key: 'council', label: 'Council', icon: React.createElement(InkIcon, { name: 'columns', size: 12 }), color: '#C89B3C', rung: 5 },
    { key: 'editor', label: 'Editor', icon: React.createElement(InkIcon, { name: 'scroll', size: 12 }), color: '#A184D6', rung: 4 },
    { key: 'mentor', label: 'Mentor', icon: React.createElement(InkIcon, { name: 'candle', size: 12 }), color: '#7FB2C9', rung: 3 },
    { key: 'writer', label: 'Writer', icon: React.createElement(InkIcon, { name: 'book', size: 12 }), color: '#B08D57', rung: 2 },
    { key: 'apprentice', label: 'Apprentice', icon: React.createElement(InkIcon, { name: 'tree', size: 12 }), color: '#8FA37A', rung: 1 },
];


export function goRoleByKey(key) { return GO_ROLES.find((r) => r.key === key) || GO_ROLES[GO_ROLES.length - 1]; }


export const GO_PERMISSIONS = {
    proposeChapter: 1, draftChapter: 2, editChapter: 4, approveChapter: 4, lockManuscript: 5,
    addWorldEntry: 2, curateWorldEntry: 4, submitAnthology: 1, manageAnthology: 4,
    spendTreasury: 5, openVote: 5, castVote: 1,
};


// A member's own role is the one thing here that's real, not simulated: whoever runs their own
// guild is its Guild Master; inside a Founder Guild, rung follows the writer's actual Writer Rank
// tier, so climbing WRITER_RANKS for real climbs the guild hierarchy for real too.
export function goPlayerRung(writerRank, isFounderView) {
    if (!isFounderView)
        return 6;
    const tier = (writerRank && writerRank.tier) || 1;
    if (tier >= 9) return 5;
    if (tier >= 7) return 4;
    if (tier >= 5) return 3;
    if (tier >= 3) return 2;
    return 1;
}


// Real rung for a FOUNDER Guild's other members (goPlayerRung above only ever computes the
// current writer's own rung). publishedCount is that member's own quality-length
// (REPUTATION_QUALITY_MIN_WORDS+) published_books count — the same public signal
// AuthorsHallScreen already uses for someone else's Hall, since follow/completed/guild-
// contribution counts aren't knowable about another writer from here. Deliberately mapped onto
// the Reputation ladder's tier (1-6), not re-derived from scratch, so a member's Roster-tab rung
// always matches what their own Writer Rank badge would say. Rung 6 (Guild Master) is reserved
// for a Player Guild's owner (see goRealPlayerRung below) — nobody reaches it via Reputation
// alone here, same as goPlayerRung above never returns 6 for a Founder Guild.
export function goRealFounderRung(publishedCount) {
    const tier = reputationTitleFor(computeAuthorReputation({ publishedCount })).tier;
    if (tier >= 6) return 5;
    if (tier >= 4) return 4;
    if (tier >= 3) return 3;
    if (tier >= 2) return 2;
    return 1;
}


// Real rung for a PLAYER Guild's other members — needs no Reputation lookup at all, unlike the
// Founder Guild case above: owner_id and player_guild_members.role are both real,
// RLS-authoritative fields already (see 44_migration_guild_treasury_roles_and_approvals.sql), so
// this just maps them onto the same rung scale GO_ROLES uses everywhere else.
export function goRealPlayerRung(isOwner, role) {
    if (isOwner) return 6;
    if (role === 'treasurer') return 5;
    if (role === 'officer') return 4;
    return 2;
}


export function goHash(str) {
    let h = 0;
    for (let i = 0; i < String(str).length; i++) { h = (Math.imul(31, h) + String(str).charCodeAt(i)) | 0; }
    return h >>> 0;
}


export function goMulberry32(seed) {
    let s = seed >>> 0;
    return function () {
        s = (s + 0x6D2B79F5) | 0;
        let t = Math.imul(s ^ (s >>> 15), 1 | s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}


// Deterministic per-guild roster: the same guild always shows the same simulated members (so
// re-opening it doesn't reshuffle everyone's identity), while a different guild gets a different
// cast, seeded from its own name.
export function goBuildRoster(guildKey, guildName, playerName, playerRung) {
    const rng = goMulberry32(goHash(guildKey || guildName || 'guild'));
    const pool = [...LU_AUTHORS].sort(() => rng() - 0.5);
    const slotCounts = { 6: 1, 5: 3, 4: 4, 3: 4, 2: 8, 1: 6 };
    const members = [];
    let idx = 0;
    GO_ROLES.forEach((role) => {
        let n = slotCounts[role.rung] || 0;
        if (role.rung === playerRung) n = Math.max(0, n - 1);
        for (let i = 0; i < n; i++) {
            const name = pool[idx % pool.length]; idx++;
            members.push({ id: `npc-${role.key}-${i}`, name, role: role.key, rung: role.rung, contribution: Math.round(20 + rng() * 480) });
        }
    });
    members.push({ id: 'you', name: playerName || 'You', role: goRoleByKey(GO_ROLES.find((r) => r.rung === playerRung).key).key, rung: playerRung, isPlayer: true, contribution: null });
    return members.sort((a, b) => b.rung - a.rung || (b.contribution || 0) - (a.contribution || 0));
}


// REMOVED — GO_CHAPTER_TITLES / goBuildManuscript(roster), the simulated chapter list the
// Manuscript tab used to build from the fake NPC roster. The tab now fetches real chapters from
// guild_order_chapters (migration 65) via fetchGuildManuscript — see GoManuscriptTab and
// lib/guild-manuscript.js.


export const GO_WORLD_CATEGORIES = ['Houses & Orders', 'Magic & Rites', 'Realms & Regions', 'Bestiary', 'Artifacts & Relics'];


export const GO_WORLD_SEED = [
    { id: 'ws1', category: 'Houses & Orders', title: 'The Ashgrove Concord', blurb: "A pact between three founding families, sealed in the guild's first year.", author: 'Elara Voss' },
    { id: 'ws2', category: 'Magic & Rites', title: 'The Ember Vow', blurb: 'A binding oath sworn over open flame; breaking it is said to cost the breaker their voice.', author: 'Kael Thorne' },
    { id: 'ws3', category: 'Realms & Regions', title: 'The Sundered Coast', blurb: 'A fractured shoreline where the tide runs backward twice a year.', author: 'Wren Ashbury' },
    { id: 'ws4', category: 'Bestiary', title: 'The Long-Toothed Kestrel', blurb: 'A hawk the size of a wolf, native to the Long Winter Courts.', author: 'Marlowe Finch' },
    { id: 'ws5', category: 'Artifacts & Relics', title: "The Cartographer's Compass", blurb: 'Never points north \u2014 only toward what its bearer has lost.', author: 'Isolde Graye' },
    { id: 'ws6', category: 'Houses & Orders', title: 'The Hollow Vale Wardens', blurb: 'A militia turned monastic order after the Long Winter.', author: 'Thane Ashford' },
];


export function goBuildAnthologySeed(roster) {
    const contributors = roster.filter((m) => !m.isPlayer).slice(0, 4);
    const titles = ['The Last Ember', 'Between Two Vows', 'What the Guild Remembers', 'A Quiet Reckoning'];
    return contributors.map((m, i) => ({ id: `as-${i}`, title: titles[i % titles.length], author: m.name, words: 2200 + (m.contribution || 50) * 20, ts: Date.now() - i * 86400000 }));
}


export const GO_COMMISSIONS = [
    { id: 'seal', icon: React.createElement(InkIcon, { name: 'coin', size: 18 }), title: 'Commission an Illuminated Guild Seal', cost: 150, desc: 'A hand-drawn seal for official guild correspondence.' },
    { id: 'apprentice', icon: React.createElement(InkIcon, { name: 'tree', size: 18 }), title: "Fund an Apprentice's First Year", cost: 300, desc: "Sponsor a new writer's first year of guild dues." },
    { id: 'banner', icon: React.createElement(InkIcon, { name: 'shield', size: 18 }), title: 'Restore the Guild Banner', cost: 500, desc: 'Reweave the banner hanging in the Hall.' },
    { id: 'feast', icon: React.createElement(InkIcon, { name: 'gift', size: 18 }), title: 'Host a Grand Feast', cost: 250, desc: 'A celebration for the whole guild.' },
    { id: 'scholars', icon: React.createElement(InkIcon, { name: 'library', size: 18 }), title: "Endow the Scholars' Shelf", cost: 400, desc: "Reserve library shelf space for members' research." },
];


export const GO_HISTORICAL_PROPOSALS = [
    { title: 'Adopt a shared style guide for guild anthologies', outcome: 'Passed', forPct: 78 },
    { title: 'Meet twice monthly instead of weekly', outcome: 'Rejected', forPct: 41 },
    { title: 'Open a Mentor track for new Apprentices', outcome: 'Passed', forPct: 86 },
];


export const GO_ACTIVE_PROPOSAL = { title: 'Commission a guild anthology this season', desc: 'Formally open submissions and appoint an Editor to run the process.' };


// Manuscript and World Bible are no longer separate top-level tabs here — they're consolidated
// inside Guild Anthology (see guild-anthology.jsx's workspace), since a shared manuscript/world
// bible is what an anthology actually needs, not a second, disconnected home for the same
// content. GoManuscriptTab/GoWorldBibleTab themselves are unchanged and still live in this file;
// only their place in the nav moved.
export const GO_TABS = [
    { key: 'roster', label: 'Roster', icon: React.createElement(InkIcon, { name: 'users', size: 13 }) },
    { key: 'anthology', label: 'Guild Anthology', icon: React.createElement(InkIcon, { name: 'library', size: 13 }) },
    { key: 'quests', label: 'Quests', icon: "\u2694\uFE0F" },
    { key: 'treasury', label: 'Treasury', icon: React.createElement(InkIcon, { name: 'moneybag', size: 13 }) },
    { key: 'events', label: 'Guild Events', icon: React.createElement(InkIcon, { name: 'horn', size: 13 }) },
    { key: 'council', label: 'Council', icon: React.createElement(InkIcon, { name: 'columns', size: 13 }) },
];


export function goBtnStyle(primary) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', borderRadius: RADIUS_SCALE[8], cursor: 'pointer',
        border: primary ? '1px solid rgba(232,196,104,0.5)' : '1px solid #2A2A30',
        background: primary ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'transparent',
        color: primary ? '#E8C468' : '#8A8680',
    };
}


export const goInputStyle = {
    width: '100%', boxSizing: 'border-box', background: '#100E0A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8],
    padding: '10px 12px', color: '#EFE7D2', fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit', resize: 'vertical',
};


export function GoTabNav({ active, onSelect }) {
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], overflowX: 'auto', padding: '2px 2px 16px', marginBottom: 6, WebkitOverflowScrolling: 'touch' } },
        GO_TABS.map((t) => React.createElement("button", {
            key: t.key, onClick: () => onSelect(t.key),
            style: {
                flexShrink: 0, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], padding: '8px 13px', borderRadius: RADIUS_SCALE[100],
                border: `1px solid ${active === t.key ? 'rgba(232,196,104,0.5)' : '#2A2A30'}`,
                background: active === t.key ? 'linear-gradient(160deg, #241F14, #1A160D)' : '#1D1D22',
                color: active === t.key ? '#E8C468' : '#8A8680', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
            },
        }, t.icon, ' ', t.label)));
}


export function GoRoleBadge({ role, size }) {
    const r = goRoleByKey(role);
    return React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[5], fontSize: size || 11, fontWeight: 600, color: r.color, border: `1px solid ${r.color}55`, borderRadius: RADIUS_SCALE[100], padding: '3px 9px' } }, r.icon, ' ', r.label);
}


export function GoLocked({ text }) {
    return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center', padding: '10px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6] } },
        React.createElement(InkIcon, { name: "lock", size: 11 }), text);
}


// Real roster for the Roster tab — replaces the simulated goBuildRoster cast entirely for this
// one tab (goBuildRoster/`roster` itself stays in place further down, still driving the still-
// simulated Anthology-seed/pulse-line flavor text, which would misattribute
// fabricated content to real people if it started reading real names instead — see this file's
// own HONESTY NOTE up top). isOwner/remoteGuildId/guildKey/writerRank/playerRung are exactly the
// same props GuildOrderScreen already threads through everywhere else; membersLoading/members are
// this hook's own async state, not derived synchronously the way the simulated roster was.
function useGoRealRoster({ isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung }) {
    const [state, setState] = useState({ loading: true, members: [] });
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, members: [] });
        (async () => {
            const guildId = isFounderView ? guildKey : remoteGuildId;
            if (!guildId) {
                if (!cancelled) setState({ loading: false, members: [] });
                return;
            }
            const user = await currentUser();
            const selfId = user && user.id;
            let rows = [];
            try {
                rows = isFounderView ? await fetchFounderGuildMembers(guildId) : await fetchPlayerGuildMembers(guildId);
            }
            catch (e) {
                if (!cancelled) setState({ loading: false, members: [] });
                return;
            }
            const withRung = await Promise.all(rows.map(async (m) => {
                const isSelf = m.user_id === selfId;
                let rung;
                if (isSelf) {
                    rung = playerRung;
                }
                else if (isFounderView) {
                    let publishedCount = 0;
                    try {
                        const books = await fetchPublishedBooksByAuthor(m.user_id);
                        publishedCount = books.filter((b) => (b.wordCount || 0) >= REPUTATION_QUALITY_MIN_WORDS).length;
                    }
                    catch (e) { /* no signal for this member — treated as Apprentice below */ }
                    rung = goRealFounderRung(publishedCount);
                }
                else {
                    rung = goRealPlayerRung(isOwner && isSelf, m.role);
                }
                const roleKey = (GO_ROLES.find((r) => r.rung === rung) || GO_ROLES[GO_ROLES.length - 1]).key;
                return { id: m.user_id, name: (isSelf ? playerName : m.name) || 'A writer', role: roleKey, rung, isPlayer: isSelf };
            }));
            // A Player Guild's owner might not have their own player_guild_members row (see
            // player_guilds' own schema comment) — add them if fetchPlayerGuildMembers didn't
            // already return them, so the owner isn't missing from their own guild's roster.
            if (!isFounderView && isOwner && !withRung.some((m) => m.isPlayer)) {
                withRung.push({ id: selfId, name: playerName || 'You', role: 'guildmaster', rung: 6, isPlayer: true });
            }
            withRung.sort((a, b) => b.rung - a.rung);
            if (!cancelled) setState({ loading: false, members: withRung });
        })();
        return () => { cancelled = true; };
    }, [isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung]);
    return state;
}


export function GoRosterTab({ roster, guildRank }) {
    const { loading, members } = roster;
    const grouped = GO_ROLES.map((role) => ({ role, members: members.filter((m) => m.role === role.key) })).filter((g) => g.members.length > 0);
    const renderGroup = (g) => {
        const role = g.role;
        const roleMembers = g.members;
        const header = React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 10 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, role.icon),
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: role.color } }, role.label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64' } }, `(${roleMembers.length})`));
        const memberRows = roleMembers.map((m) => {
            const initials = m.name.split(' ').map((n) => n[0]).join('');
            const avatar = React.createElement("div", { style: { width: 30, height: 30, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[12], fontWeight: 600, color: role.color, background: '#17140F', border: `1.5px solid ${role.color}` } }, initials);
            const nameLine = React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', fontWeight: m.isPlayer ? 600 : 400 } }, m.isPlayer ? `${m.name} (you)` : m.name));
            return React.createElement("div", {
                key: m.id, style: {
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '9px 12px', borderRadius: RADIUS_SCALE[9],
                    background: m.isPlayer ? 'linear-gradient(160deg, #241F14, #1A160D)' : '#1D1D22',
                    border: `1px solid ${m.isPlayer ? 'rgba(232,196,104,0.4)' : '#2A2A30'}`,
                },
            }, avatar, nameLine);
        });
        return React.createElement("div", { key: role.key, style: { marginBottom: 22 } },
            header,
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } }, memberRows));
    };
    return React.createElement("div", null,
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: SPACE_SCALE[10], marginBottom: 26 } },
            React.createElement(StatCard, { label: 'Members', value: members.length }),
            React.createElement(StatCard, { label: 'Standing', value: guildRank.name, accent: true })),
        loading && React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '20px 0' } }, "Gathering the roster\u2026"),
        !loading && members.length === 0 && React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '20px 0' } }, "Nobody's shown up here yet \u2014 you're the first."),
        grouped.map(renderGroup),
        React.createElement("div", { style: { marginTop: 10, fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Every member here is real \u2014 fetched from this guild's actual roster, not a preview."));
}


// Real shared manuscript — fetches from guild_order_chapters/guild_order_passages (migration 65)
// itself rather than being handed `chapters` from the simulated goBuildManuscript(roster) the way
// this tab used to be. guildId is whichever real id this guild type actually has (a Founder
// Guild's fixed key or a Player Guild's real uuid); guildType is 'founder'/'player', matching the
// migration's own discriminator column.
export function GoManuscriptTab({ guild, guildType, guildId, playerRung }) {
    const [state, setState] = useState({ loading: true, chapters: [] });
    const [newTitle, setNewTitle] = useState('');
    const [showNewChapter, setShowNewChapter] = useState(false);
    const [openChapter, setOpenChapter] = useState(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const canDraft = playerRung >= GO_PERMISSIONS.draftChapter;

    useEffect(() => { currentUser().then((u) => setMyUserId(u && u.id)).catch(() => {}); }, []);

    const reload = () => {
        if (!guildId) { setState({ loading: false, chapters: [] }); return Promise.resolve(); }
        return fetchGuildManuscript(guildType, guildId).then((chapters) => setState({ loading: false, chapters }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, chapters: [] });
        (guildId ? fetchGuildManuscript(guildType, guildId) : Promise.resolve([]))
            .then((chapters) => { if (!cancelled) setState({ loading: false, chapters }); })
            .catch(() => { if (!cancelled) setState({ loading: false, chapters: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    // Live sync (migration 66): another real member proposing a chapter, adding a passage, or
    // advancing a status shows up here without waiting for this device's own next action —
    // reload() re-fetches the whole manuscript rather than trying to merge the changed row in,
    // same "cheap to recompute, simpler than patching" call subscribeFiresideRealtime's own
    // comment makes for the Fireside.
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildManuscriptRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const runAction = (fn) => {
        setBusy(true); setActionError(null);
        fn().then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusy(false));
    };
    const submitNewChapter = () => {
        if (!newTitle.trim()) return;
        runAction(() => proposeGuildChapter(guildType, guildId, newTitle).then(() => { setNewTitle(''); setShowNewChapter(false); }));
    };
    const submitPassage = (chId) => {
        if (!draft.trim()) return;
        runAction(() => addGuildPassage(chId, draft).then(() => setDraft('')));
        setOpenChapter(null);
    };
    const advance = (chId, current) => {
        const next = current === 'draft' ? 'in review' : 'approved';
        runAction(() => setGuildChapterStatus(chId, next));
    };
    // Only the proposer, and only while it's still a draft (see guild_order_chapters' own delete
    // policy) — once it moves to review/approved, other members may have added passages to it,
    // so there's no client-side way around the server enforcing this the same way.
    const removeChapter = (chId) => {
        if (!window.confirm('Delete this chapter? This cannot be undone.')) return;
        runAction(() => deleteGuildChapter(chId));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the manuscript\u2026");
    }
    return React.createElement("div", null,
        React.createElement("div", { style: { textAlign: 'center', fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[16], color: '#EFE7D2', marginBottom: 4 } }, `${guild.name}: A Chronicle Unwritten`),
        React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 18 } }, "A real, shared manuscript \u2014 every chapter and passage below is written by an actual guild member, live as they add it."),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: '#C97B63', marginBottom: 12 } }, actionError),
        canDraft
            ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
                React.createElement("button", { onClick: () => setShowNewChapter((s) => !s), style: goBtnStyle(true) }, showNewChapter ? 'Cancel' : '+ Propose a chapter'))
            : React.createElement(GoLocked, { text: 'Writers and above may propose new chapters.' }),
        showNewChapter && React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 18, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("input", { value: newTitle, onChange: (e) => setNewTitle(e.target.value), placeholder: 'Chapter title', style: goInputStyle }),
            React.createElement("button", { disabled: busy, onClick: submitNewChapter, style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, "Propose")),
        state.chapters.length === 0 && React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '20px 0' } }, "No chapters yet \u2014 be the first to propose one."),
        state.chapters.map((ch) => {
            const statusColor = ch.status === 'approved' ? '#8FCB8F' : ch.status === 'in review' ? '#C89B3C' : '#7A7A82';
            return React.createElement("div", { key: ch.id, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 12 } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64' } }, `Proposed by ${ch.proposerName}`),
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], color: '#EFE7D2', fontWeight: 600 } }, ch.title)),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: statusColor, border: `1px solid ${statusColor}55`, borderRadius: RADIUS_SCALE[5], padding: '3px 7px', whiteSpace: 'nowrap' } }, ch.status)),
                ch.passages.length > 0 && React.createElement("div", { style: { marginTop: 10, borderTop: '1px solid #2A2A30', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[7] } },
                    ch.passages.map((p) => React.createElement("div", { key: p.id, style: { fontSize: TYPE_SCALE[11.5], color: '#B9B2A0', lineHeight: 1.5 } },
                        React.createElement("span", { style: { color: '#7A7A82', fontStyle: 'italic' } }, `${p.authorName}: `), `\u201C${p.content}\u201D`))),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
                    canDraft && React.createElement("button", { onClick: () => setOpenChapter(openChapter === ch.id ? null : ch.id), style: goBtnStyle(false) }, openChapter === ch.id ? 'Cancel' : 'Add your passage'),
                    canDraft && ch.status !== 'approved' && React.createElement("button", { disabled: busy, onClick: () => advance(ch.id, ch.status), style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, ch.status === 'draft' ? 'Send to review' : 'Approve chapter'),
                    ch.status === 'draft' && ch.proposed_by === myUserId && React.createElement("button", { disabled: busy, onClick: () => removeChapter(ch.id), style: { ...goBtnStyle(false), color: '#B8735C' } }, "Delete")),
                openChapter === ch.id && React.createElement("div", { style: { marginTop: 10 } },
                    React.createElement("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: "Write your contribution\u2026", rows: 3, style: goInputStyle }),
                    React.createElement("button", { disabled: busy, onClick: () => submitPassage(ch.id), style: { ...goBtnStyle(true), marginTop: 8, opacity: busy ? 0.5 : 1 } }, "Save to the manuscript")));
        }),
        React.createElement("div", { style: { marginTop: 10, fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Approving a chapter needs real standing in the guild \u2014 an established Founder Guild member, or a Player Guild's owner/treasurer/officer."));
}


// Real World Bible — fetches from guild_order_world_entries (migration 81) itself rather than
// being handed `state.worldEntries`/`GO_WORLD_SEED` the way this tab used to be. guild/guildType/
// guildId/playerRung/playerName are exactly the same real props GoManuscriptTab above already
// takes, not this hook's own async state — same real-for-both-guild-types shape Manuscript
// already established.
export function GoWorldBibleTab({ guild, guildType, guildId, playerRung, playerName }) {
    const [state, setState] = useState({ loading: true, entries: [] });
    const [form, setForm] = useState({ category: GO_WORLD_CATEGORIES[0], title: '', blurb: '' });
    const [showForm, setShowForm] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState(null);
    const canAdd = playerRung >= GO_PERMISSIONS.addWorldEntry;

    const reload = () => {
        if (!guildId) { setState({ loading: false, entries: [] }); return Promise.resolve(); }
        return fetchGuildWorldEntries(guildType, guildId).then((entries) => setState({ loading: false, entries }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, entries: [] });
        (guildId ? fetchGuildWorldEntries(guildType, guildId) : Promise.resolve([]))
            .then((entries) => { if (!cancelled) setState({ loading: false, entries }); })
            .catch(() => { if (!cancelled) setState({ loading: false, entries: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    // Live sync (migration 81, shipped alongside the table itself) — another real member's new
    // entry shows up here without waiting for this device's own next action, same
    // "cheap to recompute, simpler than patching" reload()-on-change call Manuscript's own
    // subscribeGuildManuscriptRealtime already makes.
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildWorldBibleRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const submit = () => {
        if (!form.title.trim()) return;
        setBusy(true); setActionError(null);
        addGuildWorldEntry(guildType, guildId, form)
            .then(reload)
            .then(() => { setForm({ category: GO_WORLD_CATEGORIES[0], title: '', blurb: '' }); setShowForm(false); })
            .catch((e) => setActionError(e.message || 'That didn\u2019t go through.'))
            .finally(() => setBusy(false));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the World Bible\u2026");
    }
    return React.createElement("div", null,
        canAdd ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
            React.createElement("button", { onClick: () => setShowForm((s) => !s), style: goBtnStyle(true) }, showForm ? 'Cancel' : '+ Add an entry'))
            : React.createElement(GoLocked, { text: 'Writers and above can add entries to the shared World Bible.' }),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: '#C97B63', marginBottom: 12 } }, actionError),
        showForm && React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("select", { value: form.category, onChange: (e) => setForm({ ...form, category: e.target.value }), style: goInputStyle },
                GO_WORLD_CATEGORIES.map((c) => React.createElement("option", { key: c, value: c }, c))),
            React.createElement("input", { value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }), placeholder: 'Entry title', style: goInputStyle }),
            React.createElement("textarea", { value: form.blurb, onChange: (e) => setForm({ ...form, blurb: e.target.value }), placeholder: "A few sentences\u2026", rows: 3, style: goInputStyle }),
            React.createElement("button", { disabled: busy, onClick: submit, style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, "Add to the World Bible")),
        state.entries.length === 0 && React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '20px 0' } }, "No entries yet \u2014 be the first to add one."),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: SPACE_SCALE[12] } },
            state.entries.map((e) => React.createElement("div", { key: e.id, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 15 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], textTransform: 'uppercase', letterSpacing: '0.06em', color: '#A184D6', marginBottom: 6 } }, e.category),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2', marginBottom: 5 } }, e.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8680', lineHeight: 1.55, marginBottom: 8 } }, e.blurb),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64' } }, `Contributed by ${e.authorName}`)))),
        React.createElement("div", { style: { marginTop: 10, fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Every entry here is real \u2014 written by an actual guild member, live as they add it."));
}


// The original fake, word-count-split preview content — kept as the honest fallback for anyone
// signed out or offline (see this file's HONESTY NOTE — a Founder Guild gets the real thing now
// too, same as a Player Guild). Nothing here is real: state.anthologySubmissions is this device's
// own local-only storage, same as every other GoState field, and the split shown is illustrative,
// not a real payout. Exported (banner-less, on purpose) so guild-anthology.jsx's simulated workspace can
// drop it straight into its own Overview tab, inside the same desk-plate/tab chrome the real
// workspace uses — the content itself is unchanged from what always rendered here, only the
// surrounding banner (now owned by the caller) has moved.
export function GoAnthologyOverviewSimulated({ guild, seedSubs, state, patchState, projects, playerName }) {
    const [showPicker, setShowPicker] = useState(false);
    const submissions = [...seedSubs, ...state.anthologySubmissions];
    const totalWords = submissions.reduce((s, x) => s + x.words, 0) || 1;
    const eligible = (projects || []).filter((p) => (p.wordCount || 0) > 0 && !state.anthologySubmissions.some((s) => s.id === `pj-${p.id}`));
    const submit = (p) => {
        patchState({ anthologySubmissions: [...state.anthologySubmissions, { id: `pj-${p.id}`, title: p.title, author: playerName || 'You', words: p.wordCount || 0, ts: Date.now(), isPlayer: true }] });
        setShowPicker(false);
    };
    const byContributor = {};
    submissions.forEach((s) => { byContributor[s.author] = (byContributor[s.author] || 0) + s.words; });
    const splits = Object.entries(byContributor).map(([author, words]) => ({ author, words, pct: Math.round((words / totalWords) * 1000) / 10 })).sort((a, b) => b.words - a.words);
    return React.createElement("div", null,
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 20 } },
            React.createElement("button", { onClick: () => setShowPicker((s) => !s), style: goBtnStyle(true) }, showPicker ? 'Cancel' : 'Submit your work')),
        showPicker && React.createElement("div", { style: { marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            eligible.length === 0 ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center' } }, 'No eligible manuscripts to submit yet.')
                : eligible.map((p) => React.createElement("button", { key: p.id, onClick: () => submit(p), style: { ...goBtnStyle(false), textAlign: 'left' } }, `${p.title} (${(p.wordCount || 0).toLocaleString()} words)`))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, `Contributors (${submissions.length})`),
        submissions.map((s) => React.createElement("div", { key: s.id, className: "gw-slip" },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12.5], color: '#EFE7D2' } },
                React.createElement("span", null, `${s.title} \u2014 ${s.author}${s.isPlayer ? ' (you)' : ''}`),
                React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[11] } }, `${s.words.toLocaleString()} words`)))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', margin: '22px 0 10px' } }, 'Projected Revenue Split'),
        splits.map((s) => React.createElement("div", { key: s.author, style: { marginBottom: 10 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12], color: '#8A8680', marginBottom: 3 } },
                React.createElement("span", null, s.author), React.createElement("span", null, `${s.pct}%`)),
            React.createElement(ProgressBar, { value: s.words, max: totalWords, color: '#C89B3C' }))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 14, textAlign: 'center' } }, "Split by contributed word count, shown for planning \u2014 Inkroot doesn't process real anthology sales yet."));
}


// The same style/accent/motif picker a book cover already uses, wherever a cover object needs
// editing — just the three selects plus a live BookCover preview, sized down for an inline form.
export function GoCoverPicker({ title, cover, onChange }) {
    const styleKey = (cover && COVER_STYLES[cover.style]) ? cover.style : 'leather';
    const accentKey = (cover && COVER_ACCENTS[cover.accent]) ? cover.accent : 'gold';
    const motifKey = cover && Object.prototype.hasOwnProperty.call(COVER_MOTIFS, cover.motif) ? cover.motif : 'compass';
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start' } },
        React.createElement(BookCover, { title: title || 'Untitled', author: '', cover: { style: styleKey, accent: accentKey, motif: motifKey }, size: 'sm' }),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("select", { value: styleKey, onChange: (e) => onChange({ style: e.target.value, accent: accentKey, motif: motifKey }), style: goInputStyle },
                Object.keys(COVER_STYLES).map((k) => React.createElement("option", { key: k, value: k }, k))),
            React.createElement("select", { value: accentKey, onChange: (e) => onChange({ style: styleKey, accent: e.target.value, motif: motifKey }), style: goInputStyle },
                Object.keys(COVER_ACCENTS).map((k) => React.createElement("option", { key: k, value: k }, k))),
            React.createElement("select", { value: motifKey, onChange: (e) => onChange({ style: styleKey, accent: accentKey, motif: e.target.value }), style: goInputStyle },
                Object.keys(COVER_MOTIFS).map((k) => React.createElement("option", { key: k, value: k }, k)))));
}


// Who can do what — the anthology's authority model is simpler than the rest of the Guild Order
// (owner-only for every write except a contributor's own submission/approval, see this file's
// header comment on GO_PERMISSIONS not applying here), so it's spelled out once, plainly, rather
// than left for a writer to infer from which buttons happen to be disabled.
export function GoAnthologyPermissionsNote({ isOwner }) {
    const [expanded, setExpanded] = useState(false);
    return React.createElement("div", {
        style: {
            fontSize: TYPE_SCALE[10.5], color: '#7A7A82', lineHeight: 1.6, background: '#1D1D22',
            border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '10px 12px', marginBottom: 18,
        },
    },
        !expanded
            ? React.createElement("button", {
                onClick: () => setExpanded(true),
                style: { background: 'none', border: 'none', padding: 0, color: '#7A7A82', fontSize: TYPE_SCALE[10.5], cursor: 'pointer', textDecoration: 'underline' },
            }, "Who can do what here?")
            : React.createElement(React.Fragment, null,
                React.createElement("span", { style: { color: '#C89B3C', fontWeight: 600 } }, isOwner ? "As the guild owner, you " : "The guild owner "),
                "creates the anthology, reviews submissions, proposes the revenue split, and publishes or cancels it. ",
                React.createElement("span", { style: { color: '#C89B3C', fontWeight: 600 } }, "Every member "),
                "may submit one manuscript while it's open, edit or withdraw their own pending submission, and approve only their own revenue share \u2014 nobody, including the owner, can change a share once a contributor has approved it without resetting every approval first."));
}


// ---------- Guild Anthologies — "The Workshop" ----------
// The full anthology experience (landing page, workspace, and — as of this update — the
// Founder-Guild/signed-out/offline simulated preview too) no longer lives here — see
// guild-anthology.jsx's GuildAnthologyScreen, which the 'anthology' case in this file's own tab
// switch renders directly and which now routes to either GuildAnthologyWorkshop (real) or
// GuildAnthologyWorkshopSimulated (preview) itself. What stays in THIS file is only what both of
// those still reuse: GoAnthologyOverviewSimulated (the simulated Overview tab's content —
// submissions/split, no banner of its own), GW_ANTHOLOGY_STYLES (the shared "pinned manuscript
// pages on a corkboard" visual language every version renders with), GoCoverPicker, and
// GoAnthologyPermissionsNote. A shared writing desk, not a storefront:
// submissions read as manuscript pages pinned to the workshop wall (a slight alternating tilt +
// a corkboard pin, not a rounded SaaS card), and the anthology itself opens onto a desk plate
// rather than a plain title block. Mobile-first: the pinned-manuscript list is a single column
// by default (a phone doesn't have room for a corkboard grid), gaining a two-column spread only
// once there's room to actually see two pages side by side.
export const GW_ANTHOLOGY_STYLES = `
    .gw-desk-banner{position:relative;border-radius:${RADIUS_SCALE[14]}px;border:1px solid rgba(200,155,60,0.28);background:linear-gradient(160deg,#241E14,#1A160D 70%);padding:20px 18px;margin-bottom:20px;text-align:center;overflow:hidden;}
    .gw-desk-banner::before{content:'';position:absolute;left:0;right:0;bottom:0;height:6px;background:linear-gradient(90deg,transparent,rgba(200,155,60,0.35),transparent);}
    .gw-quill{font-size:22px;display:block;margin-bottom:8px;transform:rotate(-12deg);}
    .gw-eyebrow{font-size:10px;letter-spacing:0.16em;text-transform:uppercase;color:#C89B3C;margin-bottom:6px;}
    .gw-title{font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:18px;color:#EFE7D2;margin-bottom:6px;}
    .gw-sub{font-size:11.5px;color:#8A8680;line-height:1.55;max-width:340px;margin:0 auto;}
    .gw-pin-list{display:grid;grid-template-columns:1fr;gap:14px;}
    @media (min-width: 620px) { .gw-pin-list{grid-template-columns:1fr 1fr;} }
    .gw-page{position:relative;display:flex;gap:12px;align-items:center;width:100%;text-align:left;background:linear-gradient(175deg,#232025,#1C1A1E);border:1px solid #2E2A28;border-left:3px solid rgba(200,155,60,0.4);border-radius:3px 10px 10px 3px;padding:15px 16px 15px 14px;cursor:pointer;box-shadow:0 6px 14px rgba(0,0,0,0.35);}
    .gw-page::before{content:'\\1F4CC';position:absolute;top:-9px;left:18px;font-size:13px;filter:drop-shadow(0 2px 2px rgba(0,0,0,0.5));}
    .gw-desk-plate{border-radius:${RADIUS_SCALE[14]}px;background:linear-gradient(160deg,#211D18,#19160F);border:1px solid rgba(200,155,60,0.24);padding:20px 18px;margin-bottom:18px;text-align:center;}
    .gw-slip{position:relative;padding:12px 14px 12px 16px;border-left:2px dashed rgba(138,134,128,0.35);background:#1D1B1D;border-radius:0 8px 8px 0;margin-bottom:8px;}
`;



// The original fake "Guild Coin" preview — kept as the honest fallback for whoever can't get a
// real treasury: only a signed-out or offline session now (see this file's HONESTY NOTE — a
// Founder Guild gets the real treasury too, same as a Player Guild).
// Nothing here moves real money; state.treasurySpent/treasuryLedger are this device's own
// local-only storage, same as every other GoState field.
function GoTreasuryTabSimulated({ guildReputation, playerRung, state, patchState }) {
    const balance = Math.max(0, Math.round((guildReputation || 0) / 8) - state.treasurySpent);
    const canSpend = playerRung >= GO_PERMISSIONS.spendTreasury;
    const commission = (c) => {
        if (balance < c.cost || !canSpend) return;
        patchState({ treasurySpent: state.treasurySpent + c.cost, treasuryLedger: [{ title: c.title, cost: c.cost, ts: Date.now() }, ...state.treasuryLedger] });
    };
    return React.createElement("div", null,
        React.createElement("style", null, GT_TREASURY_STYLES),
        React.createElement("div", { className: "gt-vault", style: { textAlign: 'center', marginBottom: 22 } },
            React.createElement("div", { className: "gt-strap" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8A7752', marginBottom: 10 } }, "The Guild Coffer"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[34], fontWeight: 600, color: '#E8C468' } }, balance.toLocaleString()),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 } }, 'Guild Coin'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } }, "Preview only \u2014 join or sign in to a real guild for the real treasury.")),
        !canSpend && React.createElement(GoLocked, { text: 'Only the Council and Guild Master may authorize spending from the treasury.' }),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px,1fr))', gap: SPACE_SCALE[12], marginBottom: 26, opacity: canSpend ? 1 : 0.5 } },
            GO_COMMISSIONS.map((c) => React.createElement("div", { key: c.id, style: { background: 'linear-gradient(165deg,#1D1A14,#17140F)', border: '1px solid #332B1D', borderRadius: RADIUS_SCALE[11], padding: 15 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[18], marginBottom: 6 } }, c.icon),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], color: '#EFE7D2', fontWeight: 600, marginBottom: 4 } }, c.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginBottom: 10, lineHeight: 1.5 } }, c.desc),
                React.createElement("button", { disabled: !canSpend || balance < c.cost, onClick: () => commission(c), style: { ...goBtnStyle(true), opacity: (!canSpend || balance < c.cost) ? 0.4 : 1, cursor: (!canSpend || balance < c.cost) ? 'default' : 'pointer' } }, `Commission \u2014 ${c.cost} coin`)))),
        state.treasuryLedger.length > 0 && React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'The ledger'),
            React.createElement("div", { className: "gt-ledger" }, state.treasuryLedger.slice(0, 8).map((l, i) => React.createElement("div", { key: i, className: "gt-ledger-row", style: { color: '#8A8680' } },
                React.createElement("span", null, l.title), React.createElement("span", { style: { color: '#B8735C', fontFamily: "'Fraunces',Georgia,serif", fontWeight: 600 } }, `\u2212${l.cost}`))))));
}


// The real treasury. See supabase/history/33_migration_guild_treasury.sql /
// 44_migration_guild_treasury_roles_and_approvals.sql for where every number and role below
// comes from: guild_treasury_summary() is the single source for every balance shown here, and the
// ledger is a plain RLS-scoped select over guild_treasury_transactions — this component never
// computes, stores, or trusts a balance locally, and it never writes to the ledger directly.
// Contributing, authorizing/proposing a spend, approving a pending one, and assigning treasury
// roles are handled below by GoTreasuryAdminSection, each gated to the same role the backend
// itself requires (see that file's own header) — Guild Events and Anthology revenue splitting
// remain out of scope here, with their own dedicated screens.
// ---------- Guild Treasury — "The Guild Coffer" ----------
// An iron-bound strongbox and its ledger book, not a dashboard: the total sits behind a
// riveted plate, each balance reads as a drawer in the coffer, and every transaction is a line
// in a ruled ledger (credit in ink-green, debit in ink-oxblood) rather than a plain list row.
// Mobile-first: the drawer grid already collapses to one column below ~400px via its own
// auto-fit minmax, so no extra media query is needed there; the ledger itself never needs to
// reflow since it's always a single stacked column, the one layout that reads correctly whether
// it's an iPhone SE or a desktop window.
const GT_TREASURY_STYLES = `
    .gt-vault{position:relative;border-radius:${RADIUS_SCALE[16]}px;padding:26px 20px 22px;margin-bottom:6px;background:linear-gradient(165deg,#221C12 0%,#171310 100%);border:1px solid #3A2F1C;box-shadow:inset 0 0 0 1px rgba(232,196,104,0.08),0 10px 26px rgba(0,0,0,0.35);}
    .gt-vault::before,.gt-vault::after{content:'';position:absolute;top:10px;width:6px;height:6px;border-radius:50%;background:radial-gradient(circle at 35% 30%,#B8935A,#5A4526);box-shadow:0 0 0 2px rgba(0,0,0,0.3);}
    .gt-vault::before{left:12px;}
    .gt-vault::after{right:12px;}
    .gt-strap{position:absolute;left:0;right:0;top:0;height:4px;background:linear-gradient(90deg,transparent,rgba(184,147,90,0.55) 20%,rgba(184,147,90,0.55) 80%,transparent);}
    .gt-seal{display:inline-flex;align-items:center;justify-content:center;gap:5px;font-size:9.5px;letter-spacing:0.05em;padding:4px 11px;border-radius:100px;background:radial-gradient(circle at 30% 30%,#8F4A3A,#5E2E22);color:#F2DCC8;box-shadow:inset 0 0 0 1px rgba(0,0,0,0.3);}
    .gt-ledger{background:#18140F;border:1px solid #2E2820;border-radius:${RADIUS_SCALE[12]}px;padding:4px 14px;}
    .gt-ledger-row{display:flex;justify-content:space-between;align-items:baseline;gap:10px;font-size:12px;padding:11px 0;border-bottom:1px solid #2A241C;}
    .gt-ledger-row:last-child{border-bottom:none;}
`;

function GoTreasuryTabReal({ remoteGuildId, isFounderView }) {
    // undefined = still loading; null = nothing to render (permission-denied or errored); an
    // object = loaded. Kept distinct from `[]`/`null` ledger states below so a real empty ledger
    // ("no transactions yet") never gets confused with "still fetching" or "couldn't fetch".
    const [summary, setSummary] = useState(undefined);
    const [ledger, setLedger] = useState(undefined);
    const [role, setRole] = useState(null);
    const [deniedText, setDeniedText] = useState(null);
    const [errorText, setErrorText] = useState(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        let cancelled = false;
        setSummary(undefined);
        setLedger(undefined);
        setDeniedText(null);
        setErrorText(null);

        fetchGuildTreasurySummary(remoteGuildId).then((s) => {
            if (cancelled) return;
            // fetchGuildTreasurySummary itself returns null for signed-out/offline (see
            // guild-treasury.js) — the permission state, not a fetch failure.
            if (!s) { setDeniedText('Sign in and join this guild to open its treasury.'); return; }
            setSummary(s);
        }).catch((e) => {
            if (cancelled) return;
            const message = (e && e.message) || '';
            // guild_treasury_summary() raises exactly this for a signed-in writer who isn't a
            // member of this guild — a permission state, not a technical failure, so it gets its
            // own message instead of the generic error/retry state below.
            if (/not a member/i.test(message)) setDeniedText('Only members of this guild can open its treasury.');
            else setErrorText(message || 'Could not open the treasury.');
        });

        fetchGuildTreasuryLedger(remoteGuildId, 12).then((rows) => { if (!cancelled) setLedger(rows); }).catch(() => { if (!cancelled) setLedger([]); });
        fetchGuildTreasuryRole(remoteGuildId).then((r) => { if (!cancelled) setRole(r); }).catch(() => { });

        return () => { cancelled = true; };
    }, [remoteGuildId, attempt]);

    // ---- Permission state ----
    if (deniedText) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement(InkIcon, { name: 'lock', size: 22, color: '#5C5C64', style: { margin: '0 auto 12px' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8A8680', maxWidth: 260, margin: '0 auto', lineHeight: 1.55 } }, deniedText));
    }

    // ---- Error state ----
    if (errorText) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#C97B63', marginBottom: 14, lineHeight: 1.55, maxWidth: 280, margin: '0 auto 14px' } }, errorText),
            React.createElement("button", { onClick: () => setAttempt((n) => n + 1), style: goBtnStyle(false) }, 'Try again'));
    }

    // ---- Loading state ----
    if (summary === undefined) {
        return React.createElement("div", null,
            React.createElement("style", null, `
                @keyframes goTreasuryPulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 0.85; } }
                .go-treasury-skel { animation: goTreasuryPulse 1.3s ease-in-out infinite; }
            `),
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 24 } },
                React.createElement("div", { className: 'go-treasury-skel', style: { width: 150, height: 32, background: '#2A2A30', borderRadius: RADIUS_SCALE[6], margin: '0 auto 8px' } }),
                React.createElement("div", { className: 'go-treasury-skel', style: { width: 120, height: 9, background: '#2A2A30', borderRadius: RADIUS_SCALE[4], margin: '0 auto' } })),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: SPACE_SCALE[12], marginBottom: 24 } },
                [0, 1, 2, 3].map((i) => React.createElement("div", { key: i, className: 'go-treasury-skel', style: { height: 64, background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11] } }))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', fontStyle: 'italic' } }, "Opening the treasury\u2026"));
    }

    // ---- Loaded ----
    // formatNaira() prints "Free" for a zero amount (fine for a book price, wrong for a treasury
    // balance sitting at \u20a60), so the treasury uses its own formatter that always prints a real amount.
    const nairaText = (n) => `\u20a6${Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`;
    // "Total guild funds": every Naira this guild's treasury currently holds across both buckets —
    // its own collective purse (guildOwnedNaira, lifetime settled credits) plus what it's holding
    // in trust on members' behalf (memberEarningsNaira). Not the same as "Available", which is
    // guild-owned funds minus what's already spent/reserved.
    const totalNaira = (summary.guildOwnedNaira || 0) + (summary.memberEarningsNaira || 0);

    const stat = (label, naira) => React.createElement("div", { key: label, style: { textAlign: 'center', background: 'linear-gradient(165deg,#1D1A14,#17140F)', border: '1px solid #332B1D', borderRadius: RADIUS_SCALE[11], padding: '14px 8px' } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, nairaText(naira)),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 } }, label));

    const roleLabel = { leader: 'Guild Leader', treasurer: 'Treasurer', officer: 'Officer', member: 'Member' }[role] || null;

    // Friendly label for a ledger row's `kind` — anthology_share/event_revenue rows can already
    // exist server-side (see 37/48_migration_*.sql) even though their own dedicated screens
    // aren't built here; this just names them plainly rather than showing a raw enum value.
    const kindLabel = (t) => {
        if (t.title) return t.title;
        switch (t.kind) {
            case 'contribution': return 'Member contribution';
            case 'spend': return 'Guild spend';
            case 'anthology_share': return 'Anthology revenue share';
            case 'event_revenue': return 'Guild event revenue';
            case 'release_to_member': return 'Earnings released';
            default: return t.kind;
        }
    };

    return React.createElement("div", null,
        React.createElement("style", null, GT_TREASURY_STYLES),
        React.createElement("div", { className: "gt-vault", style: { textAlign: 'center', marginBottom: 24 } },
            React.createElement("div", { className: "gt-strap" }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#8A7752', marginBottom: 10 } }, "The Guild Coffer"),
            React.createElement(InkIcon, { name: 'moneybag', size: 22, color: '#E8C468', style: { margin: '0 auto 10px' } }),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontWeight: 600, color: '#E8C468', wordBreak: 'break-word' } }, nairaText(totalNaira)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 4 } }, 'Total guild funds'),
            roleLabel && React.createElement("div", { className: "gt-seal", style: { marginTop: 12 } }, "\u2694\uFE0F", roleLabel)),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', textAlign: 'center', margin: '14px 0 20px', fontStyle: 'italic' } }, "Real Naira \u2014 every number here is computed server-side from the guild's own ledger, never stored or trusted from this device."),

        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px,1fr))', gap: SPACE_SCALE[12], marginBottom: 28 } },
            stat('Available', summary.availableNaira),
            stat('Pending', summary.pendingNaira),
            stat('Member earnings', summary.memberEarningsNaira),
            stat('Guild-owned', summary.guildOwnedNaira)),

        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'The ledger \u2014 recent entries'),
            (!ledger || ledger.length === 0)
                ? React.createElement("div", { style: { textAlign: 'center', padding: '26px 10px' } },
                    React.createElement(InkIcon, { name: 'coin', size: 18, color: '#5C5C64', style: { margin: '0 auto 8px', opacity: 0.7 } }),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic' } }, "The ledger is empty \u2014 no contributions or spends have been recorded yet."))
                : React.createElement("div", { className: "gt-ledger" }, ledger.map((t) => React.createElement("div", { key: t.id, className: "gt-ledger-row", style: { color: '#8A8680' } },
                    React.createElement("span", null, kindLabel(t) + (t.bucket === 'member' ? ' (your earnings)' : '') + (t.status === 'pending' ? ' \u2014 pending' : '')),
                    React.createElement("span", { style: { color: t.direction === 'credit' ? '#7FB2A0' : '#B8735C', flexShrink: 0, fontWeight: 600, fontFamily: "'Fraunces', Georgia, serif" } }, `${t.direction === 'credit' ? '+' : '\u2212'}${nairaText(t.amountNaira)}`))))),

        // Treasury actions — Contribute (any member), Authorize/Propose a spend and approve
        // pending ones (Leader/Treasurer/Officer only), and role management (Leader only). Every
        // control here operates on the guild-owned bucket above, never on any member's own held
        // earnings — see GoTreasuryAdminSection's own header comment.
        // A Founder Guild has no treasury to contribute to or spend from (see
        // 122_migration_founder_guild_no_treasury_or_hosting.sql) \u2014 contribute_to_guild_treasury/
        // spend_from_guild_treasury/propose_guild_treasury_spend all refuse server-side for one, so
        // this swaps the admin controls for a short note instead of a dead-end button.
        isFounderView
            ? React.createElement("div", { style: { marginTop: 26, paddingTop: 22, borderTop: '1px solid #2A2A30', fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } },
                "A Founder Guild has no treasury of its own \u2014 Inkroot funds any official cash-prize event for it directly, and members' own earnings still show below.")
            : React.createElement(GoTreasuryAdminSection, {
                guildId: remoteGuildId, role, availableNaira: summary.availableNaira,
                refreshSummary: () => setAttempt((n) => n + 1), isFounderView,
            }),

        // My Earnings — this signed-in member's own held-in-trust earnings in this one guild
        // (available/pending/lifetime, earnings by project, and real withdrawal history), plus
        // the Withdraw action against them. Entirely separate data from the guild-wide summary
        // above: GoMemberEarningsPanel only ever reads/moves this member's own 'member'-bucket
        // rows (see its own header comment for why that's enforced server-side, not just by
        // props), so there's no overlap with the guild-owned funds shown higher on this screen.
        React.createElement(GoMemberEarningsPanel, { guildId: remoteGuildId }));
}


// remoteGuildId is a real player_guilds.id for both guild types now — a Player Guild's own real
// row, or a Founder Guild's fixed backendGuildId (see FOUNDER_GUILDS in guild-hall.jsx and
// supabase/history/69_migration_founder_guild_parity.sql), set by home-screen.jsx's
// guildOrderBackendId. null only for a signed-out or offline session, which is exactly when the
// simulated preview below should show instead. isOwner only affects which controls GoTreasuryTabReal renders; every
// financial action is still re-authorized server-side regardless of what this prop says.
export function GoTreasuryTab({ guildReputation, playerRung, state, patchState, remoteGuildId, isFounderView }) {
    if (remoteGuildId) {
        return React.createElement(GoTreasuryTabReal, { remoteGuildId, isFounderView });
    }
    return React.createElement(GoTreasuryTabSimulated, { guildReputation, playerRung, state, patchState });
}


export function GoCouncilTab({ guildType, guildId, playerRung, playerName }) {
    const [state, setState] = useState({ loading: true, proposals: [] });
    const [draft, setDraft] = useState({ title: '', body: '' });
    const [showForm, setShowForm] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const [actionError, setActionError] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const canPropose = playerRung >= GO_PERMISSIONS.openVote;

    useEffect(() => { currentUser().then((u) => setMyUserId(u && u.id)).catch(() => {}); }, []);

    const reload = () => {
        if (!guildId) { setState({ loading: false, proposals: [] }); return Promise.resolve(); }
        return fetchGuildProposals(guildType, guildId).then((proposals) => setState({ loading: false, proposals }));
    };
    useEffect(() => {
        let cancelled = false;
        setState({ loading: true, proposals: [] });
        (guildId ? fetchGuildProposals(guildType, guildId) : Promise.resolve([]))
            .then((proposals) => { if (!cancelled) setState({ loading: false, proposals }); })
            .catch(() => { if (!cancelled) setState({ loading: false, proposals: [] }); });
        return () => { cancelled = true; };
    }, [guildType, guildId]);
    useEffect(() => {
        if (!guildId) return undefined;
        return subscribeGuildCouncilRealtime(guildType, guildId, reload);
    }, [guildType, guildId]);

    const raiseProposal = () => {
        if (!draft.title.trim()) return;
        setBusyId('new'); setActionError(null);
        openGuildProposal(guildType, guildId, draft)
            .then(reload)
            .then(() => { setDraft({ title: '', body: '' }); setShowForm(false); })
            .catch((e) => setActionError(e.message || 'That didn\u2019t go through.'))
            .finally(() => setBusyId(null));
    };
    const vote = (proposalId, choice) => {
        setBusyId(proposalId); setActionError(null);
        castGuildVote(proposalId, choice).then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };
    const close = (proposalId) => {
        setBusyId(proposalId); setActionError(null);
        closeGuildProposal(proposalId).then(reload).catch((e) => setActionError(e.message || 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '30px 0' } }, "Opening the Council chamber\u2026");
    }
    const open = state.proposals.filter((p) => p.status === 'open');
    const closed = state.proposals.filter((p) => p.status === 'closed');

    const renderProposal = (p) => {
        const total = p.total || 0;
        const pct = (n) => (total > 0 ? Math.round((n / total) * 100) : 0);
        return React.createElement("div", { key: p.id, style: { background: '#1D1D22', border: p.status === 'open' ? '1px solid rgba(232,196,104,0.3)' : '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 18, marginBottom: 14 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], textTransform: 'uppercase', letterSpacing: '0.1em', color: p.status === 'open' ? '#E8C468' : '#5C5C64', marginBottom: 8 } }, p.status === 'open' ? 'Active Proposal' : 'Closed'),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], color: '#EFE7D2', fontWeight: 600, marginBottom: 6 } }, p.title),
            p.body && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8680', marginBottom: 14, lineHeight: 1.55 } }, p.body),
            ['yes', 'no', 'abstain'].map((choice) => React.createElement("div", { key: choice, style: { marginBottom: 8 } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[11.5], color: '#8A8680', marginBottom: 3 } },
                    React.createElement("span", null, choice === 'yes' ? 'For' : choice === 'no' ? 'Against' : 'Abstain'), React.createElement("span", null, `${pct(p.tally[choice])}%`)),
                React.createElement(ProgressBar, { value: p.tally[choice], max: Math.max(total, 1), color: choice === 'yes' ? '#8FCB8F' : choice === 'no' ? '#B8735C' : '#5C5C64' }))),
            p.status === 'open' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 14 } },
                ['yes', 'no', 'abstain'].map((choice) => React.createElement("button", { key: choice, disabled: busyId === p.id, onClick: () => vote(p.id, choice), style: { ...goBtnStyle(p.myVote === choice), flex: 1, opacity: busyId === p.id ? 0.5 : 1 } }, choice === 'yes' ? 'Vote For' : choice === 'no' ? 'Vote Against' : 'Abstain'))),
            p.myVote && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10 } }, `Your vote is recorded as "${p.myVote}."`),
            React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 6 } }, `Opened by ${p.openedByName}${total > 0 ? ` \u00b7 ${total} vote${total === 1 ? '' : 's'}` : ''}`),
            p.status === 'open' && p.opened_by === myUserId && React.createElement("div", { style: { textAlign: 'center', marginTop: 10 } },
                React.createElement("button", { disabled: busyId === p.id, onClick: () => close(p.id), style: { background: 'none', border: 'none', color: '#7A4A3A', fontSize: TYPE_SCALE[11], cursor: 'pointer', textDecoration: 'underline' } }, "Close this proposal")));
    };

    return React.createElement("div", null,
        canPropose ? React.createElement("div", { style: { textAlign: 'center', marginBottom: 18 } },
            React.createElement("button", { onClick: () => setShowForm((s) => !s), style: goBtnStyle(true) }, showForm ? 'Cancel' : '+ Raise a proposal'))
            : React.createElement(GoLocked, { text: 'Only the Council and Guild Master may raise new proposals.' }),
        actionError && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: '#C97B63', marginBottom: 12 } }, actionError),
        showForm && React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement("input", { value: draft.title, onChange: (e) => setDraft({ ...draft, title: e.target.value }), placeholder: 'Proposal title', style: goInputStyle }),
            React.createElement("textarea", { value: draft.body, onChange: (e) => setDraft({ ...draft, body: e.target.value }), placeholder: "What is the Council deciding\u2026?", rows: 2, style: goInputStyle }),
            React.createElement("button", { disabled: busyId === 'new', onClick: raiseProposal, style: { ...goBtnStyle(true), opacity: busyId === 'new' ? 0.5 : 1 } }, "Bring before the Council")),
        open.length === 0 && closed.length === 0 && React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12], padding: '20px 0' } }, "No proposals yet \u2014 be the first to raise one."),
        open.map(renderProposal),
        closed.length > 0 && React.createElement("div", { style: { marginTop: open.length > 0 ? 10 : 0 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Past Proposals'),
            closed.map(renderProposal)),
        React.createElement("div", { style: { marginTop: 10, fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Every proposal and vote here is real \u2014 cast by an actual guild member, live as they cast it."));
}


export const GO_STATE_KEY_PREFIX = 'inkroot:guildOrder:v1:';


export function goDefaultState() {
    return {
        worldEntries: [], anthologySubmissions: [],
        treasurySpent: 0, treasuryLedger: [],
        councilVote: null, proposals: [],
    };
}


export function useGoState(guildKey) {
    const [state, setState] = useState(null);
    const key = GO_STATE_KEY_PREFIX + (guildKey || 'guild');
    useEffect(() => {
        let cancelled = false;
        (async () => {
            let loaded = null;
            try { const res = await storage.get(key); if (res && res.value) loaded = JSON.parse(res.value); } catch (e) { /* nothing stored yet */ }
            if (!cancelled) setState({ ...goDefaultState(), ...(loaded || {}) });
        })();
        return () => { cancelled = true; };
    }, [key]);
    const patchState = (patch) => {
        setState((prev) => {
            const next = { ...prev, ...patch };
            storage.set(key, JSON.stringify(next)).catch(() => { });
            return next;
        });
    };
    return [state, patchState];
}


export function GuildOrderScreen({
    guild, guildKey, isFounderView, guildRank, guildReputation, writerProfile, writerRank, projects, lifetimeStats, remoteGuildId, isOwner, onViewPublishedBook, initialTab,
    initialAnthologyId, initialAnthologyAction, initialAnthologySeedProjectId,
}) {
    // initialTab lets a caller (e.g. the Guild Order overview directory on the Guild Hall home
    // screen — see guild-order-overview.jsx) land straight on a specific tab instead of always
    // opening to Roster. Purely a starting point for this component's own tab state below, same
    // pattern as GrandLibraryScreen's initialBookId; nothing else about the Guild Order changes.
    const [tab, setTab] = useState((initialTab && GO_TABS.some((t) => t.key === initialTab)) ? initialTab : 'roster');
    const [state, patchState] = useGoState(guildKey);
    const playerName = (writerProfile && (writerProfile.penName || writerProfile.name)) || 'You';
    const playerRung = goPlayerRung(writerRank, isFounderView);
    const roster = useMemo(() => goBuildRoster(guildKey, guild.name, playerName, playerRung), [guildKey, guild.name, playerName, playerRung]);
    // The Guild Order's real id for THIS guild — a Founder Guild's fixed key or a Player Guild's
    // real uuid — is whichever of guildKey/remoteGuildId actually applies; used by both the real
    // roster hook and the real manuscript tab below, not by anthologySeed/pulseLines, which stay
    // reading from the simulated `roster` above (see this file's own HONESTY NOTE).
    const realGuildId = isFounderView ? guildKey : remoteGuildId;
    const realRoster = useGoRealRoster({ isFounderView, guildKey, remoteGuildId, isOwner, playerName, playerRung });
    const anthologySeed = useMemo(() => goBuildAnthologySeed(roster), [roster]);
    const playerRoleKey = (GO_ROLES.find((r) => r.rung === playerRung) || GO_ROLES[GO_ROLES.length - 1]).key;
    const pulseLines = useMemo(() => {
        const mentor = roster.find((m) => m.role === 'mentor');
        const editor = roster.find((m) => m.role === 'editor');
        const writer = roster.find((m) => m.role === 'writer');
        return [
            `${(mentor && mentor.name) || 'A Mentor'} raised a proposal to the Council.`,
            `${(editor && editor.name) || 'An Editor'} approved a chapter in the shared manuscript.`,
            `${(writer && writer.name) || 'A Writer'} added an entry to the World Bible.`,
        ];
    }, [roster]);
    const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
    const pulseLine = pulseLines[dayOfYear % pulseLines.length];

    if (!state) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Opening the Guild Order\u2026");
    }
    return React.createElement("div", { className: "ink-page-in" },
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 22 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], letterSpacing: '0.18em', textTransform: 'uppercase', color: '#5C5C64', marginBottom: 10 } }, "The Guild Order \u00B7 Preview"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[24], fontWeight: 600, color: '#EFE7D2', marginBottom: 10 } }, guild.name),
            React.createElement(GoRoleBadge, { role: playerRoleKey, size: 12 }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 12, fontStyle: 'italic' } }, pulseLine)),
        React.createElement(GoTabNav, { active: tab, onSelect: setTab }),
        (() => {
            switch (tab) {
                case 'roster': return React.createElement(GoRosterTab, { roster: realRoster, guildRank });
                case 'anthology': return React.createElement(GuildAnthologyScreen, {
                    guild, guildType: isFounderView ? 'founder' : 'player', guildId: realGuildId, playerRung, seedSubs: anthologySeed, state, patchState, projects, playerName, remoteGuildId, isOwner, onViewPublishedBook,
                    // Passed straight through from whatever the Guild Homepage's Anthology preview
                    // asked for (see home-screen.jsx's pendingAnthology* state) \u2014 all optional,
                    // undefined for every other way into this tab, same as initialTab above.
                    initialSelectedId: initialAnthologyId, initialAction: initialAnthologyAction, initialSeedProjectId: initialAnthologySeedProjectId,
                });
                case 'quests': return React.createElement(GuildQuestBoard, { lifetimeStats });
                case 'treasury': return React.createElement(GoTreasuryTab, { guildReputation, playerRung, state, patchState, remoteGuildId, isOwner, isFounderView });
                case 'events': return React.createElement(GoGuildEventsSection, { remoteGuildId, isOwner, isFounderView, guildKey });
                case 'council': return React.createElement(GoCouncilTab, { guildType: isFounderView ? 'founder' : 'player', guildId: realGuildId, playerRung, playerName });
                default: return null;
            }
        })());
}
