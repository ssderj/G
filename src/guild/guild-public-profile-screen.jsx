import React, { useEffect, useState } from 'react';
import { fetchGuildEvents } from '../lib/guild-events.js';
import { fetchPublicGuildProfile } from '../lib/guild-rankings.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, UniversalBackButton } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';

// Read-only public view of a Player Guild by id — reached by tapping a guild from Living
// Universe's Guilds on the Rise / Guild Events / Best & Most Read cards, or anywhere else that
// carries a real guild_id (see lib/guild-rankings.js's fetchPublicGuildProfile and
// 51_migration_public_guild_events_directory.sql's get_public_guild_profile()). Deliberately
// separate from the Guild Hall a member sees (guild-hall.jsx / home-screen.jsx's guildContent) —
// this never shows Treasury, Roster management, or anything else scoped to members/owner, only
// what's safe to show any signed-in reader.
export function GuildPublicProfileScreen({ guildId, onOpenEvent }) {
    const [profile, setProfile] = useState(null); // null while loading, false if it couldn't be loaded
    const [events, setEvents] = useState(null);
    useEffect(() => {
        let cancelled = false;
        setProfile(null);
        setEvents(null);
        if (!guildId) return;
        fetchPublicGuildProfile(guildId).then((p) => { if (!cancelled) setProfile(p || false); });
        fetchGuildEvents(guildId).then((rows) => { if (!cancelled) setEvents(rows); }).catch(() => { if (!cancelled) setEvents([]); });
        return () => { cancelled = true; };
    }, [guildId]);

    return React.createElement("div", { className: "ink-page-in" },
        React.createElement("style", null, `
            .gpp-card{border:1px solid #2A2A30;border-radius:${RADIUS_SCALE[12]}px;padding:16px;background:#1D1D22;}
            .gpp-ev-row{display:flex;align-items:center;gap: 12px;padding:12px 2px;border-bottom:1px solid #2A2A30;}
            .gpp-ev-row:last-child{border-bottom:none;}
            .gpp-ev-row:hover{cursor:pointer;}
            .gpp-ev-title{font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:13.5px;color:#EFE7D2;}
            .gpp-ev-meta{font-size:11px;color:#7A7A82;margin-top:2px;}
        `),
        React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 24 } }),

        profile === null && React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Opening the guild hall\u2026"),

        profile === false && React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "This guild couldn't be found."),

        profile && React.createElement(React.Fragment, null,
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[16], alignItems: 'center', marginBottom: 28 } },
                profile.crestUrl
                    ? React.createElement("img", { src: profile.crestUrl, alt: "", style: { width: 64, height: 64, borderRadius: '50%', objectFit: 'cover', border: '2px solid #E8C468', flexShrink: 0 } })
                    : React.createElement("div", { style: { width: 64, height: 64, borderRadius: '50%', border: '2px solid #E8C468', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'radial-gradient(circle at 34% 28%, rgba(232,196,104,0.4), #17140F 72%)', flexShrink: 0 } }, React.createElement(InkIcon, { name: "castle", size: 26, color: "#E8C468" })),
                React.createElement("div", null,
                    React.createElement("h1", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontWeight: 600, fontSize: TYPE_SCALE[24], margin: '0 0 4px', color: '#EFE7D2' } }, profile.name),
                    profile.motto && React.createElement("p", { style: { margin: 0, fontSize: TYPE_SCALE[12.5], color: '#8A8680' } }, `\u201C${profile.motto}\u201D`),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 6, textTransform: 'uppercase', letterSpacing: '0.05em' } },
                        `${profile.memberCount} member${profile.memberCount === 1 ? '' : 's'}`))),

            React.createElement("div", { className: "gpp-card" },
                React.createElement("h2", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], margin: '0 0 10px', color: '#EFE7D2' } }, "Guild Events"),
                events === null
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, "Loading\u2026")
                    : (events.length
                        ? events.map((ev) => React.createElement("div", { className: "gpp-ev-row", key: ev.id, onClick: () => onOpenEvent && onOpenEvent(ev.id, profile.guildId) },
                            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                                React.createElement("div", { className: "gpp-ev-title" }, ev.title),
                                React.createElement("div", { className: "gpp-ev-meta" }, ev.approval_status))))
                        : React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, "No published events from this guild yet.")))));
}
