import React, { useState, useEffect, useRef } from 'react';
import { storage } from '../lib/storage.js';
import { FiresideBoard } from '../guild/fireside-board.jsx';
import { GuildBookFeedbackModal, GuildBookshelf } from '../guild/guild-book-feedback-modal.jsx';
import { GuildHallAtmosphere, readEnteredGuildId, writeEnteredGuildId } from '../guild/guild-building-art.jsx';
import { readGuildFeedback, writeGuildFeedback } from '../guild/guild-feedback.jsx';
import { FIRESIDE_KEY, GUILD_QUEST_DEFS, GuildBanner, GuildQuestBoard, GuildWelcomeScreen, formatCooldownRemaining, founderGuildById, guildCooldownRemainingMs } from '../guild/guild-hall.jsx';
import { NoticeBoard } from '../guild/notice-board.jsx';
import { GuildEventsHomePreview } from '../guild/guild-events-preview.jsx';
import { GuildAnthologyHomePreview } from '../guild/guild-anthology-preview.jsx';
import { subscribeGuildPresence } from '../lib/player-guild.js';
import { GuildOrderScreen } from '../guild/guild-order.jsx';
import { GuildOrderOverview } from '../guild/guild-order-overview.jsx';
import { computeGuildReputation, computeSharedGuildReputation, sumGuildMemberStats } from '../guild/guild-progression.jsx';
import { fetchGuildMemberStats, pushGuildMemberStats } from '../lib/guild-progression-remote.js';
import { guildRankForReputation } from '../guild/guild-reputation-panel.jsx';
import { hashSeed } from '../library/author-reputation.jsx';
import { AuthorsHallScreen } from '../library/authors-hall-screen.jsx';
import { GrandLibraryScreen } from '../library/grand-library-screen.jsx';
import { AuthorInboxScreen, seedInboxItems } from '../library/inbox-and-living-universe.jsx';
import { LivingUniverseScreen } from '../library/living-universe-screen.jsx';
import { IconPlus, IconTrash } from '../shared-ui/icons.jsx';
import { readLocalImageFile } from '../shared-ui/image-utils.jsx';
import { deleteUploadedImage, isUploadedMediaUrl, uploadImageDataUrl } from '../lib/mediaStorage.js';
import { ArchiveSectionHeading, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { ConfirmDialog } from '../shared-ui/ui-primitives.jsx';
import { formatBytes } from '../shared-utils/format-bytes.jsx';
import { formatRelativeTime } from '../shared-utils/format-duration.jsx';
import { INBOX_KEY, projectKey } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { HomeNav, HomeQuickActionTile, InkIcon, InkrootNewsCard, LibraryHero, TodaysInspirationCard } from './ink-icon.jsx';
import { AccountSyncControl } from './account-sync-control.jsx';
import { ConflictRecoveryControl } from './conflict-recovery-control.jsx';
import { AccountRestrictionBanner } from './account-restriction-banner.jsx';
import { SyncStatusIndicator } from './sync-status-indicator.jsx';
import { InkRoot } from './ink-root.jsx';
import { Breadcrumbs, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, useNav } from './nav-context.jsx';

// A stable empty Set for "no presence signal yet" — see the onlineGuildMembers state below —
// so resetting between guilds/signed-out doesn't hand every consumer a new, identity-changing
// empty Set on every render.
const NOBODY_ONLINE = new Set();
import { BookCover, COVER_THEMES, COVER_THEME_ORDER } from '../worldbuilding/book-cover.jsx';
import { HealthScoreSummary, WRITER_RANKS, runHealthChecks } from '../writing/health-checks.jsx';
import { chapterLabel, patchProjectDefaults } from '../writing/project-schema-and-backups.jsx';
import { ProjectWorkspace } from '../writing/project-workspace.jsx';


// Picks the shared, real, guild-wide totals when they're available for a real guild — a Player
// Guild's remoteGuildId, or a Founder Guild's own slug (migration 88, founder_guild_member_stats)
// — plus a loaded sharedGuildTotals, and otherwise falls back to the honest local-only
// computation: a not-yet-loaded fetch, offline, or signed out all land here rather than showing
// a shared number that isn't real yet.
// Used to also return `guildProgress` (Guild Level/XP) alongside `guildReputation` — Guild Level
// is gone (see guild-progression.jsx), so this now returns Guild Reputation only.
// Every brand-new project starts with the exact same plain gold-leather cover (see emptyProject
// in project-schema-and-backups.jsx: style 'leather', accent 'gold', motif 'compass', every
// time). Fine for one book on the shelf, but a writer with several untouched "Untitled Novel"
// projects then sees an identical stamped-out cover repeated down the row — the shelf reads as
// broken/lifeless rather than a real, lived-in bookcase. This is a display-time-only fallback:
// a project whose cover still exactly matches that untouched default gets a themed look (style
// + accent + motif from COVER_THEMES) derived from its own stable `id` instead, so different
// projects land on different themes and the same project always lands on the same one. The
// instant a writer sets their own cover in Settings, `cover` no longer matches the default
// shape and this stops applying — their choice always wins, and nothing here touches the
// project's actual stored data.
function shelfDisplayCover(project) {
    const cover = project && project.cover;
    const isUntouchedDefault = !cover || (
        !cover.customImageUrl &&
        (!cover.style || cover.style === 'leather') &&
        (!cover.accent || cover.accent === 'gold') &&
        (!cover.motif || cover.motif === 'compass')
    );
    if (!isUntouchedDefault)
        return cover;
    const themeKey = COVER_THEME_ORDER[hashSeed(project.id || project.title || '') % COVER_THEME_ORDER.length];
    const theme = COVER_THEMES[themeKey];
    return { style: theme.style, accent: theme.accent, motif: theme.motif, customImageUrl: '' };
}


function resolveGuildReputation({ statsGuildId, sharedGuildTotals, publishedCount, questsCompleted, firesidePostCount }) {
    if (statsGuildId && sharedGuildTotals)
        return computeSharedGuildReputation(sharedGuildTotals);
    return computeGuildReputation({ publishedCount, questsCompleted, firesidePostCount });
}


// ---------- Grand Hall dressing: bookcase alcove + wall sconces + dust motes ----------
// A handful of purely decorative, deterministic (never randomized per-render) fixtures that
// turn the plain page background into a royal library's reading hall — a receded row of
// shelved spines behind the real Recent Activity shelf, brass candle sconces flanking the
// hall, and a slow drift of dust motes caught in the candlelight. Fixed data/JSX rather than
// component state since none of it needs to change after mount.
const SHELF_BACKROW_SPINES = [
    { h: 40, c: '#5C3A22' }, { h: 46, c: '#2E4A2E' }, { h: 34, c: '#6B3030' }, { h: 44, c: '#4A3D22' },
    { h: 38, c: '#2A3550' }, { h: 48, c: '#5C3A22' }, { h: 36, c: '#6B3030' }, { h: 42, c: '#2E4A2E' },
    { h: 32, c: '#4A3D22' }, { h: 46, c: '#2A3550' }, { h: 40, c: '#5C3A22' }, { h: 36, c: '#6B3030' },
    { h: 44, c: '#2A3550' }, { h: 30, c: '#6B3030' },
];
// Wraps a shelf (the "Begin Your Shelf" / "Recent Activity" wood ledge) in a recessed
// wood-paneled bookcase niche, with a faint, blurred second row of spines glimpsed above it —
// so the shelf reads as one tier of a real bookcase rather than a single carousel floating on
// the page. Doesn't touch the shelf's own internals (still exactly the .shelf-stage markup/CSS
// it always was), just frames it.
function ShelfNiche({ children }) {
    return React.createElement("div", { className: "shelf-niche" },
        React.createElement("div", { className: "shelf-backrow" },
            SHELF_BACKROW_SPINES.map((s, i) => React.createElement("span", {
                key: i, className: "shelf-backspine",
                style: { height: s.h, background: `linear-gradient(180deg, ${s.c}, ${s.c}CC)` },
            }))),
        children);
}
// A small brass wall sconce — a lit candle in a cupped brass holder on a short bracket —
// mounted near the top corners of the Hall. Reuses the same flame look/flicker
// (.gl-flame / glCandleFlicker) as the Grand Library's own chandelier, so every candle in the
// app burns the same way.
// `reduced` freezes the candle's flicker on whatever frame it's on (animationPlayState: paused)
// rather than looping every 1.8s forever — see HOME_AMBIENCE_SEEN_KEY below for when this kicks
// in. The flame/glow themselves stay exactly as bright; only the endless looping motion stops.
function WallSconce({ side, top, reduced }) {
    return React.createElement("div", { style: {
            position: 'absolute', top, [side]: 14, zIndex: 0, pointerEvents: 'none',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
        } },
        React.createElement("div", { className: "gl-flame", style: {
                width: 7, height: 13, borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
                background: 'radial-gradient(circle at 50% 30%, #FFF3C4, #E8C468 55%, #C25E2E 100%)',
                boxShadow: '0 0 10px 3px rgba(232,196,104,0.5), 0 0 24px 7px rgba(232,196,104,0.2)',
                animationPlayState: reduced ? 'paused' : 'running',
            } }),
        React.createElement("div", { style: {
                width: 11, height: 8, marginTop: -1, borderRadius: '2px 2px 6px 6px',
                background: 'linear-gradient(180deg, #E8C468, #7A5E24)', boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
            } }),
        React.createElement("div", { style: { width: 2, height: 24, background: 'linear-gradient(180deg, #8A6B25, #4A3D22)' } }),
        React.createElement("div", { style: {
                width: 18, height: 3, borderRadius: 2,
                background: 'linear-gradient(90deg, #4A3D22, #8A6B25, #4A3D22)', boxShadow: '0 2px 5px rgba(0,0,0,0.45)',
            } }));
}
// Fixed left%/size/timing per mote, spread the length of the page — the same drifting-ember
// look as the Grand Library and Guild Hall (.gl-dust-mote / glDustFloat, already global in
// app.css), just sprinkled across the whole homepage rather than one card.
const HOME_DUST_MOTES = [
    { left: 6, size: 3, delay: 0.2, duration: 11 }, { left: 16, size: 2, delay: 3.4, duration: 9 },
    { left: 27, size: 3.5, delay: 1.6, duration: 12.5 }, { left: 38, size: 2.5, delay: 5.1, duration: 10 },
    { left: 49, size: 3, delay: 0.8, duration: 13 }, { left: 60, size: 2, delay: 4.2, duration: 9.5 },
    { left: 71, size: 3.5, delay: 2.4, duration: 11.5 }, { left: 82, size: 2.5, delay: 6, duration: 10.5 },
    { left: 91, size: 3, delay: 3, duration: 12 },
];
// This hall dressing (sconces + dust) is unconditional — it sits behind every tab, not just
// Home — so a writer who's been in the app a while has had it looping continuously the entire
// time, on top of app.css's global `prefers-reduced-motion` handling for anyone who's asked the
// OS to cut motion. Even for everyone else, "flickering candles forever" is meant to read as a
// nice detail on arrival, not run at full intensity indefinitely. So: full flicker + the whole
// mote field the first time this ever loads in a browser, then — persisted the same way every
// other "played once" flag in Inkroot is (see GUILD_ENTERED_KEY in guild-building-art.jsx) —
// the candles hold steady and only half the motes drift on every load after that. Nothing is
// removed outright; it just stops being the loudest continuous motion on the screen.
const HOME_AMBIENCE_SEEN_KEY = 'inkroot:home:ambienceSeen';
function hasSeenHomeAmbience() {
    try {
        return localStorage.getItem(HOME_AMBIENCE_SEEN_KEY) === '1';
    }
    catch (e) {
        return false;
    }
}
function markHomeAmbienceSeen() {
    try {
        localStorage.setItem(HOME_AMBIENCE_SEEN_KEY, '1');
    }
    catch (e) { }
}


export function HomeScreen({ projects, onOpen, onReadBook, onOpenHealth, onOpenPacks, onCreate, onDelete, onExportAll, onImportFile, onOptimizeAll, writerProfile, onOpenProfile, writerRank, writerReputation, guildProfile, isPlatformAdmin, onJoinFounderGuild, onLeaveGuild, onEnterOwnGuild, onSaveOwnGuild, onJoinGuildByCode, joinCodeError, lifetimeStats, onReputationChange, onSetPublishStatus, onSetPackPublishStatus, onPublishBookWithDetails, onPublishPackWithDetails, activeTab, setActiveTab, onOpenAuthor, onOpenGuild, onOpenEvent, libraryInitialMode }) {
    const sorted = [...projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const featured = sorted.length > 0 ? sorted[0] : null;
    const rest = featured ? sorted.slice(1) : sorted;
    const fileInputRef = useRef(null);
    const crestFileInputRef = useRef(null);
    // Captured once, before we mark it seen below, so *this* mount still gets the full-intensity
    // welcome even though we're about to write the flag for next time — see HOME_AMBIENCE_SEEN_KEY.
    const [ambienceReduced] = useState(hasSeenHomeAmbience);
    useEffect(() => { markHomeAmbienceSeen(); }, []);
    const [crestError, setCrestError] = useState('');
    const [inviteStatus, setInviteStatus] = useState('');
    const inviteStatusTimer = useRef(null);
    useEffect(() => () => { if (inviteStatusTimer.current)
        clearTimeout(inviteStatusTimer.current); }, []);
    // Which Guild Hall's "stepping through the door" entrance bloom (see GuildHallAtmosphere) has
    // already played — captured once per mount, then updated the moment a *different* guildId is
    // seen, exactly like most "played once" entrance/reveal beats in Inkroot handle theirs — a
    // construction animations. This is what keeps the entrance transition a one-time arrival beat
    // rather than something that replays every time this tab is revisited.
    const enteredGuildRef = useRef(null);
    if (enteredGuildRef.current === null)
        enteredGuildRef.current = readEnteredGuildId() || 'none';
    useEffect(() => {
        if (!guildProfile || !guildProfile.guildType)
            return;
        const key = (guildProfile.guildType === 'founder' ? guildProfile.founderGuildId : null) || 'general';
        if (enteredGuildRef.current !== key) {
            writeEnteredGuildId(key);
            enteredGuildRef.current = key;
        }
    }, [guildProfile]);
    // Guild Bookshelf feedback (see GuildBookshelf / GuildBookFeedbackModal) — local-only today,
    // keyed the same way as the rest of the Grand Library's on-device data.
    const [guildFeedback, setGuildFeedback] = useState(() => readGuildFeedback());
    const handleAddGuildFeedback = (bookId, entry) => {
        setGuildFeedback((prev) => {
            const next = { ...prev, [bookId]: [...(prev[bookId] || []), entry] };
            writeGuildFeedback(next);
            return next;
        });
    };
    const handleCrestFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setCrestError('');
        try {
            const dataUrl = await readLocalImageFile(file, 480, 0.85);
            // Same upload-then-fall-back pattern as the avatar handler in
            // authors-hall-screen.jsx — this is what ends up in player_guilds.crest_url
            // (see ink-root.jsx's saveOwnGuild -> syncPlayerGuild), a table every guild
            // member's device reads, so keeping it a short URL instead of a data URL matters
            // there too.
            const previousCrest = guildProfile && guildProfile.playerGuild && guildProfile.playerGuild.crest;
            const uploadedUrl = await uploadImageDataUrl(dataUrl, 'guild-crests');
            onSaveOwnGuild({ crest: uploadedUrl || dataUrl });
            if (uploadedUrl && isUploadedMediaUrl(previousCrest)) {
                deleteUploadedImage(previousCrest);
            }
        }
        catch (err) {
            setCrestError(err.message || 'Could not use that image.');
        }
    };
    const playerGuild = guildProfile && guildProfile.playerGuild;
    const joinedGuild = guildProfile && guildProfile.joinedGuild;
    const activeFounderGuild = guildProfile && guildProfile.guildType === 'founder' ? founderGuildById(guildProfile.founderGuildId) : null;
    const activeGuildName = guildProfile && guildProfile.guildType === 'player'
        ? (playerGuild && playerGuild.name) || 'my guild'
        : guildProfile && guildProfile.guildType === 'joined'
            ? (joinedGuild && joinedGuild.name) || 'my guild'
            : (activeFounderGuild && activeFounderGuild.name) || 'my guild';
    // The remote id of the real, multi-member Player Guild this writer is currently in (owned or
    // joined) — null for Founder Guilds, since those have no real roster to aggregate (see the
    // HONESTY NOTE above sumGuildMemberStats in guild-progression.jsx). This is the guildId
    // guild_member_stats rows key off, both for pushing this device's own stats and for fetching
    // every member's rows back.
    //
    // For a self-founded Player Guild specifically, this id is only ever handed out once
    // playerGuild.synced is confirmed true (see ink-root.jsx's enterOwnGuild/saveOwnGuild) —
    // NOT the moment playerGuild.id exists locally. Founding a guild creates its id client-side
    // and pushes it to the server in the background (syncPlayerGuild); until that call actually
    // lands, no player_guilds row exists yet under that id. Handing this id out during that
    // window used to send every consumer below (events, treasury, anthology, presence) straight
    // at a row that doesn't exist server-side yet — surfacing everywhere as a raw, confusing
    // "Guild not found." the moment the writer tried to use any of them, even though the guild
    // itself would have finished saving moments later. `synced !== false` (rather than requiring
    // it `=== true`) keeps every already-founded guild from before this field existed working
    // exactly as before — only a freshly-founded, not-yet-confirmed guild is held back now.
    const remoteGuildId = guildProfile && guildProfile.guildType === 'joined'
        ? (joinedGuild && joinedGuild.id)
        : guildProfile && guildProfile.guildType === 'player'
            ? (playerGuild && playerGuild.synced !== false ? playerGuild.id : null)
            : null;
    // The guild id (and which of the two per-member stats tables) Guild Reputation's real,
    // cross-member path sums from — remoteGuildId itself for a Player Guild, or a Founder
    // Guild's own slug (founder_guild_member_stats, migration 88) for a Founder Guild. Kept
    // separate from remoteGuildId, which stays exactly what it was — Player-Guild-only — since
    // presenceGuildId's own fallback and Guild Order's guildOrderBackendId below still key off
    // remoteGuildId specifically, for reasons unrelated to Reputation.
    const statsGuildId = guildProfile && guildProfile.guildType === 'founder'
        ? guildProfile.founderGuildId
        : remoteGuildId;
    const statsGuildType = guildProfile && guildProfile.guildType === 'founder' ? 'founder' : 'player';
    // Live "who's online" for this guild's Hall — a single Presence subscription shared by both
    // GuildBanner's Members Online plaque (just the count) and PlayerGuildRoster/
    // FounderGuildRoster's per-member dots (the actual Set), rather than each opening its own
    // channel for the same guild. Kept as top-level state/effect here (not inside the
    // guildContent IIFE below, which only runs conditionally) so the Rules of Hooks aren't at the
    // mercy of guildProfile/writerProfile being present yet.
    //
    // presenceGuildId is deliberately its own variable, not remoteGuildId above: remoteGuildId
    // stays Player-Guild-only for reasons unrelated to presence (see remoteGuildId's own
    // comment and statsGuildId just above it) — that's not a gap presence needs to route
    // around, just a different variable for a different concern. founder_guild_members has held
    // every Founder Guild's real join/leave history since Phase 8 (see FounderGuildRoster's own
    // comment in guild-hall.jsx), so presence has a real roster to key off of for both guild
    // types, same as statsGuildId does for Reputation.
    const presenceGuildId = guildProfile && guildProfile.guildType === 'founder'
        ? guildProfile.founderGuildId
        : remoteGuildId;
    const [onlineGuildMembers, setOnlineGuildMembers] = useState(NOBODY_ONLINE);
    useEffect(() => {
        if (!presenceGuildId) {
            setOnlineGuildMembers(NOBODY_ONLINE);
            return;
        }
        setOnlineGuildMembers(NOBODY_ONLINE);
        const selfName = writerProfile && (writerProfile.penName || writerProfile.name);
        return subscribeGuildPresence(presenceGuildId, selfName, setOnlineGuildMembers);
    }, [presenceGuildId, writerProfile]);
    const handleInviteGuild = () => {
        // Real invite code once the guild has synced remotely (see enterOwnGuild/saveOwnGuild
        // in InkRoot); falls back to the old generic message if it hasn't synced yet — e.g.
        // signed out, or the very first save hasn't round-tripped to Supabase yet.
        const message = playerGuild && playerGuild.inviteCode
            ? `Join ${activeGuildName} on Inkroot! Use invite code: ${playerGuild.inviteCode}`
            : `Join ${activeGuildName} on Inkroot!`;
        const showStatus = (text) => {
            setInviteStatus(text);
            if (inviteStatusTimer.current)
                clearTimeout(inviteStatusTimer.current);
            inviteStatusTimer.current = setTimeout(() => setInviteStatus(''), 3000);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(message).then(() => showStatus('Invite message copied \u2014 paste it anywhere to share.'), () => showStatus('Could not copy the invite \u2014 your browser may be blocking it.'));
        }
        else {
            showStatus('Could not copy the invite \u2014 your browser may be blocking it.');
        }
    };
    const [status, setStatus] = useState('');
    const [confirmState, setConfirmState] = useState(null); // { message, onConfirm }
    // activeTab ('home' | 'guild' | 'library') is owned by InkRoot, not this component: HomeScreen
    // unmounts every time a project or the Writer Profile is opened (InkRoot swaps it out for
    // ProjectWorkspace/AuthorsHallScreen entirely) and remounts fresh when the writer comes back.
    // Local state here would reset to 'home' on every such remount even though the nav breadcrumb
    // stack still remembered "Grand Library"/"Guild Hall" — that mismatch was what let repeated
    // trips into a project stack duplicate, dead "Grand Library" crumbs whose undo() pointed at a
    // setActiveTab from an already-unmounted instance. Keeping the state in InkRoot (which never
    // unmounts) keeps it in sync with the nav stack no matter how many times the writer dips into
    // a project and back.
    const nav = useNav();
    // A published anthology's book id, set right before switching to the Library tab so the
    // Grand Library opens straight to that book's own real detail view (see GrandLibraryScreen's
    // initialBookId) instead of the Guild Order inventing a second place to look at it.
    const [pendingLibraryBookId, setPendingLibraryBookId] = useState(null);
    const viewPublishedBook = (bookId) => {
        setPendingLibraryBookId(bookId);
        changeHomeTab('library');
    };
    // Same pattern as pendingLibraryBookId above: which Guild Order tab to land on, set right
    // before switching to the 'guildorder' tab so a tap on one of the Guild Order overview
    // directory's rows (see guild-order-overview.jsx) opens the Guild Order already on Roster/
    // Anthology/Quests/Treasury/Guild Events/Council instead of always defaulting to Roster.
    const [pendingGuildOrderTab, setPendingGuildOrderTab] = useState(null);
    const enterGuildOrder = (tabKey) => {
        setPendingGuildOrderTab(tabKey);
        changeHomeTab('guildorder');
    };
    // Same idea again, one level deeper: which anthology (if any) and which starting action the
    // Anthology tab itself should land on, set right before switching there so a tap on the Guild
    // Homepage's compact Anthology preview (see guild-anthology-preview.jsx) opens the real
    // workspace already on that anthology, or already showing the create form, instead of always
    // opening to the plain anthology list.
    const [pendingAnthology, setPendingAnthology] = useState({ id: null, action: null, seedProjectId: null });
    const enterGuildAnthology = ({ anthologyId, action, seedProjectId } = {}) => {
        setPendingAnthology({ id: anthologyId || null, action: action || null, seedProjectId: seedProjectId || null });
        enterGuildOrder('anthology');
    };
    // Home itself is the breadcrumb root, so only Guild/Library push a level; switching straight
    // between those two siblings swaps the crumb in place instead of stacking a second one.
    const changeHomeTab = (next) => {
        if (next === activeTab)
            return;
        const label = next === 'guild' ? 'Guild Hall' : next === 'library' ? 'Grand Library' : next === 'inbox' ? 'Author Inbox' : next === 'universe' ? 'Living Universe' : next === 'guildorder' ? 'The Guild Order' : 'Home';
        if (next === 'home') {
            nav.pop();
        }
        else if (activeTab === 'home') {
            nav.push({ label, undo: () => setActiveTab('home') });
        }
        else {
            nav.replaceTop({ label, undo: () => setActiveTab('home') });
        }
        setActiveTab(next);
    };
    const [firesidePostCount, setFiresidePostCount] = useState(0); // feeds the "community participation" leg of Guild Reputation
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const res = await storage.get(FIRESIDE_KEY);
            if (!cancelled && res) {
                try {
                    setFiresidePostCount(JSON.parse(res.value).length);
                }
                catch (e) { /* leave the count as-is if the stored value is unreadable */ }
            }
        })();
        return () => { cancelled = true; };
    }, [activeTab]); // re-tally whenever the Guild tab is (re)opened, so a fresh Fireside post is reflected
    // ---------- Shared Guild Level/XP/Reputation (both guild types, migration 88) ----------
    // Once a guild has a real roster (statsGuildId — a Player Guild's remoteGuildId, or a
    // Founder Guild's own slug), its Level/XP/Reputation should be a real sum across every
    // member who's synced, not just this device's own activity. `sharedGuildTotals` stays null
    // until the first successful fetch (or whenever statsGuildId itself changes), so every call
    // site below falls back to the honest local-only numbers while it loads, offline, or signed
    // out — never a flashed-wrong zero.
    const [sharedGuildTotals, setSharedGuildTotals] = useState(null);
    useEffect(() => {
        setSharedGuildTotals(null);
        if (!statsGuildId)
            return;
        let cancelled = false;
        const publishedCount = projects.filter((p) => p.completed).length;
        const completedQuestDefs = GUILD_QUEST_DEFS.filter((def) => def.statKey && (lifetimeStats[def.statKey] || 0) >= def.target);
        const questGuildXP = completedQuestDefs.reduce((sum, def) => sum + (def.guildXP || 0), 0);
        // Push this device's own current numbers, then fetch the whole guild's rows back —
        // fire-and-forget on the push (see pushGuildMemberStats), so a failed push never blocks
        // the fetch or the render.
        pushGuildMemberStats(statsGuildId, {
            publishedCount, questsCompleted: completedQuestDefs.length, questGuildXP,
            writingDayCount: lifetimeStats.writingDayCount, firesidePostCount,
        }, statsGuildType).catch((e) => console.warn('Inkroot: guild stats push failed', e));
        fetchGuildMemberStats(statsGuildId, statsGuildType)
            .then((rows) => { if (!cancelled) setSharedGuildTotals(sumGuildMemberStats(rows)); })
            .catch((e) => console.warn('Inkroot: guild stats fetch failed', e));
        return () => { cancelled = true; };
    }, [statsGuildId, statsGuildType, projects, lifetimeStats, firesidePostCount]);
    // Unread-letter tally for HomeNav's Inbox badge — AuthorInboxScreen only mounts while the Inbox
    // tab is actually open, so this peeks at INBOX_KEY directly (same trick as firesidePostCount
    // above) and re-tallies whenever any Home tab is opened, including right after leaving the
    // Inbox itself, so the badge count is never stale.
    const [inboxUnreadCount, setInboxUnreadCount] = useState(0);
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const res = await storage.get(INBOX_KEY);
            if (cancelled)
                return;
            try {
                const list = res ? JSON.parse(res.value) : (projects.some((p) => p.completed) ? seedInboxItems() : []);
                setInboxUnreadCount(list.filter((i) => i.unread && !i.archived).length);
            }
            catch (e) { /* leave the count as-is if the stored value is unreadable */ }
        })();
        return () => { cancelled = true; };
    }, [activeTab]);
    // REMOVED — Guild Level Up detection (guildLevelUpEvent/setGuildLevelUpEvent and the effect
    // that used to compute it). Guild Level no longer exists; Guild Reputation just is whatever it
    // currently computes to, same as Writer Reputation — no threshold-crossing ceremony to detect.
    // Loads the featured project's full data (the index only stores title/word count/etc.) just
    // to run the same Story Health checks used inside the project, so this card can show a real
    // count without waiting for the user to open the project first.
    const [featuredHealth, setFeaturedHealth] = useState(null); // null while loading (or no featured project); else { score, issueCount }
    useEffect(() => {
        let cancelled = false;
        if (!featured) {
            setFeaturedHealth(null);
            return;
        }
        setFeaturedHealth(null);
        (async () => {
            try {
                const res = await storage.get(projectKey(featured.id));
                if (!res) return;
                const data = patchProjectDefaults(JSON.parse(res.value));
                const { score, totalIssues } = runHealthChecks(data);
                if (!cancelled)
                    setFeaturedHealth({ score, issueCount: totalIssues });
            }
            catch (e) {
                // Leave featuredHealth null — the card just won't render rather than show a wrong count.
            }
        })();
        return () => { cancelled = true; };
    }, [featured && featured.id, featured && featured.updatedAt]);
    const handleFileChosen = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = ''; // allow re-selecting the same file later
        if (!file)
            return;
        setStatus('Importing…');
        const msg = await onImportFile(file);
        setStatus(msg);
        setTimeout(() => setStatus(''), 5000);
    };
    const handleOptimizeAllClick = async () => {
        setStatus('Optimizing images across all projects\u2026');
        try {
            const { totalFreed, touchedProjects } = await onOptimizeAll();
            setStatus(touchedProjects > 0
                ? `Freed about ${formatBytes(totalFreed)} across ${touchedProjects} project${touchedProjects === 1 ? '' : 's'}.`
                : "Nothing needed optimizing across your projects.");
        }
        catch (e) {
            setStatus('Could not finish optimizing \u2014 try again.');
        }
        setTimeout(() => setStatus(''), 8000);
    };
    // "Continue Writing" hero card for the most recently edited project — a generated book cover
    // stands in for the old plain-text title, so the featured project reads as an actual book.
    // Redesigned as a small enchanted-bookshelf / lit writing-desk scene: a carved dark-wood frame
    // (the same walnut/gold vocabulary as the Guild Order tile and the bookshelf elsewhere on this
    // screen) with layered shadow depth, a warm lamplight glow, a fine gilt rule under the eyebrow,
    // gold filigree corners, and a faint quill-and-ink watermark — so the current project reads as
    // the writer's featured work physically displayed on the shelf, not just another list row.
    // All of featured's actual data/handlers are untouched — this only changes how it's dressed.
    let featuredCard = null;
    if (featured) {
        const featuredTitle = featured.title && featured.title.trim() ? featured.title : 'Untitled Novel';
        // Warm lamplight spilling in from the upper-left, plus the original soft gold glow in the
        // far corner — together they read as one light source falling across the desk rather than
        // two unrelated decorative blobs. A second, tighter pool of light sits low over where the
        // cover rests, as if a small lamp were aimed at the book itself.
        const deskLight = React.createElement("div", { className: "hero-desk-ambient", style: {
                position: 'absolute', inset: 0, pointerEvents: 'none',
                background: 'radial-gradient(120% 90% at 6% -10%, rgba(232,196,104,0.14) 0%, transparent 48%)',
                // Same one-loop-then-hold treatment as the wall sconces (see ambienceReduced) —
                // this breathing glow is faint on its own, but it's one more thing looping
                // forever in the corner of a card the writer sees every time they open the app.
                animationPlayState: ambienceReduced ? 'paused' : 'running',
            } });
        const glow = React.createElement("div", { style: {
                position: 'absolute', top: -60, right: -60, width: 180, height: 180, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(200,155,60,0.10) 0%, rgba(200,155,60,0) 70%)',
                pointerEvents: 'none',
            } });
        const coverLamp = React.createElement("div", { style: {
                position: 'absolute', left: 6, top: -20, width: 210, height: 210, borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(232,196,104,0.16) 0%, rgba(232,196,104,0) 70%)',
                pointerEvents: 'none',
            } });
        // A faint carved-edge inset frame, echoing the same hairline treatment BookCover itself
        // uses inside every cover — the card frames its contents the same way a cover does. A
        // second, outer hairline just inside the card border reads as the gilt lip of a wooden
        // picture frame rather than a single flat rule.
        const innerFrame = React.createElement("div", { style: {
                position: 'absolute', inset: 7, border: '1px solid rgba(232,196,104,0.08)',
                borderRadius: RADIUS_SCALE[10], pointerEvents: 'none',
            } });
        const outerFrame = React.createElement("div", { style: {
                position: 'absolute', inset: 2, border: '1px solid rgba(232,196,104,0.06)',
                borderRadius: RADIUS_SCALE[14], pointerEvents: 'none',
            } });
        // Small gold filigree corner brackets — the one ornamental flourish borrowed from
        // title-page book plates. Dimmed further (0.4/0.45 stroke/fill down to 0.2/0.22) on top
        // of already being faint: with the Resume pill's solid gold fill added below, these were
        // still enough visual texture competing at the same corners of the card to blur which
        // gold shape the eye should land on first. Kept, not removed, so the card still reads as
        // a dressed page rather than a bare rectangle — just quieter than the button it sits
        // behind now.
        const cornerFlourish = (corner) => {
            const isTL = corner === 'tl';
            return React.createElement("svg", {
                width: 30, height: 30, viewBox: "0 0 30 30", fill: "none", stroke: "rgba(200,155,60,0.2)",
                strokeWidth: 1, strokeLinecap: "round", style: {
                    position: 'absolute', pointerEvents: 'none',
                    top: isTL ? 10 : 'auto', left: isTL ? 10 : 'auto',
                    bottom: isTL ? 'auto' : 10, right: isTL ? 'auto' : 10,
                    transform: isTL ? 'none' : 'rotate(180deg)',
                },
            },
                React.createElement("path", { d: "M2,14 V6 A4,4 0 0,1 6,2 H14" }),
                React.createElement("path", { d: "M2,18 C10,18 18,10 18,2", strokeWidth: 0.7, strokeOpacity: 0.4 }),
                React.createElement("circle", { cx: 2, cy: 2, r: 1.3, fill: "rgba(200,155,60,0.22)", stroke: "none" }));
        };
        // A faint quill-and-ink watermark resting low in the card — a quiet literary motif behind
        // the text, never competing with it. Halved again from its already-low 0.07 stroke
        // opacity (see cornerFlourish above for why) so it reads as barely-there paper texture,
        // not a second gold shape drawing the eye away from Resume.
        const quillMotif = React.createElement("svg", {
            width: 92, height: 92, viewBox: "0 0 100 100", fill: "none", stroke: "rgba(232,196,104,0.035)",
            strokeWidth: 1.3, strokeLinecap: "round", style: {
                position: 'absolute', right: -6, bottom: -8, pointerEvents: 'none',
            },
        },
            React.createElement("path", { d: "M23,88 C16,68 24,44 40,30 C56,16 76,9 90,10 C82,22 70,34 58,42" }),
            React.createElement("path", { d: "M40,30 L23,88" }),
            React.createElement("ellipse", { cx: 24, cy: 90, rx: 7, ry: 2.2 }));
        const eyebrow = React.createElement("div", { className: "hero-desk-eyebrow", style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                fontSize: TYPE_SCALE[11], fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase',
                color: '#C89B3C',
            } },
            React.createElement(InkIcon, { name: "sparkle", size: 11, color: "#C89B3C" }),
            "Continue Writing");
        // A fine gilt rule under the eyebrow — the one flourish this card spends its restraint on,
        // like the rule under a title-page imprint in a leather-bound book.
        const gildRule = React.createElement("div", { style: {
                width: 40, height: 1, marginTop: 10, marginBottom: 14,
                background: 'linear-gradient(90deg, rgba(200,155,60,0.55), rgba(200,155,60,0))',
            } });
        const titleEl = React.createElement("div", { style: {
                fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[21], fontWeight: 600, lineHeight: 1.2,
                color: '#F3ECD9',
            } }, featuredTitle);
        const chapterEl = featured.chapterLabel ? React.createElement("div", { style: { fontSize: TYPE_SCALE[14.5], color: '#B8AC90', marginTop: 10 } }, featured.chapterLabel) : null;
        const wordsEl = React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#9C9280', marginTop: 6 } }, (featured.wordCount || 0).toLocaleString(), " words");
        const editedEl = featured.updatedAt ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7160', marginTop: 14 } }, "Last edited ", formatRelativeTime(featured.updatedAt)) : null;
        const resumeEl = React.createElement("div", { className: "hero-desk-resume", style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 20,
                color: '#1A1610', fontSize: TYPE_SCALE[14], fontWeight: 700,
                border: '1px solid rgba(232,196,104,0.6)', borderRadius: RADIUS_SCALE[999],
                padding: '7px 16px 7px 14px',
                background: 'linear-gradient(180deg, #E8C468 0%, #C89B3C 100%)',
                boxShadow: '0 4px 10px -3px rgba(200,155,60,0.45), inset 0 1px 0 rgba(255,255,255,0.35)',
            } }, "Resume \u2192");
        const coverEl = React.createElement(BookCover, { title: featured.title, subtitle: featured.subtitle, seriesName: featured.seriesName, author: featured.author, cover: shelfDisplayCover(featured), size: 'md' });
        // The cover no longer floats alone: two offset parchment "page" layers, dimmed a bit
        // further below (see .hero-desk-page-far/-near) sit just behind it, like the fanned
        // page-block of a real hardback glimpsed past its cover, and the whole stack is propped
        // at a slight lean — as if resting against a shelf rail — rather than pasted flat on the
        // card. See .hero-desk-pages / .hero-desk-cover below for the shared "resting on a
        // surface, lifts on touch" language used elsewhere on this screen.
        // A slim gold ribbon bookmark used to tuck in at the top of the cover here too, but it
        // was a second fully-opaque solid-gold shape on the card (the same gold as the Resume
        // pill below), competing with Resume for "the one loud gold thing here" rather than
        // reading as background dressing the way the flourishes/watermark/pages do at low
        // opacity. Removed rather than dimmed, since a half-opacity ribbon just looks like a
        // washed-out mistake — Resume is now the only fully-opaque gold shape on the card.
        const pageLayerFar = React.createElement("div", { className: "hero-desk-page hero-desk-page-far" });
        const pageLayerNear = React.createElement("div", { className: "hero-desk-page hero-desk-page-near" });
        const coverWrap = React.createElement("div", { className: "hero-desk-cover" }, pageLayerFar, pageLayerNear, coverEl);
        const textCol = React.createElement("div", { style: { flex: 1, minWidth: 0, position: 'relative' } }, eyebrow, gildRule, titleEl, chapterEl, wordsEl, editedEl, resumeEl);
        // A simple tabletop, filling the whole card now (previously just the bottom half, with
        // a plain dark background above it) so the featured book reads as resting on an actual
        // desk surface across the entire card — the same walnut/grain/gilt-highlight language
        // the Recent Activity shelf's plank already uses, kept plain and unornamented (one
        // surface, one front edge) rather than a second decorative scene competing with the
        // shelf below it.
        const tableSurface = React.createElement("div", { style: {
                position: 'absolute', inset: 0, pointerEvents: 'none',
                background: [
                    'repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0px, rgba(0,0,0,0.10) 1px, transparent 1px, transparent 34px)',
                    'linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0) 12%)',
                    'linear-gradient(180deg, #3A2716 0%, #2E1D10 55%, #20140A 100%)',
                ].join(', '),
            } });
        const tableEdge = React.createElement("div", { style: {
                position: 'absolute', left: 0, right: 0, bottom: 0, height: 6, pointerEvents: 'none',
                background: 'linear-gradient(180deg, #4A3220 0%, #1C1108 100%)',
                boxShadow: 'inset 0 1px 0 rgba(232,196,104,0.22)',
            } });
        // ---- Ancient hand-carved ornament in the desk wood ----
        // A quiet layer of manuscript-style tool-work worked into the tabletop already laid down
        // by tableSurface/tableEdge above: two thin tick-mark trims (a "headpiece" line near the
        // top edge and a matching one along the desk's own front edge at the bottom) plus a small
        // carved rosette in each of the two corners the existing gold flourishes don't already
        // use (cornerFlourish keeps 'tl'/'br' exactly as before; these take 'tr'/'bl'). Every mark
        // here sits at the same low, stroke-only opacity as the flourishes/watermark elsewhere on
        // this card, and all of it renders — like they do — before the book/text content below,
        // so it reads as old tool-work sitting quietly in the wood grain rather than a new
        // decorative layer competing with the book or the copy beside it.
        const tickBand = (edge) => {
            const patternId = `ink-tick-${edge}`;
            return React.createElement("svg", {
                width: "100%", height: 7, style: {
                    position: 'absolute', left: 14, right: 14, width: 'calc(100% - 28px)',
                    top: edge === 'top' ? 10 : 'auto', bottom: edge === 'bottom' ? 8 : 'auto',
                    pointerEvents: 'none',
                },
            },
                React.createElement("defs", null,
                    React.createElement("pattern", { id: patternId, width: 1 / 22, height: 1, patternUnits: "objectBoundingBox" },
                        React.createElement("rect", { x: 0.32, y: 0.15, width: 0.055, height: 0.7, fill: "rgba(232,196,104,0.13)" }))),
                React.createElement("rect", { x: "0", y: "0", width: "100%", height: "100%", fill: `url(#${patternId})` }));
        };
        const engraveTopBand = tickBand('top');
        const engraveBottomBand = tickBand('bottom');
        // Small carved rosette — a common, purely decorative boss in old woodwork and manuscript
        // borders on its own. The 'bl' variant folds a tiny Chi-Rho monogram into its center
        // (replacing the plain radiating-line/dot center the 'tr' one uses) as a quiet personal
        // maker's mark, at the same faint opacity as the rest of the linework so it reads as
        // just another carved flourish rather than a symbol — deliberately not a separate, more
        // visible element.
        const engraveRosette = (corner) => {
            const isTR = corner === 'tr';
            const centerpiece = isTR
                ? [
                    ...[0, 60, 120, 180, 240, 300].map((deg, i) => React.createElement("line", {
                        key: 'p' + i, x1: 9, y1: 9,
                        x2: 9 + Math.cos((deg * Math.PI) / 180) * 6.2, y2: 9 + Math.sin((deg * Math.PI) / 180) * 6.2,
                        stroke: "rgba(200,155,60,0.14)", strokeWidth: 0.7,
                    })),
                    React.createElement("circle", { key: 'ctr', cx: 9, cy: 9, r: 1.3, fill: "rgba(200,155,60,0.18)" }),
                ]
                : [
                    // Rho: a vertical stem with a small loop at the top, like a capital P.
                    React.createElement("path", { key: 'rho-stem', d: "M9,13.2 L9,4.8", stroke: "rgba(200,155,60,0.15)", strokeWidth: 0.75, fill: "none" }),
                    React.createElement("path", { key: 'rho-bowl', d: "M9,4.8 C12.1,4.8 12.1,9.1 9,9.1", stroke: "rgba(200,155,60,0.15)", strokeWidth: 0.75, fill: "none" }),
                    // Chi: two crossing diagonals over the lower stem.
                    React.createElement("path", { key: 'chi-1', d: "M6.2,7.6 L11.8,13", stroke: "rgba(200,155,60,0.13)", strokeWidth: 0.7, fill: "none" }),
                    React.createElement("path", { key: 'chi-2', d: "M11.8,7.6 L6.2,13", stroke: "rgba(200,155,60,0.13)", strokeWidth: 0.7, fill: "none" }),
                ];
            return React.createElement("svg", {
                width: 18, height: 18, viewBox: "0 0 18 18", style: {
                    position: 'absolute', pointerEvents: 'none',
                    top: isTR ? 10 : 'auto', right: isTR ? 10 : 'auto',
                    bottom: isTR ? 'auto' : 10, left: isTR ? 'auto' : 10,
                },
            },
                React.createElement("circle", { cx: 9, cy: 9, r: 7, fill: "none", stroke: "rgba(200,155,60,0.16)", strokeWidth: 0.8 }),
                ...centerpiece);
        };
        const rosetteTR = engraveRosette('tr');
        const rosetteBL = engraveRosette('bl');
        // A worn, near-illegible inscription tucked beside the maker's-mark rosette — "I·VIII", a
        // quiet nod to Joshua 1:8 rather than any quoted text. Sized and dimmed to read as a
        // faint tool-mark scratched into old wood, not as a caption meant to be read.
        const makerInscription = React.createElement("div", { style: {
                position: 'absolute', left: 34, bottom: 9, fontSize: 6, letterSpacing: '0.14em',
                fontFamily: "'Fraunces', Georgia, serif", color: 'rgba(232,196,104,0.11)',
                pointerEvents: 'none', userSelect: 'none',
            } }, "I\u00B7VIII");
        featuredCard = React.createElement("div", {
            onClick: () => onOpen(featured.id), className: "continue-card hero-desk", style: {
                cursor: 'pointer', borderRadius: RADIUS_SCALE[16], padding: '26px 20px', marginBottom: 28,
                backgroundImage: [
                    'repeating-linear-gradient(124deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0.05) 1px, transparent 1px, transparent 6px)',
                    'repeating-linear-gradient(35deg, rgba(255,255,255,0.015) 0px, rgba(255,255,255,0.015) 1px, transparent 1px, transparent 10px)',
                    'radial-gradient(140% 100% at 50% 0%, rgba(255,255,255,0.03) 0%, transparent 30%)',
                    'radial-gradient(120% 90% at 50% 115%, rgba(0,0,0,0.35) 0%, transparent 60%)',
                    'linear-gradient(160deg, #241F16 0%, #1B1A1F 52%, #17161B 100%)',
                ].join(', '),
                border: '1px solid rgba(232,196,104,0.22)', position: 'relative', overflow: 'hidden',
                boxShadow: '0 24px 48px -16px rgba(0,0,0,0.65), inset 0 1px 0 rgba(232,196,104,0.08), inset 0 0 60px rgba(200,155,60,0.035), inset 0 -18px 30px -20px rgba(0,0,0,0.5)',
            }
        }, deskLight, glow, coverLamp, tableSurface, tableEdge, engraveTopBand, engraveBottomBand, rosetteTR, rosetteBL, makerInscription,
            innerFrame, outerFrame, cornerFlourish('tl'), cornerFlourish('br'), quillMotif,

            React.createElement("div", { className: "hero-desk-inner" }, coverWrap, textCol));
    }
    // Story Health summary strip for that same featured project — sits between "Continue
    // Writing" and "+ New Project". Kept compact and secondary (small type, single row, muted
    // icon/label) so it reads as a glanceable status strip rather than competing with the
    // Continue Writing card above it; all the same info (score, status, issue count, tap hint)
    // is still there via HealthScoreSummary's `compact` mode, and tapping it still opens the
    // full Story Health page. Loading state and healthy/issues states share one layout so this
    // doesn't jump around as featuredHealth resolves.
    let storyHealthCard = null;
    if (featured) {
        const loading = !featuredHealth;
        storyHealthCard = React.createElement("div", {
            onClick: () => onOpenHealth(featured.id), className: "health-card", style: {
                cursor: 'pointer', borderRadius: RADIUS_SCALE[10], padding: '10px 14px', marginBottom: 14,
                background: 'linear-gradient(160deg, #1D1712 0%, #17130E 100%)', border: '1px solid #3A3020', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10],
            }
        },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[13], opacity: 0.85, flexShrink: 0 } }, "🩺"),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11], fontWeight: 600, color: '#9C9280', textTransform: 'uppercase', letterSpacing: '0.04em', flexShrink: 0 } }, "Health"),
            loading
                ? React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#9C9280' } }, "Checking\u2026")
                : React.createElement(HealthScoreSummary, { compact: true, score: featuredHealth.score, totalIssues: featuredHealth.issueCount, tapHint: featuredHealth.issueCount === 0 ? 'Tap to open.' : 'Tap to review.' }));
    }
    // Remaining projects, shown as a shelf of generated book covers below the featured card.
    // Rendered as a real horizontal shelf, not a wrapping grid: fixed-width, non-stretching
    // rows in a scrollable flex row. That's what makes a shelf of 2 books sit compactly with
    // natural breathing room instead of stretching to fill the row the way a grid would.
    // Each book is wrapped in .shelf-item-cover, which carries its own soft contact shadow
    // (a ::after ellipse) so it reads as resting on the wood rather than floating above it.
    // Which book(s) lean against a neighbor — deterministic by position, not random per render.
    // One lean (index 1, tipping left into the book to its left) as soon as there are enough
    // books for a neighbor to lean into; a second, opposite-direction lean further down the
    // shelf once there's a big enough row for a second one not to read as the whole shelf
    // toppling the same way. Recent Activity only — Begin Your Shelf and every other shelf that
    // reuses BookCover/.shelf-item are untouched, since this logic lives entirely inside this
    // map and never changes BookCover's own defaults.
    // Every book now stands independently at its own calm tilt (see tiltDeg/leanDeg below) rather
    // than one deliberately tipping into a neighbor — that "leaning into a neighbor" detail read
    // as two books overlapping/colliding once the shelf's tilt/lean angles were brought down to a
    // realistic range, which doesn't match the tidy, independently-upright row of the reference.
    // Left at -1/-1 (never triggers) rather than removed outright, so this can be re-enabled by
    // restoring real indices here alone if a future design wants it back at a gentler angle.
    const leanIndexLeft = -1;
    const leanIndexRight = -1;
    const projectRows = rest.map((p, index) => {
        const deleteBtn = React.createElement("button", {
            className: "proj-delete", onClick: (e) => {
                e.stopPropagation();
                const label = p.title && p.title.trim() ? `"${p.title.trim()}"` : 'this project';
                const words = p.wordCount ? ` (${p.wordCount.toLocaleString()} words)` : '';
                setConfirmState({ message: `Delete ${label}${words}? This cannot be undone — everything in it will be permanently lost.`, onConfirm: () => onDelete(p.id) });
            }, style: {
                position: 'absolute', top: 6, right: 6, background: 'rgba(23,23,27,0.82)', border: 'none',
                color: '#EFE7D2', cursor: 'pointer', display: 'flex', borderRadius: RADIUS_SCALE[6],
                padding: 6, opacity: 0, transition: 'opacity 0.15s', zIndex: 2,
            }
        }, React.createElement(IconTrash, null));
        // Subtle, deterministic per-book size variation — every book is a slightly different
        // width/height (independently, so some read as taller-and-narrower or shorter-and-wider,
        // not just uniformly bigger/smaller) rather than identical stamped-out covers. Scaled
        // from the bottom edge so every book still sits flush on the shelf regardless of its
        // height, keeping the row looking organized rather than jagged.
        // For a book with an uploaded custom cover image, an independent width/height scale
        // would stretch/squash the actual photo (unlike the generated pattern covers, where
        // slight distortion isn't visible). So a custom cover keeps the same size-variety effect
        // but scaled uniformly on both axes, preserving the uploaded image's aspect ratio.
        const seed = hashSeed(p.id);
        const scaleW = 0.94 + ((seed % 13) / 12) * 0.12; // ~0.94–1.06
        const scaleH = 0.95 + (((seed >> 4) % 11) / 10) * 0.12; // ~0.95–1.07, independent of width
        const hasCustomCoverImage = !!(p.cover && p.cover.customImageUrl);
        const uniformScale = (scaleW + scaleH) / 2;
        const coverScaleX = hasCustomCoverImage ? uniformScale : scaleW;
        const coverScaleY = hasCustomCoverImage ? uniformScale : scaleH;
        // Physical placement on the shelf: BookCover already gives every cover a quiet default
        // thickness/tilt/lean from its own title/author hash (see defaultPhysicalVariation in
        // book-cover.jsx) — that stays in effect on every other shelf in the app. Here, the one
        // shelf this task is about, those same three knobs are set explicitly instead, from the
        // same per-book seed already used for width/height above, so a heavier lean can be
        // reserved for the two chosen "leaning" books without touching that shared default or
        // any other screen that renders a BookCover.
        const isLeanLeft = index === leanIndexLeft;
        const isLeanRight = index === leanIndexRight;
        const depthScale = 0.85 + (((seed >> 18) % 9) / 8) * 0.4; // ~0.85–1.25 — a different spine thickness per book
        // Calm, upright idle turn — the same range BookCover's own default (defaultPhysicalVariation
        // in book-cover.jsx) already uses on every other shelf in the app, rather than this shelf's
        // old ~-16 to -26deg. That wider range existed only to keep the (now-removed, see `physical`
        // below) true rotated page-block face from foreshortening into an invisible sliver; at this
        // shelf's actual on-screen size it read as each book swiveled a quarter-turn into a fan of
        // tilted cards rather than a row of upright spines.
        const tiltDeg = -5.5 - (((seed >> 21) % 6) / 5) * 3; // ~-5.5 to -8.5deg
        const leanDeg = isLeanLeft ? -(3 + (seed % 3)) // ~-3 to -5deg, tipping left into the book on its left
            : isLeanRight ? (3 + ((seed >> 3) % 3)) // ~3 to 5deg, tipping right into the book on its right
                : (((seed >> 6) % 9) - 4) * 0.4; // ~-1.6 to 1.6deg — most books stay nearly upright
        // `physical: true` (the fuller hardcover-object shell — real front/back cover faces, a true
        // spine face, and page-block faces with actual rotated depth, see book3DShellFull in
        // book-cover.jsx) is what needed the dramatic tilt above to stay legible, and dramatic tilt
        // is exactly what didn't read as a shelf. Dropped in favor of BookCover's default flat-plane
        // shell — the same one every other shelf in the app already uses — whose spine/page-edge
        // strip is a fixed offset rather than a rotated face, so it still reads as a real book even
        // standing upright.
        // A hair of vertical seating variance per book (±0–2px) — real books on a real shelf
        // never sit with their bottom edges perfectly laser-flush; this is the difference
        // between a row that looks printed and one that looks placed by hand. Deliberately
        // tiny and seed-driven (same per-book seed as every other physical trait above) so it
        // stays a texture, not a jagged row.
        const seatOffset = (seed >> 24) % 3; // 0, 1, or 2px
        const scaledCover = React.createElement("div", { style: { transform: `scale(${coverScaleX}, ${coverScaleY}) translateY(${seatOffset}px)`, transformOrigin: 'center bottom' } },
            React.createElement(BookCover, { title: p.title, subtitle: p.subtitle, seriesName: p.seriesName, author: p.author, cover: shelfDisplayCover(p), size: 'sm', depthScale, tiltDeg, leanDeg }));
        // A warmer, wood-toned grounding shadow under each book, layered underneath the shared
        // .shelf-item-cover::after ellipse (kept exactly as-is, since it's reused by Guild
        // Hall's shelf too) — this one only exists here, so each book reads as sitting in the
        // plank's own warm shadow rather than a generic gray blur.
        const warmContact = React.createElement("div", { className: "ra-book-contact" });
        const rankBadge = (p.completed && writerRank) ? React.createElement("div", { title: writerRank.name, style: {
                position: 'absolute', top: 6, left: 6, width: 20, height: 20, borderRadius: '50%', zIndex: 2,
                background: `radial-gradient(circle at 34% 28%, ${writerRank.color}66, #17140F 72%)`,
                border: `1.5px solid ${writerRank.color}`, boxShadow: '0 0 0 2px #100E0A',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[10],
            } }, writerRank.icon) : null;
        // The soft dark falloff a leaning book casts across the neighbor it's tipping into — cast
        // *from* the leaning book's own row (so it moves and reads as attached to that book, not
        // the neighbor), spilling past this row's edge on the side it leans toward. Neither
        // .shelf-item-cover nor BookCover itself knows this exists; it's an extra sibling layer
        // scoped to this shelf only (.ra-book-lean-shadow, new class, appended alongside the
        // .ra-shelf-* rules from Step 2).
        const leanShadow = (isLeanLeft || isLeanRight) ? React.createElement("div", {
            className: `ra-book-lean-shadow ${isLeanLeft ? 'ra-book-lean-shadow-left' : 'ra-book-lean-shadow-right'}`,
        }) : null;
        // The book's outer wrapper is just a plain positioning box now — no border-radius/
        // background/shadow of its own (that was a leftover from when this row was a flat
        // rounded-rect card; the book itself, via BookCover's physical shell, now supplies every
        // edge/corner/shadow a real object needs). .shelf-item-cover's shared CSS (still just
        // `position: relative` plus the ::after contact-shadow ellipse, reused by Guild Hall too)
        // is untouched.
        const coverWrap = React.createElement("div", { className: "shelf-item-cover" },
            warmContact,
            scaledCover,
            deleteBtn,
            rankBadge);
        // Word-count caption removed from this shelf's presentation only — p.wordCount itself is
        // untouched and still drives the delete-confirmation copy above; this shelf just no
        // longer prints a metadata line under every book, so a row of physical books doesn't
        // read as a row of data cards with labels underneath them.
        // A leaning book is also nudged a few px into whichever neighbor it tips toward, closing
        // the gap .shelf-scroll's own flex `gap` would otherwise leave — real contact instead of
        // a book that merely leans in place with a gap still hanging in front of it. Reduced
        // from -9 alongside the calmer leanDeg above — a wider nudge than the now-gentler lean
        // actually swings would overshoot into a visible overlap with the neighbor's front face.
        const leanMargin = isLeanLeft ? { marginLeft: -5 } : isLeanRight ? { marginRight: -5 } : null;
        return React.createElement("div", {
            key: p.id, onClick: () => onOpen(p.id), className: "proj-row shelf-item", style: {
                cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
                flexShrink: 0, scrollSnapAlign: 'start', ...leanMargin,
            }
        }, coverWrap, leanShadow);
    });

    // Closing "book" at the end of the shelf, in place of trailing empty space: same footprint
    // as a real cover (94×141) so it sits naturally in the row, but a fixed size and a dashed
    // gold-tinted outline (echoing the "+ New Project" CTA below) rather than a generated cover,
    // so it reads clearly as an action slot and not one more novel. Shares .proj-row/.shelf-item-cover
    // so it gets the same resting lower/hover-lift and contact shadow as every other book.
    const newProjectTile = React.createElement("div", {
        key: "__new_project__", onClick: onCreate, className: "proj-row shelf-item", style: {
            cursor: 'pointer', position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center',
            flexShrink: 0, scrollSnapAlign: 'start',
        }
    }, React.createElement("div", { className: "shelf-item-cover", style: { borderRadius: RADIUS_SCALE[5] } },
        React.createElement("div", { className: "shelf-add-cover" },
            React.createElement(IconPlus, { width: 17, height: 17 }),
            React.createElement("div", { className: "shelf-add-label" }, "New", React.createElement("br", null), "project"))));
    // The shelf itself: .shelf-ambient is a soft, blurred shadow sitting behind everything, so
    // the shelf reads as mounted a little off the page rather than pasted flat onto it.
    // .shelf-wood is a slim, absolutely-positioned walnut ledge (fixed, so it doesn't scroll
    // with the books — a shelf mounted on the wall, not moving with its books) positioned to
    // sit just under the cover row. .shelf-bookend-left/-right are small turned-wood posts
    // flanking the shelf, purely decorative. .shelf-scroll holds the actual scrolling row of
    // books plus the closing "New project" tile, z-indexed above all of it; captions render
    // below, off the wood entirely. Shown whenever there's at least a featured project, so the
    // shelf — and its closing tile — is always there rather than only appearing once a second
    // project exists.
    const listSection = !featured
        ? React.createElement(React.Fragment, null,
            React.createElement(SectionLabel, null, "Begin Your Shelf"),
            React.createElement(ShelfNiche, null,
                React.createElement("div", { className: "shelf-stage" },
                    React.createElement("div", { className: "shelf-ambient" }),
                    React.createElement("div", { className: "shelf-wood" }),
                    React.createElement("div", { className: "shelf-bookend shelf-bookend-left" }),
                    React.createElement("div", { className: "shelf-bookend shelf-bookend-right" }),
                    React.createElement("div", { className: "shelf-scroll" }, newProjectTile))))
        : React.createElement(React.Fragment, null,
            React.createElement(SectionLabel, null, "Recent Activity"),
            // NOTE: this shelf is rendered WITHOUT the ShelfNiche wrapper on purpose — the
            // rounded-rect bookcase-niche card (background panel, border-radius, inset
            // box-shadow "border", side padding) made this section read as a UI card/dashboard
            // panel. The bookcase itself is now the visual container — a real recessed wood
            // structure built from scoped .ra-shelf-* pieces (Recent Activity only; the "Begin
            // Your Shelf" branch above and every other reuse of .shelf-wood/.shelf-bookend/
            // .shelf-ambient elsewhere in the app, e.g. Guild Hall, is untouched since those
            // class names are shared/global).
            //
            // Structure, back to front:
            //   .ra-shelf-recess    — the dark back wall of the cubby. Deliberately a warmer,
            //                         lighter wood tone than the surrounding page background
            //                         (previously near-identical to it, which is why the recess
            //                         used to visually disappear and the books looked like they
            //                         were floating on a bare ledge instead of sitting inside a
            //                         real enclosure). Panel-seam texture, un-rounded, bleeding
            //                         past the phone's edges so the cubby reads as one tier of a
            //                         much larger bookcase.
            //   .ra-shelf-atmosphere— the same light-wash/vignette overlay as before, sitting
            //                         just above the recess and below everything else.
            //   .ra-shelf-crown     — new: a thin wood cap across the top of the recess, standing
            //                         in for the underside of the shelf tier above. Gives the
            //                         cubby a definite top boundary instead of just fading into
            //                         the page, so it reads as an enclosed box.
            //   .ra-shelf-side-*    — wood support posts flanking the books, now wide enough and
            //                         high-contrast enough to actually read as posts (previously
            //                         a near-invisible 16px sliver in the same tone as the
            //                         recess). Sit flush with the viewport edge — the local
            //                         divider of this cubby — while the recess/crown/plank bleed
            //                         further out past them, so the structure still continues
            //                         beyond both edges of the phone.
            //   .ra-shelf-plank     — the shelf itself. Same top:155px anchor as before so books
            //                         still sit exactly where they did; thickened and split into
            //                         a shadowed top surface, a crisp corner seam, and a lit
            //                         front face.
            //   .ra-shelf-lip       — new: a distinct, thicker front lip jutting below the plank,
            //                         so the shelf reads as a substantial load-bearing plank
            //                         instead of a thin strip.
            //   .ra-shelf-window    — new: masks the scrolling row down to the interior between
            //                         the two posts (see its own comment below), so the books
            //                         stay visually inside the cubby while scrolling instead of
            //                         sliding out over the posts/frame.
            // .shelf-scroll/.shelf-item-cover (books, contact shadows under each book) are
            // completely unchanged — the word-count caption under each book was already removed
            // from this shelf's presentation (p.wordCount itself is untouched and still drives
            // the delete-confirmation copy above).
            React.createElement("div", { className: "shelf-stage ra-shelf-stage" },
                React.createElement("div", { className: "ra-shelf-recess" }),
                React.createElement("div", { className: "ra-shelf-atmosphere" }),
                React.createElement("div", { className: "ra-shelf-crown" }),
                React.createElement("div", { className: "ra-shelf-side ra-shelf-side-left" }),
                React.createElement("div", { className: "ra-shelf-side ra-shelf-side-right" }),
                React.createElement("div", { className: "ra-shelf-plank" }),
                React.createElement("div", { className: "ra-shelf-lip" }),
                // Masked so the row only ever scrolls within the posts, never over them — see
                // .ra-shelf-window above.
                React.createElement("div", { className: "ra-shelf-window" },
                    React.createElement("div", { className: "shelf-scroll ra-shelf-scroll" }, ...projectRows, newProjectTile))));
    const confirmDialog = confirmState && React.createElement(ConfirmDialog, { message: confirmState.message, onCancel: () => setConfirmState(null), onConfirm: () => { confirmState.onConfirm(); setConfirmState(null); } });
    const inboxContent = React.createElement(AuthorInboxScreen, { hasPublished: projects.some((p) => p.completed) });
    const universeContent = React.createElement(LivingUniverseScreen, { onRead: viewPublishedBook, onOpenAuthor, onOpenGuild, onOpenEvent });
    const libraryContent = React.createElement(GrandLibraryScreen, {
        projects, writerName: writerProfile && (writerProfile.penName || writerProfile.name),
        writerGuildName: (guildProfile && guildProfile.guildType) ? activeGuildName : null,
        writerProfile, writerRank, writerReputation,
        onOpen, onRead: onReadBook, onSetPublishStatus, onOpenPacks, onSetPackPublishStatus, onPublishBookWithDetails, onPublishPackWithDetails,
        onOpenAuthor, initialMode: libraryInitialMode, inboxUnreadCount, onOpenInbox: () => setActiveTab('inbox'),
        initialBookId: pendingLibraryBookId, onInitialBookIdConsumed: () => setPendingLibraryBookId(null),
    });
    const guildContent = (!guildProfile || !writerProfile)
        ? React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#7A7160' } }, "Consulting the archives\u2026")
        : (() => {
            const publishedCount = projects.filter((p) => p.completed).length;
            const completedQuestDefs = GUILD_QUEST_DEFS.filter((def) => def.statKey && (lifetimeStats[def.statKey] || 0) >= def.target);
            const questsCompleted = completedQuestDefs.length;
            const guildReputation = resolveGuildReputation({
                statsGuildId, sharedGuildTotals, publishedCount, questsCompleted, firesidePostCount,
            });
            const hasPlayerGuild = !!(playerGuild && playerGuild.name);
            if (!guildProfile.guildType) {
                const cooldownMs = guildCooldownRemainingMs(guildProfile);
                const everJoinedBefore = !!(guildProfile.founderGuildId || guildProfile.playerGuild || guildProfile.leftAt);
                const mode = cooldownMs > 0 ? 'cooldown' : (everJoinedBefore ? 'return' : 'first');
                return React.createElement(GuildWelcomeScreen, {
                    mode, cooldownLabel: cooldownMs > 0 ? formatCooldownRemaining(cooldownMs) : '',
                    hasPlayerGuild, playerGuildName: playerGuild && playerGuild.name, onJoin: onJoinFounderGuild, onEnterOwnGuild,
                    onJoinByCode: onJoinGuildByCode, joinCodeError,
                });
            }
            const isFounderView = guildProfile.guildType === 'founder';
            const isJoinedView = guildProfile.guildType === 'joined';
            const founderGuild = isFounderView ? founderGuildById(guildProfile.founderGuildId) : null;
            // Same isOwner rule guildOrderContent computes further down (see its own comment there)
            // — duplicated rather than shared since this render and that one already independently
            // recompute isFounderView/founderGuild/questsCompleted/guildReputation too. Needed here
            // only so GuildAnthologyHomePreview's empty state can tell an owner's "+ Start an
            // Anthology" from a member's read-only note, same as the real Anthology page does.
            const isOwner = guildProfile.guildType === 'player' || (isFounderView && !!isPlatformAdmin);
            // See GuildHallAtmosphere: the Hall's whole background, lighting, and particle drift
            // come from this same guildId, so a Fantasy Guild's torchlit stone or a Horror Guild's
            // fog carries in from the building the writer picked, rather than every Hall looking
            // the same underneath a different crest. Joined/self-founded guilds have no preset
            // architecture of their own, so they fall back to the same warm hall the General
            // Writers Guild uses (see GUILD_ATMOSPHERE_DEFAULT).
            const guildAtmosphereId = isFounderView ? guildProfile.founderGuildId : null;
            const justEnteredThisGuild = enteredGuildRef.current !== (guildAtmosphereId || 'general');
            const activeGuild = isFounderView
                ? { name: (founderGuild && founderGuild.name) || 'Founder Guild', crest: null, motto: (founderGuild && founderGuild.motto) || '', createdDate: guildProfile.founderJoinedDate }
                : isJoinedView
                    ? (joinedGuild ? { name: joinedGuild.name, crest: joinedGuild.crest, motto: joinedGuild.motto, createdDate: joinedGuild.joinedDate } : { name: '', crest: null, motto: '', createdDate: new Date().toISOString() })
                    : (playerGuild || { name: '', crest: null, motto: '', createdDate: new Date().toISOString() });
            // activeGuildRemoteId is the real player_guilds.id for whichever guild is active here
            // — a joined/self-founded Player Guild's own row, or (since supabase/history/
            // 69_migration_founder_guild_parity.sql) a Founder Guild's fixed backendGuildId — so
            // GuildAnthologyShelf below can show real published anthology books for a Founder
            // Guild's Hall too, not just inside the Guild Order tab.
            const activeGuildRemoteId = isFounderView
                ? (founderGuild && founderGuild.backendGuildId) || null
                : isJoinedView ? (joinedGuild && joinedGuild.id)
                    // Same synced-gate as remoteGuildId above — don't hand out a self-founded
                    // guild's id here either until the server actually agrees it exists.
                    : (playerGuild && playerGuild.synced !== false ? playerGuild.id : null);
            return React.createElement(GuildHallAtmosphere, { guildId: guildAtmosphereId, justEntered: justEnteredThisGuild },
                React.createElement("div", { style: { textAlign: 'center' } },
                React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Guild Hall"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#9C9280', marginTop: 6, marginBottom: 30 } }, "A fortress raised for writers, not a feed to scroll")),
                React.createElement(GuildBanner, {
                    guild: activeGuild, fileInputRef: crestFileInputRef, handleCrestFile, crestError,
                    onSaveGuild: onSaveOwnGuild, onLeave: onLeaveGuild, onInvite: handleInviteGuild, inviteStatus,
                    reputation: guildReputation, isFounder: isFounderView, isJoinedMember: isJoinedView, founderIcon: founderGuild && founderGuild.icon,
                    founderGuildId: guildProfile.founderGuildId,
                    onlineCount: (isFounderView || activeGuildRemoteId) ? onlineGuildMembers.size : null,
                }),
                React.createElement(GuildOrderOverview, {
                    onSelect: enterGuildOrder,
                    overrides: {
                        // Both drawn from data already computed just above for this same Guild Hall
                        // render (onlineGuildMembers/questsCompleted) — no new fetch, just a livelier
                        // one-liner than the static blurb wherever a real number is on hand.
                        roster: (isFounderView || activeGuildRemoteId) && onlineGuildMembers.size > 0
                            ? `${onlineGuildMembers.size} member${onlineGuildMembers.size === 1 ? '' : 's'} online now`
                            : undefined,
                        quests: `${questsCompleted} of ${GUILD_QUEST_DEFS.length} complete`,
                    },
                }),
                React.createElement(GuildEventsHomePreview, { remoteGuildId: activeGuildRemoteId, onViewEvents: () => enterGuildOrder('events') }),
                React.createElement(GuildAnthologyHomePreview, {
                    remoteGuildId: activeGuildRemoteId, projects, isOwner,
                    onOpenAnthology: (anthologyId) => enterGuildAnthology({ anthologyId }),
                    onOpenWorkshop: () => enterGuildAnthology({}),
                    onStartAnthology: () => enterGuildAnthology({ action: 'create' }),
                    onBringProject: () => enterGuildAnthology({ action: 'create' }),
                }),
                React.createElement(NoticeBoard, { guildId: activeGuildRemoteId, isFounderView }),
                React.createElement("div", { style: { marginTop: 34 } }, React.createElement(GuildQuestBoard, { lifetimeStats })),
                React.createElement("div", { style: { marginTop: 34, marginBottom: 8 } },
                    React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "flame", size: 20, style: { display: "inline-block" } }), label: "The Fireside" }),
                    React.createElement("div", { style: { marginTop: 16 } }, React.createElement(FiresideBoard, { profile: writerProfile, guildId: isFounderView ? guildProfile.founderGuildId : null }))),
                React.createElement(GuildBookshelf, {
                    projects, writerName: writerProfile && (writerProfile.penName || writerProfile.name),
                    guildName: activeGuildName, feedback: guildFeedback, onAddFeedback: handleAddGuildFeedback, onSetPublishStatus, onOpen: onReadBook,
                    // A Founder Guild's book-publishing membership check keys off its fixed slug
                    // (founder_guild_members.guild_id); a self-founded or joined Player Guild's
                    // keys off its real player_guilds.id — activeGuildRemoteId already resolves
                    // to exactly that for both cases (see its own comment above). Player Guild
                    // Bookshelves are real as of 92_migration_player_guild_book_publishing.sql —
                    // this was the last place still hardcoded to Founder-only.
                    onOpenAuthor, guildId: isFounderView ? guildProfile.founderGuildId : activeGuildRemoteId,
                }),
                React.createElement("div", { onClick: () => changeHomeTab('library'), style: {
                        marginTop: 34, cursor: 'pointer', textAlign: 'center', background: 'linear-gradient(160deg, #211C13, #17130E)',
                        border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: '20px 18px',
                    } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[19], marginBottom: 6 } }, React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } })),
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, "The Grand Library"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#9C9280', marginTop: 4 } }, "Publish books, browse the guild's shelves, and manage your marketplace listings \u2192"))));
        })();
    const guildOrderContent = (!guildProfile || !writerProfile || !guildProfile.guildType)
        ? React.createElement("div", { style: { textAlign: 'center', padding: '64px 12px', fontSize: TYPE_SCALE[12.5], color: '#7A7160' } }, "Join a guild first to enter the Guild Order.")
        : (() => {
            const rank = writerRank || WRITER_RANKS[0];
            const publishedCount = projects.filter((p) => p.completed).length;
            const completedQuestDefs = GUILD_QUEST_DEFS.filter((def) => def.statKey && (lifetimeStats[def.statKey] || 0) >= def.target);
            const questsCompleted = completedQuestDefs.length;
            const guildReputation = resolveGuildReputation({
                statsGuildId, sharedGuildTotals, publishedCount, questsCompleted, firesidePostCount,
            });
            const guildRank = guildRankForReputation(guildReputation);
            const isFounderView = guildProfile.guildType === 'founder';
            const founderGuild = isFounderView ? founderGuildById(guildProfile.founderGuildId) : null;
            const activeGuild = isFounderView
                ? { name: (founderGuild && founderGuild.name) || 'Founder Guild', icon: (founderGuild && founderGuild.icon) || React.createElement(InkIcon, { name: 'castle', size: 22 }), motto: (founderGuild && founderGuild.motto) || '' }
                : { name: (playerGuild && playerGuild.name) || 'Your Guild', icon: React.createElement(InkIcon, { name: 'castle', size: 22 }), motto: (playerGuild && playerGuild.motto) || '' };
            const guildKey = isFounderView ? (guildProfile.founderGuildId || 'founder') : ('own:' + (activeGuild.name || 'guild'));
            // guildOrderBackendId is the real player_guilds.id GoTreasuryTab/GuildAnthologyScreen/
            // GoGuildEventsSection actually operate against — remoteGuildId (a real, synced Player
            // Guild) for a Player Guild, or the Founder Guild's fixed backendGuildId (see
            // FOUNDER_GUILDS in guild-hall.jsx and supabase/history/69_migration_founder_guild_
            // parity.sql) for a Founder Guild. Deliberately NOT the same variable as remoteGuildId
            // itself, which stays exactly what it was — null for Founder Guilds — since that's a
            // different id space (player_guilds.id vs. a Founder Guild's fixed text slug), not a
            // gap: Level/XP/Reputation aggregation has its own equivalent pairing, statsGuildId/
            // statsGuildType above, covering both guild types since migration 88.
            const guildOrderBackendId = isFounderView ? (founderGuild && founderGuild.backendGuildId) || null : remoteGuildId;
            // isOwner is real too: 'player' means this device owns the guild (player_guilds.
            // owner_id), which is the only authority spend_from_guild_treasury checks server-side
            // for a Player Guild. For a Founder Guild there's no owner_id — the same server-side
            // authority (is_guild_officer()) instead recognizes any Inkroot admin, so isPlatformAdmin
            // plays the equivalent role here; every write still re-checks this for itself
            // server-side regardless of what this client-side flag says.
            const isOwner = guildProfile.guildType === 'player' || (isFounderView && !!isPlatformAdmin);
            return React.createElement(GuildOrderScreen, {
                guild: activeGuild, guildKey, isFounderView, guildRank, guildReputation,
                writerProfile, writerRank: rank, projects, lifetimeStats, remoteGuildId: guildOrderBackendId, isOwner,
                onViewPublishedBook: viewPublishedBook, initialTab: pendingGuildOrderTab,
                initialAnthologyId: pendingAnthology.id, initialAnthologyAction: pendingAnthology.action, initialAnthologySeedProjectId: pendingAnthology.seedProjectId,
            });
        })();
    // The reputation earned here (published books, completed guild quests, Fireside posts) also
    // shows up on the Writer Profile — it's the same number, just surfaced in two places.
    useEffect(() => {
        if (!writerProfile || !onReputationChange)
            return;
        const publishedCount = projects.filter((p) => p.completed).length;
        const completedQuestDefs = GUILD_QUEST_DEFS.filter((def) => def.statKey && (lifetimeStats[def.statKey] || 0) >= def.target);
        const guildReputation = resolveGuildReputation({
            statsGuildId, sharedGuildTotals, publishedCount,
            questsCompleted: completedQuestDefs.length, firesidePostCount,
        });
        onReputationChange(guildReputation);
    }, [writerProfile, projects, lifetimeStats, firesidePostCount, statsGuildId, sharedGuildTotals]);
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { style: {
                minHeight: '100vh', color: '#EFE7D2', position: 'relative',
                fontFamily: "'Inter', ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif",
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                // Grand Hall backdrop for the whole homepage: a warm charcoal-stone ground with a
                // soft candlelit glow high overhead (as if from a hall's own chandeliers, echoing
                // GrandLibraryAtmosphere's window light elsewhere), two much fainter pools of that
                // same light off to each side suggesting tall flanking archways, and a very quiet
                // repeating vertical rule suggesting stone joints / shelf uprights receding into
                // the hall. Everything here sits well below the muted-brown backgrounds every card
                // already uses, so cards still read as sitting slightly forward of the room itself.
                backgroundColor: '#14100B',
                backgroundImage: [
                    'radial-gradient(1100px 480px at 50% -8%, rgba(232,196,104,0.09) 0%, transparent 62%)',
                    'radial-gradient(55% 38% at 12% 0%, rgba(232,196,104,0.045) 0%, transparent 72%)',
                    'radial-gradient(55% 38% at 88% 0%, rgba(232,196,104,0.045) 0%, transparent 72%)',
                    'repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0px, rgba(0,0,0,0.10) 1px, transparent 1px, transparent 130px)',
                    // A deep vignette pulling the far edges of the hall into shadow, so the room
                    // recedes into darkness rather than reading as a flat, evenly-lit panel.
                    'radial-gradient(120% 75% at 50% 30%, transparent 55%, rgba(0,0,0,0.4) 100%)',
                    'linear-gradient(180deg, #1C160F 0%, #17130E 55%, #14100B 100%)',
                ].join(', '),
            } },
            React.createElement("style", null, `
        * { box-sizing: border-box; }
        .proj-row > div:first-child { transition: transform var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease); transform: translateY(6px); }
        .proj-row:hover > div:first-child { transform: translateY(-2px); box-shadow: 0 10px 22px rgba(0,0,0,0.45); }
        .proj-row:hover .proj-delete { opacity: 1 !important; }

        /* ---------- Bookshelf: dark walnut plank ----------
           .shelf-stage holds a slim .shelf-wood ledge (bottom-anchored, does not scroll) behind
           a scrolling row of books, so the wood reads as one continuous shelf the books glide
           along rather than moving with them. It's deliberately thin and quiet — a ledge the
           books rest on, not a slab competing with them for attention. Grain is just two wide,
           very-low-opacity linear bands rather than a repeating photographic texture, so it
           stays refined rather than reading as cartoon wood.
           Position math (kept in one place so it's easy to re-tune): shelf-scroll has 16px
           padding-top, and 'sm' covers are 94×141 — so a cover's laid-out bottom edge is 157px
           down. Covers are then visually lowered 6px onto the shelf (.proj-row > div:first-child
           transform) so their bottom edge sits right at/into the plank's top rather than
           floating just above it. The plank's top (155px) is positioned against that same
           157px line; captions start 22px below the cover's laid-out bottom so they clear the
           plank's bottom edge (175px) regardless of the visual lowering. */
        /* The bookcase alcove a shelf sits inside (see ShelfNiche): a recessed wood-paneled
           back wall with a faint, blurred second row of spines glimpsed above the real shelf,
           so the whole assembly reads as one tier of a real library bookcase. Sized by its own
           padding (24px sides) so .shelf-stage's existing -24px bleed margin below still lands
           exactly on the niche's edges, unchanged. */
        .shelf-niche {
          position: relative; border-radius: 14px 14px 4px 4px; padding: 22px 24px 0;
          background:
            /* A quiet warm glow spilling in from above, the same chandelier/candlelight this
               whole hall is lit by, fading out well before it reaches the back of the niche —
               so the top of the alcove reads as gently lit and the depth behind the spines
               still reads as genuinely darker, not just a flat panel. */
            radial-gradient(120% 60% at 50% 0%, rgba(232,196,104,0.05) 0%, transparent 60%),
            repeating-linear-gradient(90deg, rgba(0,0,0,0.10) 0px, transparent 2px, transparent 46px),
            linear-gradient(180deg, #241C13 0%, #1A140D 70%, #150F09 100%);
          box-shadow: inset 0 14px 26px -12px rgba(0,0,0,0.7), inset 0 1px 0 rgba(232,196,104,0.05), inset 0 0 0 1px rgba(0,0,0,0.4);
        }
        .shelf-backrow {
          display: flex; align-items: flex-end; justify-content: center; gap: 3px; opacity: 0.5;
          filter: blur(0.4px); margin-bottom: -4px; pointer-events: none;
        }
        .shelf-backspine { width: 11px; border-radius: 2px 2px 0 0; box-shadow: inset -2px 0 3px rgba(0,0,0,0.4), inset 2px 0 2px rgba(255,255,255,0.05); }
        .shelf-stage { position: relative; margin: 4px -24px 20px -24px; }
        /* Faint ambient shadow behind the whole assembly — a soft, blurred dark glow, not a
           hard shape — so the shelf feels lifted slightly off the page rather than flat. */
        .shelf-ambient {
          position: absolute; left: 8px; right: 8px; top: 18px; height: 150px; z-index: 0;
          pointer-events: none; filter: blur(20px);
          background: radial-gradient(ellipse at center, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 68%);
        }
        .shelf-wood {
          position: absolute; left: 24px; right: 24px; top: 155px; height: 20px; border-radius: 3px;
          z-index: 1;
          background:
            /* Wood grain: irregular, low-opacity streaks running the length of the plank rather
               than a repeating pattern of even width — real grain wanders, it doesn't tile. Layered
               on top of the same warm directional highlight and walnut base gradient this ledge
               already had. */
            repeating-linear-gradient(90deg,
              rgba(0,0,0,0.09) 0px, rgba(0,0,0,0.09) 1px, transparent 1px, transparent 5px,
              rgba(0,0,0,0.05) 5px, rgba(0,0,0,0.05) 6px, transparent 6px, transparent 13px,
              rgba(0,0,0,0.07) 13px, rgba(0,0,0,0.07) 14px, transparent 14px, transparent 24px),
            linear-gradient(120deg, rgba(255,241,214,0.06) 0%, rgba(255,241,214,0) 35%),
            linear-gradient(90deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(0,0,0,0.10) 100%),
            linear-gradient(180deg, #4A3220 0%, #35210F 50%, #281709 100%);
          box-shadow:
            0 5px 10px -3px rgba(0,0,0,0.42),
            inset 0 1px 0 rgba(212,177,116,0.3),
            inset 0 1px 2px rgba(255,255,255,0.04),
            inset 0 -5px 7px -5px rgba(0,0,0,0.55);
        }
        /* Carved wooden bookends — small turned posts flanking the shelf. A rounded cap
           (::before) stands in for a lathe-turned finial, and a thin inlay ring (::after)
           gives one restrained carved detail, echoing the app's medieval touches elsewhere
           without becoming decorative clutter. */
        .shelf-bookend {
          position: absolute; top: 8px; width: 14px; height: 168px; border-radius: 6px 6px 3px 3px;
          z-index: 1; pointer-events: none;
          background:
            linear-gradient(100deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 26%),
            linear-gradient(180deg, #4E3624 0%, #382312 55%, #241408 100%);
          box-shadow:
            0 6px 12px rgba(0,0,0,0.4),
            inset 0 1px 0 rgba(212,177,116,0.28),
            inset -2px 0 4px rgba(0,0,0,0.35),
            inset 2px 0 3px rgba(255,255,255,0.04);
        }
        .shelf-bookend::before {
          content: ''; position: absolute; top: -5px; left: 50%; transform: translateX(-50%);
          width: 21px; height: 9px; border-radius: 5px;
          background: linear-gradient(180deg, #5C4230 0%, #3C2814 100%);
          box-shadow: 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(216,181,120,0.35);
        }
        .shelf-bookend::after {
          content: ''; position: absolute; left: 2px; right: 2px; top: 30px; height: 1.5px;
          border-radius: 1px; background: rgba(212,177,116,0.28);
        }
        .shelf-bookend-left { left: 8px; }
        .shelf-bookend-right { right: 8px; }
        .shelf-scroll {
          position: relative; z-index: 3; display: flex; align-items: flex-start; gap: 12px;
          overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity;
          -webkit-overflow-scrolling: touch; scrollbar-width: none;
          padding: 16px 24px 6px 24px;
        }
        .shelf-scroll::-webkit-scrollbar { display: none; }
        /* ---------- Recent Activity only: the bookcase itself as the visual container ----------
           Scoped ra- classes so nothing here touches the shared .shelf-wood/.shelf-bookend/
           .shelf-ambient rules above (still used, unmodified, by "Begin Your Shelf" and by
           other screens like Guild Hall that reuse those exact class names).
           Rebuilt as a real recessed cubby, back to front: .ra-shelf-recess (back wall) +
           .ra-shelf-atmosphere (light wash) + .ra-shelf-crown (top cap) + .ra-shelf-side-left/
           -right (support posts) + .ra-shelf-plank (thick shelf) + .ra-shelf-lip (front edge),
           with the books sitting inside, bounded by the crown above and the plank below. */
        /* Extra top clearance on this one stage only (26px vs the shared 4px) so the recess/
           crown can extend upward into a visible "ceiling" above the books without covering the
           "Recent Activity" label above it — .shelf-stage's own margin is untouched for every
           other shelf that reuses it. */
        /* The recess/crown/plank/lip below are all absolutely positioned, so they don't
           contribute to this container's own height — left alone, the box collapses to just
           the in-flow .shelf-scroll content (~163px) while the plank+lip actually paint down
           to ~214px plus shadow blur. Without reserved space for that difference, whatever
           section follows this shelf in the page (the Continue Writing card) starts before the
           shelf is visually finished, and the two overlap. padding-bottom reserves the real
           footprint so the next section clears it cleanly. */
        .ra-shelf-stage { margin-top: 26px; padding-bottom: 64px; }
        /* The scrolling row's own box used to span the full width of .shelf-stage — the same
           footprint the two carved posts (.ra-shelf-side, 28px wide, anchored at left:0/right:0)
           sit in — and sat above them in stacking order (z-index 3 vs 2), so a book scrolled
           anywhere near an edge painted right over the post instead of stopping short of it: the
           books looked like they were sliding out past the shelf's own frame rather than staying
           inside it. This wrapper masks the scroll row down to just the interior between the two
           posts (margin equal to their 28px width) and clips anything that would extend past
           that with overflow: hidden, so scrolling now only ever reveals more of the row through
           that fixed window — nothing scrolls out over the posts, top cap, or recess edges again.
           The actual touch/drag scrolling still happens on .ra-shelf-scroll inside it, unchanged. */
        .ra-shelf-window { position: relative; z-index: 3; margin: 0 28px; overflow: hidden; }
        /* Tightened from the shared .shelf-scroll default (24px) now that .ra-shelf-window's own
           28px margin already lines up with the posts' inner face — a book's cover sits close
           enough to that edge that it reads as resting against the post, without touching the
           mask boundary closely enough to look clipped. Scoped to Recent Activity only — every
           other shelf that reuses .shelf-scroll keeps its original 24px padding. */
        .ra-shelf-scroll { padding-left: 8px; padding-right: 8px; }
        /* Flat, un-rounded recessed back wall — the interior wall of the bookcase cubby the
           books physically stand inside. Deliberately a warmer, lighter wood tone than the
           page's own near-black background (previously the two were almost identical, which is
           why the recess used to disappear entirely and the books read as floating on a bare
           ledge rather than sitting inside an enclosure) — panel-seam texture, and inset
           shadows on all four sides so the wall itself reads as sunken. Bleeds 40px past each
           phone edge (cropped by the app's own html/body overflow-x: hidden) so the cubby reads
           as one tier of a much larger bookcase rather than a self-contained widget. No
           border-radius, no box "border" — a flat recessed plane, the opposite of a UI card. */
        .ra-shelf-recess {
          position: absolute; left: -40px; right: -40px; top: -22px; height: 221px; z-index: 0;
          background:
            repeating-linear-gradient(90deg, rgba(0,0,0,0.28) 0px, rgba(0,0,0,0.28) 2px, transparent 2px, transparent 58px),
            linear-gradient(180deg, #2E1D10 0%, #24160C 40%, #190F08 78%, #120B06 100%);
          box-shadow:
            inset 0 26px 34px -18px rgba(0,0,0,0.92),
            inset 0 -30px 34px -20px rgba(0,0,0,0.7),
            inset 22px 0 30px -22px rgba(0,0,0,0.85),
            inset -22px 0 30px -22px rgba(0,0,0,0.85);
        }
        /* Environmental depth for this nook only. A single warm light source (the same
           upper-left direction every book's own .ink-book3d-sheen already catches its highlight
           from, so the whole shelf reads as lit by one consistent source rather than each book
           lit in isolation) washes faintly over the back wall; a low ambient-occlusion band
           darkens the wall toward the bottom, where the books actually meet it, the way a real
           shelf's back panel goes into shadow under a row of books rather than staying evenly
           lit all the way down. Sits directly above .ra-shelf-recess and below the crown/plank/
           sides/books (same z-index, later in source order), so it only ever lights the wall
           behind the books — never dims the books, the plank, or anything resting in front of
           it. No blur-glow, no color shift, no new geometry — just light falloff for the
           existing recess/plank/book geometry to read by. */
        /* Ambient light wash over the back wall — the same upper-left source every book's own
           .ink-book3d-sheen already catches its highlight from — plus a soft warm glow spilling
           down from a hanging lamp near top-center (reference point 5 "warm lighting"), and a
           low ambient-occlusion band darkening the wall toward the bottom, where the books
           actually meet it, the way a real shelf's back panel goes into shadow under a row of
           books rather than staying evenly lit all the way down. Sits directly above
           .ra-shelf-recess and below the crown/plank/sides/books (same z-index, later in source
           order), so it only ever lights the wall behind the books — never dims the books, the
           plank, or anything resting in front of it. No new geometry, no blur-glow shapes — just
           light falloff for the existing recess/plank/book geometry to read by. */
        .ra-shelf-atmosphere {
          position: absolute; left: -40px; right: -40px; top: -22px; height: 221px; z-index: 0; pointer-events: none;
          background:
            radial-gradient(30% 26% at 50% 4%, rgba(255,214,150,0.20) 0%, transparent 68%),
            radial-gradient(60% 55% at 20% 0%, rgba(255,224,178,0.09) 0%, transparent 55%),
            linear-gradient(180deg, transparent 55%, rgba(0,0,0,0.4) 100%);
        }
        /* The top cap of the cubby — a heavy carved beam standing in for the underside of the
           shelf tier above (see reference point 1 "heavy top beam"), so the recess has a
           definite, substantial top boundary instead of just fading into the page above it.
           Split into a shadowed underside and a lit face, with a carved trim line between them
           (::before/::after), the same depth language as the plank below. */
        .ra-shelf-crown {
          position: absolute; left: -40px; right: -40px; top: -22px; height: 26px; z-index: 1;
          background:
            linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 30%),
            linear-gradient(180deg, #4A331C 0%, #3A2716 40%, #2A1B0E 72%, #1C1108 100%);
          box-shadow: 0 8px 14px -2px rgba(0,0,0,0.65), inset 0 1px 0 rgba(212,177,116,0.22);
        }
        .ra-shelf-crown::before { content: ''; position: absolute; left: 0; right: 0; top: 17px; height: 1px; background: rgba(0,0,0,0.4); }
        .ra-shelf-crown::after { content: ''; position: absolute; left: 0; right: 0; top: 18px; height: 1px; background: rgba(255,241,214,0.16); }
        /* The physical shelf plank. Kept at top: 155px, same anchor .shelf-wood always used, so
           books still sit exactly where they did. Thickened to 46px (from 34px) and split into
           three readable depth cues: a shadowed top surface (0-15px, in shadow under the
           books), a crisp two-line corner seam (15-16px, the edge where the top meets the
           front face) via ::before/::after, and a brighter front face (16-46px) that catches
           the hall's light. Bleeds past the phone edges same as the recess. */
        .ra-shelf-plank {
          position: absolute; left: -40px; right: -40px; top: 155px; height: 46px; z-index: 1;
          background:
            linear-gradient(180deg, rgba(0,0,0,0.30) 0%, rgba(0,0,0,0) 34%),
            repeating-linear-gradient(90deg,
              rgba(0,0,0,0.09) 0px, rgba(0,0,0,0.09) 1px, transparent 1px, transparent 5px,
              rgba(0,0,0,0.05) 5px, rgba(0,0,0,0.05) 6px, transparent 6px, transparent 13px,
              rgba(0,0,0,0.07) 13px, rgba(0,0,0,0.07) 14px, transparent 14px, transparent 24px),
            linear-gradient(180deg, #5A3C21 0%, #4A3220 32%, #35210F 62%, #26160A 100%);
          box-shadow:
            0 4px 8px -2px rgba(0,0,0,0.5),
            inset 0 1px 0 rgba(212,177,116,0.32),
            inset 0 2px 3px rgba(255,255,255,0.05);
        }
        .ra-shelf-plank::before { content: ''; position: absolute; left: 0; right: 0; top: 15px; height: 1px; background: rgba(0,0,0,0.4); }
        .ra-shelf-plank::after { content: ''; position: absolute; left: 0; right: 0; top: 16px; height: 1px; background: rgba(255,241,214,0.18); }
        /* A distinct, thicker front lip jutting below the plank's front face — the forward-most,
           closest-to-camera edge of the shelf, so the whole assembly reads as a substantial
           load-bearing plank with a real molded edge rather than one thin strip of color. */
        .ra-shelf-lip {
          position: absolute; left: -40px; right: -40px; top: 201px; height: 13px; z-index: 1;
          background: linear-gradient(180deg, #6A4A2A 0%, #4A3220 45%, #2A1A0C 100%);
          box-shadow:
            0 10px 16px -3px rgba(0,0,0,0.6),
            inset 0 1px 0 rgba(232,196,140,0.4),
            inset 0 -3px 5px rgba(0,0,0,0.5);
        }
        /* Wooden vertical support posts flanking the books — the local divider of this cubby,
           now wide and high-contrast enough to actually read as carved posts (previously a
           16px sliver in nearly the same tone as the recess behind it, which made it almost
           invisible). Flush with the viewport edge rather than bled off it — the recess/crown/
           plank/lip still bleed further out past them, so the bookcase still reads as
           continuing beyond both edges of the phone; these posts are just this cubby's own
           frame. Span the full height of the recess, from the crown down to the plank. */
        /* Wooden vertical support pillars flanking the books — carved posts with a distinct
           capital block at top and a base block at bottom (reference point 1's fluted-column
           look), plus vertical fluting instead of horizontal grain, so they read as turned
           bookcase pillars rather than a plain painted strip. Flush with the viewport edge
           rather than bled off it — the recess/crown/plank/lip still bleed further out past
           them, so the bookcase still reads as continuing beyond both edges of the phone; these
           pillars are just this cubby's own frame. Span the full height of the recess, from the
           crown down to the plank. */
        .ra-shelf-side {
          position: absolute; top: -22px; width: 28px; height: 221px; z-index: 2; pointer-events: none;
          background:
            repeating-linear-gradient(90deg, rgba(0,0,0,0.16) 0px, rgba(0,0,0,0.16) 1px, transparent 1px, transparent 4px, rgba(255,255,255,0.05) 4px, rgba(255,255,255,0.05) 5px, transparent 5px, transparent 8px),
            linear-gradient(100deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0) 30%),
            linear-gradient(180deg, #5A3E27 0%, #432C18 45%, #2E1D10 100%);
          box-shadow: 0 10px 16px rgba(0,0,0,0.45);
        }
        /* Capital block — a wider, lit carved cap where the pillar meets the beam above. */
        .ra-shelf-side::before {
          content: ''; position: absolute; left: -3px; right: -3px; top: 0; height: 20px; border-radius: 2px 2px 0 0;
          background: linear-gradient(180deg, #6A4A2A 0%, #4A3220 60%, #35210F 100%);
          box-shadow: 0 2px 4px rgba(0,0,0,0.5), inset 0 1px 0 rgba(232,196,140,0.35);
        }
        /* Base block — a matching wider foot where the pillar meets the shelf below. */
        .ra-shelf-side::after {
          content: ''; position: absolute; left: -3px; right: -3px; bottom: 0; height: 16px; border-radius: 0 0 2px 2px;
          background: linear-gradient(180deg, #35210F 0%, #2A1A0C 55%, #1C1108 100%);
          box-shadow: 0 -1px 0 rgba(212,177,116,0.15) inset, 0 3px 6px rgba(0,0,0,0.5);
        }
        .ra-shelf-side-left { left: 0; box-shadow: 0 10px 16px rgba(0,0,0,0.45), inset -4px 0 7px rgba(0,0,0,0.5), inset 3px 0 4px rgba(255,255,255,0.08); }
        .ra-shelf-side-right { right: 0; box-shadow: 0 10px 16px rgba(0,0,0,0.45), inset 4px 0 7px rgba(0,0,0,0.5), inset -3px 0 4px rgba(255,255,255,0.08); }
        /* The falloff a leaning book (see leanShadow in projectRows above) casts across the
           neighbor it tips into — dark right at the touching edge, fading away as it crosses
           into the neighbor's cover, rather than a hard-edged rectangle. Scoped to Recent
           Activity's own book rows; .shelf-item-cover's shared shadow (the ellipse under every
           book, everywhere) is untouched. */
        .ra-book-lean-shadow {
          position: absolute; top: 4px; width: 12px; height: 150px; pointer-events: none; z-index: 3; filter: blur(2px);
        }
        .ra-book-lean-shadow-left { left: -12px; background: linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.3) 100%); }
        .ra-book-lean-shadow-right { right: -12px; background: linear-gradient(90deg, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0) 100%); }
        /* Warm, wood-toned grounding shadow, Recent Activity's books only — sits behind the
           shared .shelf-item-cover::after ellipse (untouched) so each book reads as casting its
           shadow onto the walnut plank specifically, not a neutral gray surface. Wider and
           softer than the shared ellipse, so the two combine into one believable contact
           shadow: a warm broad pool plus a tighter dark core. */
        .ra-book-contact {
          position: absolute; left: 50%; bottom: -9px; transform: translateX(-50%);
          width: 92%; height: 16px; pointer-events: none; filter: blur(3px); z-index: 0;
          background: radial-gradient(ellipse at center, rgba(20,11,4,0.55) 0%, rgba(20,11,4,0) 70%);
        }
        .shelf-item-cover { position: relative; }
        /* Contact shadow where the book meets the plank — two stacked falloffs (a tight, barely-
           blurred dark core right at the touch point, then a wider softer pool around it) rather
           than one blurred ellipse, so the base of every book reads as genuinely resting in
           contact with the wood instead of hovering just above it. */
        .shelf-item-cover::after {
          content: ''; position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%);
          width: 74%; height: 10px; pointer-events: none; filter: blur(1px);
          background:
            radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 40%),
            radial-gradient(ellipse at center, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0) 72%);
        }
        .shelf-label {
          font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 10.5; letter-spacing: 0.02em;
          color: #9C9280; text-align: center; margin-top: 22px; opacity: 0.9;
        }
        /* Closing "New project" tile — same footprint as a book (94×141) so it sits naturally
           at the end of the row, but dashed and gold-tinted so it's unmistakably an action, not
           another spine. */
        .shelf-add-cover {
          width: 94px; height: 141px; box-sizing: border-box; border-radius: 5px;
          display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px;
          border: 1px dashed rgba(200,155,60,0.4); color: #C89B3C;
          background: linear-gradient(180deg, rgba(200,155,60,0.05) 0%, rgba(200,155,60,0.015) 100%);
          transition: border-color var(--ink-dur) var(--ink-ease), background var(--ink-dur) var(--ink-ease);
        }
        .proj-row:hover .shelf-add-cover { border-color: rgba(200,155,60,0.7); background: rgba(200,155,60,0.09); }
        .shelf-add-label {
          font-family: 'Fraunces', Georgia, serif; font-size: 11.5; font-weight: 600; line-height: 1.3;
          text-align: center; letter-spacing: 0.01em;
        }

        .ghost-btn:hover { background: #241D14 !important; }
        /* "Continue Writing" hero — desk-scene layout: cover and text sit side by side from
           tablet width up, the same as before, but stack centered on a narrow phone where 172px
           of cover plus text has no room to breathe. Hovering the whole card lifts it slightly
           and warms its border/shadow, echoing the same "resting on a surface, lifts on touch"
           language as the bookshelf rows below it. */
        /* "Continue Writing" hero — desk-scene layout: cover and text sit side by side at every
           width now (previously stacked/centered below 560px) so a phone matches the reference
           layout too — smaller gap here than the tablet/desktop version so 172px of cover still
           leaves the text column room to breathe on a narrow screen. */
        .hero-desk-inner { display: flex; flex-direction: row; align-items: flex-start; text-align: left; gap: 16px; }
        @media (min-width: 560px) {
          .hero-desk-inner { gap: 24px; }
        }
        .continue-card {
          transition: transform var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease);
        }
        .continue-card:hover {
          transform: translateY(-2px);
          border-color: rgba(232,196,104,0.38) !important;
          box-shadow: 0 26px 52px -16px rgba(0,0,0,0.65), inset 0 1px 0 rgba(232,196,104,0.1), inset 0 0 60px rgba(200,155,60,0.045), 0 0 0 1px rgba(232,196,104,0.06);
        }
        /* Soft contact shadow under the featured cover, a slight resting lean, plus a slight
           independent lift-and-straighten on hover so the cover reads as propped against the
           shelf rather than pasted flat onto the card. */
        .hero-desk-cover {
          position: relative; flex-shrink: 0;
          transition: transform var(--ink-dur) var(--ink-ease);
        }
        .hero-desk-cover::after {
          content: ''; position: absolute; left: 50%; bottom: -12px; transform: translateX(-50%);
          width: 80%; height: 16px; pointer-events: none; filter: blur(7px);
          background: radial-gradient(ellipse at center, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 72%);
        }
        .continue-card:hover .hero-desk-cover { transform: translateY(-3px); }
        /* On a narrow phone, 172px of cover next to a text column with a title, word count,
           "Last edited," and the Resume pill leaves too little room for that text to breathe —
           shrink the cover itself (not the text) below 420px so both columns stay readable
           without wrapping every line. */
        @media (max-width: 419px) {
          .hero-desk-cover { transform: scale(0.82); transform-origin: left top; }
          .continue-card:hover .hero-desk-cover { transform: translateY(-3px) scale(0.82); }
        }
        /* Two parchment "page block" layers glimpsed just behind the cover, like the fanned edge
           of a real hardback's pages — this is what makes the cover read as a physical object
           sitting on the shelf instead of a flat swatch floating on the card. */
        .hero-desk-page {
          position: absolute; inset: 0; border-radius: 8px; pointer-events: none;
          background: linear-gradient(115deg, #EFE3C4 0%, #E1CE9F 55%, #CBB07E 100%);
          box-shadow: inset 0 0 0 1px rgba(59,42,24,0.25);
        }
        /* Dimmed from 0.55/0.8 — with the Resume pill needing to read as the card's one loud
           gold shape (see the ribbon-removal note above coverWrap), these fanned page-block
           layers only need to suggest "there are pages behind this cover", not compete for
           attention at the same visual weight as the cover art itself. */
        .hero-desk-page-far { transform: rotate(5deg) translate(5px, -3px); opacity: 0.4; z-index: 0; }
        .hero-desk-page-near { transform: rotate(3deg) translate(3px, -1.5px); opacity: 0.55; z-index: 1; }
        .hero-desk-cover > :not(.hero-desk-page) { position: relative; z-index: 2; }
        /* A very slow, faint breathing glow — reads as ambient lamplight rather than an obvious
           animation. */
        @keyframes inkHeroGlowBreathe { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
        .hero-desk-ambient { animation: inkHeroGlowBreathe 7s ease-in-out infinite; }
        .health-card:hover { border-color: #4A3D22 !important; }
        /* Guild nav tab, while locked: a gold glow that pulses every few seconds, gradually
           intensifying as the writer nears level 10 via the --guild-glow-* custom properties set
           inline per-level (see HomeNav). */
        @keyframes inkGuildLockPulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(200,155,60,0); }
            50% { box-shadow: 0 0 var(--guild-glow-blur, 16px) var(--guild-glow-spread, 2px) rgba(200,155,60, var(--guild-glow-opacity, 0.32)); }
        }
        .ink-guild-lock-pulse { animation: inkGuildLockPulse var(--guild-glow-duration, 3.2s) ease-in-out infinite; }
        /* A faint magical shimmer sweeping across the Guild tab, added only at level 9 — a quiet
           sign that something is close to breaking open. */
        @keyframes inkGuildShimmerSweep {
            0% { transform: translateX(-120%) skewX(-12deg); opacity: 0; }
            10% { opacity: 0.5; }
            35% { opacity: 0.5; }
            55% { transform: translateX(160%) skewX(-12deg); opacity: 0; }
            100% { transform: translateX(160%) skewX(-12deg); opacity: 0; }
        }
        .ink-guild-shimmer-sweep {
            position: absolute; top: 0; left: 0; width: 45%; height: 100%; pointer-events: none;
            background: linear-gradient(100deg, transparent, rgba(255,240,200,0.4), transparent);
            animation: inkGuildShimmerSweep 4.6s ease-in-out infinite;
        }
        /* The unlock ceremony: the lock cracks and scales away while its particles fly outward,
           the tab's glow flares once, and the "unlocked" banner fades in and back out. */
        @keyframes inkGuildLockCrack {
            0% { transform: scale(1) rotate(0deg); opacity: 1; }
            35% { transform: scale(1.2) rotate(-10deg); opacity: 1; }
            100% { transform: scale(0.2) rotate(16deg); opacity: 0; }
        }
        .ink-guild-lock-crack { animation: inkGuildLockCrack 0.5s ease-in forwards; }
        @keyframes inkGuildShatterFly {
            0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
            100% { transform: translate(calc(-50% + var(--tx)), calc(-50% + var(--ty))) scale(0.2); opacity: 0; }
        }
        .ink-guild-shatter-particle {
            position: absolute; top: 50%; left: 50%; width: 4px; height: 4px; border-radius: 50%;
            background: radial-gradient(circle, #F5DFA0, #C89B3C 70%, transparent);
            transform: translate(-50%, -50%);
            animation: inkGuildShatterFly 0.8s ease-out forwards;
        }
        @keyframes inkGuildUnlockBurst {
            0% { box-shadow: 0 0 0 0 rgba(232,196,104,0); }
            30% { box-shadow: 0 0 36px 10px rgba(232,196,104,0.55); }
            100% { box-shadow: 0 0 0 0 rgba(232,196,104,0); }
        }
        .ink-guild-unlock-burst { animation: inkGuildUnlockBurst 1.5s ease-out; }
        @keyframes inkGuildUnlockBannerFade {
            0% { opacity: 0; transform: translateY(-3px); }
            15% { opacity: 1; transform: translateY(0); }
            75% { opacity: 1; transform: translateY(0); }
            100% { opacity: 0; transform: translateY(2px); }
        }
        .ink-guild-unlock-banner { animation: inkGuildUnlockBannerFade 2.6s ease; }
        /* The Guild Notice Board: a thick wooden frame with a subtle grain, holding parchment
           notices pinned at gentle, alternating angles (each card's own inline rotation). */
        .notice-board {
            position: relative; border-radius: 16px; padding: 26px 22px;
            background:
                repeating-linear-gradient(90deg, rgba(0,0,0,0.12) 0px, transparent 2px, transparent 7px),
                linear-gradient(180deg, #4A3220 0%, #35210F 55%, #281709 100%);
            border: 6px solid #241408;
            box-shadow: inset 0 2px 3px rgba(255,255,255,0.05), inset 0 -8px 14px rgba(0,0,0,0.5), 0 12px 26px rgba(0,0,0,0.4);
        }
        .notice-card {
            position: relative;
            background: linear-gradient(160deg, #EFE3C4 0%, #E1CE9F 55%, #CBB07E 100%);
            border-radius: 3px; padding: 20px 14px 14px; text-align: left;
            box-shadow: 0 8px 16px rgba(0,0,0,0.4), inset 0 0 0 1px rgba(59,42,24,0.15);
        }
        .notice-pin {
            position: absolute; top: -7px; left: 50%; transform: translateX(-50%); width: 13px; height: 13px; border-radius: 50%;
            background: radial-gradient(circle at 35% 30%, #F0D48A, #8A6B25 75%); border: 1.5px solid #100E0A;
            box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        }
        .member-card:hover { border-color: #4A3D22 !important; }
        /* The Fireside: a small glowing hearth above a discussion space, with a flickering
           three-flame fire (each flame on its own slightly offset cycle so it never looks static)
           and a plain wooden bench-plank as a quiet floor beneath the messages. */
        .fireside-hall {
            position: relative; border-radius: 16px; overflow: hidden; padding-bottom: 14px;
            background: radial-gradient(ellipse at 50% 0%, rgba(232,140,60,0.16), transparent 60%), linear-gradient(180deg, #1C140D 0%, #17130E 100%);
            border: 1px solid #3A2A18;
        }
        .fireside-fire {
            position: relative; height: 84px; width: 132px; margin: 18px auto 0;
            background: radial-gradient(ellipse at 50% 100%, #2A1810 0%, #17110A 70%);
            border-radius: 50% 50% 8px 8px / 60% 60% 8px 8px;
            border: 3px solid #2E2014;
            box-shadow: 0 0 40px rgba(232,140,60,0.32), inset 0 0 20px rgba(0,0,0,0.6);
            overflow: hidden;
        }
        .fireside-flame {
            position: absolute; bottom: 4px; left: 50%; border-radius: 50% 50% 50% 50% / 60% 60% 40% 40%;
            background: linear-gradient(0deg, #FF7A1A 0%, #FFC24D 55%, #FFE9A8 100%);
            opacity: 0.9; transform-origin: bottom center;
        }
        .fireside-flame.f1 { width: 24px; height: 42px; margin-left: -28px; animation: inkFireFlicker1 2.6s ease-in-out infinite; }
        .fireside-flame.f2 { width: 18px; height: 34px; margin-left: -2px; animation: inkFireFlicker2 2.1s ease-in-out infinite; background: linear-gradient(0deg, #FF5A1A 0%, #FFB23D 60%, #FFE9A8 100%); }
        .fireside-flame.f3 { width: 20px; height: 38px; margin-left: 16px; animation: inkFireFlicker3 2.4s ease-in-out infinite; }
        @keyframes inkFireFlicker1 { 0%, 100% { transform: scaleY(1) skewX(-2deg); opacity: 0.85; } 50% { transform: scaleY(1.15) skewX(3deg); opacity: 1; } }
        @keyframes inkFireFlicker2 { 0%, 100% { transform: scaleY(1) skewX(2deg); opacity: 0.8; } 50% { transform: scaleY(0.85) skewX(-3deg); opacity: 1; } }
        @keyframes inkFireFlicker3 { 0%, 100% { transform: scaleY(1.05) skewX(-1deg); opacity: 0.9; } 50% { transform: scaleY(0.9) skewX(4deg); opacity: 1; } }
        .fireside-bench {
            height: 14px; margin: 14px 18px 0;
            background: repeating-linear-gradient(90deg, #4A3220 0px, #5A3E26 4px, #4A3220 8px);
            border-radius: 3px; box-shadow: inset 0 2px 3px rgba(255,255,255,0.06), inset 0 -3px 4px rgba(0,0,0,0.5);
        }
      `),
            // Ambient hall dressing, sitting behind every screen (not just the "home" tab) so the
            // room never breaks character while flipping between Library/Guild/Inbox tabs: two
            // brass candle sconces flanking the top of the hall, and a slow drift of dust motes
            // caught in their light the whole length of the page.
            React.createElement("div", { style: { position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none', overflow: 'hidden' } },
                React.createElement(WallSconce, { side: 'left', top: 78, reduced: ambienceReduced }),
                React.createElement(WallSconce, { side: 'right', top: 78, reduced: ambienceReduced }),
                (ambienceReduced ? HOME_DUST_MOTES.filter((_, i) => i % 2 === 0) : HOME_DUST_MOTES).map((m, i) => React.createElement("span", { key: i, className: "gl-dust-mote", style: {
                        position: 'absolute', left: `${m.left}%`, bottom: 0, width: m.size, height: m.size, borderRadius: '50%',
                        background: 'radial-gradient(circle, rgba(255,238,200,0.85), rgba(255,238,200,0))',
                        animationDuration: `${m.duration}s`, animationDelay: `${m.delay}s`,
                    } }))),
            React.createElement("div", { style: { position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' } },
            React.createElement(HomeNav, { activeTab, onSelect: changeHomeTab, inboxUnreadCount, hasProjects: projects.length > 0 }),
            React.createElement("div", { className: "ink-page-container", style: { padding: activeTab !== 'home' ? '10px 24px 0' : '0' } },
                activeTab !== 'home' && React.createElement(Breadcrumbs, { style: { justifyContent: 'center', marginBottom: 0 } })),
            React.createElement("div", { className: "ink-page-container", style: { padding: '32px 24px 64px' } },
                activeTab !== 'home' && React.createElement("div", { style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[30], fontWeight: 600 } }, "Inkroot"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#9C9280', marginTop: 4 } }, "a home for the whole story")),
                    React.createElement("button", { onClick: onOpenProfile, title: "Writer Profile", style: {
                            width: 44, height: 44, borderRadius: '50%', flexShrink: 0, cursor: 'pointer', padding: 0,
                            background: writerProfile && writerProfile.avatar ? `center/cover url(${writerProfile.avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                            border: '2px solid #C89B3C', boxShadow: '0 0 0 2px #100E0A, 0 0 14px rgba(200,155,60,0.25)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[17],
                        } }, !(writerProfile && writerProfile.avatar) && React.createElement(InkIcon, { name: "users", size: 18, color: "#C89B3C" }))),
                activeTab !== 'home' && React.createElement("div", { style: { marginBottom: 32 } }),
                activeTab === 'home'
                    ? React.createElement(React.Fragment, null,
                        React.createElement(SyncStatusIndicator, null),
                        React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: SPACE_SCALE[8], marginBottom: 10 } },
                            React.createElement(ConflictRecoveryControl, null),
                            React.createElement(AccountSyncControl, null)),
                        React.createElement(AccountRestrictionBanner, null),
                        React.createElement("div", { className: "ink-parchment-in", style: { marginBottom: 28 } },
                            React.createElement(LibraryHero, { writerName: writerProfile && (writerProfile.penName || writerProfile.name), writerProfile, onOpenProfile, hasProjects: !!featured })),
                        React.createElement("div", { className: "ink-parchment-in", style: { animationDelay: '90ms', marginBottom: 8 } }, listSection),
                        // Featured Book + Story Health pair against Today's Inspiration + Quick Actions +
                        // News in a responsive two-column layout from tablet-landscape/laptop up (see
                        // .ink-grid-2 in app.css) — but only once there's actually a left column to pair
                        // against (a returning writer with a project). A brand-new account with nothing
                        // featured yet has nothing to put there, and reserving an empty column would just
                        // strand Quick Actions in a lopsided right-hand strip with a blank gap beside it;
                        // for that case this renders as one plain stacked column instead, same as mobile.
                        React.createElement("div", { className: (featuredCard || storyHealthCard) ? "ink-grid-2" : "" },
                            (featuredCard || storyHealthCard) && React.createElement("div", null,
                                React.createElement("div", { className: "ink-parchment-in", style: { animationDelay: '150ms' } },
                                    featuredCard,
                                    storyHealthCard && React.createElement("div", { style: { marginTop: featuredCard ? 20 : 0 } }, storyHealthCard))),
                            React.createElement("div", null,
                                React.createElement("div", { className: "ink-parchment-in", style: { animationDelay: '270ms' } },
                                    React.createElement(TodaysInspirationCard, null)),
                                React.createElement("div", { className: "ink-parchment-in", style: { animationDelay: '330ms', marginTop: 20 } },
                                    React.createElement(SectionLabel, null, "Quick Actions"),
                                    React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: SPACE_SCALE[10], marginBottom: 8 } },
                                        React.createElement(HomeQuickActionTile, { icon: React.createElement(InkIcon, { name: "plus", size: 19, color: "#C89B3C" }), label: "New Project", onClick: onCreate }),
                                        React.createElement(HomeQuickActionTile, { icon: React.createElement(InkIcon, { name: "download", size: 19, color: "#C89B3C" }), label: "Backup All", onClick: onExportAll }),
                                        React.createElement(HomeQuickActionTile, { icon: React.createElement(InkIcon, { name: "upload", size: 19, color: "#C89B3C" }), label: "Import Backup", onClick: () => fileInputRef.current && fileInputRef.current.click() }),
                                        React.createElement(HomeQuickActionTile, { icon: React.createElement(InkIcon, { name: "broom", size: 19, color: "#C89B3C" }), label: "Free Up Storage", onClick: handleOptimizeAllClick })),
                                    React.createElement("input", { ref: fileInputRef, type: "file", accept: "application/json", onChange: handleFileChosen, style: { display: 'none' } }),
                                    status && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#C89B3C', marginTop: 6 } }, status)),
                                featured && React.createElement("div", { className: "ink-parchment-in", style: { animationDelay: '390ms', marginTop: 20 } },
                                    React.createElement(SectionLabel, null, "Inkroot News"),
                                    React.createElement(InkrootNewsCard, { icon: "\u2696\uFE0F", title: "Community Bookshelves", description: "Real reviews and ratings from other readers across Inkroot, not just your own." })))),
                        React.createElement("div", { style: { marginTop: 32, fontSize: TYPE_SCALE[12], color: '#7A7160', lineHeight: 1.6 } }, "Everything autosaves to this device as you type \u2014 no button to press, and no account required. \"Backup All\"/\"Import Backup\" above are the fully offline way to move a project between devices by hand. If you'd rather your Author's Hall, Guild, and Library just followed you automatically, sign in via \"Sync this device\" above \u2014 it's optional and free, never gates anything, and every device you sign into stays up to date on its own."))
                    : activeTab === 'guild'
                        ? guildContent
                        : activeTab === 'inbox'
                            ? inboxContent
                            : activeTab === 'universe'
                                ? universeContent
                                : activeTab === 'guildorder'
                                    ? guildOrderContent
                                    : libraryContent),
            confirmDialog))));
}
