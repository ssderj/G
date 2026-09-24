import React, { useState, useEffect } from 'react';
import { fetchFiresidePosts, subscribeFiresideRealtime } from '../lib/library-guild.js';
import { fetchPlayerGuild, fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchPlatformAdminIds } from '../lib/moderation.js';
import { GO_ROLES, goRealPlayerRung } from './guild-order.jsx';
import { EmptyState, ArchiveSectionHeading } from '../shared-ui/ui-cards.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- The Guild Notice Board (real) ----------
// REPLACES the old NoticeBoard in guild-hall.jsx, which was six seeded/evergreen cards (a
// welcome, a founding-date card, and four permanently-generic filler notices) — nothing a real
// officer ever wrote. This version shows nothing but real fireside_posts rows: real title-less
// messages, real authors, real timestamps, real pins — tagged category = 'announcement' by
// whoever posted them via the Fireside's own composer (see FIRESIDE_CATEGORIES in
// guild-hall.jsx) further down this same Guild Hall screen. No new backend, no new table: this
// is the same fireside_posts/fireside_reactions system FiresideBoard already reads and writes,
// just filtered, permission-checked, and laid out differently for the compact board up top.
//
// "Authorized Guild admins/officers" is enforced here using the guild's real, existing
// permission signals rather than a new one invented for this feature:
//   - Player Guild: player_guilds.owner_id (real Leader) and player_guild_members.role
//     ('treasurer'/'officer'/'member', real, RLS-authoritative — see 44_migration_guild_
//     treasury_roles_and_approvals.sql), mapped onto the same rung scale the Guild Order's
//     Roster tab already uses (goRealPlayerRung — see guild-order.jsx).
//   - Founder Guild: a real Inkroot platform admin (profiles.is_platform_admin) — the only real
//     officer authority a Founder Guild has server-side (is_guild_officer() in
//     69_migration_founder_guild_parity.sql delegates a Founder Guild's officer authority to
//     "any Inkroot admin", not to any per-member role). A Founder Guild member's cosmetic
//     Reputation-based rung (goRealFounderRung) is deliberately NOT used to authorize a post
//     here — that ladder reflects how much someone has published, not any real posting
//     authority, and using it would let a prolific but unofficial member's post masquerade as
//     an official one.
// Nothing here stops any member from tagging their own Fireside post 'announcement' — the RLS
// on fireside_posts doesn't restrict the category column by role (see library-guild.js). This
// board is what actually enforces "official" by only ever displaying the ones whose author
// really does hold officer-or-above authority (rung >= OFFICER_RUNG_THRESHOLD) by the time it
// renders; an unauthorized member's 'announcement'-tagged post still shows up in the Fireside
// itself (correctly, as their own message) but never here.
//
// There's also no separate "title" column on fireside_posts — a real announcement is just a
// body of text, same as any other post. Rather than inventing one (truncating the body into a
// fake headline), a heading is only ever shown when the author naturally wrote one themselves —
// a first line followed by a blank line, the same convention people already use for an email or
// a forum post. Everything else just renders as one plain message. See splitNoticeText below.
const OFFICER_RUNG_THRESHOLD = 4; // Editor/Council/Guild Master — same officer-or-above cut GO_PERMISSIONS already uses for manageAnthology/curateWorldEntry/etc.
const HOMEPAGE_NOTICE_LIMIT = 3;


function splitNoticeText(body) {
    const text = (body || '').trim();
    const blankLineIdx = text.search(/\n\s*\n/);
    if (blankLineIdx === -1)
        return { heading: null, message: text };
    const firstLine = text.slice(0, blankLineIdx).trim();
    const rest = text.slice(blankLineIdx).trim();
    // Only treat it as a real heading if it reads like one — short, and not the whole message.
    if (!firstLine || firstLine.length > 90 || !rest)
        return { heading: null, message: text };
    return { heading: firstLine, message: rest };
}


function formatNoticeDate(iso) {
    try {
        return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
    catch (e) {
        return '';
    }
}


function NoticeCard({ notice, rotation }) {
    const roleInfo = GO_ROLES.find((r) => r.rung === notice.rung) || GO_ROLES[GO_ROLES.length - 1];
    const { heading, message } = splitNoticeText(notice.body);
    return React.createElement("div", { className: "notice-card", style: { transform: `rotate(${rotation}deg)` } },
        React.createElement("div", { className: "notice-pin" }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[6], marginBottom: 8 } },
            React.createElement("span", { style: {
                    display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[9.5], fontWeight: 700,
                    letterSpacing: '0.04em', textTransform: 'uppercase', color: roleInfo.color,
                    border: `1px solid ${roleInfo.color}66`, borderRadius: RADIUS_SCALE[100], padding: '2px 8px',
                } }, roleInfo.icon, ' ', roleInfo.label),
            notice.pinned && React.createElement(InkIcon, { name: "pin", size: 14, color: "#8A2E1F" })),
        heading && React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 700, color: '#2A1D10', marginBottom: 5, lineHeight: 1.25 } }, heading),
        React.createElement("div", {
            style: {
                fontSize: TYPE_SCALE[11.5], color: '#4A3826', lineHeight: 1.45, marginBottom: 10,
                display: '-webkit-box', WebkitLineClamp: heading ? 4 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden',
            },
        }, message),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#6B5A3E', display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[6] } },
            React.createElement("span", null, notice.author_name || 'A guild officer'),
            React.createElement("span", null, formatNoticeDate(notice.created_at))));
}


export function NoticeBoard({ guildId, isFounderView }) {
    const [status, setStatus] = useState('loading'); // 'loading' | 'ready'
    const [notices, setNotices] = useState([]);

    useEffect(() => {
        let cancelled = false;
        if (!guildId) {
            setStatus('ready');
            setNotices([]);
            return;
        }
        setStatus('loading');
        const load = () => {
            fetchFiresidePosts(guildId).then(async ({ posts }) => {
                const announcementPosts = (posts || []).filter((p) => p.category === 'announcement' && !p.parent_id);
                if (announcementPosts.length === 0) {
                    if (!cancelled) { setNotices([]); setStatus('ready'); }
                    return;
                }
                const authorIds = [...new Set(announcementPosts.map((p) => p.author_id))];
                const rungByAuthor = {};
                if (isFounderView) {
                    const adminIds = await fetchPlatformAdminIds(authorIds).catch(() => new Set());
                    authorIds.forEach((id) => { rungByAuthor[id] = adminIds.has(id) ? 6 : 1; });
                }
                else {
                    const [members, guildRow] = await Promise.all([
                        fetchPlayerGuildMembers(guildId).catch(() => []),
                        fetchPlayerGuild(guildId).catch(() => null),
                    ]);
                    const roleByUserId = {};
                    (members || []).forEach((m) => { roleByUserId[m.user_id] = m.role; });
                    const ownerId = guildRow && guildRow.owner_id;
                    authorIds.forEach((id) => { rungByAuthor[id] = goRealPlayerRung(!!ownerId && id === ownerId, roleByUserId[id]); });
                }
                if (cancelled) return;
                const authorized = announcementPosts
                    .filter((p) => (rungByAuthor[p.author_id] || 0) >= OFFICER_RUNG_THRESHOLD)
                    .map((p) => ({ ...p, rung: rungByAuthor[p.author_id] }))
                    .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || new Date(b.created_at) - new Date(a.created_at));
                setNotices(authorized);
                setStatus('ready');
            }).catch((e) => {
                console.warn('Inkroot: guild notice board fetch failed', e);
                if (!cancelled) { setNotices([]); setStatus('ready'); }
            });
        };
        load();
        const unsubscribe = subscribeFiresideRealtime(guildId, load);
        return () => { cancelled = true; if (unsubscribe) unsubscribe(); };
    }, [guildId, isFounderView]);

    const rotations = [-2.5, 1.5, -1, 2, -2, 1];
    const shown = notices.slice(0, HOMEPAGE_NOTICE_LIMIT);
    const remaining = notices.length - shown.length;

    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "scroll", size: 20, style: { display: "inline-block" } }), label: "Guild Notice Board" }),
        !guildId
            ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 12 } },
                "The board is bare until this guild syncs online \u2014 sign in to see official announcements from its admins and officers here.")
            : status === 'loading'
                ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 12 } }, "Reading the board\u2026")
                : shown.length === 0
                    ? React.createElement("div", { style: { marginTop: 12 } },
                        React.createElement(EmptyState, { text: "No official announcements yet \u2014 an admin or officer can post one from the Fireside below, tagged Announcement." }))
                    : React.createElement(React.Fragment, null,
                        React.createElement("div", { className: "notice-board", style: { marginTop: 16 } },
                            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: SPACE_SCALE[22] } },
                                shown.map((n, i) => React.createElement(NoticeCard, { key: n.id, notice: n, rotation: rotations[i % rotations.length] })))),
                        remaining > 0 && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: '#7A7160', marginTop: 12, fontStyle: 'italic' } },
                            `${remaining} more official announcement${remaining === 1 ? '' : 's'} in the Fireside below`)));
}
