import React, { useState, useRef, useMemo, useEffect } from 'react';
import { FOUNDER_GUILDS } from '../guild/guild-hall.jsx';
import { fetchRisingStars } from '../lib/rising-stars.js';
import { fetchBestSellers, fetchMostRead, fetchTrending } from '../lib/book-rankings.js';
import { fetchGuildsOnRise } from '../lib/guild-rankings.js';
import { fetchPublicGuildEvents } from '../lib/guild-events.js';
import { INBOX_ICON_COLOR, LU_AUTHORS, LU_BOOK_TITLES, LU_WORLD_PACKS, LuSectionHeader, luGuildEventPhase, luIconKey, luPick, luTimeAgo, useLivingUniverseFeed, useLuGuildEvents, useLuTrending } from './inbox-and-living-universe.jsx';
import { formatNaira, koboToNaira } from '../lib/payments.js';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { ICON_PATHS, InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { WRITER_RANKS } from '../writing/health-checks.jsx';


// A handful of badge/seal fields on this screen (guild-event covers, Chronicle entries, guild
// cards) hold an InkIcon glyph name for everything this screen mints itself (see
// LU_GUILD_EVENT_TEMPLATES and luMakeEntry in inbox-and-living-universe.jsx), but a few still
// carry a shared rank/reputation/achievement/guild badge borrowed from its own home elsewhere in
// the app (Writer Ranks, Reputation Titles, Achievements, Founder Guilds) that isn't this
// screen's to redraw. LuGlyph renders whichever it's given: a known InkIcon name becomes a
// proper engraved glyph in this screen's own ivory/gold tone; anything else renders exactly as
// it always has.
function LuGlyph({ value, size = 14, color = INBOX_ICON_COLOR, style }) {
    if (value && ICON_PATHS[value]) return React.createElement(InkIcon, { name: value, size, color, style });
    return React.createElement("span", { style }, value);
}


const LU_GE_PHASE_META = {
    upcoming: { label: 'Upcoming', color: '#7FB2C9' },
    active: { label: 'Active', color: '#8FA37A' },
    completed: { label: 'Completed', color: '#5C5C64' },
};


function luFormatEventDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}


function luGuildNameForGenre(genre) {
    const g = FOUNDER_GUILDS.find((x) => x.id === genre);
    return g ? g.name.replace('The ', '').replace(' Guild', '') : 'General';
}


// Discovery-page aggregates below are all derived from the same real Chronicle entries and Guild
// Events state already powering Trending Now / Guild Events / Reader Activity above — no new
// random numbers are introduced. Each one counts or groups real, already-persisted entries.

// Rising Stars: the most recent Writer Rank ascension per author, newest first.
function useLuRisingStars(entries) {
    return useMemo(() => {
        const byAuthor = new Map();
        entries.filter((e) => e.kind === 'rank' && e.author).forEach((e) => {
            const cur = byAuthor.get(e.author);
            if (!cur || cur.ts < e.ts) byAuthor.set(e.author, e);
        });
        return [...byAuthor.values()].sort((a, b) => b.ts - a.ts).slice(0, 6);
    }, [entries]);
}


// Best Sellers: titles ranked by how many times they've been chronicled as a new release.
function useLuBestSellers(entries) {
    return useMemo(() => {
        const counts = new Map();
        entries.filter((e) => e.kind === 'release' && e.book).forEach((e) => {
            const cur = counts.get(e.book);
            if (cur) { cur.count += 1; if (e.ts > cur.ts) { cur.ts = e.ts; cur.author = e.author; cur.genre = e.genre; } }
            else counts.set(e.book, { book: e.book, author: e.author, genre: e.genre, count: 1, ts: e.ts });
        });
        return [...counts.values()].sort((a, b) => b.count - a.count || b.ts - a.ts).slice(0, 5);
    }, [entries]);
}


// Most Read: titles ranked by how many reader-activity entries reference them.
function useLuMostRead(entries) {
    return useMemo(() => {
        const counts = new Map();
        entries.filter((e) => e.kind === 'reader' && e.book).forEach((e) => {
            const cur = counts.get(e.book);
            if (cur) { cur.count += 1; if (e.ts > cur.ts) cur.ts = e.ts; }
            else counts.set(e.book, { book: e.book, count: 1, ts: e.ts });
        });
        return [...counts.values()].sort((a, b) => b.count - a.count || b.ts - a.ts).slice(0, 5);
    }, [entries]);
}


// Guilds on the Rise (local fallback): Founder Guilds ranked by combined participants across
// their live/upcoming Guild Events. Founder Guild Events are still an on-device simulation (see
// useLuGuildEvents), so this stays the fallback shown until the real, server-computed Player
// Guild ranking below (fetchGuildsOnRise) has something to show.
function useLuGuildsOnRise(guildEventsVisible) {
    return useMemo(() => {
        const now = Date.now();
        const live = guildEventsVisible.filter((ev) => luGuildEventPhase(ev, now) !== 'completed');
        const byGuild = new Map();
        live.forEach((ev) => {
            const cur = byGuild.get(ev.guildId);
            if (cur) { cur.participants += ev.participantCount; cur.events += 1; }
            else byGuild.set(ev.guildId, { guildId: ev.guildId, guildName: ev.guildName, guildIcon: ev.guildIcon, participants: ev.participantCount, events: 1 });
        });
        return [...byGuild.values()].sort((a, b) => b.participants - a.participants).slice(0, 4);
    }, [guildEventsVisible]);
}


// New & Notable: the newest World Pack and Anthology entries chronicled.
function useLuNewAndNotable(entries) {
    return useMemo(() => entries.filter((e) => e.kind === 'worldpack' || e.kind === 'anthology').slice(0, 6), [entries]);
}


// Recent Achievements: the newest achievement unlocks chronicled.
function useLuRecentAchievements(entries) {
    return useMemo(() => entries.filter((e) => e.kind === 'achievement').slice(0, 6), [entries]);
}


// One event card, shared by the Upcoming / Active / Recently Completed rows below — only its
// phase (for the status pill's color/label) differs between rows. `real` events (fetched from
// list_public_guild_events — see fetchPublicGuildEvents) carry a real guildId/id and are
// clickable through to the guild's public profile and the event's own detail page; the local
// chronicle-simulation fallback rows have neither a real guild nor a real event behind them, so
// they stay inert rather than linking somewhere fake.
function LuGuildEventCard({ ev, phase, onOpenGuild, onOpenEvent }) {
    const meta = LU_GE_PHASE_META[phase];
    const clickableGuild = !!(onOpenGuild && ev.guildId);
    const clickableEvent = !!(onOpenEvent && ev.real);
    return React.createElement("div", { className: "lu-ge-card", style: clickableEvent ? { cursor: 'pointer' } : undefined,
            onClick: clickableEvent ? () => onOpenEvent(ev.id) : undefined },
        React.createElement("div", { className: "lu-ge-cover", style: { background: ev.cover } },
            React.createElement("div", { className: "lu-ge-cover-badge" },
                React.createElement(LuGlyph, { value: ev.icon, size: 15, style: { filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.6))' } })),
            React.createElement("div", { className: "lu-ge-cover-title" }, ev.title)),
        React.createElement("div", { className: "lu-ge-body" },
            React.createElement("div", {
                    className: "lu-ge-guild", style: clickableGuild ? { cursor: 'pointer' } : undefined,
                    onClick: clickableGuild ? (e) => { e.stopPropagation(); onOpenGuild(ev.guildId); } : undefined,
                },
                React.createElement("span", { style: { display: 'flex', alignItems: 'center' } }, React.createElement(LuGlyph, { value: ev.guildIcon, size: 12, color: "currentColor" })),
                React.createElement("span", null, ev.guildName)),
            React.createElement("div", { className: "lu-ge-stats" },
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, "Entry fee"),
                    React.createElement("div", { className: "lu-ge-stat-value" }, ev.entryFeeNaira ? formatNaira(ev.entryFeeNaira) : 'Free')),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, ev.host === 'inkroot' ? 'Cash prize' : 'Prize pool'),
                    React.createElement("div", { className: "lu-ge-stat-value" }, formatNaira(ev.prizePoolNaira))),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, "Participants"),
                    React.createElement("div", { className: "lu-ge-stat-value" }, ev.participantCount)),
                React.createElement("div", null,
                    React.createElement("div", { className: "lu-ge-stat-label" }, "Status"),
                    React.createElement("div", { className: "lu-ge-stat-value", style: { color: meta.color } }, meta.label))),
            React.createElement("div", { className: "lu-ge-dates" }, `${luFormatEventDate(ev.startAt)} \u2013 ${luFormatEventDate(ev.endAt)}`)));
}


function LuGuildEventGroup({ phase, events, emptyText, onOpenGuild, onOpenEvent }) {
    const meta = LU_GE_PHASE_META[phase];
    return React.createElement("div", { className: "lu-ge-group" },
        React.createElement("div", { className: "lu-ge-group-title" },
            React.createElement("span", { className: "lu-ge-group-dot", style: { background: meta.color } }),
            `${meta.label} (${events.length})`),
        events.length
            ? React.createElement("div", { className: "lu-ge-shelf" }, events.map((ev) => React.createElement(LuGuildEventCard, { key: ev.id, ev, phase, onOpenGuild, onOpenEvent })))
            : React.createElement("div", { className: "lu-ge-empty" }, emptyText));
}


const LU_GE_STATUS_PHASE = { published: 'upcoming', active: 'active', completed: 'completed' };


// Adapts a real, backend row (fetchPublicGuildEvents — see
// 51_migration_public_guild_events_directory.sql) into the exact shape LuGuildEventCard already
// renders, so the card itself doesn't need to know real from simulated. `real: true` is what
// gates the card/guild-name actually being clickable — see LuGuildEventCard above.
function luAdaptRealGuildEvent(ev) {
    return {
        ...ev, real: true,
        icon: 'trophy', guildIcon: 'castle',
        cover: ev.coverImageUrl ? `url(${ev.coverImageUrl}) center/cover` : 'linear-gradient(155deg, #B08D5766, #221A24 55%, #14131A 90%)',
    };
}


export function LivingUniverseScreen({ onRead, onOpenAuthor, onOpenGuild, onOpenEvent }) {
    const entries = useLivingUniverseFeed();
    const trending = useLuTrending();
    const localGuildEventsVisible = useLuGuildEvents() || [];
    // Real, server-computed Guild Events (see 51_migration_public_guild_events_directory.sql) —
    // only approved-and-published (or later: active/completed) events, exactly the same
    // "approved AND published" gate the local simulation below has always enforced, now enforced
    // server-side instead. Same null/[] loading convention as every other real section on this
    // screen: null = not loaded yet, [] = loaded but genuinely empty. The local, device-only
    // simulation (useLuGuildEvents) stays as the fallback for either case.
    const [remoteGuildEvents, setRemoteGuildEvents] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchPublicGuildEvents({ limit: 24 }).then((rows) => { if (!cancelled) setRemoteGuildEvents(rows); });
        return () => { cancelled = true; };
    }, []);
    const guildEventsAreReal = !!(remoteGuildEvents && remoteGuildEvents.length);
    const guildEventsVisible = guildEventsAreReal ? remoteGuildEvents.map(luAdaptRealGuildEvent) : localGuildEventsVisible;
    const [visibleCount, setVisibleCount] = useState(10);
    const lastSeenIds = useRef(new Set());
    const risingStars = useLuRisingStars(entries || []);
    // Real, server-computed Rising Star ranking (see supabase/history/38_migration_rising_star_scoring.sql) —
    // recent momentum only, never a lifetime total, scored and anti-gamed entirely server-side.
    // null = not loaded yet (signed out, offline, or still in flight); [] = loaded but empty.
    // The local chronicle-derived `risingStars` above stays as the fallback for either case, same
    // "honest when there's nothing real yet" pattern the rest of this screen already follows.
    const [remoteRisingStars, setRemoteRisingStars] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchRisingStars({ limit: 6 }).then((rows) => { if (!cancelled) setRemoteRisingStars(rows); });
        return () => { cancelled = true; };
    }, []);
    const risingStarsAreReal = !!(remoteRisingStars && remoteRisingStars.length);
    const bestSellers = useLuBestSellers(entries || []);
    const mostRead = useLuMostRead(entries || []);
    // Real, server-computed rankings (see supabase/history/39_migration_best_sellers_most_read.sql) —
    // verified purchases / verified reads, recency-weighted, never a lifetime total and never
    // editable by an author or guild. Same null/[] loading convention as remoteRisingStars below:
    // the local Chronicle-derived versions above stay as the fallback either way.
    const [remoteBestSellers, setRemoteBestSellers] = useState(null);
    const [remoteMostRead, setRemoteMostRead] = useState(null);
    // Real, server-computed Trending (see supabase/history/64_migration_trending.sql) —
    // deliberately a lighter, faster-moving signal than Best Sellers/Most Read above (short
    // window, unverified view/read-start activity rather than verified purchases/reads). Same
    // null/[] loading convention; useLuTrending (fully simulated — see its own header) stays the
    // fallback either way, same as every other section here.
    const [remoteTrending, setRemoteTrending] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchBestSellers({ limit: 5 }).then((rows) => { if (!cancelled) setRemoteBestSellers(rows); });
        fetchMostRead({ limit: 5 }).then((rows) => { if (!cancelled) setRemoteMostRead(rows); });
        fetchTrending({ limit: 5 }).then((rows) => { if (!cancelled) setRemoteTrending(rows); });
        return () => { cancelled = true; };
    }, []);
    const bestSellersAreReal = !!(remoteBestSellers && remoteBestSellers.length);
    const mostReadAreReal = !!(remoteMostRead && remoteMostRead.length);
    const trendingIsReal = !!(remoteTrending && remoteTrending.length);
    // Real, server-computed Guilds on the Rise (see
    // supabase/history/40_migration_guilds_on_rise_scoring.sql) — recent Player Guild momentum
    // only, never guild size, scored and anti-gamed entirely server-side. Same null/[] loading
    // convention as the rankings above: the local Founder-Guild-events fallback below
    // (useLuGuildsOnRise) covers either case.
    const [remoteGuildsOnRise, setRemoteGuildsOnRise] = useState(null);
    useEffect(() => {
        let cancelled = false;
        fetchGuildsOnRise({ limit: 4 }).then((rows) => { if (!cancelled) setRemoteGuildsOnRise(rows); });
        return () => { cancelled = true; };
    }, []);
    const guildsOnRiseAreReal = !!(remoteGuildsOnRise && remoteGuildsOnRise.length);
    const guildsOnRise = useLuGuildsOnRise(guildEventsVisible);
    // Whether ANY section on this screen is currently showing real, server-computed data rather
    // than the on-device Chronicle simulation — used only to keep the page's own top/bottom
    // messaging honest. Individual sections already say "real" vs "preview" for themselves (see
    // each *AreReal flag above); this just stops the page-level banner and footer from flatly
    // claiming "no shared backend" while some of the numbers on screen are, in fact, real.
    const anyLiveData = guildEventsAreReal || risingStarsAreReal || bestSellersAreReal || mostReadAreReal || trendingIsReal || guildsOnRiseAreReal;
    const newAndNotable = useLuNewAndNotable(entries || []);
    const recentAchievements = useLuRecentAchievements(entries || []);

    const weekNumber = Math.floor(Date.now() / (1000 * 60 * 60 * 24 * 7));
    const spotlight = React.useMemo(() => {
        const author = LU_AUTHORS[weekNumber % LU_AUTHORS.length];
        const guild = FOUNDER_GUILDS[weekNumber % FOUNDER_GUILDS.length];
        const bookPool = LU_BOOK_TITLES[guild.id] || LU_BOOK_TITLES.general;
        const book = bookPool[weekNumber % bookPool.length];
        return { author, guild, book };
    }, [weekNumber]);
    const featuredAuthors = React.useMemo(() => {
        return [...LU_AUTHORS].sort(() => Math.random() - 0.5).slice(0, 6).map((name) => {
            const rank = luPick(WRITER_RANKS.slice(1));
            const guild = luPick(FOUNDER_GUILDS);
            const bookPool = LU_BOOK_TITLES[guild.id] || LU_BOOK_TITLES.general;
            return { name, rank, blurb: `Known for \u201C${luPick(bookPool)}\u201D` };
        });
    }, []);

    if (!entries) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Opening the Chronicle\u2026");
    }
    const newIds = new Set();
    entries.forEach((e) => { if (!lastSeenIds.current.has(e.id) && Date.now() - e.ts < 20000) newIds.add(e.id); });
    entries.forEach((e) => lastSeenIds.current.add(e.id));

    const releases = entries.filter((e) => e.kind === 'release').slice(0, 8);
    const worldPackEntries = entries.filter((e) => e.kind === 'worldpack');
    const worldPacks = (worldPackEntries.length ? worldPackEntries : LU_WORLD_PACKS.slice(0, 6).map((p) => ({ id: uuid(), pack: p }))).slice(0, 6);
    const guildEvents = entries.filter((e) => e.kind === 'guild' || e.kind === 'anthology').slice(0, 4);
    const readerEvents = entries.filter((e) => e.kind === 'reader').slice(0, 6);
    const publishedToday = entries.filter((e) => e.kind === 'release' && Date.now() - e.ts < 1000 * 60 * 60 * 24).length;

    // Only approved and published Guild Events ever reach this screen — real rows are gated
    // server-side (see fetchPublicGuildEvents/list_public_guild_events), local-simulation rows by
    // useLuGuildEvents. Real rows use their own approval_status for phase (published/active/
    // completed) rather than the local simulation's time-based guess, since an organizer's own
    // publish/activate/complete timing is the actual source of truth once it's real.
    const geNow = Date.now();
    const gePhase = (e) => (e.real ? (LU_GE_STATUS_PHASE[e.approvalStatus] || 'upcoming') : luGuildEventPhase(e, geNow));
    const upcomingGuildEvents = guildEventsVisible.filter((e) => gePhase(e) === 'upcoming').sort((a, b) => a.startAt - b.startAt);
    const activeGuildEvents = guildEventsVisible.filter((e) => gePhase(e) === 'active').sort((a, b) => a.endAt - b.endAt);
    const completedGuildEvents = guildEventsVisible.filter((e) => gePhase(e) === 'completed').sort((a, b) => b.endAt - a.endAt).slice(0, 6);

    return React.createElement("div", { className: "ink-page-in lu-universe" },
        React.createElement("style", null, `
            /* ---------- Atmosphere ----------
               The whole screen is one continuous sky: a charcoal base with slow-fading pockets
               of midnight blue, forest green and muted burgundy standing in for distant realms,
               plus a scattered field of faint gold-and-parchment star flecks that repeats down
               the entire scroll length, not just the first viewport. Pure layered CSS gradients
               on the root element itself \u2014 no extra DOM, no fixed/absolute layers, so it can
               never sit on top of (or get clipped away from) the real content. */
            .lu-universe{
                --lu-gold:#E8C468; --lu-gold-dim:#B08D57; --lu-parchment:#EFE7D2;
                --lu-ink:#8A8680; --lu-ink-soft:#6E6A63; --lu-hair:rgba(232,196,104,0.14);
                position:relative;
                background-color:#131218;
                background-image:
                    radial-gradient(1.4px 1.4px at 8% 6%, rgba(239,231,210,0.55), transparent 60%),
                    radial-gradient(1px 1px at 34% 18%, rgba(239,231,210,0.35), transparent 60%),
                    radial-gradient(1.6px 1.6px at 68% 9%, rgba(232,196,104,0.55), transparent 60%),
                    radial-gradient(1px 1px at 88% 27%, rgba(239,231,210,0.4), transparent 60%),
                    radial-gradient(1.2px 1.2px at 18% 42%, rgba(239,231,210,0.3), transparent 60%),
                    radial-gradient(1px 1px at 52% 58%, rgba(239,231,210,0.4), transparent 60%),
                    radial-gradient(1.5px 1.5px at 77% 63%, rgba(232,196,104,0.4), transparent 60%),
                    radial-gradient(1px 1px at 12% 78%, rgba(239,231,210,0.32), transparent 60%),
                    radial-gradient(1.3px 1.3px at 61% 88%, rgba(239,231,210,0.4), transparent 60%),
                    radial-gradient(ellipse 60% 34% at 12% 6%, rgba(59,90,69,0.22), transparent 68%),
                    radial-gradient(ellipse 55% 30% at 92% 14%, rgba(110,59,66,0.20), transparent 68%),
                    radial-gradient(ellipse 72% 42% at 50% 40%, rgba(35,44,66,0.32), transparent 70%),
                    radial-gradient(ellipse 58% 32% at 16% 76%, rgba(59,90,69,0.16), transparent 68%),
                    radial-gradient(ellipse 60% 34% at 88% 86%, rgba(110,59,66,0.18), transparent 68%),
                    linear-gradient(180deg, #121017 0%, #14161F 26%, #101319 52%, #14121A 78%, #100F14 100%);
                background-repeat:repeat,repeat,repeat,repeat,repeat,repeat,repeat,repeat,repeat,no-repeat,no-repeat,no-repeat,no-repeat,no-repeat,no-repeat;
                background-size:260px 260px,300px 300px,340px 340px,280px 280px,320px 320px,260px 260px,300px 300px,340px 340px,280px 280px,auto,auto,auto,auto,auto,auto;
            }
            /* Hero: two overlapping mountain-ridge silhouettes at different tones give the title
               a sense of standing above vast, layered, receding terrain. */
            .lu-hero{position:relative;padding:8px 4px 40px;}
            .lu-hero::before,.lu-hero::after{content:'';position:absolute;left:-8%;right:-8%;bottom:-4px;pointer-events:none;background-repeat:no-repeat;background-size:100% 100%;}
            .lu-hero::before{height:96px;opacity:0.5;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 140' preserveAspectRatio='none'%3E%3Cpath d='M0 140 L0 92 L60 56 L130 96 L200 42 L270 86 L340 50 L410 100 L480 60 L560 96 L640 46 L720 90 L800 62 L800 140 Z' fill='%23202538'/%3E%3C/svg%3E");}
            .lu-hero::after{height:58px;opacity:0.8;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 90' preserveAspectRatio='none'%3E%3Cpath d='M0 90 L0 60 L90 30 L170 62 L250 22 L330 58 L420 18 L500 55 L590 25 L680 60 L760 30 L800 50 L800 90 Z' fill='%230D0F14'/%3E%3C/svg%3E");}
            .lu-hero > *{position:relative;z-index:1;}
            .lu-eyebrow{display:flex;align-items:center;gap: 12px;margin:0 0 14px;}
            .lu-tag{display:flex;align-items:center;gap: 8px;font-size:10.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--lu-eyebrow-color,#E8C468);white-space:nowrap;font-family:'Fraunces',Georgia,serif;}
            .lu-rule{flex:1;height:1px;background:linear-gradient(90deg, var(--lu-eyebrow-color,#E8C468), rgba(232,196,104,0.1) 30%, transparent);opacity:0.55;}
            .lu-title{font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:19px;font-weight:600;margin:0 0 4px;color:var(--lu-parchment);text-shadow:0 1px 12px rgba(0,0,0,0.5);}
            .lu-sub{color:var(--lu-ink);font-size:12px;margin:0 0 18px;line-height:1.6;}
            .lu-section{margin-bottom:44px;}
            .lu-chronicle{position:relative;padding-left:30px;}
            .lu-chronicle::before{content:'';position:absolute;left:8px;top:4px;bottom:4px;width:1px;background:linear-gradient(to bottom, rgba(232,196,104,0.5), rgba(35,44,66,0.5) 12%, rgba(35,44,66,0.5) 88%, transparent);}
            .lu-entry{position:relative;padding-bottom:20px;}
            .lu-entry:last-child{padding-bottom:0;}
            .lu-entry-seal{position:absolute;left:-30px;top:0px;width:18px;height:18px;border-radius:50%;border:1.5px solid var(--lu-seal-color,#B08D57);background:#14121A;display:flex;align-items:center;justify-content:center;font-size:9.5px;box-shadow:0 0 0 4px rgba(16,15,20,0.88);}
            /* A slow pulse on the chronicle's most recent seal only \u2014 the one visual cue that
               says "this world is updating right now" without animating the whole timeline.
               Folds into the shared reduced-motion rule in app.css like every other animation. */
            @keyframes luLiveSealPulse{0%,100%{box-shadow:0 0 0 4px rgba(16,15,20,0.88);}50%{box-shadow:0 0 0 4px rgba(16,15,20,0.88),0 0 8px 1px var(--lu-seal-color,#B08D57);}}
            .lu-entry:first-child .lu-entry-seal{animation:luLiveSealPulse 2.6s ease-in-out infinite;}
            @media (max-width: 359px) {
                .lu-title{font-size:17px;}
                .lu-section{margin-bottom:34px;}
            }
            .lu-entry-title{font-family:'Fraunces',Georgia,serif;font-size:14px;color:var(--lu-parchment);line-height:1.5;}
            .lu-entry-time{font-size:10px;color:var(--lu-ink-soft);white-space:nowrap;margin-left:8px;}
            .lu-entry-sub{font-size:11.5px;color:var(--lu-ink);margin-top:2px;}
            @keyframes luInkIn{0%{opacity:0;transform:translateY(-6px);}100%{opacity:1;transform:translateY(0);}}
            .lu-entry-new{animation:luInkIn 700ms var(--ink-ease);}
            .lu-shelf{display:flex;gap: 12px;overflow-x:auto;padding:6px 2px 10px;-webkit-overflow-scrolling:touch;}
            .lu-book{flex:0 0 128px;}
            .lu-book-cover{width:128px;height:180px;border-radius:6px;position:relative;overflow:hidden;display:flex;align-items:flex-end;padding:11px;box-shadow:0 10px 22px rgba(0,0,0,0.5), inset 0 0 0 1px rgba(232,196,104,0.1);}
            .lu-book-cover::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,0.68) 100%);}
            .lu-book-title{position:relative;font-family:'Fraunces',Georgia,serif;font-style:italic;font-weight:600;font-size:12px;line-height:1.28;color:#F4EEDD;z-index:1;}
            .lu-book-meta{margin-top:7px;font-size:10.5px;color:var(--lu-ink);}
            .lu-trend-row{display:flex;align-items:center;gap: 12px;padding:11px 2px;border-bottom:1px solid var(--lu-hair);}
            .lu-trend-rank{width:20px;font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:15px;color:var(--lu-ink-soft);flex-shrink:0;text-align:center;}
            .lu-trend-title{font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:13.5px;color:var(--lu-parchment);}
            .lu-trend-author{font-size:11px;color:var(--lu-ink);margin-top:1px;}
            .lu-trend-move{font-size:11px;flex-shrink:0;}
            /* ---------- World surfaces ----------
               Every card below shares one idea: a weathered stone-and-parchment plaque, not a
               flat SaaS tile \u2014 a soft top sheen, a deep carved shadow along the bottom edge,
               a hairline gold border, and a faint tint of forest/burgundy/midnight standing in
               for the region of the universe each card belongs to. */
            .lu-pack{flex:0 0 178px;position:relative;border:1px solid rgba(232,196,104,0.14);border-radius:10px;padding:16px;
                background:radial-gradient(120% 160% at 15% -10%, rgba(232,196,104,0.05), transparent 50%), linear-gradient(165deg, rgba(59,90,69,0.18) 0%, rgba(30,26,34,0.55) 50%, rgba(19,18,22,0.94) 100%);
                box-shadow:inset 0 1px 0 rgba(255,255,255,0.03), inset 0 -14px 20px -16px rgba(0,0,0,0.65), 0 8px 16px rgba(0,0,0,0.32);}
            .lu-pack h4{font-family:'Fraunces',Georgia,serif;font-size:13.5px;margin:0 0 5px;color:var(--lu-parchment);}
            .lu-pack p{font-size:11px;color:var(--lu-ink);margin:0;line-height:1.5;}
            .lu-pack-tags{margin-top:9px;display:flex;gap: 6px;flex-wrap:wrap;}
            .lu-pack-tag{font-size:9px;color:#B7A3E0;border:1px solid rgba(161,132,214,0.3);padding:2px 6px;border-radius:100px;}
            .lu-guild-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap: 14px 10px;margin-top:8px;}
            .lu-guild-card{position:relative;border:1px solid rgba(232,196,104,0.15);border-radius:10px;padding:18px 16px 16px;
                background:radial-gradient(130% 170% at 20% -20%, rgba(232,196,104,0.06), transparent 50%), linear-gradient(165deg, rgba(110,59,66,0.16) 0%, rgba(35,44,66,0.18) 45%, rgba(19,18,22,0.94) 100%);
                box-shadow:inset 0 1px 0 rgba(255,255,255,0.03), inset 0 -14px 22px -16px rgba(0,0,0,0.65), 0 8px 16px rgba(0,0,0,0.32);
                transition:border-color var(--ink-dur) var(--ink-ease);}
            .lu-guild-card:hover{border-color:rgba(232,196,104,0.4);}
            /* A small waypoint marker \u2014 a lit gold pin above each card \u2014 so the guild-halls,
               rising realms and new-and-notable grids read as pinned locations on a map of the
               universe rather than plain dashboard tiles. */
            .lu-guild-card::before{content:'';position:absolute;top:-8px;left:25px;width:1px;height:8px;background:linear-gradient(to bottom, transparent, var(--lu-gold));opacity:0.75;}
            .lu-guild-card::after{content:'';position:absolute;top:-11px;left:24px;width:3px;height:3px;border-radius:50%;background:var(--lu-gold);box-shadow:0 0 6px 1px rgba(232,196,104,0.6);}
            .lu-guild-head{display:flex;align-items:center;gap: 10px;margin-bottom:8px;}
            .lu-guild-icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;background:radial-gradient(circle at 34% 28%, rgba(232,196,104,0.22), rgba(20,18,26,0.9) 75%);border:1px solid rgba(232,196,104,0.3);flex-shrink:0;}
            .lu-guild-name{font-family:'Fraunces',Georgia,serif;font-size:13px;color:var(--lu-parchment);}
            .lu-guild-card p{font-size:11.5px;color:var(--lu-ink);margin:0;line-height:1.5;}
            .lu-guild-time{margin-top:8px;font-size:9.5px;color:var(--lu-ink-soft);}
            .lu-author{flex:0 0 152px;text-align:center;padding:20px 12px 16px;position:relative;border:1px solid rgba(232,196,104,0.14);border-radius:12px;
                background:radial-gradient(140% 160% at 50% -20%, rgba(232,196,104,0.06), transparent 55%), linear-gradient(180deg, rgba(35,44,66,0.24) 0%, rgba(19,18,22,0.94) 72%);
                box-shadow:inset 0 1px 0 rgba(255,255,255,0.03), inset 0 -14px 20px -16px rgba(0,0,0,0.65), 0 8px 16px rgba(0,0,0,0.32);}
            .lu-author-avatar{width:46px;height:46px;border-radius:50%;margin:0 auto 10px;display:flex;align-items:center;justify-content:center;font-family:'Fraunces',Georgia,serif;font-size:16px;font-weight:600;background:radial-gradient(circle at 35% 30%, rgba(232,196,104,0.2), #14121A 72%);}
            .lu-author h4{font-family:'Fraunces',Georgia,serif;font-style:italic;font-size:13px;margin:0 0 3px;color:var(--lu-parchment);}
            .lu-author .lu-a-rank{font-size:10px;margin-bottom:6px;}
            .lu-author .lu-a-blurb{font-size:10.5px;color:var(--lu-ink);line-height:1.4;}
            .lu-reader-row{display:flex;align-items:center;gap: 10px;padding:9px 0;border-bottom:1px solid var(--lu-hair);}
            .lu-reader-row:last-child{border-bottom:none;}
            .lu-reader-dot{width:5px;height:5px;border-radius:50%;background:#7FB2C9;flex-shrink:0;box-shadow:0 0 4px 1px rgba(127,178,201,0.5);}
            .lu-reader-text{font-size:12px;color:var(--lu-ink);}
            .lu-reader-time{margin-left:auto;font-size:9.5px;color:var(--lu-ink-soft);flex-shrink:0;}
            .lu-ge-group{margin-bottom:22px;}
            .lu-ge-group:last-child{margin-bottom:0;}
            .lu-ge-group-title{display:flex;align-items:center;gap: 8px;font-size:11px;text-transform:uppercase;letter-spacing:0.08em;color:var(--lu-ink);margin:0 0 10px;}
            .lu-ge-group-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0;}
            .lu-ge-shelf{display:flex;gap: 12px;overflow-x:auto;padding:6px 2px 10px;-webkit-overflow-scrolling:touch;}
            .lu-ge-card{flex:0 0 220px;position:relative;border:1px solid rgba(232,196,104,0.16);border-radius:12px;overflow:hidden;
                background:linear-gradient(180deg, rgba(35,44,66,0.18) 0%, rgba(19,18,22,0.95) 55%);
                box-shadow:inset 0 1px 0 rgba(255,255,255,0.03), 0 10px 18px rgba(0,0,0,0.38);}
            .lu-ge-cover{height:84px;position:relative;display:flex;align-items:flex-end;padding:10px 12px;}
            .lu-ge-cover::after{content:'';position:absolute;inset:0;background:linear-gradient(180deg,rgba(0,0,0,0) 30%,rgba(0,0,0,0.68) 100%);}
            .lu-ge-cover-badge{position:absolute;top:9px;right:10px;font-size:14px;z-index:1;}
            .lu-ge-cover-title{position:relative;font-family:'Fraunces',Georgia,serif;font-weight:600;font-size:12.5px;line-height:1.3;color:#F4EEDD;z-index:1;}
            .lu-ge-body{padding:11px 12px 13px;}
            .lu-ge-guild{display:flex;align-items:center;gap: 6px;font-size:10.5px;color:var(--lu-ink);margin-bottom:9px;}
            .lu-ge-stats{display:grid;grid-template-columns:1fr 1fr;gap: 8px 10px;}
            .lu-ge-stat-label{font-size:8.5px;text-transform:uppercase;letter-spacing:0.05em;color:var(--lu-ink-soft);}
            .lu-ge-stat-value{font-size:11.5px;color:var(--lu-parchment);margin-top:1px;}
            .lu-ge-dates{margin-top:9px;padding-top:9px;border-top:1px solid var(--lu-hair);font-size:10px;color:var(--lu-ink);}
            .lu-ge-empty{font-size:11.5px;color:var(--lu-ink-soft);padding:6px 2px 2px;}
        `),
        React.createElement("div", { className: "lu-hero", style: { textAlign: 'center', marginBottom: 30 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], letterSpacing: '0.18em', textTransform: 'uppercase', color: '#5C5C64', marginBottom: 12 } },
                anyLiveData ? "Live where available \u00B7 preview elsewhere" : "Preview \u00B7 device-local"),
            React.createElement("h1", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontWeight: 600, fontSize: TYPE_SCALE[32], margin: '0 0 12px', color: '#EFE7D2' } }, "The Living Universe"),
            React.createElement("p", { style: { maxWidth: 440, margin: '0 auto', color: '#8A8680', fontSize: TYPE_SCALE[13.5], lineHeight: 1.6 } },
                "Every book, rank, and milestone across Inkroot \u2014 gathered as one continuous chronicle."),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'center', gap: SPACE_SCALE[22], marginTop: 24, flexWrap: 'wrap' } },
                React.createElement("div", { style: { textAlign: 'center' } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#E8C468' } }, publishedToday),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 } }, "Published today")),
                React.createElement("div", { style: { textAlign: 'center' } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#E8C468' } }, FOUNDER_GUILDS.length),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 } }, "Guild halls")),
                React.createElement("div", { style: { textAlign: 'center' } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#E8C468' } }, entries.length),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 2 } }, "Chronicle entries")))),

        React.createElement("div", { className: "lu-section", style: {
                position: 'relative', borderRadius: RADIUS_SCALE[14], border: '1px solid rgba(232,196,104,0.32)',
                background: 'linear-gradient(160deg, #241D14 0%, #211A24 45%, #171821 100%)', padding: '24px 22px',
                display: 'flex', gap: SPACE_SCALE[18], alignItems: 'center', boxShadow: '0 0 26px 2px rgba(232,196,104,0.14)',
            } },
            React.createElement("div", { style: {
                    flexShrink: 0, width: 58, height: 58, borderRadius: '50%', border: '2px solid #E8C468',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[24],
                    background: 'radial-gradient(circle at 34% 28%, rgba(232,196,104,0.4), #17140F 72%)',
                } }, spotlight.guild.icon),
            React.createElement("div", null,
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.16em', textTransform: 'uppercase', color: '#E8C468', marginBottom: 6 } }, "Weekly Spotlight"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontWeight: 600, fontSize: TYPE_SCALE[18], color: '#EFE7D2', marginBottom: 4 } }, spotlight.author),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8A8680', lineHeight: 1.55 } },
                    `Author of \u201C${spotlight.book}\u201D, chosen this week from ${spotlight.guild.name}.`))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "The Chronicle", title: "Written as it happens", color: '#E8C468',
                sub: "Rank ascensions, milestones, achievements, guild news, and new pages, in the order they were written." }),
            React.createElement("div", { className: "lu-chronicle" },
                entries.slice(0, visibleCount).map((e) => React.createElement("div", {
                    key: e.id, className: `lu-entry ${newIds.has(e.id) ? 'lu-entry-new' : ''}`, style: { '--lu-seal-color': e.color },
                },
                    React.createElement("div", { className: "lu-entry-seal" }, React.createElement(LuGlyph, { value: e.seal, size: 10.5 })),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap' } },
                        React.createElement("div", { className: "lu-entry-title" }, e.title),
                        React.createElement("div", { className: "lu-entry-time" }, luTimeAgo(e.ts))),
                    e.sub && React.createElement("div", { className: "lu-entry-sub" }, e.sub)))),
            visibleCount < entries.length && React.createElement("button", {
                onClick: () => setVisibleCount((v) => v + 10),
                style: { marginTop: 4, background: 'rgba(19,18,22,0.6)', border: '1px solid rgba(232,196,104,0.25)', color: '#C9BFA8', fontSize: TYPE_SCALE[12], padding: '8px 14px', borderRadius: RADIUS_SCALE[100], cursor: 'pointer' },
            }, "Read further back")),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "New Releases", title: "Fresh off the press", color: '#B08D57', sub: "Newly published books, newest first." }),
            React.createElement("div", { className: "lu-shelf" },
                releases.map((e) => React.createElement("div", { className: "lu-book", key: e.id },
                    React.createElement("div", { className: "lu-book-cover", style: { background: `linear-gradient(155deg, ${e.color}55, #17151B 70%)` } },
                        React.createElement("div", { className: "lu-book-title" }, e.book)),
                    React.createElement("div", { className: "lu-book-meta" }, e.author))))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Trending Now", icon: "flame", title: trendingIsReal ? "Real, short-window buzz" : "What readers are turning to", color: '#8FA37A',
                sub: trendingIsReal
                    ? "Ranked by real view/read-start activity over the last few days \u2014 a lighter, faster-moving signal than Best Sellers' verified sales and Most Read's verified reads below."
                    : "A lighter-weight buzz signal across the guild halls \u2014 distinct from Best Sellers' verified sales and Most Read's verified reads below." }),
            trendingIsReal
                ? remoteTrending.map((b, i) => React.createElement("div", {
                        className: "lu-trend-row", key: b.bookId,
                        style: onRead ? { cursor: 'pointer' } : undefined,
                        onClick: onRead ? () => onRead(b.bookId) : undefined,
                    },
                    React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { className: "lu-trend-title" }, b.title),
                        React.createElement("div", { className: "lu-trend-author" }, `${b.authorName} \u00B7 ${luGuildNameForGenre(b.genre)} \u00B7 ${b.distinctSignedInViewers} viewer${b.distinctSignedInViewers === 1 ? '' : 's'}`)),
                    React.createElement("div", { className: "lu-trend-move", style: { color: '#8FA37A' } }, `${b.viewEvents}\u00D7`)))
                : trending.map((b, i) => React.createElement("div", { className: "lu-trend-row", key: b.id },
                    React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { className: "lu-trend-title" }, b.title),
                        React.createElement("div", { className: "lu-trend-author" }, `${b.author} \u00B7 ${b.genreLabel}`)),
                    React.createElement("div", { className: "lu-trend-move", style: { color: i < 2 ? '#8FA37A' : i > 3 ? '#B8735C' : '#5C5C64' } },
                        `${i < 2 ? '\u25B2' : i > 3 ? '\u25BC' : '\u2014'} ${Math.round(b.score)}`)))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "New World Packs", title: "The Atlas keeps growing", color: '#A184D6', sub: "Newly entered regions, bestiaries, and magic systems." }),
            React.createElement("div", { className: "lu-shelf" },
                worldPacks.map((w) => {
                    const p = w.pack || luPick(LU_WORLD_PACKS);
                    return React.createElement("div", { className: "lu-pack", key: w.id },
                        React.createElement("h4", null, p.name),
                        React.createElement("p", null, "Newly catalogued in the Atlas."),
                        React.createElement("div", { className: "lu-pack-tags" }, p.tags.map((t) => React.createElement("span", { className: "lu-pack-tag", key: t }, t))));
                }))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Guild Halls & Anthologies", title: "News from the halls", color: '#C89B3C', sub: "Announcements and anthology releases from every Founder Guild." }),
            React.createElement("div", { className: "lu-guild-grid" },
                (guildEvents.length ? guildEvents : FOUNDER_GUILDS.slice(0, 4).map((g) => ({ id: uuid(), seal: luIconKey(g.icon), title: g.motto, ts: Date.now(), tag: g.name }))).map((e) =>
                    React.createElement("div", { className: "lu-guild-card", key: e.id },
                        React.createElement("div", { className: "lu-guild-head" },
                            React.createElement("div", { className: "lu-guild-icon" }, React.createElement(LuGlyph, { value: e.seal, size: 15 })),
                            React.createElement("div", { className: "lu-guild-name" }, e.tag || 'Guild Hall')),
                        React.createElement("p", null, e.title),
                        React.createElement("div", { className: "lu-guild-time" }, luTimeAgo(e.ts)))))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Guild Events", icon: "trophy", title: "Contests, sprints, and championships", color: '#B8735C',
                sub: guildEventsAreReal
                    ? "Real events across every guild \u2014 only ones a guild has approved and published ever appear here."
                    : "Only events a guild has approved and published appear here." }),
            React.createElement(LuGuildEventGroup, { phase: "upcoming", events: upcomingGuildEvents, emptyText: "No upcoming events right now \u2014 check back soon.", onOpenGuild, onOpenEvent }),
            React.createElement(LuGuildEventGroup, { phase: "active", events: activeGuildEvents, emptyText: "No events are running at the moment.", onOpenGuild, onOpenEvent }),
            React.createElement(LuGuildEventGroup, { phase: "completed", events: completedGuildEvents, emptyText: "No events have wrapped up yet.", onOpenGuild, onOpenEvent })),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Rising Stars", icon: "chart", title: "Writers on the ascent", color: '#C89B3C',
                sub: risingStarsAreReal
                    ? "Recent momentum \u2014 reads, followers, and engagement gained this week, not lifetime totals. Computed and anti-gamed server-side."
                    : "Authors who\u2019ve climbed a Writer Rank most recently, straight from the Chronicle." }),
            risingStarsAreReal
                ? remoteRisingStars.map((s, i) => React.createElement("div", {
                        className: "lu-trend-row", key: s.authorId,
                        style: onOpenAuthor ? { cursor: 'pointer' } : undefined,
                        onClick: onOpenAuthor ? () => onOpenAuthor(s.name, s.authorId) : undefined,
                    },
                    React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { className: "lu-trend-title" }, s.name),
                        React.createElement("div", { className: "lu-trend-author" },
                            [
                                s.recentUniqueReaders > 0 && `${s.recentUniqueReaders} reader${s.recentUniqueReaders === 1 ? '' : 's'} this week`,
                                s.followersGained > 0 && `+${s.followersGained} follower${s.followersGained === 1 ? '' : 's'}`,
                                s.recentPublishes > 0 && `${s.recentPublishes} new release${s.recentPublishes === 1 ? '' : 's'}`,
                            ].filter(Boolean).join(' \u00B7 ') || 'Gaining ground')),
                    React.createElement("div", { className: "lu-trend-move", style: { color: '#C89B3C' } }, s.readingGrowth > 0 ? `\u2191${s.readingGrowth}` : '\u2014')))
                : (risingStars.length
                    ? risingStars.map((e, i) => React.createElement("div", { className: "lu-trend-row", key: e.id },
                        React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                            React.createElement("div", { className: "lu-trend-title" }, e.author),
                            React.createElement("div", { className: "lu-trend-author" }, `Ascended to ${e.seal} ${e.rankName}`)),
                        React.createElement("div", { className: "lu-trend-move", style: { color: e.color } }, luTimeAgo(e.ts))))
                    : React.createElement("div", { className: "lu-ge-empty" }, "No rank ascensions chronicled yet."))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Best Sellers", icon: "crown", title: bestSellersAreReal ? "Verified sales, weighted toward now" : "Most-chronicled releases", color: '#E8C468',
                sub: bestSellersAreReal
                    ? "Ranked by real, verified purchases \u2014 weighted toward recent sales, not a lifetime total. A book has to actually be bought, by more than a couple of people, to appear here."
                    : "Ranked by how often a title has been chronicled as a new release." }),
            bestSellersAreReal
                ? remoteBestSellers.map((b, i) => React.createElement("div", {
                        className: "lu-trend-row", key: b.bookId,
                        style: onRead ? { cursor: 'pointer' } : undefined,
                        onClick: onRead ? () => onRead(b.bookId) : undefined,
                    },
                    React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { className: "lu-trend-title" }, b.title),
                        React.createElement("div", { className: "lu-trend-author" }, `${b.authorName} \u00B7 ${luGuildNameForGenre(b.genre)} \u00B7 ${b.distinctBuyers} buyer${b.distinctBuyers === 1 ? '' : 's'}`)),
                    React.createElement("div", { className: "lu-trend-move", style: { color: '#E8C468' } }, formatNaira(koboToNaira(b.verifiedRevenueKobo)))))
                : (bestSellers.length
                    ? bestSellers.map((b, i) => React.createElement("div", { className: "lu-trend-row", key: b.book },
                        React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                            React.createElement("div", { className: "lu-trend-title" }, b.book),
                            React.createElement("div", { className: "lu-trend-author" }, `${b.author} \u00B7 ${luGuildNameForGenre(b.genre)}`)),
                        React.createElement("div", { className: "lu-trend-move", style: { color: '#E8C468' } }, `${b.count}\u00D7`)))
                    : React.createElement("div", { className: "lu-ge-empty" }, "No releases chronicled yet."))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Most Read", icon: "library", title: mostReadAreReal ? "Verified reads, weighted toward now" : "Where readers are spending their time", color: '#7FB2C9',
                sub: mostReadAreReal
                    ? "Ranked by real, verified reader opens \u2014 completely separate from Best Sellers: a free sample can top this list without a single sale."
                    : "Ranked by reader-activity entries in the Chronicle." }),
            mostReadAreReal
                ? remoteMostRead.map((b, i) => React.createElement("div", {
                        className: "lu-trend-row", key: b.bookId,
                        style: onRead ? { cursor: 'pointer' } : undefined,
                        onClick: onRead ? () => onRead(b.bookId) : undefined,
                    },
                    React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                    React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                        React.createElement("div", { className: "lu-trend-title" }, b.title),
                        React.createElement("div", { className: "lu-trend-author" }, `${b.authorName} \u00B7 ${b.distinctReaders} reader${b.distinctReaders === 1 ? '' : 's'}`)),
                    React.createElement("div", { className: "lu-trend-move", style: { color: '#7FB2C9' } }, `${b.verifiedReadEvents}\u00D7`)))
                : (mostRead.length
                    ? mostRead.map((b, i) => React.createElement("div", { className: "lu-trend-row", key: b.book },
                        React.createElement("div", { className: "lu-trend-rank" }, i + 1),
                        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                            React.createElement("div", { className: "lu-trend-title" }, b.book),
                            React.createElement("div", { className: "lu-trend-author" }, "Reader activity")),
                        React.createElement("div", { className: "lu-trend-move", style: { color: '#7FB2C9' } }, `${b.count}\u00D7`)))
                    : React.createElement("div", { className: "lu-ge-empty" }, "No reader activity chronicled yet."))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Guilds on the Rise", icon: "castle", title: guildsOnRiseAreReal ? "Real momentum, this week" : "Halls with the most momentum", color: '#B8735C',
                sub: guildsOnRiseAreReal
                    ? "Ranked by real, recent Guild Hall activity \u2014 new members, reads, publishes, quests, and anthology work \u2014 never by guild size, and never gameable by one member alone."
                    : "Ranked by combined participants across each guild\u2019s live and upcoming events." }),
            guildsOnRiseAreReal
                ? React.createElement("div", { className: "lu-guild-grid" },
                    remoteGuildsOnRise.map((g) => React.createElement("div", {
                            className: "lu-guild-card", key: g.guildId,
                            style: onOpenGuild ? { cursor: 'pointer' } : undefined,
                            onClick: onOpenGuild ? () => onOpenGuild(g.guildId) : undefined,
                        },
                        React.createElement("div", { className: "lu-guild-head" },
                            React.createElement("div", { className: "lu-guild-icon" }, React.createElement(InkIcon, { name: "castle", size: 15, color: INBOX_ICON_COLOR })),
                            React.createElement("div", { className: "lu-guild-name" }, g.name)),
                        React.createElement("p", null,
                            [
                                g.newMembers > 0 && `+${g.newMembers} member${g.newMembers === 1 ? '' : 's'}`,
                                g.booksPublished > 0 && `${g.booksPublished} book${g.booksPublished === 1 ? '' : 's'} published`,
                                g.readingActivity > 0 && `${g.readingActivity} reader${g.readingActivity === 1 ? '' : 's'}`,
                                g.questActivity > 0 && `${g.questActivity} quest${g.questActivity === 1 ? '' : 's'} completed`,
                                g.anthologyActivity > 0 && `${g.anthologyActivity} anthology move${g.anthologyActivity === 1 ? '' : 's'}`,
                            ].filter(Boolean).join(' \u00B7 ') || 'Gaining ground'),
                        React.createElement("div", { className: "lu-guild-time" }, `${g.memberCount} member${g.memberCount === 1 ? '' : 's'} \u00B7 +${g.reputationGrowth} Reputation this week`))))
                : (guildsOnRise.length
                    ? React.createElement("div", { className: "lu-guild-grid" },
                        guildsOnRise.map((g) => React.createElement("div", { className: "lu-guild-card", key: g.guildId },
                            React.createElement("div", { className: "lu-guild-head" },
                                React.createElement("div", { className: "lu-guild-icon" }, React.createElement(LuGlyph, { value: g.guildIcon, size: 15 })),
                                React.createElement("div", { className: "lu-guild-name" }, g.guildName)),
                            React.createElement("p", null, `${g.participants} participants across ${g.events} live or upcoming event${g.events === 1 ? '' : 's'}.`))))
                    : React.createElement("div", { className: "lu-ge-empty" }, "No live or upcoming Guild Events right now."))),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "New & Notable", icon: "sparkle", title: "Freshly added to the universe", color: '#A184D6',
                sub: "The newest World Packs and Guild anthologies to enter the Chronicle." }),
            newAndNotable.length
                ? React.createElement("div", { className: "lu-guild-grid" },
                    newAndNotable.map((e) => React.createElement("div", { className: "lu-guild-card", key: e.id },
                        React.createElement("div", { className: "lu-guild-head" },
                            React.createElement("div", { className: "lu-guild-icon" }, React.createElement(LuGlyph, { value: e.seal, size: 15 })),
                            React.createElement("div", { className: "lu-guild-name" }, e.tag)),
                        React.createElement("p", null, e.title),
                        React.createElement("div", { className: "lu-guild-time" }, luTimeAgo(e.ts)))))
                : React.createElement("div", { className: "lu-ge-empty" }, "Nothing new to report just yet.")),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Recent Achievements", icon: "medal", title: "Honors claimed across the guild halls", color: '#D8A93F',
                sub: "The latest achievement unlocks, chronicled as they happen." }),
            recentAchievements.length
                ? React.createElement("div", { className: "lu-guild-grid" },
                    recentAchievements.map((e) => React.createElement("div", { className: "lu-guild-card", key: e.id, style: { borderColor: `${e.color}55` } },
                        React.createElement("div", { className: "lu-guild-head" },
                            React.createElement("div", { className: "lu-guild-icon", style: { borderColor: `${e.color}66`, background: `${e.color}1A` } }, React.createElement(LuGlyph, { value: e.seal, size: 15 })),
                            React.createElement("div", { className: "lu-guild-name" }, e.achTitle)),
                        React.createElement("p", null, `${e.author} \u00B7 ${e.sub}`),
                        React.createElement("div", { className: "lu-guild-time" }, luTimeAgo(e.ts)))))
                : React.createElement("div", { className: "lu-ge-empty" }, "No achievements chronicled yet.")),

        React.createElement("div", { className: "lu-section" },
            React.createElement(LuSectionHeader, { eyebrow: "Featured Authors", title: "Voices worth following", color: '#E8C468' }),
            React.createElement("div", { className: "lu-shelf" },
                featuredAuthors.map((a) => React.createElement("div", { className: "lu-author", key: a.name },
                    React.createElement("div", { className: "lu-author-avatar", style: { border: `1.5px solid ${a.rank.color}` } }, a.name.split(' ').map((n) => n[0]).join('')),
                    React.createElement("h4", null, a.name),
                    React.createElement("div", { className: "lu-a-rank", style: { color: a.rank.color } }, `${a.rank.icon} ${a.rank.name}`),
                    React.createElement("div", { className: "lu-a-blurb" }, a.blurb))))),

        React.createElement("div", { className: "lu-section", style: { marginBottom: 8 } },
            React.createElement(LuSectionHeader, { eyebrow: "Reader Activity", title: "The quiet side of the ledger", color: '#7FB2C9' }),
            (readerEvents.length ? readerEvents : entries.slice(0, 5)).map((e) => React.createElement("div", { className: "lu-reader-row", key: e.id },
                React.createElement("div", { className: "lu-reader-dot" }),
                React.createElement("div", { className: "lu-reader-text" }, e.title),
                React.createElement("div", { className: "lu-reader-time" }, luTimeAgo(e.ts))))),

        React.createElement("div", { style: { textAlign: 'center', padding: '24px 12px 4px', color: '#5C5C64', fontSize: TYPE_SCALE[11], lineHeight: 1.7 } },
            anyLiveData
                // Sections marked "real" above (Best Sellers, Most Read, Rising Stars, Guilds on
                // the Rise, and/or Guild Events) are already pulling from Inkroot's real backend —
                // only the Chronicle feed itself, Weekly Spotlight, and Featured Authors are still
                // this device's own local simulation, not a claim about the whole page.
                ? "Sections above marked as real are live. The Chronicle feed, Weekly Spotlight, and Featured Authors below are still generated on this device as a preview, not drawn from other real writers."
                : "This chronicle is generated on this device as a preview \u2014 it isn't drawing from other real writers yet."));
}
