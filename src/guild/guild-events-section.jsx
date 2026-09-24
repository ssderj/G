import React, { useEffect, useState } from 'react';
import {
    EVENT_APPROVAL_COLORS, EVENT_APPROVAL_LABELS, EventCard, GuildEventForm, evBtnStyle,
} from './guild-events-panel.jsx';
import {
    createGuildEventDraft, fetchCurrentGuildEventHostingFeeNaira, fetchGuildEventEntryCount,
    fetchGuildEventFinancialAgreement, fetchGuildEvents, fetchPlatformFeePct,
    proposeGuildEventFinancialAgreement, updateGuildEventDraft,
} from '../lib/guild-events.js';
import { fetchGuildTreasuryRole } from '../lib/guild-treasury.js';
import { formatNaira } from '../lib/payments.js';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { fetchFounderGuildMembers } from '../lib/library-guild.js';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------- Guild Events section (frontend only — see src/guild/guild-events-panel.jsx and
// src/lib/guild-events.js for the real, already-built backend wiring this reuses wholesale:
// EventCard for every lifecycle control, GuildEventForm for the create/edit form itself, and
// every RPC call for creating, approving, publishing, activating, entering, and settling an
// event). This file adds the browsing shell the backend never had a Guild-facing home for:
// a tabbed Upcoming/Active/Completed list, a dedicated Create Event page, and a dedicated Event
// Details page — all mobile-first, all using only what fetchGuildEvents already returns.
//
// "Official Inkroot Events" (host === 'inkroot') are created only by an Inkroot admin — see
// src/admin/inkroot-events-admin.jsx. There is no client-callable way to create one, and nothing
// in this file exposes one; when Inkroot hosts a cash-prize event for this guild it simply shows
// up in the same list, clearly labelled, exactly as fetchGuildEvents already returns it.
//
// approval_status is the single source of truth for what's safe to show/enter, and every write
// this file makes goes through the same guarded RPCs the rest of the app already uses
// (create_guild_event_draft, submit_guild_event_for_approval, etc.) — there is no shortcut here
// that publishes, activates, or enters an event without Inkroot's review and, where relevant,
// payment. See 45_migration_guild_event_creation_workflow.sql for the lifecycle this walks.

function statusOf(event) {
    return event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
}

const EVENT_TABS = [
    { key: 'upcoming', label: 'Upcoming', statuses: ['draft', 'pending_approval', 'approved', 'published', 'rejected'] },
    { key: 'active', label: 'Active', statuses: ['active'] },
    { key: 'completed', label: 'Completed', statuses: ['completed'] },
];

function formatShortDate(value) {
    if (!value) return null;
    try { return new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return null; }
}

// ---------- Compact preview card — the Upcoming/Active/Completed list itself. Full detail,
// entry, and lifecycle controls only live on the Event Details page (EventCard, opened on tap)
// so a guild with several events doesn't turn into a wall of forms and buttons to scroll past.
function EventPreviewCard({ event, entryCount, organizerName, onOpen }) {
    const status = statusOf(event);
    const dateRange = [formatShortDate(event.start_date), formatShortDate(event.end_date)].filter(Boolean).join(' \u2013 ');
    return React.createElement("button", {
        onClick: onOpen,
        style: {
            display: 'flex', width: '100%', textAlign: 'left', gap: SPACE_SCALE[12], alignItems: 'center',
            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 12,
            marginBottom: 10, cursor: 'pointer', font: 'inherit',
        },
    },
        event.cover_image_url
            ? React.createElement("img", { src: event.cover_image_url, alt: "", style: { width: 52, height: 52, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], flexShrink: 0 } })
            : React.createElement("div", { style: { width: 52, height: 52, borderRadius: RADIUS_SCALE[8], background: '#16161A', border: '1px solid #2A2A30', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, React.createElement(InkIcon, { name: event.host === 'inkroot' ? "columns" : "flame", size: 19 })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], alignItems: 'baseline' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], color: '#EFE7D2', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, event.title || 'Untitled event'),
                React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: TYPE_SCALE[9], textTransform: 'uppercase', letterSpacing: '0.04em', color: EVENT_APPROVAL_COLORS[status] || '#C89B3C', flexShrink: 0, padding: '2px 7px', borderRadius: 100, background: `${EVENT_APPROVAL_COLORS[status] || '#C89B3C'}1A`, border: `1px solid ${EVENT_APPROVAL_COLORS[status] || '#C89B3C'}50` } }, EVENT_APPROVAL_LABELS[status] || status)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                [
                    event.host === 'inkroot' ? `Official \u2014 ${formatNaira(event.cashPrizeNaira)}` : `Entry \u2014 ${formatNaira(event.entryFeeNaira)}`,
                    dateRange,
                    organizerName ? `by ${organizerName}` : null,
                ].filter(Boolean).join(' \u00B7 ')),
            (entryCount != null) && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: event.participant_limit && entryCount >= event.participant_limit ? '#D98A8A' : '#5C5C64', marginTop: 2 } },
                event.participant_limit ? `${entryCount} / ${event.participant_limit} joined` : `${entryCount} joined`)));
}

// ---------- Hosting fee notice — shown up front while creating an event, so a guild sees
// Inkroot's cut before finishing the form, not only once the event's already been approved (the
// actual charge still only happens later, via HostingFeePanel inside EventCard, once Inkroot has
// approved the event — nothing here collects payment).
function HostingFeeNotice() {
    const [feeNaira, setFeeNaira] = useState(undefined);
    useEffect(() => { let c = false; fetchCurrentGuildEventHostingFeeNaira().then((f) => { if (!c) setFeeNaira(f); }).catch(() => { if (!c) setFeeNaira(null); }); return () => { c = true; }; }, []);
    return React.createElement("div", { style: { background: '#241F14', border: '1px solid rgba(232,196,104,0.3)', borderRadius: RADIUS_SCALE[10], padding: '11px 13px', marginBottom: 12, display: 'flex', gap: SPACE_SCALE[10], alignItems: 'flex-start' } },
        React.createElement(InkIcon, { name: "moneybag", size: 16, color: "#E8C468", style: { marginTop: 1, flexShrink: 0 } }),
        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600, color: '#E8C468' } },
                feeNaira === undefined ? 'Checking Inkroot\u2019s hosting fee\u2026' : feeNaira == null ? 'Inkroot hosting fee' : `Inkroot hosting fee \u2014 ${formatNaira(feeNaira)}`),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#B5A87A', marginTop: 3, lineHeight: 1.5 } },
                "A one-time charge to Inkroot, separate from the per-entry platform fee. You\u2019ll pay it after Inkroot approves this event, before it publishes \u2014 it never blocks saving or submitting a draft.")));
}

// ---------- Event Details page — everything EventCard already renders (rules, entry fee, prize
// breakdown, participant count, dates, approval status, the Enter/Registration button, and every
// owner/organizer lifecycle control), plus the two facts EventCard doesn't headline on its own:
// who's organizing it and what the prize pool actually is.
function EventDetailsPage({ event, isOwner, members, canApprove, myUserId, onBack, onChanged, onEdit }) {
    const [agreement, setAgreement] = useState(undefined);
    useEffect(() => {
        if (event.host !== 'guild') { setAgreement(null); return; }
        let cancelled = false;
        fetchGuildEventFinancialAgreement(event.id).then((a) => { if (!cancelled) setAgreement(a); }).catch(() => setAgreement(null));
        return () => { cancelled = true; };
    }, [event.id, event.host]);

    const organizer = members.find((m) => m.user_id === event.organizer_id);
    const prizePoolLine = event.host === 'inkroot'
        ? formatNaira(event.cashPrizeNaira)
        : agreement === undefined ? '\u2026'
            : agreement ? `${agreement.prize_pool_bps / 100}% of every entry fee`
                : 'Not set yet';

    return React.createElement("div", null,
        React.createElement("button", { onClick: onBack, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: 'none', color: '#8A8680', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer', padding: '4px 2px', marginBottom: 12 } },
            "\u2190 Back to Guild Events"),

        React.createElement("div", { style: { background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '10px 13px', marginBottom: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[10] } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Organizer'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', marginTop: 2 } }, organizer ? (organizer.name || organizer.user_id) : (event.host === 'inkroot' ? 'Inkroot' : 'Not yet assigned'))),
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em' } }, 'Prize pool'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#E8C468', fontWeight: 600, marginTop: 2 } }, prizePoolLine))),

        React.createElement(EventCard, { event, isOwner, members, onChanged, onEdit, canApprove, myUserId }));
}

// ---------- Real, guild-scoped Guild Events browsing UI ----------
function GuildEventsReal({ guildId, isOwner, isFounderView, guildKey }) {
    const [events, setEvents] = useState([]);
    const [members, setMembers] = useState([]);
    const [entryCounts, setEntryCounts] = useState({});
    const [role, setRole] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [tab, setTab] = useState('upcoming');
    const [view, setView] = useState('list'); // 'list' | 'create' | 'details'
    const [editingEvent, setEditingEvent] = useState(null);
    const [selectedEventId, setSelectedEventId] = useState(null);

    const canApprove = isOwner || role === 'treasurer' || role === 'officer';

    const load = () => {
        // A Founder Guild's real roster lives in founder_guild_members, keyed by its text slug
        // (guildKey), not by guildId (the backend uuid) — see fetchFounderGuildMembers' own
        // header comment. Shape matches fetchPlayerGuildMembers closely enough (user_id,
        // joined_at, name; no role, since a Founder Guild has no Treasurer/Officer rows) that
        // every existing use of `members` below (organizer lookup, the create-event form) works
        // unchanged either way.
        const membersPromise = isFounderView ? fetchFounderGuildMembers(guildKey) : fetchPlayerGuildMembers(guildId);
        Promise.all([fetchGuildEvents(guildId, { includeAllStatuses: isOwner }), membersPromise])
            .then(([evts, mems]) => {
                setEvents(evts);
                setMembers(mems);
                setLoading(false);
                Promise.all(evts.filter((e) => e.host === 'guild').map((e) => fetchGuildEventEntryCount(e.id).then((c) => [e.id, c]).catch(() => [e.id, null])))
                    .then((pairs) => setEntryCounts(Object.fromEntries(pairs)));
            })
            .catch((e) => { setError(e.message || 'Could not open guild events.'); setLoading(false); });
        fetchGuildTreasuryRole(guildId).then(setRole).catch(() => {});
        currentUser().then((u) => setMyUserId(u ? u.id : null)).catch(() => {});
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [guildId]);

    const openCreate = () => { setEditingEvent(null); setView('create'); };
    const openEdit = (event) => { setEditingEvent(event); setView('create'); };
    const openDetails = (event) => { setSelectedEventId(event.id); setView('details'); };
    const backToList = () => { setView('list'); setEditingEvent(null); setSelectedEventId(null); };

    const handleSaveForm = async (fields) => {
        const { financial, ...eventFields } = fields;
        const event = editingEvent
            ? await updateGuildEventDraft(guildId, editingEvent.id, eventFields)
            : await createGuildEventDraft(guildId, eventFields);
        const platformFeePct = await fetchPlatformFeePct();
        await proposeGuildEventFinancialAgreement(guildId, event.id, { ...financial, platformFeeBps: platformFeePct * 100 });
        backToList();
        setTab('upcoming');
        load();
    };

    if (loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '30px 10px' } }, "Opening Guild Events\u2026");
    }

    if (view === 'create') {
        return React.createElement("div", null,
            React.createElement("button", { onClick: backToList, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: 'none', color: '#8A8680', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer', padding: '4px 2px', marginBottom: 10 } }, "\u2190 Back"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], color: '#EFE7D2', fontWeight: 600, marginBottom: 4 } },
                editingEvent ? 'Edit guild event' : 'Host a guild event'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginBottom: 12 } },
                "Every new event starts as a draft and only goes live once Inkroot reviews and approves it \u2014 there\u2019s no way to publish or open entries before that."),
            React.createElement(HostingFeeNotice, null),
            React.createElement(GuildEventForm, { members, initial: editingEvent, onCancel: backToList, onSave: handleSaveForm }));
    }

    if (view === 'details') {
        const event = events.find((e) => e.id === selectedEventId);
        if (!event) { backToList(); return null; }
        return React.createElement(EventDetailsPage, {
            event, isOwner: isOwner && event.host === 'guild', members, onBack: backToList,
            onChanged: load, onEdit: (ev) => { openEdit(ev); }, canApprove: canApprove && event.host === 'guild', myUserId,
        });
    }

    // ---------- List view ----------
    const activeTabDef = EVENT_TABS.find((t) => t.key === tab) || EVENT_TABS[0];
    const filtered = events.filter((e) => activeTabDef.statuses.includes(statusOf(e)));
    const counts = Object.fromEntries(EVENT_TABS.map((t) => [t.key, events.filter((e) => t.statuses.includes(statusOf(e))).length]));

    return React.createElement("div", null,
        React.createElement("style", null, `
            /* Guild Events list \u2014 the same herald-notice language as the public Event Details
               page (see guild-event-detail-screen.jsx's .ged-ribbon) carried onto the guild's own
               management view, so browsing here already feels like an official noticeboard
               rather than a plain settings list. */
            .gev-board-banner{position:relative;border-radius:${RADIUS_SCALE[14]}px;border:1px solid rgba(184,115,92,0.28);background:linear-gradient(160deg,#201A19,#17151B 70%);padding:18px 18px 16px;margin-bottom:16px;text-align:center;}
            .gev-board-banner::before{content:'';position:absolute;left:14px;right:14px;top:0;height:1px;background:linear-gradient(90deg,transparent,rgba(184,115,92,0.5),transparent);}
        `),
        React.createElement("div", { className: "gev-board-banner" },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#B8735C', marginBottom: 6 } }, "Official Noticeboard"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], color: '#EFE7D2', fontWeight: 600 } }, 'Guild Events'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 6, fontStyle: 'italic', maxWidth: 320, margin: '6px auto 0' } },
                "Competitions this guild hosts and settles itself. Official Inkroot Events \u2014 cash prizes Inkroot funds and awards directly \u2014 show up here too, clearly marked.")),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10, textAlign: 'center' } }, error),

        isOwner && !isFounderView && React.createElement("button", { onClick: openCreate, style: { ...evBtnStyle(true), width: '100%', padding: '11px 13px', marginBottom: 14 } }, '+ Host a Guild Event'),
        // A Founder Guild has no treasury to fund its own entry-fee event from (see
        // 122_migration_founder_guild_no_treasury_or_hosting.sql) — Inkroot can still run an
        // official cash-prize event here, which shows up in the list above like any other.
        isOwner && isFounderView && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center', marginBottom: 14 } },
            "A Founder Guild can't host its own event \u2014 only Inkroot can run an official cash-prize event here."),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 14 } },
            EVENT_TABS.map((t) => React.createElement("button", {
                key: t.key, onClick: () => setTab(t.key),
                style: {
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 6px', borderRadius: RADIUS_SCALE[9],
                    border: `1px solid ${tab === t.key ? 'rgba(232,196,104,0.5)' : '#2A2A30'}`,
                    background: tab === t.key ? 'linear-gradient(160deg, #241F14, #1A160D)' : '#1D1D22',
                    color: tab === t.key ? '#E8C468' : '#8A8680', cursor: 'pointer',
                },
            },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600 } }, t.label),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], opacity: 0.8 } }, counts[t.key])))),

        filtered.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '20px 10px', fontStyle: 'italic' } },
                tab === 'upcoming' ? 'No upcoming events yet.' : tab === 'active' ? 'No events open for entries right now.' : 'No completed events yet.')
            : filtered.map((event) => React.createElement(EventPreviewCard, {
                key: event.id, event, entryCount: entryCounts[event.id],
                organizerName: (members.find((m) => m.user_id === event.organizer_id) || {}).name,
                onOpen: () => openDetails(event),
            })));
}

// remoteGuildId is a real player_guilds.id for both guild types now — a Player Guild's own real
// row, or a Founder Guild's fixed backendGuildId (see FOUNDER_GUILDS in guild-hall.jsx and
// supabase/history/69_migration_founder_guild_parity.sql), set by home-screen.jsx's
// guildOrderBackendId. null only for being signed out or offline, which is exactly when this
// stays a plain locked notice rather than inventing simulated events (there's no honest way to
// simulate a real-money entry fee and payout the way GoTreasuryTabSimulated simulates Guild
// Coin). isOwner only affects which controls this renders; every write the real view makes is
// still re-authorized server-side regardless of what this prop says.
export function GoGuildEventsSection({ remoteGuildId, isOwner, isFounderView, guildKey }) {
    if (!remoteGuildId) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '38px 16px' } },
            React.createElement(InkIcon, { name: 'lock', size: 22, color: '#5C5C64', style: { margin: '0 auto 12px' } }),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8A8680', maxWidth: 260, margin: '0 auto', lineHeight: 1.55 } },
                "Guild Events need a signed-in, online guild \u2014 sign in and join or found a guild to host or enter one."));
    }
    return React.createElement(GuildEventsReal, { guildId: remoteGuildId, isOwner, isFounderView, guildKey });
}
