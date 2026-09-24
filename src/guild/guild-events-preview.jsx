import React, { useEffect, useState } from 'react';
import { EVENT_APPROVAL_COLORS, EVENT_APPROVAL_LABELS, evBtnStyle } from './guild-events-panel.jsx';
import { fetchGuildEventEntryCount, fetchGuildEvents } from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { ArchiveSectionHeading, EmptyState } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// ---------- Guild Events — compact Guild Homepage preview ----------
// A small, read-only teaser for the real Guild Events feature, sitting on the Guild Hall home
// screen the same way NoticeBoard and GuildQuestBoard do. This file only READS what's already
// there — src/guild/guild-events-section.jsx (the actual Guild Events page, with every tab,
// lifecycle control, and create/edit form) and src/lib/guild-events.js (the backend RPCs and
// row-mapping) are untouched. fetchGuildEvents(guildId) below deliberately omits
// includeAllStatuses, so — exactly like a non-owner opening the real Guild Events page — this
// only ever sees published/active/completed rows, never a draft or pending-approval one.
//
// statusOf/formatShortDate are tiny, intentionally-duplicated copies of the same-named helpers
// in guild-events-section.jsx: that file exports neither, and re-deriving two one-line pure
// functions here is cheaper (and safer, given the "don't modify the Guild Events page" ask)
// than adding an export to a file this task says to leave alone.
function statusOf(event) {
    return event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
}

function formatShortDate(value) {
    if (!value) return null;
    try { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return null; }
}

// The one event worth surfacing on the homepage: whatever's open for entries right now, or —
// failing that — whichever published event starts soonest. A guild with only completed events
// (or none at all) gets the empty state instead of a stale "upcoming" event that's actually over;
// nothing here ever invents a placeholder to fill the slot.
function pickFeaturedEvent(events) {
    const active = events
        .filter((e) => statusOf(e) === 'active')
        .sort((a, b) => new Date(a.end_date || a.start_date || 0) - new Date(b.end_date || b.start_date || 0));
    if (active.length) return active[0];
    const upcoming = events
        .filter((e) => statusOf(e) === 'published')
        .sort((a, b) => new Date(a.start_date || 0) - new Date(b.start_date || 0));
    return upcoming[0] || null;
}

function FeaturedEventCard({ event, entryCount, onOpen }) {
    const status = statusOf(event);
    const color = EVENT_APPROVAL_COLORS[status] || '#C89B3C';
    const dateRange = [formatShortDate(event.start_date), formatShortDate(event.end_date)].filter(Boolean).join(' \u2013 ');
    const rewardLine = event.host === 'inkroot'
        ? `Official \u2014 ${formatNaira(event.cashPrizeNaira)} prize`
        : `Entry \u2014 ${formatNaira(event.entryFeeNaira)}`;
    return React.createElement("button", {
        onClick: onOpen,
        style: {
            display: 'flex', width: '100%', textAlign: 'left', gap: SPACE_SCALE[12], alignItems: 'center',
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14],
            padding: 14, cursor: 'pointer', font: 'inherit', marginTop: 16,
        },
    },
        event.cover_image_url
            ? React.createElement("img", { src: event.cover_image_url, alt: "", style: { width: 54, height: 54, objectFit: 'cover', borderRadius: RADIUS_SCALE[9], flexShrink: 0 } })
            : React.createElement("div", {
                style: {
                    width: 54, height: 54, borderRadius: RADIUS_SCALE[9], flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'radial-gradient(circle at 34% 30%, #241F14, #17130E 75%)', border: '1px solid rgba(232,196,104,0.4)', fontSize: TYPE_SCALE[20],
                },
            }, React.createElement(InkIcon, { name: event.host === 'inkroot' ? "columns" : "flame", size: 13 })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], alignItems: 'baseline' } },
                React.createElement("div", {
                    style: {
                        fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                }, event.title || 'Untitled event'),
                React.createElement("span", {
                    style: {
                        display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TYPE_SCALE[9], textTransform: 'uppercase', letterSpacing: '0.04em',
                        color, flexShrink: 0, padding: '2px 7px', borderRadius: 100, background: `${color}1A`, border: `1px solid ${color}50`,
                    },
                }, EVENT_APPROVAL_LABELS[status] || status)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A8680', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                [rewardLine, dateRange].filter(Boolean).join(' \u00B7 ')),
            (entryCount != null) && React.createElement("div", {
                style: { fontSize: TYPE_SCALE[10], color: event.participant_limit && entryCount >= event.participant_limit ? '#D98A8A' : '#5C5C64', marginTop: 3 },
            }, event.participant_limit ? `${entryCount} / ${event.participant_limit} joined` : `${entryCount} joined`)));
}

function ViewEventsButton({ onViewEvents }) {
    return React.createElement("button", {
        onClick: onViewEvents,
        style: { ...evBtnStyle(false), width: '100%', padding: '9px 13px', marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6] },
    }, "View Events \u2192");
}

// remoteGuildId: the same real player_guilds.id (Player Guild row, or a Founder Guild's fixed
// backendGuildId) that GoGuildEventsSection itself is keyed by — null exactly when that section
// would also show its own signed-out/offline notice, so this stays consistent with it rather than
// pretending to have data the real page couldn't show either.
export function GuildEventsHomePreview({ remoteGuildId, onViewEvents }) {
    const [status, setStatus] = useState('loading'); // 'loading' | 'ready'
    const [events, setEvents] = useState([]);
    const [entryCount, setEntryCount] = useState(null);

    useEffect(() => {
        let cancelled = false;
        setEntryCount(null);
        if (!remoteGuildId) {
            setStatus('ready');
            setEvents([]);
            return;
        }
        setStatus('loading');
        fetchGuildEvents(remoteGuildId).then((evts) => {
            if (cancelled) return;
            setEvents(evts);
            setStatus('ready');
            const featured = pickFeaturedEvent(evts);
            if (featured && featured.host === 'guild') {
                fetchGuildEventEntryCount(featured.id).then((c) => { if (!cancelled) setEntryCount(c); }).catch(() => {});
            }
        }).catch((e) => {
            console.warn('Inkroot: guild events home preview fetch failed', e);
            if (!cancelled) { setEvents([]); setStatus('ready'); }
        });
        return () => { cancelled = true; };
    }, [remoteGuildId]);

    const featured = status === 'ready' ? pickFeaturedEvent(events) : null;

    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "horn", size: 20, style: { display: "inline-block" } }), label: "Guild Events" }),
        !remoteGuildId
            ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 12 } },
                "Guild Events need a signed-in, online guild \u2014 sign in to see this guild's competitions here.")
            : status === 'loading'
                ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 12 } }, "Checking the horn call\u2026")
                : featured
                    ? React.createElement(FeaturedEventCard, { event: featured, entryCount, onOpen: onViewEvents })
                    : React.createElement("div", { style: { marginTop: 12 } },
                        React.createElement(EmptyState, { text: "No upcoming events right now \u2014 check back soon, or open Guild Events to see what's already run." })),
        React.createElement(ViewEventsButton, { onViewEvents }));
}
