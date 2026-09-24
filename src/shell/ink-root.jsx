import React, { useState, useEffect, useMemo, useRef } from 'react';
import { storage } from '../lib/storage.js';
import { fetchPublishedAuthorNames, fetchPublishedBookContent, checkBookReadAccess, fetchAuthorRatingsSummary, fetchFollowerCount } from '../lib/library.js';
import { publishBookRemoteFlow, unpublishBookRemoteFlow, publishPackRemoteFlow, unpublishPackRemoteFlow, PublishFlowError, SOLD_BOOK_UNPUBLISHED_NOTICE, SOLD_PACK_UNPUBLISHED_NOTICE } from '../lib/publish-flow.js';
import { logBookRead } from '../lib/rising-stars.js';
import { syncFounderGuildMembership, leaveFounderGuildMembership } from '../lib/library-guild.js';
import { AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { joinPlayerGuildByCode, leavePlayerGuildRemote, syncPlayerGuild } from '../lib/player-guild.js';
import { syncProfile, fetchVerifiedIds } from '../lib/profile.js';
import { fetchIsModerator, fetchIsPlatformAdmin, recordDeviceSignal } from '../lib/moderation.js';
import { formatNaira } from '../lib/payments.js';
import { ModerationQueue } from '../moderation/moderation-queue.jsx';
import { InkrootEventsAdmin } from '../admin/inkroot-events-admin.jsx';
import { ManualWithdrawalsAdmin } from '../admin/manual-withdrawals-admin.jsx';
import { ManageAdmins } from '../admin/manage-admins.jsx';
import { findSimilarName, isReservedName } from '../shared-utils/identity-safety.js';
import { useSync } from './sync-context.jsx';
import { founderGuildById, freshGuildMembership, guildCooldownRemainingMs, normalizeGuildMembership } from '../guild/guild-hall.jsx';
import { PublishedBookReader, buildLegacyBooksForReputation, computeAuthorReputation, meaningfulCompletedCountFor, myPublishedCountFor, reputationTitleFor, reviewReputationCountsFrom } from '../library/author-reputation.jsx';
import { AuthorsHallScreen } from '../library/authors-hall-screen.jsx';
import { GuildPublicProfileScreen } from '../guild/guild-public-profile-screen.jsx';
import { GuildEventDetailScreen } from '../guild/guild-event-detail-screen.jsx';
import { GuildEventJudgePanel } from '../guild/guild-event-judge-panel.jsx';
import { GrandLibraryScreen } from '../library/grand-library-screen.jsx';
import { LibraryAuthorLink, PublishingWizard, resolvePublishStatus } from '../library/publishing.jsx';
import { optimizeProjectImages } from '../shared-ui/image-utils.jsx';
import { GUILD_KEY, INDEX_KEY, LEGACY_KEY, PROFILE_KEY, projectKey, uuid } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { dateKey } from '../shared-utils/truncate.jsx';
import { HomeScreen } from './home-screen.jsx';
import { useNav } from './nav-context.jsx';
import { packSummaryForIndex } from '../worldbuilding/book-cover.jsx';
import { buildPublishedBookContent, buildPublishedPackContent } from '../lib/publish-content.js';
import { aggregateWriterStats } from '../writing/achievements.jsx';
import { SCHEMA_VERSION, backupsKey, emptyProject, patchProjectDefaults, reclaimBackupSpace, restoreProject } from '../writing/project-schema-and-backups.jsx';
import { ProjectWorkspace } from '../writing/project-workspace.jsx';


// ---------- App root: routes between home and a project ----------
export function InkRoot() {
    const sync = useSync();
    const sessionUserId = sync && sync.session ? sync.session.user.id : null;
    const [projects, setProjects] = useState(null);
    const [currentId, setCurrentId] = useState(null);
    const [openTab, setOpenTab] = useState('hub'); // which tab ProjectWorkspace should land on next open
    const [writerProfile, setWriterProfile] = useState(null); // the writer's identity — separate from any project
    // Surfaced when a quick publish/unpublish action from Author Studio (setPublishStatus /
    // setPackPublishStatus below — the two that fire directly from a book/pack card, with no
    // PublishingWizard around them to show an inline error of its own) fails against Supabase.
    // Wizard-driven publishes (publishBookWithDetails / publishPackWithDetails) instead throw
    // back to the wizard itself, which has its own inline idle/publishing/error state — see
    // PublishingWizard in library/publishing.jsx — so this dialog is only for the two quick
    // actions that have nowhere else to show a failure. See lib/publish-flow.js for why a
    // failure here means nothing was left half-published.
    const [publishNotice, setPublishNotice] = useState(null); // { title, message }
    // Anti-impersonation: every published author's { id, name }, fetched once and reused for the
    // lookalike-name warning in saveProfile below (see shared-utils/identity-safety.js). A stale
    // list for the rest of the session is an acceptable tradeoff — this is a soft warning, not a
    // security boundary, and re-fetching on every keystroke of a name field would be wasteful.
    const [publishedAuthorNames, setPublishedAuthorNames] = useState([]);
    // Inline feedback for the name/pen name fields on the Writer Identity Card — nameError blocks
    // (a reserved name was rejected), nameWarning doesn't (a lookalike name was flagged but still
    // saved). Both cleared on save unless the new value re-triggers them.
    const [profileNameError, setProfileNameError] = useState(null);
    const [profileNameWarning, setProfileNameWarning] = useState(null);
    // Reliability gap fix (same bug class as fix-tracker item 27/31): syncProfile now actually
    // throws on a real Supabase error instead of resolving silently, so a genuine failure to
    // push the writer's name/pen name/avatar/motto to `profiles` is now distinguishable from
    // success. saveProfile below still fires this fire-and-forget on every keystroke (name/
    // penName/motto are controlled inputs with no debounce — see WriterIdentityCard), so a
    // failure surfaces as this small inline notice next to the Writer Identity Card rather than
    // an AlertDialog, which would pop up disruptively mid-typing. Cleared on the next successful
    // sync; nothing here ever blocks or rolls back the local edit itself, which stays
    // local-first exactly as before — only the remote-sync status indicator changes.
    const [profileSyncNotice, setProfileSyncNotice] = useState(null);
    // Anti-impersonation piece 2 — whether the signed-in writer's own account carries the
    // verified badge (schema.sql's `profiles.verified`, see lib/profile.js's fetchVerifiedIds).
    // Re-checked whenever the session user changes; there's no in-app way to flip this (see the
    // migration's comment), so it isn't re-checked on every profile edit — only sign-in.
    const [selfVerified, setSelfVerified] = useState(false);
    // Trust-and-safety moderation — whether the signed-in writer's own account is a moderator
    // (schema.sql's `profiles.is_moderator`, see lib/moderation.js's fetchIsModerator). Gates
    // whether the Moderation Queue entry point even shows up (see WriterIdentityCard below) —
    // real enforcement is server-side RLS regardless of what this says, same caveat as
    // selfVerified above.
    const [isModerator, setIsModerator] = useState(false);
    const [showModerationQueue, setShowModerationQueue] = useState(false);
    // Same shape as isModerator/showModerationQueue immediately above, for the separate
    // is_platform_admin trust flag (see 43_migration_inkroot_events_admin.sql) — gates whether
    // the Inkroot Events admin screen's entry point even shows up. Real enforcement is still
    // server-side (is_inkroot_admin()) regardless of what this says.
    const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
    const [showInkrootEventsAdmin, setShowInkrootEventsAdmin] = useState(false);
    // Same shape again, but ungated — see author-identity.jsx's own comment on why this button
    // has no role-flag check: any verified author can be seated on a panel.
    const [showGuildEventJudging, setShowGuildEventJudging] = useState(false);
    const [showManualWithdrawalsAdmin, setShowManualWithdrawalsAdmin] = useState(false);
    const [showManageAdmins, setShowManageAdmins] = useState(false);
    const [guildProfile, setGuildProfile] = useState(null); // the writer's Guild — also separate from any project
    // Surfaced when leaveCurrentGuild's remote leave call (leavePlayerGuildRemote /
    // leaveFounderGuildMembership) fails — same {title, message}-via-AlertDialog contract as
    // publishNotice above, kept as its own state since it's a different action with its own
    // failure copy. On failure guildProfile is left untouched (see leaveCurrentGuild) so the
    // writer isn't shown a false "left" state while still actually seated in the guild.
    const [guildLeaveNotice, setGuildLeaveNotice] = useState(null); // { title, message }
    // Surfaced when syncPlayerGuild (founding or editing your own Player Guild) fails remotely.
    // Previously this was a console.warn no one ever saw: local state still flipped to
    // guildType: 'player' with a locally-generated id, so the "Host a Guild Event" button and
    // every other owner-only control rendered normally, but player_guilds never actually got a
    // matching row (or the row's owner_id never matched this id) server-side. Every event/
    // treasury RPC re-checks ownership server-side via is_guild_officer() — a guild that never
    // synced fails that check exactly like "you're not the owner" does, so this was showing up
    // as a confusing "Only the guild owner can host a guild event" error to the actual owner.
    // Same {title, message}-via-AlertDialog contract as guildLeaveNotice above; retry re-runs
    // the same sync rather than generating a new local id, so it converges on the same guild
    // row instead of orphaning yet another id.
    const [guildSyncNotice, setGuildSyncNotice] = useState(null); // { title, message }
    // Reputation earned inside a guild (published books, completed guild quests, Fireside posts) —
    // computed once in the Guild Hall and shared here so it also shows up on the Writer Profile.
    const [writerReputation, setWriterReputation] = useState(null);
    // Which author's Author's Hall (if any) is currently showing. null = not showing one. Any
    // string (including '') identifies the pen name being viewed — resolved to either the private
    // (isSelf) or public view further down, depending on whether it matches this device's own
    // writer identity.
    const [viewingAuthorName, setViewingAuthorName] = useState(null);
    // The real account id behind whichever Hall is open, when one is actually known —
    // anti-impersonation piece 5 (see lib/profile.js's fetchPublicProfile). Only ever set from a
    // surface that carries a genuine author_id (Fireside, Guild Bookshelf — see
    // guild-book-feedback-modal.jsx's onOpenAuthor calls); every other caller of openAuthorHall
    // (the local-only Grand Library, Author Studio) has no real account behind its author-name
    // strings at all, so this stays null there and AuthorsHallScreen falls back to its existing
    // local-name-matching behavior for that Hall.
    const [viewingAuthorId, setViewingAuthorId] = useState(null);
    // Whether the Hall currently open is this device's own, decided once at navigation time in
    // openAuthorHall — NOT recomputed from a live name comparison on every render. It used to be
    // re-derived by comparing viewingAuthorName against the writer's current name each render,
    // which meant editing your own name (which updates writerProfile live, keystroke by keystroke)
    // made the comparison stop matching mid-edit and flip you onto the read-only "someone else's
    // Hall" view — a forced remount that looked like being kicked to another profile while typing.
    const [viewingIsSelf, setViewingIsSelf] = useState(false);
    // Lets "Open Creator Dashboard" (on the Author's Hall) land Author Studio's segmented switch
    // straight on 'studio' instead of the default 'reader' mode — see GrandLibraryScreen's
    // initialMode prop, which only reads this once per mount, same pattern as ProjectWorkspace's
    // initialTab below.
    const [libraryInitialMode, setLibraryInitialMode] = useState('reader');
    const [lifetimeStats, setLifetimeStats] = useState({ totalWords: 0, chapters: 0, completedCount: 0 }); // feeds Guild Quests' real progress bars, and the completed-project shelf badge
    // The same quality-gated "completed projects" count Author's Hall uses for Reputation (see
    // meaningfulCompletedCountFor in author-reputation.jsx) — deliberately separate from
    // lifetimeStats.completedCount above, which stays the raw "marked complete" tally other UI
    // (the Home stat tile) still wants. writerRank below reads this one, not the raw one, so the
    // Rank shown on Home matches the Rank shown on this writer's own Author's Hall.
    const [ownReputationCompletedCount, setOwnReputationCompletedCount] = useState(0);
    // Which of Home's three tabs ('home' | 'guild' | 'library') is showing. Owned here rather than
    // inside HomeScreen because HomeScreen itself unmounts and remounts every time the writer opens
    // a project or their Writer Profile and comes back — InkRoot never unmounts, so this is the one
    // place the value (and the undo closures the nav stack holds onto for it) can stay valid for as
    // long as the nav stack itself remembers being on the Guild Hall or Grand Library.
    const [homeActiveTab, setHomeActiveTab] = useState('home');
    // The reader-facing counterpart to currentId/ProjectWorkspace below: set when a reader taps a
    // book in the Grand Library or a Guild's bookshelf. Kept entirely separate from currentId so
    // there is no code path from a published book into the author's full project workspace —
    // readingBookProject only ever holds what PublishedBookReader is given (chapters, title,
    // author), fetched fresh from storage rather than reusing any in-memory author session state.
    const [readingBookId, setReadingBookId] = useState(null);
    const [readingBookProject, setReadingBookProject] = useState(null);
    // True once we've established the book genuinely can't be opened — neither this device's
    // own local copy (the author's device) nor the public published_book_content mirror (every
    // other device) has anything for this id. Lets the render branch below show a real
    // "book unavailable" state instead of hanging on "Opening book…" forever, which is what
    // happened before published_book_content existed (see 70_migration_published_book_content.sql).
    const [readingBookError, setReadingBookError] = useState(false);
    // True once we've established the book is real and reachable but priced, and this reader
    // hasn't paid for it (see lib/library.js's checkBookReadAccess) — a distinct state from
    // readingBookError above so the reader sees an honest "buy this to read it" screen instead
    // of a generic "couldn't be opened" one. Carries the price along so that screen can show it.
    const [readingBookLocked, setReadingBookLocked] = useState(null);
    // Whether THIS book's author opted it into PDF/EPUB download (published_books.downloadable —
    // see the publishing wizard's Step 3 toggle). Set alongside readingBookProject on both the
    // local (author's own device) and remote (published_book_content mirror) load paths below, so
    // PublishedBookReader can show a download control only when the author actually turned it on.
    const [readingBookDownloadable, setReadingBookDownloadable] = useState(false);
    // Tracks which book id the most recent openReaderBook call is actually for, so a slower
    // lookup that was already in flight when the reader backed out and opened a different book
    // can detect it's stale and quietly no-op instead of overwriting the newer book's state.
    const readingBookIdRef = useRef(null);
    // Reader-facing navigation onto another guild's public profile / a single Guild Event's
    // detail page — e.g. from Living Universe's Guild Events, Guilds on the Rise, or Best/Most
    // Read cards (see lib/guild-rankings.js's fetchPublicGuildProfile and lib/guild-events.js's
    // fetchPublicGuildEvents). Kept entirely separate from guildProfile (this device's OWN guild
    // membership state) — viewing someone else's guild never touches or reinterprets that.
    const [viewingGuildId, setViewingGuildId] = useState(null);
    const [viewingEventId, setViewingEventId] = useState(null);
    const nav = useNav();
    const openProject = (id, tab) => {
        const proj = (projects || []).find((p) => p.id === id);
        nav.push({ label: (proj && proj.title) || 'Project', undo: () => setCurrentId(null) });
        setOpenTab(tab || 'hub'); setCurrentId(id);
    };
    const openReaderBook = (id) => {
        const meta = (projects || []).find((p) => p.id === id);
        nav.push({ label: (meta && meta.title) || 'Book', undo: () => { setReadingBookId(null); setReadingBookProject(null); setReadingBookError(false); setReadingBookLocked(null); setReadingBookDownloadable(false); } });
        setReadingBookProject(null); // clear any previous book while the new one loads
        setReadingBookError(false);
        setReadingBookLocked(null);
        setReadingBookDownloadable(false);
        setReadingBookId(id);
        // Fire-and-forget toward Rising Star's real "recent readers" signal (see
        // supabase/history/38_migration_rising_star_scoring.sql) — never blocks or affects this
        // read either way. log_book_read's own insert policy already excludes a book's own
        // author from counting as one of its "recent readers" regardless.
        logBookRead(id);
        // A request token so a slower, superseded lookup (the reader backed out and opened a
        // different book before this one resolved) can't clobber state for the book actually
        // on screen now — checked before every setReadingBook* call below.
        const requestId = id;
        const isStale = () => requestId !== readingBookIdRef.current;
        readingBookIdRef.current = id;
        storage.get(projectKey(id)).then((res) => {
            if (isStale())
                return;
            if (res) {
                try {
                    const localProj = JSON.parse(res.value);
                    setReadingBookProject(patchProjectDefaults(localProj));
                    setReadingBookDownloadable(!!localProj.downloadable);
                    return;
                }
                catch (e) { /* fall through to the remote mirror below */ }
            }
            // Not on this device — true for every reader who isn't the book's own author.
            // Fall back to the public mirror written at publish time (see
            // publishBookContentRemote / 70_migration_published_book_content.sql). A hard
            // timeout guards against a network stall leaving this on "Opening book…" forever,
            // same failure mode the mirror itself was built to fix.
            const withTimeout = (promise, ms) => Promise.race([
                promise,
                new Promise((resolve) => setTimeout(() => resolve(null), ms)),
            ]);
            // Gate on price/purchase before ever fetching the actual content — this is the
            // book's own author's *other* device, or another reader entirely, so unlike the
            // local branch above there's no guarantee this device has paid for it. Free books
            // (price 0, the writer's own choice in the publishing wizard) and the author's own
            // account always pass straight through; see checkBookReadAccess for the full rule.
            withTimeout(checkBookReadAccess(id), 15000).then((access) => {
                if (isStale())
                    return;
                if (!access) {
                    setReadingBookError(true); // the access check itself timed out/failed
                    return;
                }
                if (!access.allowed) {
                    setReadingBookLocked({ price: access.price || 0 });
                    return;
                }
                setReadingBookDownloadable(!!access.downloadable);
                withTimeout(fetchPublishedBookContent(id), 15000).then((content) => {
                    if (isStale())
                        return;
                    if (content)
                        setReadingBookProject(patchProjectDefaults(content));
                    else
                        setReadingBookError(true);
                });
            });
        });
    };
    // The single entry point every clickable author name/avatar/rank in the app routes through —
    // published books, the Grand Library, Author Studio listings, guilds, guild feedback, and book
    // pages alike (see LibraryAuthorLink and its call sites). A blank/omitted name means "open my
    // own Hall"; any other name opens that pen name's Hall, which the render logic below resolves
    // to either the private (isSelf) or public view depending on whether it matches this device's
    // own writer identity.
    const openAuthorHall = (name, authorId = null) => {
        const trimmed = (name || '').trim();
        const selfName = (writerProfile && (writerProfile.penName || writerProfile.name) || '').trim();
        // A real author_id that happens to be this device's own signed-in account also counts as
        // self, same as a name match — opens the private (editable) view instead of a read-only
        // public one of your own Hall.
        const isSelf = !trimmed || (selfName && trimmed.toLowerCase() === selfName.toLowerCase()) || (authorId && authorId === sessionUserId);
        nav.push({ label: isSelf ? "Your Author's Hall" : trimmed, undo: () => { setViewingAuthorName(null); setViewingAuthorId(null); setViewingIsSelf(false); } });
        setViewingAuthorName(isSelf ? selfName : trimmed);
        setViewingAuthorId(isSelf ? null : authorId);
        setViewingIsSelf(isSelf);
    };
    const openProfile = () => openAuthorHall(null);
    // Opens a real Player Guild's public profile by id — never a Founder Guild (those have no
    // real backing row to look up, and no reader-facing page exists for one yet), so callers
    // should only pass a guild_id that actually came from real backend data (compute_guilds_on_rise,
    // list_public_guild_events, etc.), never a Founder Guild's local string id like 'fantasy'.
    const openGuildProfile = (guildId) => {
        if (!guildId) return;
        setViewingEventId(null); // mutually exclusive with the event detail screen below
        nav.push({ label: 'Guild Hall', undo: () => setViewingGuildId(null) });
        setViewingGuildId(guildId);
    };
    // Opens a single Guild Event's detail page by id. GuildEventDetailScreen resolves the event's
    // own guildId itself before ever letting "View guild" navigate anywhere.
    const openGuildEvent = (eventId) => {
        if (!eventId) return;
        setViewingGuildId(null); // mutually exclusive with the guild profile screen above
        nav.push({ label: 'Guild Event', undo: () => setViewingEventId(null) });
        setViewingEventId(eventId);
    };
    // From the Author's Hall's "Open Creator Dashboard" button: leaves the Hall, lands on Home with
    // the Grand Library tab active and Author Studio's segmented switch pre-set to 'studio' — the
    // same place Author Studio has always lived, just reached in one tap from the Hall now too.
    const openCreatorDashboard = () => {
        setLibraryInitialMode('studio');
        setHomeActiveTab('library');
        setViewingAuthorName(null);
        // Same undo every other route onto the Grand Library tab carries (see changeHomeTab in
        // home-screen.jsx) — without it, Back/breadcrumb navigation away from this screen had
        // nothing to call, so the stack would correctly shrink to Home while homeActiveTab stayed
        // stuck on 'library': the breadcrumb/Back button would vanish (nothing left to pop) but
        // the screen kept showing the Grand Library, with no way back except the separate bottom
        // tab bar's own direct setActiveTab('home') call.
        nav.resetTo({ label: 'Grand Library', key: 'library:' + Date.now(), undo: () => setHomeActiveTab('home') });
    };
    const openModerationQueue = () => {
        nav.push({ label: 'Moderation queue', undo: () => setShowModerationQueue(false) });
        setShowModerationQueue(true);
    };
    const openGuildEventJudging = () => {
        nav.push({ label: 'Judging queue', undo: () => setShowGuildEventJudging(false) });
        setShowGuildEventJudging(true);
    };
    const openInkrootEventsAdmin = () => {
        nav.push({ label: 'Inkroot Events admin', undo: () => setShowInkrootEventsAdmin(false) });
        setShowInkrootEventsAdmin(true);
    };
    const openManualWithdrawalsAdmin = () => {
        nav.push({ label: 'Manual Withdrawals admin', undo: () => setShowManualWithdrawalsAdmin(false) });
        setShowManualWithdrawalsAdmin(true);
    };
    const openManageAdmins = () => {
        nav.push({ label: 'Manage Admins', undo: () => setShowManageAdmins(false) });
        setShowManageAdmins(true);
    };
    useEffect(() => {
        if (!projects || !projects.length) {
            setLifetimeStats({ totalWords: 0, chapters: 0, completedCount: 0 });
            setOwnReputationCompletedCount(0);
            return;
        }
        let cancelled = false;
        (async () => {
            const full = [];
            for (const meta of projects) {
                try {
                    const res = await storage.get(projectKey(meta.id));
                    if (res)
                        full.push(patchProjectDefaults(JSON.parse(res.value)));
                }
                catch (e) { /* skip a project that fails to parse rather than blocking the tally */ }
            }
            if (!cancelled) {
                // aggregateWriterStats used to also return .rank/.level (Writer Level) here —
                // removed along with it; see writerRank below, computed from Reputation instead.
                setLifetimeStats(aggregateWriterStats(full));
                // Same per-project quality gate Author's Hall's own legacyBooks/meaningfulCompletedCount
                // apply (see buildLegacyBooksForReputation/meaningfulCompletedCountFor) — built from
                // the same `full` project bodies already loaded above rather than a second pass.
                setOwnReputationCompletedCount(meaningfulCompletedCountFor(buildLegacyBooksForReputation(full)));
            }
        })();
        return () => { cancelled = true; };
    }, [projects]);
    // Writer Rank — used to be tallied alongside Writer Level in the effect above (lifetime level
    // -> writerRankForLevel). Now it's just Reputation's own tier (reputationTitleFor), built from
    // the exact same shared inputs authors-hall-screen.jsx uses for isSelf (see
    // myPublishedCountFor/meaningfulCompletedCountFor/reviewReputationCountsFrom in
    // author-reputation.jsx) — published and completed counts held to the real quality gates, the
    // real server-side follower count (see fetchFollowerCount in lib/library.js — same source
    // Author's Hall's own followerCount now reads, not a local device-only signal), the real
    // review/positive-rating counts across this writer's own published books, and this device's
    // own tracked guild contribution (writerReputation state, fed by HomeScreen's
    // onReputationChange).
    const [ownFollowerCount, setOwnFollowerCount] = useState(0);
    useEffect(() => {
        if (!sessionUserId) { setOwnFollowerCount(0); return; }
        let cancelled = false;
        fetchFollowerCount(sessionUserId).then((n) => { if (!cancelled) setOwnFollowerCount(n); }).catch((e) => console.warn('Inkroot: fetchFollowerCount failed', e));
        return () => { cancelled = true; };
    }, [sessionUserId]);
    // Real reviews/ratings received across this writer's own published books — same
    // fetchAuthorRatingsSummary + reviewReputationCountsFrom pairing authors-hall-screen.jsx uses
    // for the isSelf case, built from this device's own published 'inkroot' listings.
    const ownPublishedBookIds = (projects || []).filter((p) => resolvePublishStatus(p) === 'inkroot').map((p) => p.id);
    const [ownReviewCounts, setOwnReviewCounts] = useState({ reviewCount: 0, ratingCount: 0 });
    useEffect(() => {
        if (!ownPublishedBookIds.length) { setOwnReviewCounts({ reviewCount: 0, ratingCount: 0 }); return; }
        let cancelled = false;
        fetchAuthorRatingsSummary(ownPublishedBookIds)
            .then((summary) => { if (!cancelled) setOwnReviewCounts(reviewReputationCountsFrom(summary)); })
            .catch((e) => console.warn('Inkroot: fetchAuthorRatingsSummary failed', e));
        return () => { cancelled = true; };
    }, [ownPublishedBookIds.join(',')]);
    // A useMemo rather than its own state — it only ever needs to be recomputed when its actual
    // inputs change, never independently.
    const writerRank = useMemo(() => reputationTitleFor(computeAuthorReputation({
        followCount: ownFollowerCount,
        publishedCount: myPublishedCountFor(projects),
        completedCount: ownReputationCompletedCount,
        guildContribution: writerReputation || 0,
        reviewCount: ownReviewCounts.reviewCount,
        ratingCount: ownReviewCounts.ratingCount,
    })), [projects, ownReputationCompletedCount, ownFollowerCount, ownReviewCounts, writerReputation]);
    useEffect(() => {
        (async () => {
            const res = await storage.get(PROFILE_KEY);
            if (res) {
                setWriterProfile(JSON.parse(res.value));
                return;
            }
            const fresh = { name: '', penName: '', motto: '', avatar: null, joinDate: new Date().toISOString() };
            await storage.set(PROFILE_KEY, JSON.stringify(fresh));
            setWriterProfile(fresh);
        })();
    }, []);
    useEffect(() => {
        fetchPublishedAuthorNames().then(setPublishedAuthorNames);
    }, []);
    useEffect(() => {
        if (!sessionUserId) { setSelfVerified(false); return; }
        fetchVerifiedIds([sessionUserId]).then((ids) => setSelfVerified(ids.has(sessionUserId))).catch(() => setSelfVerified(false));
    }, [sessionUserId]);
    useEffect(() => {
        if (!sessionUserId) { setIsModerator(false); return; }
        fetchIsModerator(sessionUserId).then(setIsModerator).catch(() => setIsModerator(false));
    }, [sessionUserId]);
    useEffect(() => {
        if (!sessionUserId) { setIsPlatformAdmin(false); return; }
        fetchIsPlatformAdmin(sessionUserId).then(setIsPlatformAdmin).catch(() => setIsPlatformAdmin(false));
    }, [sessionUserId]);
    useEffect(() => {
        // Ban-evasion signal, piece 6 — see shared-utils/device-signal.js for what this is and
        // isn't. Best-effort, no-op when signed out; recordDeviceSignal itself is silent on
        // failure.
        if (sessionUserId) recordDeviceSignal(sessionUserId);
    }, [sessionUserId]);
    // Anti-impersonation checks — see shared-utils/identity-safety.js. Runs on every keystroke
    // (name/penName are controlled inputs that call onSaveProfile directly on onChange — see
    // WriterIdentityCard), but both checks are cheap: isReservedName is a plain Set-style lookup,
    // and findSimilarName runs against an already-fetched, small in-memory list rather than
    // hitting the network — so per-keystroke validation here doesn't add any real cost.
    const saveProfile = (patch) => {
        setWriterProfile((prev) => {
            const base = prev || { name: '', penName: '', motto: '', avatar: null, joinDate: new Date().toISOString() };
            const safePatch = { ...patch };
            let nameErr = null;
            // Hard block: a reserved name (Inkroot, Support, Staff, Admin, …) never saves at all
            // — the field is dropped from the patch, leaving the previous value in place, so the
            // rejected keystroke simply doesn't take effect rather than silently applying anyway.
            for (const field of ['name', 'penName']) {
                if (field in safePatch && isReservedName(safePatch[field])) {
                    nameErr = "That name isn't available — it reads as an official Inkroot name, which no individual account can use.";
                    delete safePatch[field];
                }
            }
            setProfileNameError(nameErr);
            const next = { ...base, ...safePatch };
            storage.set(PROFILE_KEY, JSON.stringify(next));
            // Best-effort, non-blocking — a no-op when signed out, so local-only profile
            // editing is completely unaffected. Pushes the full current profile (not just the
            // patch) since profiles.* columns are simple overwrites, not merges. syncProfile
            // now actually throws on a real database failure (see its own comment) rather than
            // resolving silently, so a genuine failure clears the "in sync" state instead of
            // being indistinguishable from success — surfaced as profileSyncNotice rather than
            // a blocking dialog, since this fires on every keystroke.
            syncProfile({ name: next.name, penName: next.penName, avatar: next.avatar, motto: next.motto })
                .then(() => setProfileSyncNotice(null))
                .catch((e) => {
                    console.warn('Inkroot: profile sync failed', e);
                    // A name the server refused (already taken / reserved) says so, since that's the one
                    // failure the writer can act on; anything else keeps the generic notice.
                    setProfileSyncNotice(e && e.code === 'PROFILE_NAME_REJECTED'
                        ? e.message
                        : "Couldn't save your latest changes to your account — they're kept on this device, but other devices and readers won't see them yet.");
                });
            // Soft warning: doesn't block the save (real people legitimately share names, so a
            // hard block here would lock people out over coincidence) — just flags that the name
            // now closely resembles a real published author, in case this wasn't intentional.
            const effectiveName = (next.penName || next.name || '').trim();
            if (('name' in safePatch || 'penName' in safePatch) && effectiveName) {
                const match = findSimilarName(effectiveName, publishedAuthorNames, { excludeId: sessionUserId });
                setProfileNameWarning(match ? `This name is very close to an existing published author, "${match.name}." If that's not you, please choose a different name.` : null);
            } else if (!effectiveName) {
                setProfileNameWarning(null);
            }
            return next;
        });
    };
    useEffect(() => {
        (async () => {
            const res = await storage.get(GUILD_KEY);
            if (res) {
                const loaded = normalizeGuildMembership(JSON.parse(res.value));
                setGuildProfile(loaded);
                // Backfill: a Founder Guild seat taken before Phase 8 (or on a device that
                // joined one while signed out) only ever existed locally — push it to
                // founder_guild_members now so this account's Fireside/Bookshelf reads and
                // writes for that guild aren't rejected by the membership-scoped RLS added in
                // schema_phase8.sql. No-ops quietly if not signed in yet; see also
                // sync-context.jsx, which does the same check right after sign-in.
                if (loaded.guildType === 'founder' && loaded.founderGuildId) {
                    syncFounderGuildMembership(loaded.founderGuildId).catch((e) => console.warn('Inkroot: founder guild membership sync failed', e));
                }
                return;
            }
            const fresh = freshGuildMembership();
            await storage.set(GUILD_KEY, JSON.stringify(fresh));
            setGuildProfile(fresh);
        })();
    }, []);
    // Takes a seat in one of the ten permanent Founder Guilds — required before a writer can go
    // on to found a Guild of their own. A writer belongs to only one Guild at a time, so this is a
    // no-op if they're already in a guild or still cooling down from having left one.
    const joinFounderGuild = (founderGuildId) => {
        setGuildProfile((prev) => {
            const base = prev || freshGuildMembership();
            if (base.guildType || guildCooldownRemainingMs(base) > 0)
                return base;
            const next = { ...base, guildType: 'founder', founderGuildId, founderJoinedDate: new Date().toISOString() };
            storage.set(GUILD_KEY, JSON.stringify(next));
            // Best-effort remote sync, same non-blocking philosophy as syncPlayerGuild below —
            // a no-op when signed out. This is what lets founder_guild_members' membership
            // check (schema_phase8.sql) actually recognize this writer as a member server-side.
            syncFounderGuildMembership(founderGuildId).catch((e) => console.warn('Inkroot: founder guild membership sync failed', e));
            return next;
        });
    };
    // Leaves whichever guild the writer currently holds a seat in (Founder, Player, or Joined)
    // and starts the cooldown before another can be joined. The guild itself isn't affected —
    // Founder Guilds are permanent regardless, and a Player Guild's data (owned or the record of
    // which guild was joined) is kept so the writer can return to it later, once the cooldown
    // has passed.
    // A 'joined' or 'founder' membership has a real founder_guild_members/player_guild_members
    // row server-side, so leaving here is awaited and local state only flips to "left" once that
    // remote delete actually succeeds — otherwise the writer would see themselves as having left
    // (and start the cooldown) while still genuinely seated in the guild server-side. On failure
    // guildProfile is left exactly as it was and guildLeaveNotice surfaces the failure instead.
    //
    // guildType 'player' (owning your own guild) is NOT a local-only case — create_or_get_own_guild
    // gives the owner a real player_guilds row (owner_id) AND a real player_guild_members row,
    // same as anyone else's membership. There is no disband/transfer-ownership flow anywhere in
    // this app yet, so an owner has nothing to actually leave to: falling through to the same
    // "flip guildType to null locally" reset the other two branches use would just desync local
    // state from the server (still the real owner/member, but the UI claims otherwise), which is
    // exactly the bug this guard exists to prevent. GuildBanner already hides the "Leave Guild"
    // button for this case (see its own comment), so reaching this function with guildType
    // 'player' should only happen via some other, currently-nonexistent path — this is the
    // server-truth backstop for that, not a route the UI is expected to take.
    const leaveCurrentGuild = async () => {
        const base = guildProfile || freshGuildMembership();
        if (!base.guildType)
            return;
        if (base.guildType === 'player') {
            setGuildLeaveNotice({
                title: "Can't leave your own guild yet",
                message: "There's no way to disband a guild or hand off ownership yet, so as the founder you can't leave. This is coming in a future update.",
            });
            return;
        }
        try {
            if (base.guildType === 'joined' && base.joinedGuild && base.joinedGuild.id) {
                await leavePlayerGuildRemote(base.joinedGuild.id);
            }
            else if (base.guildType === 'founder' && base.founderGuildId) {
                await leaveFounderGuildMembership(base.founderGuildId);
            }
        }
        catch (e) {
            setGuildLeaveNotice({
                title: "Couldn't leave guild",
                message: "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        // Only reached once the remote leave above has actually succeeded.
        const next = { ...base, guildType: null, leftAt: new Date().toISOString() };
        storage.set(GUILD_KEY, JSON.stringify(next));
        setGuildProfile(next);
    };
    // Takes the seat in the writer's own Player Guild — founding it on first use, or simply
    // returning to it later. Like joining a Founder Guild, this requires not currently being in a
    // guild and not still cooling down from having left one. Founding for the first time also
    // requires a name: GuildWelcomeScreen only calls this with one once the writer has actually
    // typed something (see its own name-entry step), but this is re-checked here too, so a guild
    // can never actually exist — even for a moment, even locally — with no name at all.
    const enterOwnGuild = (name) => {
        setGuildProfile((prev) => {
            const base = prev || freshGuildMembership();
            if (base.guildType || guildCooldownRemainingMs(base) > 0)
                return base;
            const isFirstFounding = !base.playerGuild;
            const cleanName = (name || '').trim();
            if (isFirstFounding && !cleanName)
                return base;
            // synced: false marks a just-created local guild as not yet confirmed on the server
            // — see remoteGuildId/activeGuildRemoteId in home-screen.jsx, which now withhold
            // this guild's id from every consumer (events, treasury, anthology, presence) until
            // synced flips true below. A guild re-entered from existing local state keeps
            // whatever synced value it already had (untouched by the `|| {...}` fallback here).
            const existingPlayer = base.playerGuild || { id: uuid(), name: cleanName, crest: null, motto: '', createdDate: new Date().toISOString(), synced: false };
            const next = { ...base, guildType: 'player', playerGuild: existingPlayer };
            storage.set(GUILD_KEY, JSON.stringify(next));
            // Best-effort remote sync, same non-blocking philosophy as everywhere else signed-
            // in-only in this app — a no-op when signed out. Only meaningful to announce (via
            // the log below) the very first time, since every later re-entry already has a
            // synced row from before.
            syncPlayerGuild(existingPlayer.id, { name: existingPlayer.name, motto: existingPlayer.motto, crestUrl: existingPlayer.crest })
                .then((row) => {
                    setGuildSyncNotice(null);
                    // Always mark synced now that the server has actually confirmed this row —
                    // not just on first founding — so a re-entry that finally succeeds (after an
                    // earlier failed founding attempt) also clears the hold on this guild's id.
                    if (row) {
                        const patch = { synced: true };
                        if (isFirstFounding)
                            patch.inviteCode = row.invite_code;
                        saveOwnGuild(patch);
                    }
                })
                .catch((e) => {
                    console.warn('Inkroot: guild sync failed', e);
                    // Local state above already flipped to guildType: 'player' — that part isn't
                    // rolled back, since the writer is genuinely mid-founding and every other
                    // screen already treats them as seated. What's surfaced here is specifically
                    // that the *server* doesn't yet agree, so owner-only actions elsewhere
                    // (Host a Guild Event, treasury spends, …) will keep getting rejected until
                    // this resolves — previously that showed up as an unrelated-looking "Only
                    // the guild owner can…" error with no explanation.
                    setGuildSyncNotice({
                        title: "Your guild didn't save to your account",
                        message: (e && e.message) ||
                            "Something went wrong saving your guild to your account. Until this succeeds, hosting events and other owner-only actions will be rejected by the server, even though this device shows you as the owner.",
                    });
                });
            return next;
        });
    };
    // Re-attempts the sync for the writer's own Player Guild after a failure surfaced via
    // guildSyncNotice — same call enterOwnGuild/saveOwnGuild already make, just re-run on demand
    // instead of left to fail silently. Reuses the existing local playerGuild.id rather than
    // generating a new one, so a retry converges onto the same guild row instead of orphaning
    // another id (see create_or_get_own_guild's "you already own a Player Guild" check).
    const retryOwnGuildSync = () => {
        const player = guildProfile && guildProfile.playerGuild;
        if (!player) { setGuildSyncNotice(null); return; }
        syncPlayerGuild(player.id, { name: player.name, motto: player.motto, crestUrl: player.crest })
            .then((row) => {
                setGuildSyncNotice(null);
                if (row) {
                    const patch = { synced: true };
                    if (row.invite_code && row.invite_code !== player.inviteCode)
                        patch.inviteCode = row.invite_code;
                    saveOwnGuild(patch);
                }
            })
            .catch((e) => {
                console.warn('Inkroot: guild sync retry failed', e);
                setGuildSyncNotice({
                    title: "Still couldn't save your guild",
                    message: (e && e.message) ||
                        "Something went wrong saving your guild to your account. Please check your connection and try again.",
                });
            });
    };
    // Edits the writer's own Player Guild (name, motto, crest) once they're seated in it.
    const saveOwnGuild = (patch) => {
        setGuildProfile((prev) => {
            const base = prev || freshGuildMembership();
            const existingPlayer = base.playerGuild || { id: uuid(), name: '', crest: null, motto: '', createdDate: new Date().toISOString(), synced: false };
            const next = { ...base, playerGuild: { ...existingPlayer, ...patch } };
            storage.set(GUILD_KEY, JSON.stringify(next));
            // Only push name/motto/crest edits remotely, never inviteCode itself (that field is
            // server-generated and only ever written locally as a mirror of what came back from
            // syncPlayerGuild above — pushing it back up would be redundant, not wrong, but
            // there's no reason to).
            if ('name' in patch || 'motto' in patch || 'crest' in patch) {
                syncPlayerGuild(existingPlayer.id, {
                    name: patch.name != null ? patch.name : existingPlayer.name,
                    motto: patch.motto != null ? patch.motto : existingPlayer.motto,
                    crestUrl: patch.crest != null ? patch.crest : existingPlayer.crest,
                })
                    .then(() => {
                        setGuildSyncNotice(null);
                        // Confirms synced here too — covers an edit made while a founding sync
                        // was still pending or had failed; this success is just as much proof
                        // the row exists server-side as enterOwnGuild's own sync is.
                        if (!existingPlayer.synced)
                            saveOwnGuild({ synced: true });
                    })
                    .catch((e) => {
                        console.warn('Inkroot: guild sync failed', e);
                        setGuildSyncNotice({
                            title: "Your guild changes didn't save",
                            message: (e && e.message) ||
                                "Something went wrong saving your guild to your account. Your changes are kept on this device, but other devices and readers won't see them yet, and owner-only actions may be rejected by the server until this resolves.",
                        });
                    });
            }
            return next;
        });
    };
    // Joins another writer's Player Guild by invite code. Requires being signed in (the remote
    // call itself enforces this) and not currently seated in — or cooling down from — a guild.
    const [joinCodeError, setJoinCodeError] = useState('');
    const joinGuildByCode = async (code) => {
        setJoinCodeError('');
        if (guildProfile && (guildProfile.guildType || guildCooldownRemainingMs(guildProfile) > 0))
            return;
        try {
            const guild = await joinPlayerGuildByCode(code);
            setGuildProfile((prev) => {
                const base = prev || freshGuildMembership();
                const next = {
                    ...base, guildType: 'joined',
                    joinedGuild: { id: guild.id, name: guild.name, motto: guild.motto, crest: guild.crest_url, ownerId: guild.owner_id, joinedDate: new Date().toISOString() },
                };
                storage.set(GUILD_KEY, JSON.stringify(next));
                return next;
            });
        }
        catch (e) {
            setJoinCodeError(e.message || 'Could not join that guild.');
        }
    };
    useEffect(() => {
        (async () => {
            try {
                const res = await storage.get(INDEX_KEY);
                if (res) {
                    setProjects(JSON.parse(res.value));
                    return;
                }
                // Migrate a pre-multi-project save, if one exists, so nobody loses work.
                const legacy = await storage.get(LEGACY_KEY);
                if (legacy) {
                    const data = patchProjectDefaults(JSON.parse(legacy.value));
                    const id = uuid();
                    await storage.set(projectKey(id), JSON.stringify(data));
                    const total = data.chapters.reduce((s, c) => s + wordCount(c.text), 0);
                    const index = [{ id, title: data.title, subtitle: data.subtitle || '', seriesName: data.seriesName || '', author: data.author || '', cover: data.cover || null, wordCount: total, updatedAt: Date.now() }];
                    await storage.set(INDEX_KEY, JSON.stringify(index));
                    setProjects(index);
                    return;
                }
                setProjects([]);
            }
            catch (e) {
                setProjects([]);
            }
        })();
    }, []);
    const saveIndex = (next) => {
        setProjects(next);
        storage.set(INDEX_KEY, JSON.stringify(next));
    };
    const handleCreate = () => {
        const id = uuid();
        const fresh = emptyProject();
        storage.set(projectKey(id), JSON.stringify(fresh));
        const entry = { id, title: fresh.title, subtitle: '', seriesName: '', author: '', cover: fresh.cover, wordCount: 0, updatedAt: Date.now() };
        saveIndex([...(projects || []), entry]);
        nav.push({ label: fresh.title || 'Project', undo: () => setCurrentId(null) });
        setOpenTab('hub');
        setCurrentId(id);
    };
    const handleMeta = (id, meta) => {
        setProjects((prev) => {
            const next = (prev || []).map((p) => (p.id === id ? { ...p, ...meta } : p));
            storage.set(INDEX_KEY, JSON.stringify(next));
            return next;
        });
    };
    // Builds the payload for published_book_content — the public reader-facing mirror written
    // alongside every publishBookRemote call (see lib/library.js's publishBookContentRemote and
    // 70_migration_published_book_content.sql). Shaped exactly like what PublishedBookReader
    // (author-reputation.jsx) expects, so openReaderBook can hand a fetched row straight to
    // patchProjectDefaults with no further lookup. Chapters are trimmed to only the fields a
    // reader ever sees — never the author's own project-only fields (notes, backups, etc.).
    // The guild id guild_published_books'/published_books'/published_book_content's own
    // guild-membership RLS actually keys off (see 92_migration_player_guild_book_publishing.sql)
    // — a Founder Guild's fixed slug (founder_guild_members.guild_id) for a Founder Guild, or the
    // real player_guilds.id (player_guild_members.guild_id) for a self-founded ('player') or
    // joined ('joined') Player Guild. Deliberately NOT the same value as home-screen.jsx's own
    // activeGuildRemoteId, which uses a Founder Guild's backendGuildId (migration 69) instead —
    // that id space backs Guild Order/Anthology/Events, not the Bookshelf, and
    // guild_published_books has never used it. Returns null when there's no active guild to
    // publish a book to, same as the founderGuildId-only check this replaces.
    const activeBookshelfGuildId = () => {
        if (!guildProfile || !guildProfile.guildType)
            return null;
        if (guildProfile.guildType === 'founder')
            return guildProfile.founderGuildId || null;
        if (guildProfile.guildType === 'joined')
            return (guildProfile.joinedGuild && guildProfile.joinedGuild.id) || null;
        if (guildProfile.guildType === 'player')
            return (guildProfile.playerGuild && guildProfile.playerGuild.id) || null;
        return null;
    };
    // buildPublishedBookContent / buildPublishedPackContent moved to lib/publish-content.js
    // (publishing reliability pass, fix-tracker item 27) so Author Studio here and a project's
    // own Publishing Hub (project-workspace.jsx) build the exact same published_book_content /
    // published_pack_content shape instead of each keeping a private copy.
    const authorDisplayName = () => (writerProfile && (writerProfile.penName || writerProfile.name)) || '';
    // Grand Library > Author Studio: sets a completed project's publish destination ('none',
    // 'inkroot', or 'guild') from outside the project itself. The full project object (not just
    // the index entry) is the source of truth — same reasoning as `completed` elsewhere in the
    // app (Legacy Shelf, Guild XP, Guild Reputation) — so this loads it, sets the one field, and
    // saves it back, then patches the index via handleMeta so Home and the Grand Library reflect
    // it immediately without needing to open the project. Promoting a Guild publication to
    // Inkroot is just this same call with 'inkroot' — the project record never gets duplicated.
    // Publishing reliability (fix-tracker item 27): the local write that flips this UI to
    // "Published"/"Unpublished" now happens ONLY after the remote flow below has actually
    // resolved — never before, never in parallel with it. See lib/publish-flow.js for the full
    // rationale and for why a content-publish failure now rolls its own listing back instead of
    // leaving a half-published book standing. A failure here (this is a quick-action call site,
    // not the Wizard, so there's no inline error surface of its own) shows publishNotice and
    // returns without touching local state — the project keeps whatever status it already had,
    // which is always the truthful one since nothing changed remotely.
    const setPublishStatus = async (id, status) => {
        const res = await storage.get(projectKey(id));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const publishedAt = status !== 'none' ? Date.now() : null;
        // Computed once, up front — used by both the published_books push below AND the guild
        // push further down, so a book's real word count is consistent between the two (and
        // available for real-author-accounts display even when it's never guild-published — see
        // lib/library.js's publishBookRemote and fetchPublishedBooksByAuthor).
        const totalWords = (proj.chapters || []).reduce((s, c) => s + wordCount(c.text), 0);
        const activeGuildId = activeBookshelfGuildId();
        // Set when the server kept the listing (hidden, not deleted) because readers have already
        // bought the book — see unpublishBookRemoteFlow. Surfaced once the local status is saved.
        let soldBookHidden = false;
        try {
            if (status === 'none') {
                const flow = await unpublishBookRemoteFlow(id);
                soldBookHidden = !!(flow && flow.mode === 'hidden');
            }
            else {
                await publishBookRemoteFlow({
                    id,
                    listing: {
                        id, title: proj.title, subtitle: proj.subtitle, seriesName: proj.seriesName, cover: proj.cover,
                        blurb: proj.blurb, genre: proj.genre, tags: proj.tags, wordCount: totalWords,
                        price: proj.price, destination: status, publishedAt,
                    },
                    content: buildPublishedBookContent(proj, authorDisplayName()),
                    destination: status,
                    guildId: activeGuildId,
                });
            }
        }
        catch (e) {
            setPublishNotice({
                title: status === 'none' ? "Couldn't unpublish" : "Couldn't publish",
                message: e instanceof PublishFlowError ? e.message : "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        // Only reached once the remote steps above have actually succeeded (or there's no
        // signed-in account to push to at all — the same local-only fallback this always had).
        proj.publishStatus = status;
        proj.publishedAt = publishedAt;
        await storage.set(projectKey(id), JSON.stringify(proj));
        handleMeta(id, { publishStatus: status, publishedAt });
        if (soldBookHidden)
            setPublishNotice(SOLD_BOOK_UNPUBLISHED_NOTICE);
    };
    // Same idea as setPublishStatus above, but for a single Worldbuilding Pack inside a project
    // rather than the project's own book publication. Lets the Grand Library's Author Studio
    // unpublish a pack directly, without opening the project that owns it — the project file is
    // still the source of truth, this just loads it, updates the one pack, saves it back, and
    // re-mirrors every pack's summary onto the index (see packSummaryForIndex) so what the
    // Library shows stays current.
    // Same publishing-reliability contract as setPublishStatus above, applied to a single
    // Worldbuilding Pack — the local write only lands once the remote listing+content pair has
    // actually succeeded (see publishPackRemoteFlow in lib/publish-flow.js).
    const setPackPublishStatus = async (projectId, packId, status) => {
        const res = await storage.get(projectKey(projectId));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const patched = patchProjectDefaults(proj);
        const pack = patched.worldbuildingPacks.find((p) => p.id === packId);
        if (!pack)
            return;
        // The composite id ("<projectId>:<packKey>") matches what grand-library-screen.jsx
        // already computes locally as `selectedPackKey`.
        const remotePackId = `${projectId}:${packId}`;
        const publishedAt = status !== 'none' ? (pack.publishedAt || Date.now()) : null;
        // True when the server kept the pack off-offer (owners exist) instead of deleting it.
        let soldPackHidden = false;
        try {
            if (status === 'none') {
                const flow = await unpublishPackRemoteFlow(remotePackId);
                soldPackHidden = !!(flow && flow.mode === 'hidden');
            }
            else {
                const summary = packSummaryForIndex(patched, pack);
                await publishPackRemoteFlow({
                    id: remotePackId,
                    listing: {
                        id: remotePackId, projectId, packKey: packId, title: summary.title, subtitle: summary.subtitle,
                        description: summary.description, genre: summary.genre, tags: summary.tags,
                        coverImageUrl: summary.coverImageUrl, price: summary.price, categories: summary.categories,
                        totalEntries: summary.totalEntries, publishedAt,
                    },
                    content: buildPublishedPackContent(patched, pack),
                });
            }
        }
        catch (e) {
            setPublishNotice({
                title: status === 'none' ? "Couldn't unpublish pack" : "Couldn't publish pack",
                message: e instanceof PublishFlowError ? e.message : "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
            });
            return;
        }
        pack.publishStatus = status;
        pack.publishedAt = publishedAt;
        pack.updatedAt = Date.now();
        await storage.set(projectKey(projectId), JSON.stringify(patched));
        handleMeta(projectId, { worldbuildingPacks: patched.worldbuildingPacks.map((pk) => packSummaryForIndex(patched, pk)) });
        if (soldPackHidden)
            setPublishNotice(SOLD_PACK_UNPUBLISHED_NOTICE);
    };
    // Confirm handlers for the Publishing Wizard (see PublishingWizard) when it's opened from
    // Author Studio, which — unlike a project's own Settings tab — doesn't have the project
    // loaded, only its index entry. Same read-modify-write pattern as setPublishStatus /
    // setPackPublishStatus just above, just also writing the listing fields Step 3 collected
    // (title, description, genre, tags, price, and — for a pack — its cover) rather than only
    // the publish status, and mirroring the same fields onto the index afterward.
    // Called from PublishingWizard's onPublishBook — unlike setPublishStatus above, this is
    // awaited by the Wizard itself (see PublishingWizard's own idle/publishing/error state in
    // library/publishing.jsx), so a failure here is re-thrown rather than shown via
    // publishNotice: the Wizard has its own inline error surface and stays open on its confirm
    // step so the writer can retry without re-filling the form. Same "local write only after the
    // remote flow resolves" contract as setPublishStatus either way.
    const publishBookWithDetails = async (id, destination, details) => {
        const res = await storage.get(projectKey(id));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const publishedAt = Date.now();
        const nextProj = { ...proj };
        nextProj.title = details.title || proj.title;
        nextProj.genre = details.genre;
        nextProj.blurb = details.description;
        nextProj.tags = details.tags;
        nextProj.price = details.priceMode === 'paid' ? details.price : 0;
        nextProj.downloadable = !!details.downloadable;
        if (details.storyFormat === 'series' || details.storyFormat === 'book')
            nextProj.storyFormat = details.storyFormat;
        // Computed once, up front — same reasoning as setPublishStatus's totalWords above.
        const totalWords = (proj.chapters || []).reduce((s, c) => s + wordCount(c.text), 0);
        const activeGuildId = activeBookshelfGuildId();
        await publishBookRemoteFlow({
            id,
            listing: {
                id, title: nextProj.title, subtitle: nextProj.subtitle, seriesName: nextProj.seriesName, cover: nextProj.cover,
                blurb: nextProj.blurb, genre: nextProj.genre, tags: nextProj.tags, wordCount: totalWords,
                price: nextProj.price, destination, publishedAt, storyFormat: nextProj.storyFormat || 'book',
                downloadable: nextProj.downloadable,
            },
            content: buildPublishedBookContent(nextProj, authorDisplayName()),
            destination,
            guildId: activeGuildId,
        }); // throws PublishFlowError on failure — nothing below runs, nothing local changes
        nextProj.publishStatus = destination;
        nextProj.publishedAt = publishedAt;
        await storage.set(projectKey(id), JSON.stringify(nextProj));
        handleMeta(id, { publishStatus: destination, publishedAt, title: nextProj.title, genre: nextProj.genre, blurb: nextProj.blurb, tags: nextProj.tags, price: nextProj.price, storyFormat: nextProj.storyFormat || 'book', downloadable: nextProj.downloadable });
    };
    // Called from PublishingWizard's onPublishPack — same "awaited by the Wizard, throws on
    // failure instead of using publishNotice" contract as publishBookWithDetails above.
    const publishPackWithDetails = async (projectId, packId, destination, details) => {
        const res = await storage.get(projectKey(projectId));
        if (!res)
            return;
        let proj;
        try {
            proj = JSON.parse(res.value);
        }
        catch (e) {
            return;
        }
        const patched = patchProjectDefaults(proj);
        const pack = patched.worldbuildingPacks.find((p) => p.id === packId);
        if (!pack)
            return;
        const nextPack = { ...pack };
        nextPack.title = details.title || pack.title;
        nextPack.description = details.description;
        nextPack.genre = details.genre;
        nextPack.tags = details.tags;
        nextPack.coverImageUrl = details.coverImageUrl;
        nextPack.price = details.priceMode === 'paid' ? details.price : 0;
        const publishedAt = Date.now();
        const remotePackId = `${projectId}:${packId}`;
        const summary = packSummaryForIndex(patched, nextPack);
        await publishPackRemoteFlow({
            id: remotePackId,
            listing: {
                id: remotePackId, projectId, packKey: packId, title: summary.title, subtitle: summary.subtitle,
                description: summary.description, genre: summary.genre, tags: summary.tags,
                coverImageUrl: summary.coverImageUrl, price: summary.price, categories: summary.categories,
                totalEntries: summary.totalEntries, publishedAt,
            },
            content: buildPublishedPackContent(patched, nextPack),
        }); // throws PublishFlowError on failure — nothing below runs, nothing local changes
        nextPack.publishStatus = destination;
        nextPack.publishedAt = publishedAt;
        nextPack.updatedAt = Date.now();
        const packIdx = patched.worldbuildingPacks.findIndex((p) => p.id === packId);
        patched.worldbuildingPacks[packIdx] = nextPack;
        await storage.set(projectKey(projectId), JSON.stringify(patched));
        handleMeta(projectId, { worldbuildingPacks: patched.worldbuildingPacks.map((pk) => packSummaryForIndex(patched, pk)) });
    };
    const handleDelete = (id) => {
        storage.delete(projectKey(id));
        storage.delete(backupsKey(projectKey(id)));
        saveIndex((projects || []).filter((p) => p.id !== id));
    };
    const handleDeleteCurrent = (id) => {
        storage.delete(projectKey(id));
        storage.delete(backupsKey(projectKey(id)));
        saveIndex((projects || []).filter((p) => p.id !== id));
        // The project this trail was pointing at no longer exists, so restart from Home rather
        // than trying to "undo" back into a screen that's now gone.
        nav.resetTo(null);
        setCurrentId(null);
    };
    // Storage quota is shared across every project in this browser, not allocated per-project —
    // so a project can still fail to save even after its own images are optimized, if other
    // projects (or their old backups, from before backups stripped heavy media) are what's using
    // up the room. This sweeps every project on the device, not just the one currently open.
    const handleOptimizeAllStorage = async () => {
        let totalFreed = 0, touchedProjects = 0;
        for (const meta of (projects || [])) {
            const res = await storage.get(projectKey(meta.id));
            if (!res)
                continue;
            let proj;
            try {
                proj = JSON.parse(res.value);
            }
            catch (e) {
                continue;
            }
            const before = res.value.length;
            const { project: optimized, freedBytes } = await optimizeProjectImages(proj);
            const backupFreed = await reclaimBackupSpace(projectKey(meta.id));
            const serialized = JSON.stringify(optimized);
            if (serialized.length < before) {
                try {
                    await storage.set(projectKey(meta.id), serialized);
                    touchedProjects++;
                }
                catch (e) { }
            }
            totalFreed += freedBytes + backupFreed;
        }
        return { totalFreed, touchedProjects };
    };
    const handleExportAll = async () => {
        const bundle = { exportedFrom: 'inkroot', schemaVersion: SCHEMA_VERSION, exportedAt: new Date().toISOString(), projects: [] };
        for (const meta of (projects || [])) {
            const res = await storage.get(projectKey(meta.id));
            if (res)
                bundle.projects.push(JSON.parse(res.value));
        }
        const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `inkroot-backup-${dateKey(new Date())}.json`;
        a.click();
        URL.revokeObjectURL(url);
    };
    const handleImportFile = (file) => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onerror = () => resolve('Could not read that file.');
        reader.onload = () => {
            try {
                const parsed = JSON.parse(reader.result);
                const incoming = Array.isArray(parsed.projects) ? parsed.projects : (parsed.chapters ? [parsed] : null);
                if (!incoming || incoming.length === 0) {
                    resolve('That file doesn\'t look like an Inkroot backup.');
                    return;
                }
                const newEntries = incoming.map((raw) => {
                    // restoreProject (not just patchProjectDefaults) so we also get back which, if
                    // any, schema migrations ran for this specific project being restored.
                    const { data, log } = restoreProject(raw);
                    const id = uuid();
                    storage.set(projectKey(id), JSON.stringify(data));
                    const total = data.chapters.reduce((s, c) => s + wordCount(c.text), 0);
                    return { id, title: data.title, subtitle: data.subtitle || '', seriesName: data.seriesName || '', author: data.author || '', cover: data.cover || null, wordCount: total, updatedAt: Date.now(), migrated: log.length > 0 };
                });
                saveIndex([...(projects || []), ...newEntries]);
                const migratedCount = newEntries.filter((e) => e.migrated).length;
                const migratedNote = migratedCount > 0
                    ? ` (${migratedCount} upgraded from an older backup format — see console for details)`
                    : '';
                resolve(`Imported ${newEntries.length} project${newEntries.length === 1 ? '' : 's'}${migratedNote}.`);
            }
            catch (e) {
                resolve('Could not read that file — is it an Inkroot backup?');
            }
        };
        reader.readAsText(file);
    });
    if (projects === null) {
        return (React.createElement("div", { style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui' } }, "Opening Inkroot\u2026"));
    }
    if (showModerationQueue) {
        return React.createElement("div", { key: "moderation-queue", className: "ink-page-in" },
            React.createElement(ModerationQueue, { onBack: () => { nav.pop(); setShowModerationQueue(false); } }));
    }
    if (showGuildEventJudging) {
        return React.createElement("div", { key: "guildevent-judging", className: "ink-page-in" },
            React.createElement(GuildEventJudgePanel, null));
    }
    if (showInkrootEventsAdmin) {
        return React.createElement("div", { key: "inkroot-events-admin", className: "ink-page-in" },
            React.createElement(InkrootEventsAdmin, { onBack: () => { nav.pop(); setShowInkrootEventsAdmin(false); } }));
    }
    if (showManageAdmins) {
        return React.createElement("div", { key: "manage-admins", className: "ink-page-in" },
            React.createElement(ManageAdmins, { onBack: () => { nav.pop(); setShowManageAdmins(false); } }));
    }
    if (showManualWithdrawalsAdmin) {
        return React.createElement("div", { key: "manual-withdrawals-admin", className: "ink-page-in" },
            React.createElement(ManualWithdrawalsAdmin, { onBack: () => { nav.pop(); setShowManualWithdrawalsAdmin(false); } }));
    }
    if (currentId) {
        return React.createElement("div", { key: "workspace-" + currentId, className: "ink-page-in" },
            React.createElement(ProjectWorkspace, { projectId: currentId, onBack: () => nav.pop(), onMeta: handleMeta, onDeleteProject: handleDeleteCurrent, initialTab: openTab, guildProfile: guildProfile, writerProfile: writerProfile, activeBookshelfGuildId: activeBookshelfGuildId }));
    }
    if (readingBookId) {
        return React.createElement("div", { key: "reader-" + readingBookId, className: "ink-page-in" },
            readingBookProject
                ? React.createElement(PublishedBookReader, { project: readingBookProject, bookId: readingBookId, downloadable: readingBookDownloadable, onBack: () => nav.pop() })
                : readingBookLocked
                    ? React.createElement("div", { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui', padding: 24, textAlign: 'center' } },
                        React.createElement("div", { style: { fontSize: 16, fontWeight: 600 } }, "This book is only for readers who've bought it"),
                        React.createElement("div", { style: { fontSize: 13, color: '#A8A0A8', maxWidth: 320 } }, `The author priced this at ${formatNaira(readingBookLocked.price)}. Buy it from the Grand Library to read the full book.`),
                        React.createElement("button", { onClick: () => nav.pop(), style: { marginTop: 8, background: 'none', border: '1px solid #4A3D22', color: '#E8C468', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' } }, "Go back"))
                    : readingBookError
                        ? React.createElement("div", { style: { minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui', padding: 24, textAlign: 'center' } },
                            React.createElement("div", { style: { fontSize: 16, fontWeight: 600 } }, "This book couldn't be opened"),
                            React.createElement("div", { style: { fontSize: 13, color: '#A8A0A8', maxWidth: 320 } }, "It may have been unpublished, or something went wrong loading it. Please try again in a moment."),
                            React.createElement("button", { onClick: () => nav.pop(), style: { marginTop: 8, background: 'none', border: '1px solid #4A3D22', color: '#E8C468', borderRadius: 8, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer' } }, "Go back"))
                        : React.createElement("div", { style: { minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#17171B', color: '#EFE7D2', fontFamily: 'ui-sans-serif, system-ui' } }, "Opening book\u2026"));
    }
    if (viewingEventId !== null) {
        return React.createElement("div", { key: "guildevent-" + viewingEventId, className: "ink-page-in" },
            React.createElement(GuildEventDetailScreen, { eventId: viewingEventId, onOpenGuild: openGuildProfile }));
    }
    if (viewingGuildId !== null) {
        return React.createElement("div", { key: "guildprofile-" + viewingGuildId, className: "ink-page-in" },
            React.createElement(GuildPublicProfileScreen, { guildId: viewingGuildId, onOpenEvent: openGuildEvent }));
    }
    if (viewingAuthorName !== null && writerProfile) {
        const selfName = ((writerProfile.penName || writerProfile.name) || '').trim();
        const isSelf = viewingIsSelf;
        const authorHallGuildName = (() => {
            if (!guildProfile || !guildProfile.guildType)
                return null;
            if (guildProfile.guildType === 'player')
                return (guildProfile.playerGuild && guildProfile.playerGuild.name) || 'my guild';
            const fg = founderGuildById(guildProfile.founderGuildId);
            return (fg && fg.name) || 'my guild';
        })();
        return React.createElement("div", { key: "authorhall-" + (isSelf ? 'self' : (viewingAuthorId || viewingAuthorName)), className: "ink-page-in" },
            React.createElement(AuthorsHallScreen, {
                isSelf, authorName: isSelf ? selfName : viewingAuthorName, authorId: isSelf ? sessionUserId : viewingAuthorId,
                profile: writerProfile, projects: projects, onSaveProfile: saveProfile,
                nameError: profileNameError, nameWarning: profileNameWarning, profileSyncNotice, selfVerified,
                isModerator, onOpenModerationQueue: openModerationQueue,
                isPlatformAdmin, onOpenInkrootEventsAdmin: openInkrootEventsAdmin,
                onOpenManualWithdrawalsAdmin: openManualWithdrawalsAdmin,
                onOpenManageAdmins: openManageAdmins,
                onOpenGuildEventJudging: openGuildEventJudging,
                onBack: () => nav.pop(), onOpenProjectHall: (id) => openProject(id, 'achievements'),
                guildReputation: writerReputation, writerGuildName: authorHallGuildName,
                onOpenCreatorDashboard: openCreatorDashboard, onRead: openReaderBook,
            }));
    }
    return React.createElement("div", { key: "home", className: "ink-page-in" },
        React.createElement(HomeScreen, { projects: projects, onOpen: (id) => openProject(id, 'hub'), onReadBook: openReaderBook, onOpenHealth: (id) => openProject(id, 'health'), onOpenPacks: (id) => openProject(id, 'packs'), onCreate: handleCreate, onDelete: handleDelete, onExportAll: handleExportAll, onImportFile: handleImportFile, onOptimizeAll: handleOptimizeAllStorage, writerProfile: writerProfile, onOpenProfile: openProfile, writerRank: writerRank, writerReputation: writerReputation, guildProfile: guildProfile, isPlatformAdmin: isPlatformAdmin, onJoinFounderGuild: joinFounderGuild, onLeaveGuild: leaveCurrentGuild, onEnterOwnGuild: enterOwnGuild, onSaveOwnGuild: saveOwnGuild, onJoinGuildByCode: joinGuildByCode, joinCodeError: joinCodeError, lifetimeStats: lifetimeStats, onReputationChange: setWriterReputation, onSetPublishStatus: setPublishStatus, onSetPackPublishStatus: setPackPublishStatus, onPublishBookWithDetails: publishBookWithDetails, onPublishPackWithDetails: publishPackWithDetails, activeTab: homeActiveTab, setActiveTab: setHomeActiveTab, onOpenAuthor: openAuthorHall, onOpenGuild: openGuildProfile, onOpenEvent: openGuildEvent, libraryInitialMode: libraryInitialMode }),
        publishNotice && React.createElement(AlertDialog, { title: publishNotice.title, message: publishNotice.message, onClose: () => setPublishNotice(null) }),
        guildLeaveNotice && React.createElement(AlertDialog, { title: guildLeaveNotice.title, message: guildLeaveNotice.message, onClose: () => setGuildLeaveNotice(null) }),
        // closeLabel doubles as the retry action here (see retryOwnGuildSync) rather than a
        // plain dismiss — leaving this unresolved is exactly the state that used to show up
        // downstream as a confusing "Only the guild owner can…" error, so there's no reason to
        // let it sit dismissed without at least one more attempt.
        guildSyncNotice && React.createElement(AlertDialog, { title: guildSyncNotice.title, message: guildSyncNotice.message, closeLabel: 'Try again', onClose: retryOwnGuildSync }));
}
