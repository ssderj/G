import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventObjectiveConfig, fetchGuildEventResults, fetchMyGuildEventSubmission, submitGuildEventSubmission,
} from '../lib/guild-events.js';
import { evBtnStyle, evInputStyle, OBJECTIVE_METRIC_LABELS } from './guild-events-panel.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

const gesLabelStyle = { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4, display: 'block' };

function countWords(text) {
    if (!text) return 0;
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}

// Entrant-facing submission + status + results panel for a Guild Event — see
// 121_migration_guild_event_fair_judging.sql. Meant to be rendered by EventCard
// (guild-events-panel.jsx) once an entrant has a successful paid entry (myEntry.status ===
// 'success'); kept as its own file, not yet wired into EventCard, so it can be reviewed on its
// own first. It fetches its own judging config, own submission, and own results — nothing here
// is passed down that the caller would have to assemble.
//
// ---------------------------------------------------------------------------------------------
// KNOWN GAP, flagged rather than quietly worked around: guild_event_results has no entrant-facing
// RLS read policy today (49_migration_guild_event_results_approval.sql grants only the event's
// organizer and the guild's own treasury authority — see that migration's "organizer reads their
// own submitted results" / "guild treasury authority reads event results" policies, unchanged by
// migration 121). So once placements are 'computed', an ordinary entrant's fetchGuildEventResults()
// call below returns null in exactly the same shape as "nothing computed yet" — RLS silently
// filters the row rather than erroring. The status strip therefore can only ever promise
// "Placements computed" when this component happens to be viewed by someone RLS does let read that
// row (the organizer, or a treasury-authorized officer); for a genuine entrant it will sit at
// "Judging in progress…" forever, even after they've actually placed and been paid. Closing this
// needs a new, narrowly-scoped read added server-side — e.g. a fetch_my_guild_event_placement(event_id)
// function returning only the caller's own place/share, never the full placements array — before
// this reveal is real for entrants. Nothing below papers over that; myPlacement will just stay
// null for them until that lands.
// ---------------------------------------------------------------------------------------------
export function GuildEventSubmissionPanel({ event, myUserId, hasPaidEntry }) {
    const [config, setConfig] = useState(undefined); // undefined = loading, null = none on file
    const [submission, setSubmission] = useState(undefined); // undefined = loading, null = none yet
    const [results, setResults] = useState(undefined);
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState('');
    const [content, setContent] = useState('');
    const [manuscriptLink, setManuscriptLink] = useState('');
    const [manualWordCount, setManualWordCount] = useState('');
    const [useLink, setUseLink] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    const load = () => {
        fetchGuildEventObjectiveConfig(event.id).then(setConfig).catch(() => setConfig(null));
        fetchMyGuildEventSubmission(event.id).then((s) => {
            setSubmission(s);
            if (s) {
                setTitle(s.title || '');
                const c = s.content || {};
                if (c.link) {
                    setUseLink(true);
                    setManuscriptLink(c.link);
                    setManualWordCount(s.word_count != null ? String(s.word_count) : '');
                } else {
                    setUseLink(false);
                    setContent(c.text || '');
                }
            }
        }).catch(() => setSubmission(null));
        // See the KNOWN GAP note above — this can come back null for a real entrant even once
        // placements exist. Never treated here as proof nothing has been computed.
        fetchGuildEventResults(event.id).then(setResults).catch(() => setResults(null));
    };
    useEffect(load, [event.id]);

    if (!hasPaidEntry) return null;

    const approvalStatus = event.approval_status;
    const liveWordCount = useLink ? Math.round(Number(manualWordCount) || 0) : countWords(content);

    const handleSubmit = async () => {
        if (!useLink && !content.trim()) { setError('Add your entry, or switch to a manuscript link.'); return; }
        if (useLink && !manuscriptLink.trim()) { setError('Add a manuscript link, or paste your entry directly.'); return; }
        setBusy(true);
        setError(null);
        try {
            const submittedContent = useLink ? { link: manuscriptLink.trim() } : { text: content };
            await submitGuildEventSubmission(event.id, { title, wordCount: liveWordCount, content: submittedContent });
            setEditing(false);
            load();
        } catch (e) {
            setError(e.message || 'Could not submit your entry.');
        } finally {
            setBusy(false);
        }
    };

    // ---------- Status strip: Submitted / Judging in progress / Placements computed ----------
    let statusNode = null;
    if (approvalStatus === 'active') {
        statusNode = submission
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8FCB8F' } },
                `\u2713 Submitted${submission.updated_at ? ` \u2014 last updated ${new Date(submission.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}`)
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C' } }, 'Not submitted yet');
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
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.05em', color: '#7A7A82', marginBottom: 8 } }, 'Your entry'),

        config && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 10 } },
            config.weight_bps >= 10000
                ? `Judged purely on ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()} \u2014 no judge panel.`
                : config.weight_bps <= 0
                    ? 'Judged blind by a panel of 3\u20135 verified authors from outside this guild.'
                    : `${config.weight_bps / 100}% ${OBJECTIVE_METRIC_LABELS[config.metric].toLowerCase()}, ${100 - config.weight_bps / 100}% blind judge panel.`),

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

        // ---------- Submission form ----------
        approvalStatus === 'active' && (editing || !submission)
            ? React.createElement("div", null,
                React.createElement("div", { style: { marginBottom: 8 } },
                    React.createElement("label", { style: gesLabelStyle }, 'Title'),
                    React.createElement("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "Give your entry a title", style: evInputStyle })),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 8 } },
                    React.createElement("button", { onClick: () => setUseLink(false), style: evBtnStyle(!useLink) }, 'Paste entry'),
                    React.createElement("button", { onClick: () => setUseLink(true), style: evBtnStyle(useLink) }, 'Manuscript link')),
                !useLink
                    ? React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: gesLabelStyle }, `Entry \u2014 ${liveWordCount} word${liveWordCount === 1 ? '' : 's'}`),
                        React.createElement("textarea", {
                            value: content, onChange: (e) => setContent(e.target.value), rows: 8,
                            placeholder: "Paste your entry here\u2026", style: { ...evInputStyle, resize: 'vertical', fontFamily: 'inherit' },
                        }))
                    : React.createElement("div", { style: { marginBottom: 8 } },
                        React.createElement("label", { style: gesLabelStyle }, 'Manuscript link'),
                        React.createElement("input", { value: manuscriptLink, onChange: (e) => setManuscriptLink(e.target.value), placeholder: "https://\u2026", style: evInputStyle }),
                        React.createElement("label", { style: { ...gesLabelStyle, marginTop: 8 } }, 'Word count'),
                        React.createElement("input", { type: "number", min: "0", value: manualWordCount, onChange: (e) => setManualWordCount(e.target.value), style: evInputStyle })),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                    React.createElement("button", { disabled: busy, onClick: handleSubmit, style: { ...evBtnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : (submission ? 'Save changes' : 'Submit entry')),
                    submission && editing && React.createElement("button", { onClick: () => setEditing(false), style: evBtnStyle(false) }, 'Cancel')))
            : approvalStatus === 'active' && submission && React.createElement("button", { onClick: () => setEditing(true), style: evBtnStyle(false) }, 'Edit entry'));
}
