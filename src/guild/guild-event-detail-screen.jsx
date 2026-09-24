import React, { useEffect, useState } from 'react';
import { fetchPublicGuildEvents } from '../lib/guild-events.js';
import { EventTypeBadge } from './guild-events-panel.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, UniversalBackButton } from '../shell/nav-context.jsx';
import { formatNaira } from '../lib/payments.js';
import { InkIcon } from '../shell/ink-icon.jsx';

const GED_PHASE_META = {
    published: { label: 'Upcoming', color: '#7FB2C9' },
    active: { label: 'Active', color: '#8FA37A' },
    completed: { label: 'Completed', color: '#5C5C64' },
};

function gedFormatDate(ts) {
    return ts ? new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '\u2014';
}

// Read-only detail view of a single Guild Event — reached by tapping an event card on Living
// Universe or a guild's public profile. Pulls from the same public, approved-and-published-only
// directory as Living Universe's Guild Events section (fetchPublicGuildEvents — see
// 51_migration_public_guild_events_directory.sql) rather than a second, separate fetch, so this
// page can never show an event a reader couldn't already see on the card that linked here.
export function GuildEventDetailScreen({ eventId, onOpenGuild }) {
    const [event, setEvent] = useState(null); // null while loading, false if not found/not public
    useEffect(() => {
        let cancelled = false;
        setEvent(null);
        if (!eventId) return;
        fetchPublicGuildEvents({ limit: 100 }).then((rows) => {
            if (cancelled) return;
            setEvent(rows.find((r) => r.id === eventId) || false);
        });
        return () => { cancelled = true; };
    }, [eventId]);

    if (event === null) {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Opening the event\u2026"));
    }
    if (event === false) {
        return React.createElement("div", { className: "ink-page-in" },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),
            React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "This event couldn't be found."));
    }

    const meta = GED_PHASE_META[event.approvalStatus] || GED_PHASE_META.published;
    // The wax seal stamped on every official notice: colored by the event's real phase (the same
    // meta.color used on the guild-line label above), so a glance at the seal alone tells a
    // reader upcoming/active/completed without reading the ribbon text.
    return React.createElement("div", { className: "ink-page-in" },
        React.createElement("style", null, `
            /* ---------- Official Guild Event notice ----------
               An Inkroot herald posting, not a storefront card: a poster frame with a hairline
               inner border, a ribbon banner declaring it official, and a wax seal of the event's
               real phase stamped over the corner of the cover art. Ticket-stub stats replace the
               plain stat grid so the entry fee/prize/participants/dates read as one torn stub of
               information rather than four identical little cards. Mobile-first: everything below
               is full-width and single-column by default; the stub only gains its 2-column layout
               once there's room (see the 420px step), matching how tightly an iPhone SE-width
               screen needs to pack this before anything else in the app relaxes its own grid. */
            .ged-poster{position:relative;border:1px solid rgba(232,196,104,0.28);border-radius:${RADIUS_SCALE[16]}px;padding:3px;background:linear-gradient(160deg,#211D14,#17151B 60%);margin-bottom:22px;}
            .ged-poster::before{content:'';position:absolute;inset:6px;border:1px solid rgba(232,196,104,0.16);border-radius:${RADIUS_SCALE[13]}px;pointer-events:none;}
            .ged-ribbon{display:inline-flex;align-items:center;gap:7px;position:relative;left:16px;top:-1px;margin-bottom:-1px;padding:5px 14px 5px 12px;font-size:9.5px;letter-spacing:0.14em;color:#17140F;background:linear-gradient(180deg,#F2D98A,#C89B3C);border-radius:3px 3px 0 0;font-weight:700;}
            .ged-cover{height:150px;border-radius:${RADIUS_SCALE[13]}px;position:relative;display:flex;align-items:flex-end;padding:18px 20px;overflow:hidden;margin:0;}
            .ged-cover::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,0.7) 100%);}
            .ged-seal{position:absolute;right:14px;top:-16px;width:52px;height:52px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-direction:column;transform:rotate(-8deg);box-shadow:0 4px 10px rgba(0,0,0,0.5),inset 0 0 0 1px rgba(0,0,0,0.25);border:2px solid rgba(23,20,15,0.4);z-index:2;}
            .ged-seal-label{font-size:6.5px;letter-spacing:0.08em;text-transform:uppercase;color:#17140F;font-weight:700;line-height:1.15;text-align:center;}
            .ged-body{padding:18px 20px 20px;}
            .ged-stub{position:relative;border:1px dashed rgba(138,134,128,0.4);border-radius:${RADIUS_SCALE[12]}px;padding:16px 14px;background:#1A1A1F;display:grid;grid-template-columns:1fr 1fr;gap:14px 10px;margin-bottom:4px;}
            .ged-stub::before,.ged-stub::after{content:'';position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:#17171B;transform:translateY(-50%);}
            .ged-stub::before{left:-9px;}
            .ged-stub::after{right:-9px;}
            .ged-stat-label{font-size:9px;text-transform:uppercase;letter-spacing:0.07em;color:#5C5C64;}
            .ged-stat-value{font-size:15px;color:#EFE7D2;margin-top:3px;font-family:'Fraunces',Georgia,serif;}
            @media (min-width: 420px) { .ged-stub{grid-template-columns:repeat(4,1fr);} }
        `),
        React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),

        React.createElement("div", null,
            React.createElement("div", { className: "ged-ribbon" }, "\u2696\uFE0F Official Guild Event"),
            React.createElement("div", { className: "ged-poster" },
                React.createElement("div", { className: "ged-cover", style: { background: event.coverImageUrl ? `url(${event.coverImageUrl}) center/cover` : 'linear-gradient(155deg, #B08D5766, #17151B 75%)' } },
                    React.createElement("div", {
                        className: "ged-seal",
                        style: { background: `radial-gradient(circle at 35% 30%, ${meta.color}, ${meta.color}CC 70%)` },
                    },
                        React.createElement("div", { className: "ged-seal-label" }, meta.label)),
                    React.createElement("h1", { style: { position: 'relative', fontFamily: "'Fraunces', Georgia, serif", fontWeight: 600, fontSize: TYPE_SCALE[22], margin: 0, color: '#F4EEDD' } }, event.title)),

                React.createElement("div", { className: "ged-body" },
                    React.createElement("div", {
                        style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 18, cursor: onOpenGuild ? 'pointer' : 'default' },
                        onClick: () => onOpenGuild && onOpenGuild(event.guildId),
                    },
                        React.createElement(InkIcon, { name: "castle", size: 15 }),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2' } }, event.guildName),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginLeft: 4 } }, "\u2014 host guild")),

                    event.eventType && React.createElement(EventTypeBadge, { eventType: event.eventType, style: { marginBottom: 14 } }),

                    event.description && React.createElement("p", { style: { fontSize: TYPE_SCALE[13], color: '#8A8680', lineHeight: 1.6, marginBottom: 18 } }, event.description),

                    React.createElement("div", { className: "ged-stub" },
                        React.createElement("div", null,
                            React.createElement("div", { className: "ged-stat-label" }, "Entry fee"),
                            React.createElement("div", { className: "ged-stat-value" }, event.entryFeeNaira != null ? formatNaira(event.entryFeeNaira) : 'Free')),
                        React.createElement("div", null,
                            React.createElement("div", { className: "ged-stat-label" }, event.host === 'inkroot' ? 'Cash prize' : 'Prize pool'),
                            React.createElement("div", { className: "ged-stat-value" }, formatNaira(event.prizePoolNaira))),
                        React.createElement("div", null,
                            React.createElement("div", { className: "ged-stat-label" }, "Participants"),
                            React.createElement("div", { className: "ged-stat-value" }, event.participantCount + (event.participantLimit ? ` / ${event.participantLimit}` : ''))),
                        React.createElement("div", null,
                            React.createElement("div", { className: "ged-stat-label" }, "Dates"),
                            React.createElement("div", { className: "ged-stat-value", style: { fontSize: 12.5 } }, `${gedFormatDate(event.startAt)} \u2013 ${gedFormatDate(event.endAt)}`)))))));
}
