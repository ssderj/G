import React, { useEffect, useState } from 'react';
import {
    activateGuildEvent, adminCancelGuildEventDispute, approveGuildEventResults, cancelGuildEvent, closeGuildEvent,
    completeGuildEvent, computeEntryFinancialBreakdown, createGuildEventDraft, depositGuildEventPrizeEscrow,
    enterGuildEvent, fetchCurrentGuildEventHostingFeeNaira, fetchGuildEventEntryCount, fetchGuildEventEscrowStatus,
    fetchGuildEventFinancialAgreement, fetchGuildEventHostingFeeStatus, fetchGuildEventObjectiveConfig, fetchGuildEventResults, fetchGuildEvents,
    fetchMyGuildEventEntry, fetchPendingGuildEventResults, fetchPlatformFeePct, payGuildEventHostingFee, proposeGuildEventFinancialAgreement,
    proposeGuildEventObjectiveConfig, publishGuildEvent, rejectGuildEventResults, settleGuildEvent, submitGuildEventForApproval, submitGuildEventResults,
    updateGuildEventDraft, uploadGuildEventCover,
} from '../lib/guild-events.js';
import { fetchGuildTreasuryRole } from '../lib/guild-treasury.js';
import { formatNaira } from '../lib/payments.js';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { readLocalImageFile } from '../shared-ui/image-utils.jsx';
import {
    IconEventGiveaway, IconEventOther, IconEventReadingChallenge, IconEventTournament,
    IconEventWorkshop, IconEventWritingContest,
} from '../shared-ui/icons.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { GuildEventSubmissionPanel } from './guild-event-submission-panel.jsx';
import { GuildEventReadingChallengePanel } from './guild-event-reading-challenge-panel.jsx';

// Deliberately not imported from guild-order.jsx (which renders this panel) — same one-way-copy
// reasoning as guild-member-earnings.jsx's own local style helpers.
export function evBtnStyle(primary) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', borderRadius: RADIUS_SCALE[8], cursor: 'pointer',
        border: primary ? '1px solid rgba(232,196,104,0.5)' : '1px solid #2A2A30',
        background: primary ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'transparent',
        color: primary ? '#E8C468' : '#8A8680',
    };
}
export const evInputStyle = { background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], color: '#EFE7D2', padding: '8px 10px', fontSize: TYPE_SCALE[12.5], width: '100%', boxSizing: 'border-box' };
const evLabelStyle = { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };

// Guild Event creation — see 45_migration_guild_event_creation_workflow.sql. approval_status is
// the lifecycle this form and the buttons below walk an event through:
//   draft -> pending_approval -> approved -> published -> active -> completed
//   (or draft/pending_approval -> rejected, which stays unpublished until edited back to draft
//   and resubmitted)
// Human-readable labels + a color per stage, used by both the EventCard badge and the admin
// queue.
export const EVENT_APPROVAL_LABELS = {
    draft: 'Draft', pending_approval: 'Pending approval', approved: 'Approved',
    published: 'Published', active: 'Active', completed: 'Completed', rejected: 'Rejected',
    cancelled: 'Cancelled',
};
export const EVENT_APPROVAL_COLORS = {
    draft: '#7A7A82', pending_approval: '#C89B3C', approved: '#8FB8CB', published: '#8FB8CB',
    active: '#8FCB8F', completed: '#8FCB8F', rejected: '#D98A8A',
    // 'cancelled' has no producer anywhere server-side today (see 45_migration_guild_event_creation_workflow.sql's
    // approval_status check \u2014 'cancelled' isn't one of the allowed values), so this key is
    // inert until the backend ever adds one. Kept here \u2014 same as the entry-status handling
    // in EventCard below \u2014 so the UI doesn't need another pass the day it does.
    cancelled: '#D98A8A',
};
export const EVENT_TYPE_LABELS = {
    tournament: 'Tournament', writing_contest: 'Writing contest', reading_challenge: 'Reading challenge',
    giveaway: 'Giveaway', workshop: 'Workshop', other: 'Other',
};
// A distinct, muted tint per event type — deliberately its own palette from
// EVENT_APPROVAL_COLORS above so a type badge is never mistaken for a status badge sitting next
// to it on the same card.
export const EVENT_TYPE_COLORS = {
    tournament: '#D4A54A', writing_contest: '#B8735C', reading_challenge: '#8FB8CB',
    giveaway: '#C97FB0', workshop: '#CB9C5C', other: '#7A7A82',
};
export const EVENT_TYPE_ICONS = {
    tournament: IconEventTournament, writing_contest: IconEventWritingContest, reading_challenge: IconEventReadingChallenge,
    giveaway: IconEventGiveaway, workshop: IconEventWorkshop, other: IconEventOther,
};

// Judging — see 121_migration_guild_event_fair_judging.sql. Placements are computed, never
// declared: an objective metric (scored off data the server already has) and/or a blind judge
// panel (3-5 verified authors, assigned automatically, outside the hosting guild) combine into a
// ranked result. Every host='guild' event needs one of these on file before it can activate —
// there is no event type that skips this step, including giveaway/workshop (see the note
// JudgingConfigSection renders for those two below).
export const OBJECTIVE_METRIC_LABELS = { none: 'None — judge panel only', word_count: 'Word count', on_time_completion: 'On-time completion' };

// The event-type pill shown on both a guild's own event cards (EventCard below) and Inkroot
// Admin's pending-submission rows — one place so the glyph/tint/label can never drift between
// the two. Renders nothing for an event with no recognized type.
export function EventTypeBadge({ eventType, style }) {
    if (!eventType || !EVENT_TYPE_LABELS[eventType]) return null;
    const color = EVENT_TYPE_COLORS[eventType] || '#7A7A82';
    const Icon = EVENT_TYPE_ICONS[eventType];
    return React.createElement("div", {
        style: {
            display: 'inline-flex', alignItems: 'center', gap: 5, marginTop: 4, padding: '3px 9px 3px 7px',
            borderRadius: 100, fontSize: TYPE_SCALE[10], color, background: `${color}1A`, border: `1px solid ${color}55`,
            ...style,
        },
    },
        Icon && React.createElement(Icon, { style: { flexShrink: 0 } }),
        EVENT_TYPE_LABELS[eventType]);
}

// Guild Event results — organizer submission + required approval, see
// 49_migration_guild_event_results_approval.sql. Distinct from approval_status above: this is
// entirely about whether a *proposed payout* for an already-completed event has been reviewed,
// never about whether the event itself is fit to show readers.
const RESULTS_STATUS_LABELS = { pending_approval: 'Awaiting approval', approved: 'Approved & paid out', rejected: 'Sent back for revision' };
const RESULTS_STATUS_COLORS = { pending_approval: '#C89B3C', approved: '#8FCB8F', rejected: '#D98A8A' };

function formatEventDate(value) {
    if (!value) return null;
    try {
        return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) {
        return null;
    }
}

// Converts a value from an <input type="date"> into a fields.startDate/endDate the create/edit
// form can round-trip, and vice versa — kept in one place so the two directions can't drift.
function toDateInputValue(value) {
    if (!value) return '';
    try { return new Date(value).toISOString().slice(0, 10); } catch (e) { return ''; }
}

// The full Guild Event submission form — every field from the migration header: title,
// description, rules, event type, entry fee, participant limit, prize structure, guild share,
// start/end date, organizer, cover image. Shared between "+ Host a guild event" (create) and
// "Edit" on a draft/rejected event (edit) — `initial` is either null (create) or an existing
// event's fields (edit).
export function GuildEventForm({ members, initial, onCancel, onSave }) {
    const [fields, setFields] = useState(() => ({
        title: initial?.title || '',
        description: initial?.description || '',
        rules: initial?.rules || '',
        eventType: initial?.event_type || 'other',
        entryFeeNaira: initial?.entryFeeNaira != null ? String(initial.entryFeeNaira) : '',
        participantLimit: initial?.participant_limit != null ? String(initial.participant_limit) : '',
        guildSharePct: initial?.guild_share_bps != null ? String(initial.guild_share_bps / 100) : '',
        startDate: toDateInputValue(initial?.start_date),
        endDate: toDateInputValue(initial?.end_date),
        organizerId: initial?.organizer_id || '',
        coverImageUrl: initial?.cover_image_url || '',
        guaranteedPrizeNaira: initial?.guaranteedPrizeNaira != null ? String(initial.guaranteedPrizeNaira) : '',
    }));
    const [prizeRows, setPrizeRows] = useState(
        (initial?.prize_structure && initial.prize_structure.length > 0)
            ? initial.prize_structure.map((p) => ({ place: p.place != null ? String(p.place) : '', sharePct: p.share_pct != null ? String(p.share_pct) : '' }))
            : [{ place: '1', sharePct: '' }]
    );
    // The locked, enforced money split — see 48_migration_guild_event_financial_agreement.sql.
    // Distinct from prizeRows above (which only guides how the prize pool gets divided among
    // placements once winners are known — still informational, unenforced): this is what
    // actually gates how much of the pool goes to winners vs. the guild, checked server-side at
    // settlement. Defaults to "100% to the prize pool" for a brand-new event so a first-time
    // organizer isn't forced to think about a guild cut before they can save anything.
    const [prizePoolPct, setPrizePoolPct] = useState('100');
    const [guildSharePct, setGuildSharePct] = useState('0');
    const [otherAllocRows, setOtherAllocRows] = useState([]);
    // Judging configuration — see 121_migration_guild_event_fair_judging.sql. Every host='guild'
    // event needs one of these on file before it can activate; placements get computed from this,
    // never declared by the organizer. Distinct from prizeRows above (which stays purely
    // informational) — placementSplitRows is what compute_guild_event_placements() actually pays
    // out against. Defaults to "pure judge panel, winner takes the whole pool" so a first-time
    // organizer isn't forced to understand the objective-metric math before saving a draft.
    const [objectiveMetric, setObjectiveMetric] = useState('none');
    const [objectiveWeightPct, setObjectiveWeightPct] = useState('0');
    const [placementSplitRows, setPlacementSplitRows] = useState([{ place: '1', sharePct: '100' }]);
    const [objectiveLocked, setObjectiveLocked] = useState(false);
    const [coverUploading, setCoverUploading] = useState(false);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    // Inkroot's real, current per-entry cut \u2014 read fresh the same way handleSaveForm below
    // (and proposeGuildEventFinancialAgreement's own doc comment) already insists on, purely so
    // the live preview never shows a % that could drift from what actually gets proposed on save.
    const [platformFeeBps, setPlatformFeeBps] = useState(null);
    useEffect(() => { fetchPlatformFeePct().then((pct) => setPlatformFeeBps(pct * 100)).catch(() => {}); }, []);

    // Loads the existing agreement when editing a draft/rejected event that already has one —
    // a brand-new event (initial === null) has nothing to load, and keeps the 100%/0% default.
    useEffect(() => {
        if (!initial) return;
        let cancelled = false;
        fetchGuildEventFinancialAgreement(initial.id).then((a) => {
            if (cancelled || !a) return;
            setPrizePoolPct(String(a.prize_pool_bps / 100));
            setGuildSharePct(String(a.guild_share_bps / 100));
            setOtherAllocRows((a.other_allocations || []).map((x) => ({ label: x.label, sharePct: String(x.bps / 100) })));
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [initial]);

    // Loads the existing judging config the same way — an event with none yet (brand new, or a
    // draft never taken past the old form) keeps the pure-judge-panel default above.
    useEffect(() => {
        if (!initial) return;
        let cancelled = false;
        fetchGuildEventObjectiveConfig(initial.id).then((c) => {
            if (cancelled || !c) return;
            setObjectiveMetric(c.metric);
            setObjectiveWeightPct(String(c.weight_bps / 100));
            setObjectiveLocked(c.locked);
            if (c.placement_split_bps && c.placement_split_bps.length > 0) {
                setPlacementSplitRows(c.placement_split_bps.map((p) => ({ place: String(p.place), sharePct: String(p.share_bps / 100) })));
            }
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [initial]);

    // metric = 'none' requires weight = 0 — propose_guild_event_objective_config() refuses the
    // combination server-side too, this just stops the form from ever offering it.
    const handleMetricChange = (e) => {
        const v = e.target.value;
        setObjectiveMetric(v);
        if (v === 'none') setObjectiveWeightPct('0');
    };

    const otherAllocTotalPct = otherAllocRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);
    const financialTotalPct = (Number(prizePoolPct) || 0) + (Number(guildSharePct) || 0) + otherAllocTotalPct;
    const placementSplitTotalPct = placementSplitRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);

    // Same shape computeEntryFinancialBreakdown expects from a real, saved
    // guild_event_financial_agreements row \u2014 built from this form's own in-progress values
    // purely for display; nothing here is sent anywhere (the actual save is still
    // proposeGuildEventFinancialAgreement, unchanged, in handleSaveForm below).
    const previewAgreement = platformFeeBps != null ? {
        platform_fee_bps: platformFeeBps,
        prize_pool_bps: Math.round((Number(prizePoolPct) || 0) * 100),
        guild_share_bps: Math.round((Number(guildSharePct) || 0) * 100),
        other_allocations: otherAllocRows.filter((r) => r.label && r.sharePct)
            .map((r) => ({ label: r.label, bps: Math.round((Number(r.sharePct) || 0) * 100) })),
    } : null;
    const previewEntryFeeKobo = fields.entryFeeNaira && Number(fields.entryFeeNaira) > 0 ? Math.round(Number(fields.entryFeeNaira) * 100) : null;
    const previewBreakdown = computeEntryFinancialBreakdown(previewEntryFeeKobo, previewAgreement);

    const patch = (key) => (e) => setFields((f) => ({ ...f, [key]: e.target.value }));

    const handleCoverFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file) return;
        setError(null);
        setCoverUploading(true);
        try {
            const dataUrl = await readLocalImageFile(file, 1000, 0.85);
            const uploadedUrl = await uploadGuildEventCover(dataUrl);
            setFields((f) => ({ ...f, coverImageUrl: uploadedUrl }));
        } catch (err) {
            setError(err.message || 'Could not use that image.');
        } finally {
            setCoverUploading(false);
        }
    };

    const handleSubmit = async () => {
        if (!fields.title.trim()) { setError('Give the event a title.'); return; }
        if (!fields.entryFeeNaira || Number(fields.entryFeeNaira) <= 0) { setError('Set a positive entry fee.'); return; }
        if (!prizePoolPct || Number(prizePoolPct) <= 0) { setError('The prize pool needs a positive share \u2014 participants are paying to compete for something.'); return; }
        if (otherAllocRows.some((r) => r.label && !r.sharePct)) { setError('Give every other allocation a share, or remove the row.'); return; }
        if (Math.round(financialTotalPct * 100) !== 10000) {
            setError(`Prize pool + guild share + other allocations must add up to exactly 100% \u2014 currently ${financialTotalPct}%.`);
            return;
        }
        if (fields.guaranteedPrizeNaira && Number(fields.guaranteedPrizeNaira) <= 0) {
            setError('Guaranteed prize must be a positive amount, or left blank.');
            return;
        }
        if (!fields.startDate || !fields.endDate) {
            setError('Choose a start and end date for the event.');
            return;
        }
        if (new Date(fields.endDate) <= new Date(fields.startDate)) {
            setError('End date must be after the start date.');
            return;
        }
        if (objectiveWeightPct === '' || Number(objectiveWeightPct) < 0 || Number(objectiveWeightPct) > 100) {
            setError('Objective weight must be between 0% and 100%.');
            return;
        }
        if (objectiveMetric === 'none' && Number(objectiveWeightPct) !== 0) {
            setError('An objective weight requires an objective metric.');
            return;
        }
        if (placementSplitRows.some((r) => r.place && !r.sharePct)) {
            setError('Give every judging placement a share, or remove the row.');
            return;
        }
        if (Math.round(placementSplitTotalPct * 100) !== 10000) {
            setError(`Judging placement split must add up to exactly 100% \u2014 currently ${placementSplitTotalPct}%.`);
            return;
        }
        setBusy(true);
        setError(null);
        try {
            const prizeStructure = prizeRows
                .filter((r) => r.place && r.sharePct)
                .map((r) => ({ place: Number(r.place), share_pct: Number(r.sharePct) }));
            const otherAllocations = otherAllocRows.filter((r) => r.label && r.sharePct);
            const placementSplit = placementSplitRows.filter((r) => r.place && r.sharePct);
            await onSave({
                ...fields, prizeStructure,
                financial: { prizePoolPct, guildSharePct, otherAllocations },
                judging: { metric: objectiveMetric, weightPct: objectiveWeightPct, placementSplit },
            });
        } catch (e) {
            setError(e.message || 'Could not save this event.');
        } finally {
            setBusy(false);
        }
    };

    return React.createElement("div", { style: { position: 'relative', display: 'grid', gap: SPACE_SCALE[10], background: 'linear-gradient(165deg,#1F1B1A,#1B1B20)', border: '1px solid rgba(184,115,92,0.24)', borderRadius: RADIUS_SCALE[13], padding: '18px 14px 14px', marginBottom: 10 } },
        React.createElement("div", { style: { position: 'absolute', left: 14, right: 14, top: 0, height: 1, background: 'linear-gradient(90deg,transparent,rgba(184,115,92,0.45),transparent)' } }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9], letterSpacing: '0.14em', textTransform: 'uppercase', color: '#B8735C', marginBottom: 2 } }, "\u2696\uFE0F Event application"),
        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Event title'),
            React.createElement("input", { value: fields.title, onChange: patch('title'), placeholder: "e.g. Autumn Flash Fiction Sprint", style: evInputStyle })),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Description'),
            React.createElement("textarea", { value: fields.description, onChange: patch('description'), rows: 3, placeholder: "What's this event about?", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } })),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Rules'),
            React.createElement("textarea", { value: fields.rules, onChange: patch('rules'), rows: 3, placeholder: "Eligibility, submission format, judging\u2026", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } })),

        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Event type'),
                React.createElement("select", { value: fields.eventType, onChange: patch('eventType'), style: evInputStyle },
                    Object.entries(EVENT_TYPE_LABELS).map(([v, label]) => React.createElement("option", { key: v, value: v }, label)))),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Organizer'),
                React.createElement("select", { value: fields.organizerId, onChange: patch('organizerId'), style: evInputStyle },
                    React.createElement("option", { value: "" }, 'None chosen'),
                    members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id))))),

        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Entry fee (\u20a6)'),
                React.createElement("input", { type: "number", min: "1", value: fields.entryFeeNaira, onChange: patch('entryFeeNaira'), style: evInputStyle })),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Participant limit'),
                React.createElement("input", { type: "number", min: "1", value: fields.participantLimit, onChange: patch('participantLimit'), placeholder: "Unlimited", style: evInputStyle }))),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, "Guaranteed prize (\u20a6, optional \u2014 must be locked in escrow from the guild treasury before this event can be submitted for review)"),
            React.createElement("input", { type: "number", min: "1", value: fields.guaranteedPrizeNaira, onChange: patch('guaranteedPrizeNaira'), placeholder: "Leave blank for no guaranteed prize", style: evInputStyle })),

        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'Start date *'),
                React.createElement("input", { type: "date", required: true, value: fields.startDate, onChange: patch('startDate'), style: evInputStyle })),
            React.createElement("div", null,
                React.createElement("label", { style: evLabelStyle }, 'End date *'),
                React.createElement("input", { type: "date", required: true, value: fields.endDate, onChange: patch('endDate'), style: evInputStyle }))),

        React.createElement("div", { style: { background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
            React.createElement("div", { style: { ...evLabelStyle, marginBottom: 8 } }, "Financial agreement \u2014 locked once this event opens for entries"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 8 } },
                "Every entrant sees this breakdown before they pay. Once the event is activated, it can never be changed \u2014 and settling the event will refuse any winner shares that don't add up to exactly the prize pool below."),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8], marginBottom: 8 } },
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Prize pool (%)"),
                    React.createElement("input", { type: "number", min: "0", max: "100", value: prizePoolPct, onChange: (e) => setPrizePoolPct(e.target.value), style: evInputStyle })),
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Guild's own share (%)"),
                    React.createElement("input", { type: "number", min: "0", max: "100", value: guildSharePct, onChange: (e) => setGuildSharePct(e.target.value), style: evInputStyle }))),
            React.createElement("div", { style: { marginBottom: 8 } },
                React.createElement("label", { style: evLabelStyle }, "Other agreed allocations \u2014 e.g. judges, charity, co-host"),
                otherAllocRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                    React.createElement("input", {
                        placeholder: "Label (e.g. Judges' honorarium)", value: row.label, style: { ...evInputStyle, flex: 2 },
                        onChange: (e) => setOtherAllocRows((rows) => rows.map((r, ri) => ri === i ? { ...r, label: e.target.value } : r)),
                    }),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 80 },
                        onChange: (e) => setOtherAllocRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                    }),
                    React.createElement("button", { onClick: () => setOtherAllocRows((rows) => rows.filter((_, ri) => ri !== i)), style: { ...evBtnStyle(false), padding: '4px 9px' } }, '\u2715'))),
                React.createElement("button", { onClick: () => setOtherAllocRows((rows) => [...rows, { label: '', sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add allocation')),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: Math.round(financialTotalPct * 100) === 10000 ? '#8FCB8F' : '#D98A8A' } },
                `${financialTotalPct}% allocated \u2014 must total 100%`)),

        // Live preview of the same Entry Fee \u2192 Inkroot Fee \u2192 Prize Pool \u2192 Guild
        // Share \u2192 Other Allocations flow an entrant and the pre-publish review both see \u2014
        // computed from this form's own current values plus the real, current platform fee (never
        // a guessed or hardcoded %), so what the organizer previews here is what actually applies.
        React.createElement(FinancialFlowDiagram, { breakdown: previewBreakdown, locked: false }),

        // Judging configuration \u2014 see 121_migration_guild_event_fair_judging.sql. Mandatory
        // for every host='guild' event regardless of type: activate_guild_event() refuses to
        // open the event for entries without a locked row here, giveaway and workshop included.
        React.createElement("div", { style: { background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
                React.createElement("div", { style: { ...evLabelStyle, marginBottom: 0 } }, "Configure judging \u2014 locked once this event opens for entries"),
                objectiveLocked && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], fontWeight: 600, color: '#8FCB8F' } }, 'Locked')),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 8 } },
                "Placements are computed, not declared \u2014 nobody on this guild's side hand-picks a winner. Whatever weight isn't covered by the metric below goes to a panel of 3\u20135 verified authors from outside this guild, assigned automatically when the event opens, scoring each entry blind (\"Entry 1\", \"Entry 2\"\u2026 \u2014 never a name)."),
            (fields.eventType === 'giveaway' || fields.eventType === 'workshop') && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#C89B3C', marginBottom: 8, fontStyle: 'italic' } },
                `Heads up: there's no random-draw mechanic \u2014 this is the same scored-submission system every event type uses. A ${EVENT_TYPE_LABELS[fields.eventType].toLowerCase()} still needs entrants to submit something and judges/metric to score it before placements can be computed.`),
            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: SPACE_SCALE[8], marginBottom: 8 } },
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Objective metric"),
                    React.createElement("select", { value: objectiveMetric, disabled: objectiveLocked, onChange: handleMetricChange, style: evInputStyle },
                        Object.entries(OBJECTIVE_METRIC_LABELS).map(([v, label]) => React.createElement("option", { key: v, value: v }, label)))),
                React.createElement("div", null,
                    React.createElement("label", { style: evLabelStyle }, "Objective weight (%)"),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", value: objectiveWeightPct,
                        disabled: objectiveLocked || objectiveMetric === 'none',
                        onChange: (e) => setObjectiveWeightPct(e.target.value), style: evInputStyle,
                    }))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 8 } },
                Number(objectiveWeightPct) >= 100
                    ? 'Pure objective \u2014 no judge panel needed.'
                    : Number(objectiveWeightPct) <= 0
                        ? 'Pure judge panel \u2014 every entry is scored blind, 0\u2013100, by 3\u20135 assigned judges.'
                        : `${objectiveWeightPct}% from the metric above, ${100 - Number(objectiveWeightPct)}% from the judge panel's blind scores.`),
            React.createElement("div", { style: { marginBottom: 8 } },
                React.createElement("label", { style: evLabelStyle }, "Placement split \u2014 how the prize pool is divided once placements are computed (must total 100%)"),
                placementSplitRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                    React.createElement("input", {
                        type: "number", min: "1", placeholder: "Place", value: row.place, disabled: objectiveLocked, style: { ...evInputStyle, width: 90 },
                        onChange: (e) => setPlacementSplitRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                    }),
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", placeholder: "Share %", value: row.sharePct, disabled: objectiveLocked, style: { ...evInputStyle, width: 100 },
                        onChange: (e) => setPlacementSplitRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                    }),
                    !objectiveLocked && React.createElement("button", { onClick: () => setPlacementSplitRows((rows) => rows.filter((_, ri) => ri !== i)), style: { ...evBtnStyle(false), padding: '4px 9px' } }, '\u2715'))),
                !objectiveLocked && React.createElement("button", { onClick: () => setPlacementSplitRows((rows) => [...rows, { place: String(rows.length + 1), sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add place')),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: Math.round(placementSplitTotalPct * 100) === 10000 ? '#8FCB8F' : '#D98A8A' } },
                `${placementSplitTotalPct}% allocated \u2014 must total 100%`)),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, "Prize structure \u2014 how the prize pool above is split by placement, e.g. 1st/2nd/3rd (a guide for declaring winners, not separately enforced)"),
            prizeRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                React.createElement("input", {
                    type: "number", min: "1", placeholder: "Place", value: row.place, style: { ...evInputStyle, width: 90 },
                    onChange: (e) => setPrizeRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                }),
                React.createElement("input", {
                    type: "number", min: "0", max: "100", placeholder: "Share %", value: row.sharePct, style: { ...evInputStyle, width: 100 },
                    onChange: (e) => setPrizeRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                }))),
            React.createElement("button", { onClick: () => setPrizeRows((rows) => [...rows, { place: String(rows.length + 1), sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add place')),

        React.createElement("div", null,
            React.createElement("label", { style: evLabelStyle }, 'Cover / banner'),
            fields.coverImageUrl && React.createElement("img", { src: fields.coverImageUrl, alt: "", style: { width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], marginBottom: 6 } }),
            React.createElement("input", { type: "file", accept: "image/*", onChange: handleCoverFile, disabled: coverUploading, style: { fontSize: TYPE_SCALE[11], color: '#8A8680' } }),
            coverUploading && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 4 } }, 'Uploading\u2026')),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11] } }, error),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("button", { disabled: busy, onClick: handleSubmit, style: { ...evBtnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : (initial ? 'Save draft' : 'Create draft')),
            React.createElement("button", { onClick: onCancel, style: evBtnStyle(false) }, 'Cancel')));
}

// One event's full display + lifecycle controls, shared between GoGuildEventsPanel (a guild's
// own Treasury tab) and the Inkroot Admin screen (src/admin/inkroot-events-admin.jsx). isOwner
// here means "authorized to manage THIS specific event" — see the original comment on why that's
// computed per-event rather than just "is a guild owner" in general. Everything that actually
// moves money or changes approval_status — enterGuildEvent, settleGuildEvent,
// submitGuildEventForApproval, approveGuildEvent, etc. — is a request to a server RPC or edge
// function that re-derives and re-checks every fact itself; nothing here is trusted client-side.
// See 42_migration_guild_events.sql and 45_migration_guild_event_creation_workflow.sql.
function breakdownRow(label, value, opts = {}) {
    return React.createElement("div", { key: label, style: { display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: opts.last ? 'none' : '1px solid #24242A' } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: opts.muted ? '#7A7A82' : '#B5B0A5' } }, label),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: opts.highlight ? '#E8C468' : '#EFE7D2', fontWeight: opts.highlight ? 600 : 400 } }, value));
}

// The one place the Entry Fee \u2192 Inkroot Fee \u2192 Prize Pool \u2192 Guild Share \u2192 Other
// Allocations flow is actually drawn \u2014 shared by the organizer's live create/edit preview,
// the pre-publish review, and the entrant/read-only view post-activation, so the ordering and
// the numbers behind it can never drift between those three places. `breakdown` is always the
// output of computeEntryFinancialBreakdown (lib/guild-events.js) \u2014 this component only ever
// arranges numbers that file already computed, it never computes one itself. `locked` mirrors
// the financial agreement's own `locked` column (true from the moment activateGuildEvent runs,
// per 48_migration_guild_event_financial_agreement.sql) \u2014 not a guess made here.
function FinancialFlowDiagram({ breakdown, locked }) {
    if (!breakdown) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic' } },
            'Set an entry fee and a prize pool / guild share split above to see where the money goes.');
    }
    const steps = [
        { label: 'Entry Fee', value: formatNaira(breakdown.entryFeeKobo / 100) },
        { label: 'Inkroot Fee', value: `\u2212 ${formatNaira(breakdown.platformFeeKobo / 100)}` },
        { label: 'Prize Pool', value: formatNaira(breakdown.prizePoolKobo / 100), highlight: true },
        { label: 'Guild Share', value: formatNaira(breakdown.guildShareKobo / 100) },
        ...breakdown.otherAllocations.map((a) => ({ label: `Other Allocation \u2014 ${a.label}`, value: formatNaira(a.kobo / 100) })),
    ];
    return React.createElement("div", { style: { background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
            React.createElement("div", { style: { ...evLabelStyle, marginBottom: 0 } }, 'Financial structure'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], fontWeight: 600, color: locked ? '#8FCB8F' : '#C89B3C' } },
                locked ? 'Locked' : 'Not yet locked')),
        steps.map((s, i) => React.createElement(React.Fragment, { key: s.label },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', padding: '4px 0' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: s.highlight ? '#E8C468' : '#B5B0A5' } }, s.label),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: s.highlight ? 600 : 400, color: s.highlight ? '#E8C468' : '#EFE7D2' } }, s.value)),
            i < steps.length - 1 && React.createElement("div", { style: { textAlign: 'center', color: '#4A4A50', fontSize: TYPE_SCALE[11], lineHeight: '14px' } }, '\u2193'))));
}

// The full financial picture a guild owner has to review — hosting fee, entry price, expected
// revenue, prize pool, guild share, and Inkroot's other applicable (per-entry) fee — before an
// approved event can be published. Every figure comes from a live read (current hosting fee
// rate, current platform fee %, this event's own submitted numbers) rather than anything
// hardcoded here — see 47_migration_guild_event_hosting_fee.sql on why the hosting fee in
// particular is configurable server-side, not a constant in this file. Publishing itself is
// still gated server-side too (publish_guild_event refuses without a successful payment row) —
// this panel disabling the button early is just so the owner isn't surprised by a server
// rejection after already trying to publish.
function HostingFeePanel({ event, onPublished }) {
    const [hostingFeeNaira, setHostingFeeNaira] = useState(null);
    const [agreement, setAgreement] = useState(null);
    const [paymentStatus, setPaymentStatus] = useState(undefined); // undefined = loading
    const [paying, setPaying] = useState(false);
    const [error, setError] = useState(null);
    // Required, explicit confirmation of the financial structure before Publish is even
    // clickable \u2014 purely a client-side gate on top of what publish_guild_event() already
    // refuses server-side (no successful hosting-fee payment row); this is the organizer
    // actively acknowledging the split, not a new permission check.
    const [confirmed, setConfirmed] = useState(false);

    const loadFeeInfo = () => {
        Promise.all([
            fetchCurrentGuildEventHostingFeeNaira(),
            fetchGuildEventFinancialAgreement(event.id),
            fetchGuildEventHostingFeeStatus(event.id),
        ]).then(([fee, agr, status]) => {
            setHostingFeeNaira(fee);
            setAgreement(agr);
            setPaymentStatus(status);
        }).catch((e) => setError(e.message || 'Could not load hosting fee details.'));
    };
    useEffect(loadFeeInfo, [event.id]);

    const handlePay = async () => {
        setPaying(true);
        setError(null);
        try {
            const status = await payGuildEventHostingFee(event.id);
            if (status === 'failed') setError('Payment did not go through.');
            loadFeeInfo();
        } catch (e) {
            setError(e.message || 'Could not start checkout.');
        } finally {
            setPaying(false);
        }
    };

    if (hostingFeeNaira === null || paymentStatus === undefined) {
        return React.createElement("div", { style: { marginTop: 12, fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, error || 'Loading hosting fee details\u2026');
    }

    const entryPriceKobo = Math.round((event.entryFeeNaira || 0) * 100);
    const breakdown = computeEntryFinancialBreakdown(entryPriceKobo, agreement);
    const paid = paymentStatus && paymentStatus.status === 'success';
    const canPublish = paid && confirmed && !!breakdown;

    return React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 } }, 'Review before publishing'),
        breakdownRow('Hosting fee (Inkroot, one-time)', formatNaira(hostingFeeNaira), { highlight: true }),

        !breakdown
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 8 } }, 'Financial agreement not set \u2014 go back and finish the financial agreement section.')
            : React.createElement(React.Fragment, null,
                React.createElement(FinancialFlowDiagram, { breakdown, locked: !!agreement.locked }),
                event.participant_limit && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 6 } },
                    `Prize pool above is per entrant \u2014 up to ${event.participant_limit} entries.`)),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        // ---------- Required confirmation before publishing ----------
        // Publish stays disabled until the organizer explicitly ticks this \u2014 acknowledging
        // the exact split shown above \u2014 on top of the hosting-fee payment itself.
        breakdown && React.createElement("label", { style: { display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[6], marginTop: 12, fontSize: TYPE_SCALE[11], color: '#B5B0A5', cursor: 'pointer' } },
            React.createElement("input", { type: "checkbox", checked: confirmed, onChange: (e) => setConfirmed(e.target.checked), style: { marginTop: 2 } }),
            React.createElement("span", null, 'I confirm this financial structure \u2014 the entry fee, Inkroot fee, prize pool, guild share, and any other allocations shown above. Once this event is activated, the split can never be changed.')),

        paymentStatus && paymentStatus.status === 'pending' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C89B3C', marginTop: 8 } }, 'Payment pending\u2026'),

        React.createElement("div", { style: { marginTop: 12 } },
            paid
                ? React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center', flexWrap: 'wrap' } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#8FCB8F' } }, '\u2713 Hosting fee paid'),
                    React.createElement("button", { disabled: !canPublish, onClick: onPublished, style: { ...evBtnStyle(true), opacity: canPublish ? 1 : 0.5 } }, 'Publish'))
                : React.createElement("button", { disabled: paying, onClick: handlePay, style: { ...evBtnStyle(true), opacity: paying ? 0.6 : 1 } },
                    paying ? '\u2026' : `Pay hosting fee \u2014 ${formatNaira(hostingFeeNaira)}`)));
}

// The public-facing version of the same breakdown \u2014 shown to ANY viewer (not just the
// owner) once an event is visible at all (published/active/completed; see fetchGuildEvents'
// includeAllStatuses filter for why a non-owner never sees a bare draft). This is what makes
// "show participants the money distribution before payment" real: it's rendered above the Enter
// button itself, sourced from the same locked guild_event_financial_agreements row
// settle_guild_event() enforces \u2014 never a client-side guess.
function EntryFinancialBreakdown({ event }) {
    const [agreement, setAgreement] = useState(undefined); // undefined = loading, null = none on file
    useEffect(() => {
        let cancelled = false;
        fetchGuildEventFinancialAgreement(event.id).then((a) => { if (!cancelled) setAgreement(a); }).catch(() => setAgreement(null));
        return () => { cancelled = true; };
    }, [event.id]);

    if (agreement === undefined) return null;
    const entryPriceKobo = Math.round((event.entryFeeNaira || 0) * 100);
    const breakdown = computeEntryFinancialBreakdown(entryPriceKobo, agreement);
    if (!breakdown) return null;

    // Once the event has begun (active/completed), the agreement's own `locked` column is
    // already true \u2014 activateGuildEvent locks it server-side (48_migration_guild_event_
    // financial_agreement.sql). This just surfaces that real flag; it never decides locking
    // itself.
    return React.createElement("div", { style: { marginTop: 10, marginBottom: 10 } },
        React.createElement(FinancialFlowDiagram, { breakdown, locked: !!agreement.locked }));
}

export function EventCard({ event, isOwner, members, onChanged, onEdit, canApprove, myUserId, isAdmin }) {
    const [myEntry, setMyEntry] = useState(undefined); // undefined = loading, null = no entry
    const [entering, setEntering] = useState(false);
    const [error, setError] = useState(null);
    const [settling, setSettling] = useState(false);
    const [showSettle, setShowSettle] = useState(false);
    const [winnerRows, setWinnerRows] = useState([{ memberId: '', sharePct: '' }]);
    const [lifecycleBusy, setLifecycleBusy] = useState(false);
    const [entryCount, setEntryCount] = useState(null);
    const [settleAgreement, setSettleAgreement] = useState(null);

    // ---------- Guaranteed prize escrow (see 108_migration_guild_event_prize_escrow.sql) ----------
    // escrowStatus: undefined = loading/not applicable, null = declared but not yet deposited,
    // { depositedAt, amountNaira } once deposit_guild_event_prize_escrow has succeeded.
    const [escrowStatus, setEscrowStatus] = useState(undefined);
    const [depositingEscrow, setDepositingEscrow] = useState(false);
    const loadEscrowStatus = () => {
        if (event.host !== 'guild' || !event.guaranteedPrizeNaira) { setEscrowStatus(undefined); return; }
        fetchGuildEventEscrowStatus(event.guild_id, event.id).then(setEscrowStatus).catch(() => setEscrowStatus(null));
    };
    useEffect(loadEscrowStatus, [event.id, event.guaranteedPrizeNaira]);
    const handleDepositEscrow = async () => {
        setDepositingEscrow(true);
        setError(null);
        try {
            await depositGuildEventPrizeEscrow(event.guild_id, event.id);
            loadEscrowStatus();
        } catch (e) {
            setError(e.message || 'Could not deposit the guaranteed prize into escrow.');
        } finally {
            setDepositingEscrow(false);
        }
    };

    // ---------- Owner cancellation (see 108_migration_guild_event_prize_escrow.sql) ----------
    // Only succeeds server-side while no entrant has paid (or has a payment still in flight) and
    // the event isn't already settled/cancelled — this button is offered any time those two
    // aren't already visibly true, and lets the server's own refusal message explain the rest.
    const [showCancelConfirm, setShowCancelConfirm] = useState(false);
    const [cancelling, setCancelling] = useState(false);
    const handleCancelEvent = async () => {
        setCancelling(true);
        setError(null);
        try {
            await cancelGuildEvent(event.guild_id, event.id);
            setShowCancelConfirm(false);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not cancel this event.');
        } finally {
            setCancelling(false);
        }
    };

    // ---------- Inkroot-admin force-cancel for a genuine dispute ----------
    const [showAdminCancel, setShowAdminCancel] = useState(false);
    const [adminCancelReason, setAdminCancelReason] = useState('');
    const [adminCancelBusy, setAdminCancelBusy] = useState(false);
    const [adminCancelError, setAdminCancelError] = useState(null);
    const handleAdminCancel = async () => {
        if (!adminCancelReason.trim()) { setAdminCancelError('Give a reason for the record.'); return; }
        setAdminCancelBusy(true);
        setAdminCancelError(null);
        try {
            await adminCancelGuildEventDispute(event.id, adminCancelReason.trim());
            setShowAdminCancel(false);
            setAdminCancelReason('');
            onChanged();
        } catch (e) {
            setAdminCancelError(e.message || 'Could not cancel this event.');
        } finally {
            setAdminCancelBusy(false);
        }
    };

    // ---------- Guild Event results: organizer submission + required approval ----------
    // See 49_migration_guild_event_results_approval.sql. `results` is this event's current
    // proposal (undefined = loading, null = none submitted). isOrganizer/canApprove gate which
    // controls render; every write still re-derives and re-checks organizer/authority
    // server-side regardless of what this component believes.
    const [results, setResults] = useState(undefined);
    const [showSubmitResults, setShowSubmitResults] = useState(false);
    const [resultRows, setResultRows] = useState([{ place: '1', memberId: '', sharePct: '' }]);
    const [resultsBusy, setResultsBusy] = useState(false);
    const [resultsError, setResultsError] = useState(null);
    const [rejectReason, setRejectReason] = useState('');
    const [showReject, setShowReject] = useState(false);
    const isOrganizer = event.host === 'guild' && myUserId != null && event.organizer_id === myUserId;

    const loadResults = () => {
        if (event.host !== 'guild') return;
        fetchGuildEventResults(event.id).then(setResults).catch(() => setResults(null));
    };
    useEffect(() => {
        if (event.host !== 'guild' || !['completed', 'active'].includes(event.approval_status)) { setResults(null); return; }
        loadResults();
        /* eslint-disable-next-line react-hooks/exhaustive-deps */
    }, [event.id, event.approval_status]);

    // Prefills from the event's own (informational, unenforced) prize_structure the first time
    // the submit form is opened with nothing already proposed; otherwise reopens whatever was
    // last submitted (so revising after a rejection starts from the rejected proposal, not blank).
    const openSubmitResults = () => {
        if (results && results.placements && results.placements.length > 0) {
            setResultRows(results.placements.map((p) => ({ place: String(p.place || ''), memberId: p.contributorId || '', sharePct: p.sharePct != null ? String(p.sharePct) : '' })));
        } else if (event.prize_structure && event.prize_structure.length > 0) {
            setResultRows(event.prize_structure.map((p) => ({ place: String(p.place || ''), memberId: '', sharePct: p.share_pct != null ? String(p.share_pct) : '' })));
        } else {
            setResultRows([{ place: '1', memberId: '', sharePct: '' }]);
        }
        setResultsError(null);
        setShowSubmitResults(true);
    };

    const handleSubmitResults = async () => {
        const placements = resultRows
            .filter((r) => r.place && r.memberId && Number(r.sharePct) > 0)
            .map((r) => ({ contributorId: r.memberId, place: r.place, sharePct: r.sharePct }));
        if (placements.length === 0) { setResultsError('Add at least one winner.'); return; }
        setResultsBusy(true);
        setResultsError(null);
        try {
            const saved = await submitGuildEventResults(event.guild_id, event.id, placements);
            setResults(saved);
            setShowSubmitResults(false);
        } catch (e) {
            setResultsError(e.message || 'Could not submit these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    const handleApproveResults = async () => {
        setResultsBusy(true);
        setResultsError(null);
        try {
            await approveGuildEventResults(event.id);
            loadResults();
            onChanged();
        } catch (e) {
            setResultsError(e.message || 'Could not approve these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    const handleRejectResults = async () => {
        setResultsBusy(true);
        setResultsError(null);
        try {
            await rejectGuildEventResults(event.id, rejectReason);
            setShowReject(false);
            setRejectReason('');
            loadResults();
        } catch (e) {
            setResultsError(e.message || 'Could not reject these results.');
        } finally {
            setResultsBusy(false);
        }
    };

    // Loaded once settling starts, so the owner can see (and this component can enforce
    // client-side, matching what settle_guild_event() will enforce server-side regardless)
    // exactly what winner shares must add up to \u2014 the locked prize_pool_bps, not just "no
    // more than 100%". See 48_migration_guild_event_financial_agreement.sql.
    useEffect(() => {
        if (!showSettle || event.host !== 'guild') return;
        fetchGuildEventFinancialAgreement(event.id).then(setSettleAgreement).catch(() => setSettleAgreement(null));
    }, [showSettle, event.id, event.host]);

    useEffect(() => {
        // Also checked once 'completed' (not just 'active') so a refund landing after entries
        // closed \u2014 still possible, a Paystack dispute isn't tied to the event being open \u2014
        // is visible here too.
        if (event.host !== 'guild' || !['active', 'completed'].includes(event.approval_status)) return;
        fetchMyGuildEventEntry(event.id).then(setMyEntry).catch(() => setMyEntry(null));
    }, [event.id, event.approval_status]);

    // Live "X / limit entered" — only worth fetching when there's a limit to check against.
    // Anyone can call this (see 46_migration_guild_event_entry_count.sql), not just the owner.
    useEffect(() => {
        if (event.host !== 'guild' || event.participant_limit == null) return;
        fetchGuildEventEntryCount(event.id).then(setEntryCount).catch(() => {});
    }, [event.id, event.participant_limit, myEntry]);

    const handleEnter = async () => {
        setEntering(true);
        setError(null);
        try {
            const status = await enterGuildEvent(event.id);
            if (status === 'failed') setError('Payment did not go through.');
            else setMyEntry({ status });
        } catch (e) {
            setError(e.message || 'Could not start checkout.');
        } finally {
            setEntering(false);
        }
    };

    const handleClose = async () => {
        try { await closeGuildEvent(event.guild_id, event.id); onChanged(); } catch (e) { setError(e.message); }
    };

    const runLifecycle = async (fn) => {
        setLifecycleBusy(true);
        setError(null);
        try {
            await fn(event.guild_id, event.id);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not update this event.');
        } finally {
            setLifecycleBusy(false);
        }
    };

    const totalSharePct = winnerRows.reduce((s, r) => s + (Number(r.sharePct) || 0), 0);
    // For a host='guild' event, winner shares must add up to EXACTLY the locked prize pool
    // percentage \u2014 settle_guild_event() refuses anything else server-side (see the
    // migration). host='inkroot' has no agreement to match, so any total up to 100% is fine,
    // same as before this migration.
    const requiredSharePct = event.host === 'guild' && settleAgreement ? settleAgreement.prize_pool_bps / 100 : null;
    const shareTargetMet = requiredSharePct == null || Math.round(totalSharePct * 100) === Math.round(requiredSharePct * 100);
    const handleSettle = async () => {
        const shares = winnerRows
            .filter((r) => r.memberId && Number(r.sharePct) > 0)
            .map((r) => ({ contributorId: r.memberId, shareBps: Math.round(Number(r.sharePct) * 100) }));
        if (shares.length === 0) { setError('Add at least one winner.'); return; }
        if (!shareTargetMet) { setError(`Winner shares must add up to exactly ${requiredSharePct}% \u2014 the locked prize pool.`); return; }
        setSettling(true);
        setError(null);
        try {
            await settleGuildEvent(event.guild_id, event.id, shares);
            setShowSettle(false);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not settle this event.');
        } finally {
            setSettling(false);
        }
    };

    const approvalStatus = event.approval_status || (event.host === 'inkroot' ? 'active' : 'draft');
    const dateRange = [formatEventDate(event.start_date), formatEventDate(event.end_date)].filter(Boolean).join(' \u2014 ');

    // ---------- Entrant-facing state (Payment pending / Event full / Registration successful /
    // Refund / Event cancelled) ----------
    // One place these six states are decided, all from real fields already fetched above \u2014
    // myEntry.status comes straight from guild_event_entries (including 'refunded', which
    // paystack-webhook sets on a Paystack refund/dispute \u2014 see
    // 50_migration_economy_security_audit.sql), never guessed here.
    const isFull = event.participant_limit != null && entryCount != null && entryCount >= event.participant_limit;
    // 'cancelled' is not a value guild_events.status or approval_status can hold today \u2014 see
    // 45_migration_guild_event_creation_workflow.sql's own check constraint \u2014 so this branch
    // has no live path to it. It's kept, using the same string other status columns in this app
    // already use for the concept (e.g. guild_treasury_spend_requests.status), so the UI needs no
    // further changes the day a cancellation path is actually added server-side.
    let entryStateNode = null;
    if (event.status === 'cancelled') {
        entryStateNode = React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A' } },
            event.cancellation_reason ? `This event was cancelled: ${event.cancellation_reason}` : 'This event has been cancelled.');
    } else if (myEntry === undefined) {
        entryStateNode = null; // still loading
    } else if (myEntry && myEntry.status === 'success') {
        entryStateNode = React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FCB8F' } }, "\u2713 Registration successful \u2014 you're entered");
    } else if (myEntry && myEntry.status === 'refunded') {
        // Can arrive any time after a success \u2014 a Paystack refund or dispute isn't tied to
        // the event still being open \u2014 so this isn't gated on approvalStatus/event.status
        // the way the Enter button below is.
        entryStateNode = React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FB8CB' } }, '\u21ba Refunded \u2014 your entry fee was returned');
    } else if (myEntry && myEntry.status === 'pending') {
        // Production-readiness audit: a cancelled or abandoned checkout leaves the entry 'pending'
        // (nothing ever marks it failed), and this branch used to offer nothing but the text —
        // so the entrant could never pay again. While entries are still open, offer a retry;
        // create_guild_event_entry_locked (migration 104) re-uses this same pending entry for it.
        const canRetryEntry = approvalStatus === 'active' && event.status === 'open';
        entryStateNode = React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C' } }, 'Payment pending\u2026'),
            canRetryEntry && React.createElement("button", { disabled: entering, onClick: handleEnter, style: { ...evBtnStyle(true), opacity: entering ? 0.6 : 1 } }, entering ? '\u2026' : 'Try payment again'));
    } else if (approvalStatus === 'active' && event.status === 'open') {
        // No entry yet, or a previous attempt failed \u2014 either way, still enterable while
        // entries are actually open.
        entryStateNode = isFull
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, 'This event is full.')
            : React.createElement("button", { disabled: entering, onClick: handleEnter, style: { ...evBtnStyle(true), opacity: entering ? 0.6 : 1 } }, entering ? '\u2026' : `Enter \u2014 ${formatNaira(event.entryFeeNaira)}`);
    }

    const approvalColor = EVENT_APPROVAL_COLORS[approvalStatus] || '#C89B3C';
    return React.createElement("div", { id: `gev-event-${event.id}`, className: "gev-poster-card", style: { position: 'relative', background: 'linear-gradient(160deg,#201C15,#1B1B20 65%)', border: '1px solid rgba(232,196,104,0.22)', borderRadius: RADIUS_SCALE[13], padding: '16px 15px 14px', marginBottom: 10 } },
        React.createElement("style", null, `
            /* An official-notice seal on every organizer-facing event card too, so the guild's own
               management view reads as the same herald posting a reader sees, not a plain admin
               row \u2014 see guild-event-detail-screen.jsx's .ged-seal for the reader-facing twin. */
            .gev-seal-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 9px 3px 7px;border-radius:100px;font-size:9.5px;text-transform:uppercase;letter-spacing:0.06em;white-space:nowrap;flex-shrink:0;}
        `),
        event.cover_image_url && React.createElement("img", { src: event.cover_image_url, alt: "", style: { width: '100%', maxHeight: 140, objectFit: 'cover', borderRadius: RADIUS_SCALE[8], marginBottom: 10 } }),

        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600 } }, event.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 3 } },
                    event.host === 'inkroot' ? `Inkroot cash prize \u2014 ${formatNaira(event.cashPrizeNaira)}` : `Entry fee \u2014 ${formatNaira(event.entryFeeNaira)}`),
                event.event_type && React.createElement(EventTypeBadge, { eventType: event.event_type }),
                dateRange && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 2 } }, dateRange),
                event.participant_limit && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: entryCount != null && entryCount >= event.participant_limit ? '#D98A8A' : '#5C5C64', marginTop: 2 } },
                    entryCount != null ? `${entryCount} / ${event.participant_limit} entered${entryCount >= event.participant_limit ? ' \u2014 full' : ''}` : `Limit \u2014 ${event.participant_limit} participants`)),
            React.createElement("div", { className: "gev-seal-badge", style: { color: approvalColor, background: `${approvalColor}1A`, border: `1px solid ${approvalColor}55` } },
                "\u2696\uFE0F", EVENT_APPROVAL_LABELS[approvalStatus] || approvalStatus)),

        event.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginTop: 8, whiteSpace: 'pre-wrap' } }, event.description),
        event.rules && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 6, whiteSpace: 'pre-wrap' } }, `Rules: ${event.rules}`),

        approvalStatus === 'rejected' && event.rejection_reason && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 8, fontStyle: 'italic' } }, `Rejected \u2014 ${event.rejection_reason}`),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        // ---------- Reader-facing entry (only once the event is genuinely open) ----------
        // The money breakdown is shown to every visible guild-hosted event, not just while it's
        // open for entries \u2014 someone deciding whether to wait for activation should be able
        // to see the same locked commitment a currently-active event's entrants see.
        event.host === 'guild' && React.createElement(EntryFinancialBreakdown, { event }),

        // ---------- Guaranteed prize escrow ----------
        // Visible to every viewer once an organizer has declared one (it's a promise being made
        // to entrants, same as the financial breakdown above); the deposit control itself is
        // owner-only, and only useful before the event is actually activated.
        event.host === 'guild' && event.guaranteedPrizeNaira && React.createElement("div", { style: { marginTop: 10, marginBottom: 10, padding: '8px 10px', background: '#16161A', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8] } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#E8C468', fontWeight: 600 } }, `\uD83D\uDD12 Guaranteed prize \u2014 ${formatNaira(event.guaranteedPrizeNaira)}`),
            isOwner && escrowStatus !== undefined && React.createElement("div", { style: { marginTop: 6 } },
                escrowStatus
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#8FCB8F' } },
                        `\u2713 Escrowed${formatEventDate(escrowStatus.depositedAt) ? ` \u2014 ${formatEventDate(escrowStatus.depositedAt)}` : ''}`)
                    : ['draft', 'pending_approval', 'approved', 'published'].includes(approvalStatus)
                        ? React.createElement("button", { disabled: depositingEscrow, onClick: handleDepositEscrow, style: { ...evBtnStyle(true), opacity: depositingEscrow ? 0.5 : 1 } },
                            depositingEscrow ? '\u2026' : `Deposit ${formatNaira(event.guaranteedPrizeNaira)} into escrow`)
                        : React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#D98A8A' } }, 'Not escrowed \u2014 this event cannot open for entries until it is.'))),

        // Event completed \u2014 shown to every viewer once entries have stopped, distinct from
        // the approval-status badge above (which already says "Completed") in that this tells a
        // reader specifically whether payouts have happened yet.
        event.host === 'guild' && approvalStatus === 'completed' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FCB8F', marginTop: 10 } },
            event.status === 'settled' ? 'Event completed \u2014 prizes have been paid out.' : 'Event completed \u2014 awaiting prize settlement.'),

        event.host === 'guild' && ['active', 'completed'].includes(approvalStatus) && entryStateNode && React.createElement("div", { style: { marginTop: 10 } }, entryStateNode),

        // ---------- Entrant submission / progress / results page (see
        // guild-event-submission-panel.jsx and guild-event-reading-challenge-panel.jsx for what
        // each renders and the results-reveal gap both carry — RLS on guild_event_results has no
        // entrant read policy yet, so the placement reveal inside these only lights up for
        // someone RLS does let read that row today). Reading Challenge gets the lighter
        // mark-complete page per the design brief; every other guild-hosted type gets the full
        // submission page. Only rendered once there's an actual paid entry to attach it to. ----------
        event.host === 'guild' && myEntry && myEntry.status === 'success' && ['active', 'completed'].includes(approvalStatus)
            && (event.event_type === 'reading_challenge'
                ? React.createElement(GuildEventReadingChallengePanel, { event, myUserId, hasPaidEntry: true })
                : React.createElement(GuildEventSubmissionPanel, { event, myUserId, hasPaidEntry: true })),

        // ---------- Owner cancellation ----------
        // Offered any time the event isn't already settled/cancelled; the server is the one that
        // actually refuses once a paid (or still-processing) entrant exists, so this doesn't try
        // to duplicate that check client-side.
        isOwner && event.host === 'guild' && event.status !== 'settled' && event.status !== 'cancelled' && React.createElement("div", { style: { marginTop: 12 } },
            !showCancelConfirm
                ? React.createElement("button", { onClick: () => setShowCancelConfirm(true), style: { ...evBtnStyle(false), color: '#D98A8A', borderColor: 'rgba(217,138,138,0.4)' } }, 'Cancel event')
                : React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginBottom: 6 } },
                        'Cancel this event? This only works while no one has paid to enter yet \u2014 any escrowed prize is released back to the guild treasury.'),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                        React.createElement("button", { disabled: cancelling, onClick: handleCancelEvent, style: { ...evBtnStyle(true), opacity: cancelling ? 0.5 : 1 } }, cancelling ? '\u2026' : 'Yes, cancel it'),
                        React.createElement("button", { onClick: () => setShowCancelConfirm(false), style: evBtnStyle(false) }, 'Never mind')))),

        // ---------- Inkroot-admin force-cancel (genuine dispute only) ----------
        isAdmin && event.status !== 'settled' && event.status !== 'cancelled' && React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
            !showAdminCancel
                ? React.createElement("button", { onClick: () => setShowAdminCancel(true), style: { ...evBtnStyle(false), color: '#D98A8A', borderColor: 'rgba(217,138,138,0.4)' } }, 'Force-cancel (dispute)')
                : React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 6 } },
                        'This does not refund any entrant automatically \u2014 process real refunds in Paystack by hand afterward.'),
                    React.createElement("textarea", { value: adminCancelReason, onChange: (e) => setAdminCancelReason(e.target.value), rows: 2, placeholder: "Reason for the dispute cancellation", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } }),
                    adminCancelError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 6 } }, adminCancelError),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 8 } },
                        React.createElement("button", { disabled: adminCancelBusy, onClick: handleAdminCancel, style: { ...evBtnStyle(true), opacity: adminCancelBusy ? 0.5 : 1 } }, adminCancelBusy ? '\u2026' : 'Force-cancel this event'),
                        React.createElement("button", { onClick: () => setShowAdminCancel(false), style: evBtnStyle(false) }, 'Never mind')))),

        // ---------- Owner lifecycle controls ----------
        isOwner && (approvalStatus === 'draft' || approvalStatus === 'rejected') && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { onClick: () => onEdit(event), style: evBtnStyle(false) }, approvalStatus === 'rejected' ? 'Edit & resubmit' : 'Edit'),
            React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => submitGuildEventForApproval(gId, eId)), style: { ...evBtnStyle(true), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Submit for review')),

        isOwner && approvalStatus === 'pending_approval' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic', marginTop: 10 } }, 'Waiting on Inkroot to review this submission.'),

        isOwner && approvalStatus === 'approved' && event.host === 'guild' && React.createElement(HostingFeePanel, { event, onPublished: () => runLifecycle((gId, eId) => publishGuildEvent(gId, eId)) }),

        isOwner && approvalStatus === 'published' && React.createElement("div", { style: { marginTop: 12 } },
            React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => activateGuildEvent(gId, eId)), style: { ...evBtnStyle(true), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Activate \u2014 open for entries')),

        isOwner && event.host === 'guild' && approvalStatus === 'active' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            event.status === 'open' && React.createElement("button", { onClick: handleClose, style: evBtnStyle(false) }, 'Close entries'),
            React.createElement("button", { disabled: lifecycleBusy, onClick: () => runLifecycle((gId, eId) => completeGuildEvent(gId, eId)), style: { ...evBtnStyle(false), opacity: lifecycleBusy ? 0.5 : 1 } }, lifecycleBusy ? '\u2026' : 'Mark completed')),

        // Migration 120: settle_guild_event() no longer accepts a direct authenticated call for
        // host='guild' events (see that migration's header) — settlement now only happens
        // through submit_guild_event_results()/approve_guild_event_results() below, which keeps
        // the organizer-submits/a-different-authority-approves separation the app already relies
        // on. This direct "Declare winners…" control would just fail server-side now, so it's
        // restricted to host='inkroot' (unchanged from before this migration).
        isOwner && event.host === 'inkroot' && ['active', 'completed'].includes(approvalStatus) && event.status !== 'settled' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { onClick: () => setShowSettle((v) => !v), style: evBtnStyle(false) }, showSettle ? 'Cancel' : 'Declare winners \u2026')),

        isOwner && showSettle && React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
            winnerRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                React.createElement("select", {
                    value: row.memberId, style: { ...evInputStyle, flex: 2 },
                    onChange: (e) => setWinnerRows((rows) => rows.map((r, ri) => ri === i ? { ...r, memberId: e.target.value } : r)),
                },
                    React.createElement("option", { value: "" }, 'Choose a member\u2026'),
                    members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id))),
                React.createElement("input", {
                    type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 70 },
                    onChange: (e) => setWinnerRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                }))),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center', marginTop: 4, flexWrap: 'wrap' } },
                React.createElement("button", { onClick: () => setWinnerRows((rows) => [...rows, { memberId: '', sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add winner'),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: shareTargetMet ? '#5C5C64' : '#D98A8A' } },
                    requiredSharePct != null ? `${totalSharePct}% allocated \u2014 must total exactly ${requiredSharePct}% (the locked prize pool)` : `${totalSharePct}% allocated`)),
            React.createElement("button", { disabled: settling || !shareTargetMet, onClick: handleSettle, style: { ...evBtnStyle(true), marginTop: 10, opacity: (settling || !shareTargetMet) ? 0.5 : 1 } }, settling ? 'Settling\u2026' : 'Settle & pay winners')),

        // ---------- Organizer results submission ----------
        // A second, delegated path onto the same settlement: the event's own organizer proposes
        // placements once it's completed, instead of (or alongside) the guild owner declaring
        // winners directly above. Nothing is paid out here \u2014 see the approval panel below
        // for the step that actually moves money.
        isOrganizer && approvalStatus === 'completed' && event.status !== 'settled' && (!results || results.status !== 'approved')
            && React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
                results && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: RESULTS_STATUS_COLORS[results.status], marginBottom: 8 } },
                    `Results ${RESULTS_STATUS_LABELS[results.status] || results.status}`),
                results && results.status === 'rejected' && results.rejection_reason && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginBottom: 8, fontStyle: 'italic' } }, `Reason: ${results.rejection_reason}`),
                !showSubmitResults && React.createElement("button", { onClick: openSubmitResults, style: evBtnStyle(false) },
                    !results ? 'Submit results \u2026' : results.status === 'rejected' ? 'Revise & resubmit \u2026' : 'Edit submission \u2026'),
                showSubmitResults && React.createElement("div", { style: { marginTop: 10 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 8 } },
                        'This only proposes a payout \u2014 a guild leader, treasurer, or officer (other than you) must approve it before winners are actually paid.'),
                    resultRows.map((row, i) => React.createElement("div", { key: i, style: { display: 'flex', gap: SPACE_SCALE[6], marginBottom: 6 } },
                        React.createElement("input", {
                            type: "number", min: "1", placeholder: "Place", value: row.place, style: { ...evInputStyle, width: 70 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, place: e.target.value } : r)),
                        }),
                        React.createElement("select", {
                            value: row.memberId, style: { ...evInputStyle, flex: 2 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, memberId: e.target.value } : r)),
                        },
                            React.createElement("option", { value: "" }, 'Choose a member\u2026'),
                            members.map((m) => React.createElement("option", { key: m.user_id, value: m.user_id }, m.name || m.user_id))),
                        React.createElement("input", {
                            type: "number", min: "0", max: "100", placeholder: "%", value: row.sharePct, style: { ...evInputStyle, width: 70 },
                            onChange: (e) => setResultRows((rows) => rows.map((r, ri) => ri === i ? { ...r, sharePct: e.target.value } : r)),
                        }))),
                    React.createElement("button", { onClick: () => setResultRows((rows) => [...rows, { place: String(rows.length + 1), memberId: '', sharePct: '' }]), style: { ...evBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '4px 9px' } }, '+ Add place'),
                    resultsError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, resultsError),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 10 } },
                        React.createElement("button", { disabled: resultsBusy, onClick: handleSubmitResults, style: { ...evBtnStyle(true), opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Submit for approval'),
                        React.createElement("button", { onClick: () => setShowSubmitResults(false), style: evBtnStyle(false) }, 'Cancel')))),

        // ---------- Reviewer approval ----------
        // Only rendered for an authorized guild role, and never lets that same person approve
        // their own submission \u2014 approve_guild_event_results()/reject_guild_event_results()
        // refuse that server-side regardless, this just avoids showing buttons that would fail.
        canApprove && results && results.status === 'pending_approval' && React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7A82', marginBottom: 8 } }, 'Proposed results \u2014 awaiting approval'),
            results.placements.map((p, i) => React.createElement("div", { key: i, style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginBottom: 3 } },
                `#${p.place} \u2014 ${(members.find((m) => m.user_id === p.contributorId) || {}).name || p.contributorId} \u2014 ${p.sharePct}%`)),
            resultsError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, resultsError),
            myUserId != null && myUserId === results.submitted_by
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic', marginTop: 8 } }, "You submitted these results \u2014 another guild leader, treasurer, or officer needs to approve them.")
                : React.createElement("div", { style: { marginTop: 8 } },
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                        React.createElement("button", { disabled: resultsBusy, onClick: handleApproveResults, style: { ...evBtnStyle(true), opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Approve & pay winners'),
                        React.createElement("button", { disabled: resultsBusy, onClick: () => setShowReject((v) => !v), style: evBtnStyle(false) }, showReject ? 'Cancel' : 'Reject')),
                    showReject && React.createElement("div", { style: { marginTop: 8 } },
                        React.createElement("textarea", { value: rejectReason, onChange: (e) => setRejectReason(e.target.value), rows: 2, placeholder: "Why are these results being sent back?", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' } }),
                        React.createElement("button", { disabled: resultsBusy, onClick: handleRejectResults, style: { ...evBtnStyle(false), marginTop: 6, opacity: resultsBusy ? 0.5 : 1 } }, resultsBusy ? '\u2026' : 'Send back for revision')))));
}

// Guild Events — see 42_migration_guild_events.sql for entries/settlement and
// 45_migration_guild_event_creation_workflow.sql for the creation/approval pipeline. Every
// credit a settled event produces lands in the same Guild Treasury an Anthology sale does (Guild
// Member Earnings shows it the same way, under "Earnings by project"); this panel is only about
// creating/entering/settling events, not about displaying balances a second time.
export function GoGuildEventsPanel({ guildId, isOwner }) {
    const [events, setEvents] = useState([]);
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [showForm, setShowForm] = useState(false);
    const [editingEvent, setEditingEvent] = useState(null); // null = creating new, else the draft/rejected event being edited

    // Guild Treasury role (Leader/Treasurer/Officer/Member — see
    // 44_migration_guild_treasury_roles_and_approvals.sql) and the signed-in user's own id, both
    // needed to gate the results-approval controls in EventCard the same way GoTreasuryTabReal
    // already gates its own spend-approval controls: canApprove mirrors that component's
    // `canManage`, and myUserId is what lets EventCard tell "I'm the organizer who submitted
    // this" apart from "I'm a different authorized approver".
    const [role, setRole] = useState(null);
    const [myUserId, setMyUserId] = useState(null);
    const canApprove = isOwner || role === 'treasurer' || role === 'officer';
    // fetchPendingGuildEventResults was defined (migration 49) but never called from anywhere —
    // an approver had to open each event's own card to discover whether it had results awaiting
    // review. This surfaces that same query as a jump-to-it banner instead.
    const [pendingResults, setPendingResults] = useState([]);

    const load = () => {
        Promise.all([fetchGuildEvents(guildId, { includeAllStatuses: isOwner }), fetchPlayerGuildMembers(guildId)])
            .then(([evts, mems]) => { setEvents(evts); setMembers(mems); setLoading(false); })
            .catch((e) => { setError(e.message || 'Could not open guild events.'); setLoading(false); });
        fetchGuildTreasuryRole(guildId).then((r) => {
            setRole(r);
            if (isOwner || r === 'treasurer' || r === 'officer')
                fetchPendingGuildEventResults(guildId).then(setPendingResults).catch(() => setPendingResults([]));
        }).catch(() => {});
        currentUser().then((u) => setMyUserId(u ? u.id : null)).catch(() => {});
    };
    useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [guildId]);

    const openCreate = () => { setEditingEvent(null); setShowForm(true); };
    const openEdit = (event) => { setEditingEvent(event); setShowForm(true); };
    const closeForm = () => { setShowForm(false); setEditingEvent(null); };

    const handleSaveForm = async (fields) => {
        const { financial, judging, ...eventFields } = fields;
        const event = editingEvent
            ? await updateGuildEventDraft(guildId, editingEvent.id, eventFields)
            : await createGuildEventDraft(guildId, eventFields);
        // The financial agreement is proposed as its own call right after the event itself is
        // saved — see 48_migration_guild_event_financial_agreement.sql. platformFeeBps is read
        // fresh here (not cached) so the snapshot recorded always reflects Inkroot's real,
        // current per-entry cut at the moment this draft was actually saved.
        const platformFeePct = await fetchPlatformFeePct();
        await proposeGuildEventFinancialAgreement(guildId, event.id, { ...financial, platformFeeBps: platformFeePct * 100 });
        // Same pattern for the judging configuration — see
        // 121_migration_guild_event_fair_judging.sql. Without this, activateGuildEvent will
        // refuse the event with "no judging configuration on file" once the owner tries to open
        // it for entries.
        await proposeGuildEventObjectiveConfig(guildId, event.id, judging);
        closeForm();
        load();
    };

    if (loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '16px 10px' } }, "Opening guild events\u2026");
    }

    return React.createElement("div", { style: { marginTop: 8, paddingTop: 20, borderTop: '1px solid #2A2A30', marginBottom: 8 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Guild Events'),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10, textAlign: 'center' } }, error),

        pendingResults.length > 0 && React.createElement("div", { style: { background: 'rgba(200,155,60,0.1)', border: '1px solid rgba(200,155,60,0.35)', borderRadius: RADIUS_SCALE[10], padding: '10px 14px', marginBottom: 14 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], fontWeight: 700, color: '#C89B3C', marginBottom: 6 } },
                `${pendingResults.length} result${pendingResults.length === 1 ? '' : 's'} awaiting your review`),
            pendingResults.map((r) => {
                const ev = events.find((e) => e.id === r.event_id);
                return React.createElement("button", {
                    key: r.id,
                    onClick: () => { const el = document.getElementById(`gev-event-${r.event_id}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
                    style: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: '#E8C468', fontSize: TYPE_SCALE[11.5], padding: '3px 0', cursor: 'pointer' },
                }, `\u2192 ${(ev && ev.title) || 'A guild event'}`);
            })),

        events.length === 0 && !showForm
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No guild events yet.')
            : events.map((ev) => React.createElement(EventCard, { key: ev.id, event: ev, isOwner: isOwner && ev.host === 'guild', members, onChanged: load, onEdit: openEdit, canApprove: canApprove && ev.host === 'guild', myUserId })),

        isOwner && React.createElement("div", { style: { marginTop: 12 } },
            !showForm && React.createElement("button", { onClick: openCreate, style: evBtnStyle(false) }, '+ Host a guild event'),
            showForm && React.createElement(GuildEventForm, { members, initial: editingEvent, onCancel: closeForm, onSave: handleSaveForm })),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 14, fontStyle: 'italic' } }, "Inkroot-hosted cash-prize events, if any, show up here too \u2014 those are created and settled by Inkroot directly."));
}
