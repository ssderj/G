import React, { useEffect, useState } from 'react';
import { fetchAnthologyContributors, fetchGuildAnthologies } from '../lib/guild-anthologies.js';
import { stageProgress, statusColorFor } from './guild-anthology.jsx';
import { goBtnStyle } from './guild-order.jsx';
import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ArchiveSectionHeading, EmptyState, ProgressBar } from '../shared-ui/ui-cards.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------- Guild Anthology — compact Guild Homepage preview ----------
// A small, read-only glimpse of the real Guild Anthology feature, sitting on the Guild Hall home
// screen the same way GuildEventsHomePreview does for Guild Events. This file only READS what's
// already there — fetchGuildAnthologies/fetchAnthologyContributors (src/lib/guild-anthologies.js,
// untouched) — and reuses statusColorFor/stageProgress straight from the real Anthology page
// (src/guild/guild-anthology.jsx, now exporting both) so a card here always matches the real
// page's own colors and lifecycle stages, never a second slightly-different copy of either.
// Opening a card, "Open the Workshop", "+ Start an Anthology", and "Bring an Existing Project"
// all just navigate into that same real page (via the onOpen*/onStart*/onBring* callbacks
// home-screen.jsx wires up) — nothing here re-implements the create form, the submission picker,
// or any lifecycle control a second time.
const PREVIEW_LIMIT = 2;

function AnthologyPreviewCard({ anthology, contributorCount, onOpen }) {
    const color = statusColorFor(anthology.status);
    const progress = stageProgress(anthology.status);
    return React.createElement("button", {
        onClick: onOpen,
        style: {
            display: 'flex', width: '100%', textAlign: 'left', gap: SPACE_SCALE[12], alignItems: 'flex-start',
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14],
            padding: 14, cursor: 'pointer', font: 'inherit', marginTop: 14,
        },
    },
        React.createElement(BookCover, { title: anthology.title, author: '', cover: anthology.cover, size: 'sm' }),
        React.createElement("div", { style: { flex: 1, minWidth: 0, paddingTop: 2 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[8], alignItems: 'baseline' } },
                React.createElement("div", {
                    style: {
                        fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    },
                }, anthology.title),
                React.createElement("span", {
                    style: {
                        fontSize: TYPE_SCALE[9], fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                        color, border: `1px solid ${color}55`, borderRadius: RADIUS_SCALE[5], padding: '2px 7px', whiteSpace: 'nowrap',
                    },
                }, anthology.status)),
            React.createElement("div", { style: { marginTop: 8 } },
                React.createElement(ProgressBar, { value: progress.value, max: progress.max, color: anthology.status === 'cancelled' ? '#5C5C64' : '#C89B3C' })),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#8A8680', marginTop: 6 } },
                `${contributorCount != null ? contributorCount : '\u2026'} contributor${contributorCount === 1 ? '' : 's'}`)));
}

// Both buttons create-gate the same way the real AnthologyEmptyState does (only the guild owner
// may start one) — a non-owner sees the same plain explanatory line the real page shows them
// instead of two buttons that would only fail once tapped.
function AnthologyEmptyPreview({ isOwner, hasEligibleProject, onStartAnthology, onBringProject }) {
    return React.createElement("div", { style: { textAlign: 'center', padding: '20px 12px 6px' } },
        React.createElement(InkIcon, { name: "book", size: 22, color: "#5C5C64", style: { margin: '0 auto 10px' } }),
        React.createElement(EmptyState, { text: "No Guild Anthologies yet \u2014 the guild's first collaborative book is waiting to be started." }),
        isOwner
            ? React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center', flexWrap: 'wrap', marginTop: 8 } },
                React.createElement("button", { onClick: onStartAnthology, style: goBtnStyle(true) }, "+ Start an Anthology"),
                hasEligibleProject && React.createElement("button", { onClick: onBringProject, style: goBtnStyle(false) }, "Bring an Existing Project"))
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic', marginTop: 4 } }, "Only the guild owner can start a new anthology."));
}

// remoteGuildId: the same real player_guilds.id (Player Guild row, or a Founder Guild's fixed
// backendGuildId) fetchGuildAnthologies already expects. projects: the writer's own local
// projects, passed through unread here — this preview never picks one itself, it only tells the
// homepage's "Bring an Existing Project" button to exist when there's at least one to offer, the
// same eligibility the real workspace's own picker already checks (wordCount > 0).
export function GuildAnthologyHomePreview({ remoteGuildId, projects, isOwner, onOpenAnthology, onOpenWorkshop, onStartAnthology, onBringProject }) {
    const [status, setStatus] = useState('loading'); // 'loading' | 'ready'
    const [anthologies, setAnthologies] = useState([]);
    const [contributorCounts, setContributorCounts] = useState({});

    useEffect(() => {
        let cancelled = false;
        if (!remoteGuildId) {
            setStatus('ready');
            setAnthologies([]);
            return;
        }
        setStatus('loading');
        fetchGuildAnthologies(remoteGuildId).then(async (rows) => {
            if (cancelled) return;
            setAnthologies(rows);
            setStatus('ready');
            const shown = rows.slice(0, PREVIEW_LIMIT);
            const counts = {};
            await Promise.all(shown.map(async (a) => {
                try { counts[a.id] = (await fetchAnthologyContributors(a.id)).length; } catch (e) { counts[a.id] = null; }
            }));
            if (!cancelled) setContributorCounts(counts);
        }).catch((e) => {
            console.warn('Inkroot: guild anthology home preview fetch failed', e);
            if (!cancelled) { setAnthologies([]); setStatus('ready'); }
        });
        return () => { cancelled = true; };
    }, [remoteGuildId]);

    const shown = anthologies.slice(0, PREVIEW_LIMIT);
    const remaining = anthologies.length - shown.length;
    const hasEligibleProject = (projects || []).some((p) => (p.wordCount || 0) > 0);

    return React.createElement("div", { style: { marginBottom: 34 } },
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } }), label: "The Guild Anthology" }),
        !remoteGuildId
            ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 12 } },
                "Guild Anthologies need a signed-in, online guild \u2014 sign in to see this guild's collaborative books here.")
            : status === 'loading'
                ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 12 } }, "Opening the shelf\u2026")
                : shown.length === 0
                    ? React.createElement(AnthologyEmptyPreview, { isOwner, hasEligibleProject, onStartAnthology, onBringProject })
                    : React.createElement(React.Fragment, null,
                        shown.map((a) => React.createElement(AnthologyPreviewCard, {
                            key: a.id, anthology: a, contributorCount: contributorCounts[a.id], onOpen: () => onOpenAnthology(a.id),
                        })),
                        remaining > 0 && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[11], color: '#7A7160', marginTop: 10, fontStyle: 'italic' } },
                            `${remaining} more ${remaining === 1 ? 'anthology' : 'anthologies'} in the Workshop`)),
        remoteGuildId && shown.length > 0 && React.createElement("button", {
            onClick: onOpenWorkshop,
            style: { ...goBtnStyle(false), width: '100%', padding: '9px 13px', marginTop: 12 },
        }, "Open the Workshop \u2192"));
}
