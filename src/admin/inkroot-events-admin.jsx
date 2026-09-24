import React, { useEffect, useState } from 'react';
import { EventCard, EventTypeBadge, evBtnStyle, evInputStyle } from '../guild/guild-events-panel.jsx';
import {
    adminFetchGuildEventHostingFeeRates, adminSearchGuilds, adminSetGuildEventHostingFee, approveGuildEvent,
    computeEntryFinancialBreakdown, createInkrootEvent, fetchGuildEvents, fetchPendingGuildEventApprovals,
    rejectGuildEvent,
} from '../lib/guild-events.js';
import { formatNaira } from '../lib/payments.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Configurable pricing for the hosting fee every approved guild event must pay before it can be
// published — see 47_migration_guild_event_hosting_fee.sql. Setting a new fee never edits or
// backdates one that's already been charged (each is its own row, newest-effective-from wins);
// this is purely "what should the next payment be".
function HostingFeeSettings() {
    const [rates, setRates] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [newFee, setNewFee] = useState('');
    const [newNote, setNewNote] = useState('');
    const [saving, setSaving] = useState(false);
    const [expanded, setExpanded] = useState(false);

    const load = () => {
        adminFetchGuildEventHostingFeeRates()
            .then((rows) => { setRates(rows); setLoading(false); })
            .catch((e) => { setError(e.message || 'Could not load the hosting fee.'); setLoading(false); });
    };
    useEffect(() => { load(); }, []);

    const current = rates[0];

    const handleSave = async () => {
        const fee = Number(newFee);
        if (newFee === '' || fee < 0) { setError('Enter a valid fee.'); return; }
        setSaving(true);
        setError(null);
        try {
            await adminSetGuildEventHostingFee(fee, newNote.trim() || null);
            setNewFee('');
            setNewNote('');
            load();
        } catch (e) {
            setError(e.message || 'Could not save the new fee.');
        } finally {
            setSaving(false);
        }
    };

    return React.createElement("div", { style: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Guild event hosting fee'),
        loading
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Loading\u2026")
            : React.createElement("div", null,
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#E8C468', fontWeight: 600, marginBottom: 4 } },
                    current ? `Current fee: ${formatNaira(current.feeNaira)}` : 'No fee configured yet'),
                current?.note && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 8 } }, current.note),
                rates.length > 1 && React.createElement("button", { onClick: () => setExpanded((v) => !v), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px', marginBottom: 10 } }, expanded ? 'Hide history' : `View history (${rates.length})`),
                expanded && React.createElement("div", { style: { marginBottom: 10 } },
                    rates.map((r) => React.createElement("div", { key: r.id, style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', padding: '3px 0' } },
                        `${formatNaira(r.feeNaira)} \u2014 from ${new Date(r.effective_from).toLocaleDateString()}${r.note ? ` (${r.note})` : ''}`))),

                error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginBottom: 8 } }, error),

                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                    React.createElement("input", { type: "number", min: "0", value: newFee, onChange: (e) => setNewFee(e.target.value), placeholder: "New fee in \u20a6", style: { ...evInputStyle, width: 140 } }),
                    React.createElement("input", { value: newNote, onChange: (e) => setNewNote(e.target.value), placeholder: "Note (optional)", style: { ...evInputStyle, flex: 1 } }),
                    React.createElement("button", { disabled: saving, onClick: handleSave, style: { ...evBtnStyle(true), opacity: saving ? 0.5 : 1 } }, saving ? '\u2026' : 'Set fee'))));
}

// One guild-owner-submitted event awaiting Inkroot's review — see
// 45_migration_guild_event_creation_workflow.sql. Approve/reject are the only two actions here;
// publishing and activating the event afterward stay the guild owner's own step (EventCard's own
// lifecycle controls), same "review the submission, don't run the guild's event for them"
// division of labor is_inkroot_admin() draws everywhere else.
function PendingEventRow({ submission, onChanged }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [showReject, setShowReject] = useState(false);
    const [reason, setReason] = useState('');

    const handleApprove = async () => {
        setBusy(true);
        setError(null);
        try { await approveGuildEvent(submission.id); onChanged(); } catch (e) { setError(e.message || 'Could not approve this event.'); } finally { setBusy(false); }
    };
    const handleReject = async () => {
        if (!reason.trim()) { setError('Give a reason so the organizer knows what to fix.'); return; }
        setBusy(true);
        setError(null);
        try { await rejectGuildEvent(submission.id, reason.trim()); onChanged(); } catch (e) { setError(e.message || 'Could not reject this event.'); } finally { setBusy(false); }
    };

    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 14, marginBottom: 10 } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600 } }, submission.title),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 3 } },
            `${submission.guild_name} \u2014 Entry fee ${formatNaira(submission.entryFeeNaira)}`),
        submission.event_type && React.createElement(EventTypeBadge, { eventType: submission.event_type }),
        submission.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginTop: 8, whiteSpace: 'pre-wrap' } }, submission.description),

        // The committed financial agreement \u2014 see 48_migration_guild_event_financial_
        // agreement.sql. submit_guild_event_for_approval() already refuses a submission without
        // one, so financial_prize_pool_bps should always be present here; the fallback message
        // only matters for anything that reached pending_approval before this migration ran.
        (() => {
            const entryFeeKobo = Math.round((submission.entryFeeNaira || 0) * 100);
            const agreement = submission.financial_prize_pool_bps != null ? {
                platform_fee_bps: submission.financial_platform_fee_bps,
                prize_pool_bps: submission.financial_prize_pool_bps,
                guild_share_bps: submission.financial_guild_share_bps,
                other_allocations: submission.financial_other_allocations || [],
            } : null;
            const breakdown = computeEntryFinancialBreakdown(entryFeeKobo, agreement);
            if (!breakdown) {
                return React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 8, fontStyle: 'italic' } }, 'No financial agreement on file for this submission.');
            }
            return React.createElement("div", { style: { marginTop: 8, fontSize: TYPE_SCALE[10.5], color: '#7A7A82' } },
                `Per entry: ${formatNaira(breakdown.platformFeeKobo / 100)} platform fee → ${formatNaira(breakdown.prizePoolKobo / 100)} prize pool, ${formatNaira(breakdown.guildShareKobo / 100)} guild share`,
                breakdown.otherAllocations.length > 0 && `, ${breakdown.otherAllocations.map((a) => `${formatNaira(a.kobo / 100)} ${a.label}`).join(', ')}`);
        })(),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { disabled: busy, onClick: handleApprove, style: { ...evBtnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Approve'),
            React.createElement("button", { onClick: () => setShowReject((v) => !v), style: evBtnStyle(false) }, showReject ? 'Cancel' : 'Reject')),

        showReject && React.createElement("div", { style: { marginTop: 10, display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("input", { value: reason, onChange: (e) => setReason(e.target.value), placeholder: "Reason for rejection", style: { ...evInputStyle, flex: 1 } }),
            React.createElement("button", { disabled: busy, onClick: handleReject, style: { ...evBtnStyle(false), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Send')));
}

// The review queue itself — every guild-hosted event currently sitting in 'pending_approval'
// across every guild, not just one selectedGuild. Kept separate from the per-guild
// search-and-host flow below (a different admin task entirely: reviewing a guild's own
// submission vs Inkroot funding its own prize).
function PendingEventsQueue() {
    const [submissions, setSubmissions] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = () => {
        fetchPendingGuildEventApprovals()
            .then((rows) => { setSubmissions(rows); setLoading(false); })
            .catch((e) => { setError(e.message || 'Could not open the review queue.'); setLoading(false); });
    };
    useEffect(() => { load(); }, []);

    return React.createElement("div", { style: { marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Guild event submissions awaiting review'),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),
        loading
            ? React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '10px 0' } }, "Opening the queue\u2026")
            : submissions.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'Nothing waiting on review.')
                : submissions.map((s) => React.createElement(PendingEventRow, { key: s.id, submission: s, onChanged: load })));
}

// Only ever rendered for a confirmed platform admin (see shell/ink-root.jsx's isPlatformAdmin,
// fetched via lib/moderation.js's fetchIsPlatformAdmin) — same "real enforcement is server-side"
// posture as ModerationQueue. Every write here (create_guild_event, settle_guild_event) re-checks
// is_inkroot_admin() itself regardless of what got this screen open in the first place; a
// non-admin who somehow reached it would just get permission errors, not real capability. See
// 43_migration_inkroot_events_admin.sql.
export function InkrootEventsAdmin({ onBack }) {
    const [search, setSearch] = useState('');
    const [guilds, setGuilds] = useState([]);
    const [searching, setSearching] = useState(false);
    const [searchError, setSearchError] = useState(null);
    const [selectedGuild, setSelectedGuild] = useState(null); // { id, name, owner_id, member_count }
    const [events, setEvents] = useState([]);
    const [members, setMembers] = useState([]);
    const [loadingGuild, setLoadingGuild] = useState(false);

    const [showCreate, setShowCreate] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newPrize, setNewPrize] = useState('');
    const [createBusy, setCreateBusy] = useState(false);
    const [createError, setCreateError] = useState(null);

    const runSearch = () => {
        setSearching(true);
        setSearchError(null);
        adminSearchGuilds(search.trim())
            .then((rows) => { setGuilds(rows); setSearching(false); })
            .catch((e) => { setSearchError(e.message || 'Could not search guilds.'); setSearching(false); });
    };
    useEffect(() => { runSearch(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

    const loadGuildEvents = (guild) => {
        setSelectedGuild(guild);
        setLoadingGuild(true);
        Promise.all([fetchGuildEvents(guild.id), fetchPlayerGuildMembers(guild.id)])
            .then(([evts, mems]) => { setEvents(evts); setMembers(mems); setLoadingGuild(false); })
            .catch(() => setLoadingGuild(false));
    };

    const handleCreate = async () => {
        const prize = Number(newPrize);
        if (!newTitle.trim() || !prize || prize <= 0 || !selectedGuild) return;
        setCreateBusy(true);
        setCreateError(null);
        try {
            await createInkrootEvent(selectedGuild.id, newTitle.trim(), prize);
            setNewTitle('');
            setNewPrize('');
            setShowCreate(false);
            loadGuildEvents(selectedGuild);
        } catch (e) {
            setCreateError(e.message || 'Could not create that event.');
        } finally {
            setCreateBusy(false);
        }
    };

    return React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', color: '#EFE7D2', padding: '20px 16px 60px', maxWidth: 640, margin: '0 auto' } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 20 } },
            React.createElement("button", { onClick: onBack, style: { background: 'none', border: 'none', color: '#8A8680', fontSize: TYPE_SCALE[13], cursor: 'pointer' } }, "\u2190 Back"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#E8C468' } }, 'Inkroot Admin \u2014 Guild Events')),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 16, fontStyle: 'italic' } },
            "Host a cash-prize event for any guild, or settle one that's already open. Every credit still goes through the same treasury ledger and share checks as a guild's own entry-fee events."),

        !selectedGuild && React.createElement(HostingFeeSettings, null),

        !selectedGuild && React.createElement(PendingEventsQueue, null),

        !selectedGuild && React.createElement("div", null,
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 12 } },
                React.createElement("input", {
                    value: search, onChange: (e) => setSearch(e.target.value),
                    onKeyDown: (e) => e.key === 'Enter' && runSearch(),
                    placeholder: "Search guilds by name\u2026", style: { ...evInputStyle, flex: 1 },
                }),
                React.createElement("button", { onClick: runSearch, style: evBtnStyle(false) }, searching ? '\u2026' : 'Search')),
            searchError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, searchError),
            guilds.length === 0 && !searching
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No guilds found.')
                : guilds.map((g) => React.createElement("button", {
                    key: g.id, onClick: () => loadGuildEvents(g),
                    style: {
                        display: 'block', width: '100%', textAlign: 'left', background: '#1D1D22', border: '1px solid #2A2A30',
                        borderRadius: RADIUS_SCALE[10], padding: '10px 12px', marginBottom: 8, cursor: 'pointer', color: '#EFE7D2',
                    },
                },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600 } }, g.name),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 2 } }, `${g.member_count} member${g.member_count === 1 ? '' : 's'}`)))),

        selectedGuild && React.createElement("div", null,
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], color: '#EFE7D2', fontWeight: 600 } }, selectedGuild.name),
                React.createElement("button", { onClick: () => { setSelectedGuild(null); setEvents([]); setShowCreate(false); }, style: evBtnStyle(false) }, 'Choose a different guild')),

            loadingGuild
                ? React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '16px 10px' } }, "Opening this guild's events\u2026")
                : React.createElement("div", null,
                    events.length === 0
                        ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No events for this guild yet.')
                        : events.map((ev) => React.createElement(EventCard, { key: ev.id, event: ev, isOwner: ev.host === 'inkroot', members, onChanged: () => loadGuildEvents(selectedGuild), onEdit: () => {}, isAdmin: true })),

                    React.createElement("div", { style: { marginTop: 12 } },
                        !showCreate && React.createElement("button", { onClick: () => setShowCreate(true), style: evBtnStyle(true) }, '+ Host a cash-prize event here'),
                        showCreate && React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                            React.createElement("input", { value: newTitle, onChange: (e) => setNewTitle(e.target.value), placeholder: "Event title", style: evInputStyle }),
                            React.createElement("input", { value: newPrize, onChange: (e) => setNewPrize(e.target.value), placeholder: "Cash prize in \u20a6", type: "number", min: "1", style: evInputStyle }),
                            createError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11] } }, createError),
                            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                                React.createElement("button", { disabled: createBusy, onClick: handleCreate, style: { ...evBtnStyle(true), opacity: createBusy ? 0.5 : 1 } }, createBusy ? '\u2026' : 'Create event'),
                                React.createElement("button", { onClick: () => setShowCreate(false), style: evBtnStyle(false) }, 'Cancel')))))));
}
