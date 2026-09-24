import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchGuildEventResults, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { evBtnStyle, OBJECTIVE_METRIC_LABELS } from './guild-events-panel.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

function daysUntil(dateStr) {
    if (!dateStr) return null;
    const ms = new Date(dateStr).getTime() - Date.now();
    return Math.ceil(ms / (24 * 60 * 60 * 1000));
}

function formatDate(dateStr) {
    if (!dateStr) return null;
    try { return new Date(dateStr).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return null; }
}

// Entrant-facing reading-challenge panel — see 121_migration_guild_event_fair_judging.sql and
// the design brief's own note that a reading challenge is lighter-weight than a
// tournament/writing-contest entry: a single "Mark complete" action instead of a manuscript
// field, progress against the event's end date, no scoring UI (an entrant never sees judge
// scoring in either page — that's guild-event-submission-panel.jsx's twin, not this one).
//
// Under the hood this still calls submit_guild_event_submission() — the same RPC the
// tournament/writing-contest page uses — because that's the only thing that records a
// submitted_at timestamp for the 'on_time_completion' objective metric to score against
// (compute_guild_event_placements(): on-time = submitted_at <= event.end_date, scored 100,
// otherwise 0). title is left null and content is left null; word_count is sent as 0. None of
// those three matter for a reading challenge's own scoring — only that a row exists and when it
// landed — so nothing is asked of the entrant beyond the one button.
//
// Same KNOWN GAP as guild-event-submission-panel.jsx: guild_event_results has no entrant-facing
// RLS read policy today, so a real entrant's own placement reveal below only ever populates for
// someone RLS happens to let read that row (organizer / treasury authority) — see that file's
// header comment for the full explanation. Nothing here papers over it.
export function GuildEventReadingChallengePanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined); // undefined = loading, null = none on file
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = not yet
    const [results, setResults] = useState(undefined);
    const [marking, setMarking] = useState(false);
    const [error, setError] = useState(null);

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then(setSubmission).catch(() => setSubmission(null));
        // See the KNOWN GAP note above — this can come back null for a real entrant even once
        // placements exist. Never treated here as proof nothing has been computed.
        fetchGuildEventResults(event.id).then(setResults).catch(() => setResults(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const remaining = daysUntil(event.end_date);
    const deadlinePassed = remaining != null && remaining < 0;

    const handleMarkComplete = async () => {
        setMarking(true);
        setError(null);
        try {
            await submitGuildEventSubmission(event.id, { title: null, wordCount: 0, content: null });
            load();
        } catch (e) {
            setError(e.message || 'Could not mark this complete.');
        } finally {
            setMarking(false);
        }
    };

    // ---------- Status strip: Not started / Completed / Judging in progress / Placements computed ----------
    let statusNode = null;
    if (approvalStatus === 'active') {
        statusNode = submission
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FCB8F' } },
                `\u2713 Marked complete${submission.submitted_at ? ` \u2014 ${formatDate(submission.submitted_at)}` : ''}`)
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C' } }, 'Not yet marked complete');
    } else if (approvalStatus === 'completed') {
        const computed = results && (results.status === 'computed' || results.status === 'approved');
        statusNode = computed
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#E8C468', fontWeight: 600 } }, '\u2696\uFE0F Placements computed')
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FB8CB' } }, 'Judging in progress\u2026');
    }

    // ---------- Results reveal (subject to the KNOWN GAP above) ----------
    const myPlacement = results && results.placements ? (results.placements.find((p) => p.contributorId === myUserId) || null) : null;
    const showedUpButDidntPlace = results && (results.status === 'computed' || results.status === 'approved') && !myPlacement;

    return React.createElement("div", { style: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7A82', marginBottom: 8 } }, 'Your progress'),

        config && config.metric === 'on_time_completion' && approvalStatus === 'active' && React.createElement("div", {
            style: { fontSize: TYPE_SCALE[11.5], color: deadlinePassed ? '#D98A8A' : '#B5B0A5', marginBottom: 10 },
        },
            deadlinePassed
                ? `The deadline (${formatDate(event.end_date)}) has passed.`
                : event.end_date
                    ? `Finish by ${formatDate(event.end_date)}${remaining != null ? ` \u2014 ${remaining} day${remaining === 1 ? '' : 's'} left` : ''}`
                    : 'No deadline set for this challenge.'),

        config && config.weight_bps < 10000 && approvalStatus === 'active' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 10 } },
            config.weight_bps <= 0
                ? 'Placement is also decided by a blind panel of 3\u20135 verified authors from outside this guild.'
                : `${config.weight_bps / 100}% on-time completion, ${100 - config.weight_bps / 100}% blind judge panel.`),

        statusNode && React.createElement("div", { style: { marginBottom: 10 } }, statusNode),

        myPlacement && React.createElement("div", {
            style: {
                background: 'linear-gradient(160deg,#241F14,#1A160D)', border: '1px solid rgba(232,196,104,0.4)',
                borderRadius: RADIUS_SCALE[10], padding: '12px 14px', marginBottom: 10,
            },
        },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontFamily: "'Fraunces', Georgia, serif", color: '#E8C468', fontWeight: 600 } }, `#${myPlacement.place} place`),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginTop: 2 } }, `${myPlacement.sharePct}% of the prize pool`)),
        showedUpButDidntPlace && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginBottom: 10 } }, "Placements are in \u2014 this entry didn't place."),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginBottom: 8 } }, error),

        // ---------- The one action: no checklist items exist server-side to check off
        // individually (there's nothing in this schema tracking, say, chapters read) — "mark
        // complete" IS the reading challenge's entire submission, matching the design brief's
        // "single 'Mark complete' action instead of a manuscript field". ----------
        approvalStatus === 'active' && !submission && React.createElement("button", {
            disabled: marking || deadlinePassed, onClick: handleMarkComplete,
            style: { ...evBtnStyle(true), opacity: (marking || deadlinePassed) ? 0.5 : 1 },
        }, marking ? '\u2026' : 'Mark as complete'));
}
