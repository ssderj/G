import React, { useEffect, useState } from 'react';
import {
    fetchGuildEventEntriesForJudge, fetchMyGuildEventJudgeAssignment, fetchMyGuildEventJudgeAssignments,
    fetchMyGuildEventJudgeScores, submitGuildEventJudgeScore,
} from '../lib/guild-events.js';
import { evBtnStyle, evInputStyle } from './guild-events-panel.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, UniversalBackButton } from '../shell/nav-context.jsx';

function jpFormatDate(ts) {
    return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
}

const jpCardStyle = { border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '14px 16px', marginBottom: 12, background: '#1A1A1F' };

// ---------- Entry point: this judge's own seats across every event, past and present ----------
// There's no server-side notification when a seat is assigned (121_migration_guild_event_fair_judging.sql
// adds none), so this list — built from guild_event_judges' own "a judge reads their own
// assignment" RLS row, joined client-side against the publicly-readable guild_events table — is
// the only way a judge discovers which events they're on the hook for.
function GuildEventJudgeAssignmentList({ onOpen }) {
    const [rows, setRows] = useState(undefined); // undefined = loading
    const [error, setError] = useState(null);

    useEffect(() => {
        fetchMyGuildEventJudgeAssignments().then(setRows).catch((e) => { setError(e.message); setRows([]); });
    }, []);

    return React.createElement("div", { className: "ink-page-in" },
        React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
        React.createElement("h1", { style: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: TYPE_SCALE[20], color: '#F4EEDD', margin: '0 0 6px' } }, "Your judging seats"),
        React.createElement("p", { style: { fontSize: TYPE_SCALE[12], color: '#8A8680', lineHeight: 1.55, marginBottom: 20 } },
            "You're seated on a panel automatically when a guild event needs blind judging \u2014 never chosen by the hosting guild, and you never learn who else is seated with you. Every entry you score stays anonymous."),

        rows === undefined && React.createElement("div", { style: { textAlign: 'center', padding: '40px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Checking your seats\u2026"),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginBottom: 12 } }, error),
        rows && rows.length === 0 && !error && React.createElement("div", { style: { textAlign: 'center', padding: '32px 12px', fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, "You haven't been seated on a judging panel yet."),

        rows && rows.map((r) => React.createElement("div", {
            key: r.id, onClick: () => onOpen(r.id), style: { ...jpCardStyle, cursor: 'pointer' },
        },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#EFE7D2' } }, r.title || 'Untitled event'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 4 } },
                [r.approval_status, [jpFormatDate(r.start_date), jpFormatDate(r.end_date)].filter(Boolean).join(' \u2013 ')]
                    .filter(Boolean).join('  \u2022  ')))));
}

// Local "‹ Back to your seats" link used only when this screen was reached by picking an event
// off GuildEventJudgeAssignmentList above (internal state, not app navigation) — UniversalBackButton
// always pops the real nav stack, which would skip past the list entirely in that case. When a
// caller instead opens this screen directly with a fixed eventId, there's no list to return to,
// so the real UniversalBackButton is used there instead (see GuildEventJudgePanel below).
function jpBackToSeatsLink(onExit) {
    return React.createElement("button", {
        onClick: onExit,
        style: {
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: 'none',
            color: '#8A8680', fontSize: TYPE_SCALE[12], cursor: 'pointer', fontFamily: 'inherit', padding: 0, marginBottom: 24,
        },
    }, "\u2190 Your judging seats");
}

// ---------- A single event's blind-review scoring screen ----------
function GuildEventJudgeScoringScreen({ eventId, onExit, showRealBack }) {
    const [assignment, setAssignment] = useState(undefined); // undefined = loading, null = not seated
    const [gateError, setGateError] = useState(null);
    const [entries, setEntries] = useState(undefined); // undefined = loading, false = errored
    const [entriesError, setEntriesError] = useState(null);
    const [savedScores, setSavedScores] = useState({}); // submission_id -> { overall: number }
    const [drafts, setDrafts] = useState({}); // submission_id -> string being edited
    const [expanded, setExpanded] = useState({}); // submission_id -> bool
    const [rowBusy, setRowBusy] = useState(null); // submission_id currently saving
    const [rowError, setRowError] = useState({}); // submission_id -> message
    const [locked, setLocked] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setAssignment(undefined);
        setGateError(null);
        fetchMyGuildEventJudgeAssignment(eventId).then((a) => {
            if (cancelled) return;
            setAssignment(a || null);
        }).catch((e) => {
            if (cancelled) return;
            setGateError(e.message);
            setAssignment(null);
        });
        return () => { cancelled = true; };
    }, [eventId]);

    const loadEntries = () => {
        setEntries(undefined);
        setEntriesError(null);
        fetchGuildEventEntriesForJudge(eventId).then((rows) => {
            setEntries(rows);
            const drafts0 = {};
            rows.forEach((r) => { drafts0[r.submissionId] = ''; });
            setDrafts((d) => ({ ...drafts0, ...d }));
        }).catch((e) => {
            setEntries(false);
            setEntriesError(e.message);
            // The RPC itself re-checks the panel seat server-side, so a stale/rescinded
            // assignment (or a race against this screen's own gate check) surfaces here too \u2014
            // treated the same as the upfront gate rather than a separate error state.
            if (/not an assigned judge/i.test(e.message || '')) setAssignment(null);
        });
        fetchMyGuildEventJudgeScores(eventId).then(setSavedScores).catch(() => {});
    };
    useEffect(() => { if (assignment) loadEntries(); }, [assignment, eventId]);

    if (assignment === undefined) {
        return React.createElement("div", { className: "ink-page-in" },
            showRealBack ? React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }) : jpBackToSeatsLink(onExit),
            React.createElement("div", { style: { textAlign: 'center', padding: '48px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Confirming your seat\u2026"));
    }

    if (!assignment) {
        return React.createElement("div", { className: "ink-page-in" },
            showRealBack ? React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }) : jpBackToSeatsLink(onExit),
            React.createElement("div", { style: { textAlign: 'center', padding: '48px 16px' } },
                React.createElement("div", { style: { fontSize: 32, marginBottom: 12 } }, "\u2696\uFE0F"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], color: '#EFE7D2', marginBottom: 6 } }, "You're not an assigned judge for this event"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8680', lineHeight: 1.55, maxWidth: 340, margin: '0 auto' } },
                    gateError || "Either this event never needed a blind judge panel, or you simply haven't been seated \u2014 panels are assigned automatically, not requested.")));
    }

    const entryCount = entries ? entries.length : 0;
    const scoredCount = entries ? entries.filter((r) => savedScores[r.submissionId] && savedScores[r.submissionId].overall != null).length : 0;

    const handleSave = async (submissionId) => {
        const raw = drafts[submissionId];
        const num = Number(raw);
        if (raw === '' || raw == null || Number.isNaN(num) || num < 0 || num > 100) {
            setRowError((e) => ({ ...e, [submissionId]: 'Enter a score from 0 to 100.' }));
            return;
        }
        setRowBusy(submissionId);
        setRowError((e) => ({ ...e, [submissionId]: null }));
        try {
            await submitGuildEventJudgeScore(eventId, submissionId, 'overall', num);
            setSavedScores((s) => ({ ...s, [submissionId]: { ...(s[submissionId] || {}), overall: num } }));
            setDrafts((d) => ({ ...d, [submissionId]: '' }));
        } catch (e) {
            const msg = e.message || 'Could not save that score.';
            if (/already been computed|scores are locked/i.test(msg)) {
                setLocked(true);
            } else {
                setRowError((er) => ({ ...er, [submissionId]: msg }));
            }
        } finally {
            setRowBusy(null);
        }
    };

    return React.createElement("div", { className: "ink-page-in" },
        showRealBack ? React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }) : jpBackToSeatsLink(onExit),

        React.createElement("h1", { style: { fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: TYPE_SCALE[20], color: '#F4EEDD', margin: '0 0 4px' } }, "Blind review"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 4 } },
            "Entries are shown anonymously \u2014 no entrant name or profile ever reaches this screen."),
        entries && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C', marginBottom: 18 } }, `Scored ${scoredCount} of ${entryCount}`),

        locked && React.createElement("div", {
            style: { border: '1px solid rgba(232,196,104,0.4)', borderRadius: RADIUS_SCALE[10], padding: '12px 14px', marginBottom: 16, background: 'linear-gradient(160deg,#241F14,#1A160D)' },
        },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#E8C468', fontWeight: 600, marginBottom: 3 } }, "\u2696\uFE0F Scores are locked"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#B5B0A5' } }, "Placements for this event have already been computed \u2014 further changes can't be saved.")),

        entries === undefined && React.createElement("div", { style: { textAlign: 'center', padding: '40px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Loading entries\u2026"),
        entries === false && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12], padding: '12px 0' } }, entriesError),
        entries && entries.length === 0 && React.createElement("div", { style: { textAlign: 'center', padding: '32px 12px', fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, "No entries have been submitted for this event yet."),

        entries && entries.map((r) => {
            const saved = savedScores[r.submissionId] && savedScores[r.submissionId].overall != null ? savedScores[r.submissionId].overall : null;
            const isExpanded = !!expanded[r.submissionId];
            const content = r.content || {};
            const bodyText = content.text || '';
            const preview = bodyText.length > 260 && !isExpanded ? `${bodyText.slice(0, 260)}\u2026` : bodyText;
            return React.createElement("div", { key: r.submissionId, style: jpCardStyle },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.06em', color: '#7A7A82' } }, r.label),
                    saved != null && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8FCB8F' } }, `\u2713 Scored ${saved}`)),
                r.title && React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontFamily: "'Fraunces', Georgia, serif", color: '#EFE7D2', marginBottom: 4 } }, r.title),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 10 } }, `${r.wordCount != null ? r.wordCount : 0} words`),

                content.link
                    ? React.createElement("a", { href: content.link, target: "_blank", rel: "noopener noreferrer", style: { fontSize: TYPE_SCALE[12], color: '#8FB8CB', wordBreak: 'break-all', display: 'block', marginBottom: 12 } }, content.link)
                    : bodyText && React.createElement("div", { style: { marginBottom: 12 } },
                        React.createElement("p", { style: { fontSize: TYPE_SCALE[12.5], color: '#B5B0A5', lineHeight: 1.6, whiteSpace: 'pre-wrap' } }, preview),
                        bodyText.length > 260 && React.createElement("button", {
                            onClick: () => setExpanded((ex) => ({ ...ex, [r.submissionId]: !isExpanded })),
                            style: { ...evBtnStyle(false), padding: '4px 10px', fontSize: TYPE_SCALE[10.5], marginTop: 4 },
                        }, isExpanded ? 'Show less' : 'Read full entry')),

                rowError[r.submissionId] && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginBottom: 6 } }, rowError[r.submissionId]),

                !locked && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'center' } },
                    React.createElement("input", {
                        type: "number", min: "0", max: "100", placeholder: saved != null ? String(saved) : "0\u2013100",
                        value: drafts[r.submissionId] || '',
                        onChange: (e) => setDrafts((d) => ({ ...d, [r.submissionId]: e.target.value })),
                        style: { ...evInputStyle, width: 90 },
                    }),
                    React.createElement("button", {
                        disabled: rowBusy === r.submissionId, onClick: () => handleSave(r.submissionId),
                        style: { ...evBtnStyle(true), opacity: rowBusy === r.submissionId ? 0.5 : 1 },
                    }, rowBusy === r.submissionId ? '\u2026' : (saved != null ? 'Update score' : 'Save score'))));
        }));
}

// ---------- Top-level export ----------
// eventId is optional: pass it when a judge already knows which event they're reviewing (e.g.
// linked from elsewhere); omit it to start from this judge's full list of seats. Either way the
// per-event gate below is the real check — a stale or guessed eventId never gets past it.
export function GuildEventJudgePanel({ eventId }) {
    const [selectedId, setSelectedId] = useState(eventId || null);
    if (!selectedId) return React.createElement(GuildEventJudgeAssignmentList, { onOpen: setSelectedId });
    // A fixed eventId (passed in by the caller, never chosen from the list below) has no
    // internal list to fall back to, so the real app-nav back button is what belongs here.
    return React.createElement(GuildEventJudgeScoringScreen, {
        eventId: selectedId, onExit: () => setSelectedId(null), showRealBack: !!eventId,
    });
}
