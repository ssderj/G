import React, { useState, useEffect, useRef } from 'react';
import { fetchPublicProfile } from '../lib/profile.js';
import { fetchOfficialBadgeStatus } from '../lib/official-badge.js';
import { fetchAuthorRatingsSummary, fetchFollowerCount, fetchPublishedBooksByAuthor, followAuthor, isFollowing as isFollowingRemote, unfollowAuthor } from '../lib/library.js';
import { BOOK_VIEW_SOURCES, recordBookDetailView, recordBookReadStart } from '../lib/analytics.js';
import { storage } from '../lib/storage.js';
import { PublicIdentityCard, WriterIdentityCard } from './author-identity.jsx';
import { AUTHOR_EVER_FOLLOWED_KEY, AUTHOR_FOLLOWS_KEY, LegacyShelf, LifetimeStatTile, REPUTATION_QUALITY_MIN_WORDS, authorKeyFor, computeAuthorReputation, meaningfulCompletedCountFor, myPublishedCountFor, readAuthorFollowMap, reputationTitleFor, reviewReputationCountsFrom, writeAuthorFollowMap } from './author-reputation.jsx';
import { BookDetailModal, LibraryDiscoverCard } from './grand-library-cards.jsx';
import { CheckInCalendarCard } from './check-in-calendar.jsx';
import { resolvePublishStatus } from './publishing.jsx';
import { readLocalImageFile } from '../shared-ui/image-utils.jsx';
import { deleteUploadedImage, isUploadedMediaUrl, uploadImageDataUrl } from '../lib/mediaStorage.js';
import { ArchiveSectionHeading } from '../shared-ui/ui-cards.jsx';
import { AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { projectKey } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { Breadcrumbs, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, UniversalBackButton, useNav } from '../shell/nav-context.jsx';
import { AchievementCard, aggregateWriterStats } from '../writing/achievements.jsx';
import { NAIRA_ACHIEVEMENTS, RankCrest, computeAchievements, computeNairaAchievements, computeStreak, runHealthChecks } from '../writing/health-checks.jsx';
import { patchProjectDefaults } from '../writing/project-schema-and-backups.jsx';


export function AuthorsHallScreen({ isSelf, authorName, authorId, profile, projects, onSaveProfile, nameError, nameWarning, profileSyncNotice, selfVerified, isModerator, onOpenModerationQueue, isPlatformAdmin, onOpenInkrootEventsAdmin, onOpenManualWithdrawalsAdmin, onOpenManageAdmins, onOpenGuildEventJudging, onBack, onOpenProjectHall, guildReputation, writerGuildName, onOpenCreatorDashboard, onRead }) {
    const fileInputRef = useRef(null);
    const [stats, setStats] = useState(null); // null while the lifetime tally is being gathered
    const [legacyBooks, setLegacyBooks] = useState(null); // completed projects, oldest finished first
    const [avatarError, setAvatarError] = useState('');
    const [showHall, setShowHall] = useState(false); // false = identity/stats view, true = Hall of Legends
    // computeNairaAchievements() is async now (it queries Supabase — see the comment on
    // NAIRA_ACHIEVEMENTS in writing/health-checks.jsx), so it's fetched here like every other
    // remote read in this file (remoteProfile/remoteBooks above) rather than called inline during
    // render. Only fetched when the Hall is open AND this is the signed-in writer's own Hall:
    // naira_achievement_progress() always reports for whoever is actually signed in (auth.uid()),
    // not for whichever authorId's Hall happens to be open — fetching it on someone else's Hall
    // would show the viewer's own purchase/sales counts mislabeled as that other author's. Stays
    // null (falls back to the locked placeholder below) in every other case, same as before this
    // existed.
    const [nairaAchievements, setNairaAchievements] = useState(null);
    useEffect(() => {
        if (!showHall || !isSelf) {
            setNairaAchievements(null);
            return;
        }
        let cancelled = false;
        computeNairaAchievements().then((result) => { if (!cancelled) setNairaAchievements(result); });
        return () => { cancelled = true; };
    }, [showHall, isSelf]);
    // The Inkroot Official Badge — see lib/official-badge.js and the comment on
    // grant_naira_achievement() in supabase/history/94_migration_official_badge_and_checkins.sql.
    // Fetched independent of the Hall of Legends being open (unlike nairaAchievements above)
    // since it's shown on the identity card itself, not just inside the Hall.
    const [officialBadge, setOfficialBadge] = useState(null);
    useEffect(() => {
        if (!isSelf) {
            setOfficialBadge(null);
            return;
        }
        let cancelled = false;
        fetchOfficialBadgeStatus().then((result) => { if (!cancelled) setOfficialBadge(result); });
        return () => { cancelled = true; };
    }, [isSelf]);
    // authorLevelUpEvent/rankPromotionEvent/authorXpGainEvent (and readSeenAuthorLevel/
    // writeSeenAuthorLevel) removed along with Writer Level — there's nothing left that "levels
    // up" here to celebrate. Reputation (and the Rank it drives — see reputationTitleFor below)
    // simply is whatever it currently computes to; no separate ceremony, no localStorage record
    // of what's "already been seen".
    // Anti-impersonation piece 5 — when this Hall was opened from a surface that carries a real
    // account id (see shell/ink-root.jsx's openAuthorHall), fetch that ONE specific account's
    // real profile and real published books, instead of guessing from this device's own local
    // project list by author-name text (see publicBooks below for why that guess isn't safe to
    // treat as identity). `remoteProfile` stays null while loading or when authorId is absent —
    // every render below falls back to the existing name-based behavior in that case, so a Hall
    // opened without a real id (the local-only Grand Library, Author Studio) is completely
    // unaffected.
    const [remoteProfile, setRemoteProfile] = useState(null);
    const [remoteBooks, setRemoteBooks] = useState(null);
    useEffect(() => {
        setRemoteProfile(null);
        setRemoteBooks(null);
        if (!authorId || isSelf) return;
        let cancelled = false;
        fetchPublicProfile(authorId).then((p) => { if (!cancelled) setRemoteProfile(p); }).catch((e) => console.warn('Inkroot: fetchPublicProfile failed', e));
        fetchPublishedBooksByAuthor(authorId).then((books) => { if (!cancelled) setRemoteBooks(books); }).catch((e) => console.warn('Inkroot: fetchPublishedBooksByAuthor failed', e));
        return () => { cancelled = true; };
    }, [authorId, isSelf]);
    // This device's own follow relationship to whichever author's Hall is open — irrelevant (and
    // never rendered) on your own Hall, since the Follow button only ever appears on someone
    // else's. `everFollowed` is the permanent, one-time ledger the Reputation +1 actually reads
    // from; `following` is just the button's current on/off display state (see
    // AUTHOR_FOLLOWS_KEY / AUTHOR_EVER_FOLLOWED_KEY above).
    const authorFollowKey = authorKeyFor(authorName);
    const [followingMap, setFollowingMap] = useState(() => readAuthorFollowMap(AUTHOR_FOLLOWS_KEY));
    // Fix-tracker item 31: follow/unfollow notice — shown only when a real remote sync (authorId
    // present) fails, since that's the only case where the write could have silently not reached
    // the `follows` table. { title, message } | null, same shape as ink-root.jsx's publishNotice.
    const [followNotice, setFollowNotice] = useState(null);
    const [everFollowedMap, setEverFollowedMap] = useState(() => readAuthorFollowMap(AUTHOR_EVER_FOLLOWED_KEY));
    const isFollowing = !!followingMap[authorFollowKey];
    // The real follower count for whichever author's Hall this is — self or someone else, since
    // ink-root.jsx now passes the signed-in account's own id as authorId on your own Hall too
    // (see openAuthorHall/InkRoot's render call). Stays 0 for a Hall with no real account behind
    // it (the local-only Grand Library/Author Studio fallback — see publicBooks below), same as
    // completedCount/guildContribution already do on someone else's Hall.
    const [followerCount, setFollowerCount] = useState(0);
    useEffect(() => {
        if (!authorId) { setFollowerCount(0); return; }
        let cancelled = false;
        fetchFollowerCount(authorId).then((n) => { if (!cancelled) setFollowerCount(n); }).catch((e) => console.warn('Inkroot: fetchFollowerCount failed', e));
        return () => { cancelled = true; };
    }, [authorId]);
    // Correct the local map against the real `follows` row whenever this Hall was opened with a
    // real authorId (see remoteProfile effect above for the same authorId-or-fall-back-to-local
    // posture) — catches a follow made from a different device without ever downgrading an
    // existing local "following" state on a failed/offline read.
    useEffect(() => {
        if (!authorId || isSelf) return;
        let cancelled = false;
        isFollowingRemote(authorId).then((remote) => {
            if (cancelled || !remote) return;
            setFollowingMap((prev) => {
                if (prev[authorFollowKey]) return prev;
                const next = { ...prev, [authorFollowKey]: true };
                writeAuthorFollowMap(AUTHOR_FOLLOWS_KEY, next);
                return next;
            });
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [authorId, isSelf]);
    // Flips the local "Following" toggle and the "ever followed" ledger. Pulled out of
    // handleToggleFollow (fix-tracker item 31) so the local-only path (no authorId) can still
    // flip immediately as it always did, while the real-account path only calls this once the
    // server write has actually succeeded — never optimistically ahead of it.
    const flipLocalFollowState = () => {
        setFollowingMap((prev) => {
            const next = { ...prev, [authorFollowKey]: !prev[authorFollowKey] };
            if (!next[authorFollowKey])
                delete next[authorFollowKey];
            writeAuthorFollowMap(AUTHOR_FOLLOWS_KEY, next);
            return next;
        });
        // This local "ever followed" ledger no longer feeds Reputation (see followerCount above,
        // which reads the real total from the server) — kept purely as this device's own
        // permanent record of authors it has followed at least once, in case something else here
        // wants that later; the toggle above already covers the button's own on/off state.
        setEverFollowedMap((prev) => {
            if (prev[authorFollowKey])
                return prev;
            const next = { ...prev, [authorFollowKey]: true };
            writeAuthorFollowMap(AUTHOR_EVER_FOLLOWED_KEY, next);
            return next;
        });
    };
    const handleToggleFollow = () => {
        const wasFollowing = isFollowing;
        // Local-only Halls (Grand Library/Author Studio without a real account id — see the
        // authorId comment on remoteProfile above) have no server to sync to; keep exactly the
        // local-only behavior this always had.
        if (!authorId) {
            flipLocalFollowState();
            return;
        }
        // Fix-tracker item 31: followAuthor/unfollowAuthor now throw on a real database error
        // instead of silently resolving (see lib/library.js), so the local "Following" toggle and
        // follower count are only applied once the write has actually succeeded — never
        // optimistically ahead of it. A failure (offline, RLS reject) now surfaces via
        // followNotice instead of only a console.warn, and leaves both the toggle and the count
        // exactly where they were, matching the button's own real state instead of drifting from it.
        (wasFollowing ? unfollowAuthor(authorId) : followAuthor(authorId))
            .then(() => {
                flipLocalFollowState();
                setFollowerCount((n) => Math.max(0, n + (wasFollowing ? -1 : 1)));
            })
            .catch((e) => {
                setFollowNotice({
                    title: wasFollowing ? "Couldn't unfollow" : "Couldn't follow",
                    message: "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
                });
            });
    };
    useEffect(() => {
        let cancelled = false;
        setStats(null);
        setLegacyBooks(null);
        (async () => {
            const full = [];
            for (const meta of projects) {
                try {
                    const res = await storage.get(projectKey(meta.id));
                    if (res)
                        full.push(patchProjectDefaults(JSON.parse(res.value)));
                }
                catch (e) { /* skip a project that fails to parse rather than blocking the whole tally */ }
            }
            if (cancelled)
                return;
            const aggregated = aggregateWriterStats(full);
            setStats(aggregated);
            // The Legacy Shelf needs a per-book snapshot (achievement %, final health, completion
            // date) that the pooled lifetime stats above don't keep, so it's built separately here
            // from the same already-loaded project data rather than reloading anything.
            const books = full.filter((p) => p.completed).map((p) => {
                const words = p.chapters.reduce((s, c) => s + wordCount(c.text), 0);
                const streak = computeStreak((p.stats && p.stats.log) || {});
                const health = runHealthChecks(p);
                const ach = computeAchievements(p, { totalWords: words, streak, healthScore: health.score, totalHealthIssues: health.totalIssues });
                const achievementPct = ach.length ? Math.round((ach.filter((a) => a.unlocked).length / ach.length) * 100) : 0;
                return { id: p.id, title: p.title, subtitle: p.subtitle, seriesName: p.seriesName, author: p.author, cover: p.cover,
                    completedAt: p.completedAt || null, wordCount: words, achievementPct, healthScore: health.score };
            }).sort((a, b) => (a.completedAt || 0) - (b.completedAt || 0));
            if (!cancelled)
                setLegacyBooks(books);
        })();
        return () => { cancelled = true; };
    }, [projects]);
    const handleAvatarFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setAvatarError('');
        try {
            const dataUrl = await readLocalImageFile(file, 480, 0.85);
            // Signed in: upload to Storage and store the short public URL instead of the data
            // URL itself — this is what profiles.avatar_url actually gets synced to (see
            // profile.js's syncProfile), and that table is publicly readable, so this keeps the
            // raw image bytes out of Postgres. Falls back to the data URL when signed out,
            // offline, or the upload fails for any reason — avatar upload still works exactly
            // as it always did in that case, just stored inline like before this phase.
            const previousAvatar = profile && profile.avatar;
            const uploadedUrl = await uploadImageDataUrl(dataUrl, 'avatars');
            onSaveProfile({ avatar: uploadedUrl || dataUrl });
            // Best-effort — only ever removes an object this same writer owns (see the bucket's
            // own RLS in schema_phase9.sql), and only when it's actually one of ours to begin
            // with, not a leftover local data URL from before this phase.
            if (uploadedUrl && isUploadedMediaUrl(previousAvatar)) {
                deleteUploadedImage(previousAvatar);
            }
        }
        catch (err) {
            setAvatarError(err.message || 'Could not use that image.');
        }
    };
    // Clears the stored photo so WriterIdentityCard falls back to its default avatar glyph —
    // same profile-patching path as an upload, just with an empty value instead of a data URL.
    const handleRemoveAvatar = () => {
        setAvatarError('');
        if (isUploadedMediaUrl(profile && profile.avatar)) {
            deleteUploadedImage(profile.avatar);
        }
        onSaveProfile({ avatar: '' });
    };
    const joinDateLabel = (() => {
        try {
            return new Date(profile.joinDate).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
        }
        catch (e) {
            return '';
        }
    })();
    const writer = stats || { totalAchievements: 0, secretAchievementsFound: 0 };
    // For a pen name that isn't this device's own — i.e. someone else's Author's Hall — the
    // "published books" list depends on how we got here:
    //
    // - A real authorId (Fireside, Guild Bookshelf — see openAuthorHall): use their ACTUAL
    //   published_books rows (remoteBooks, fetched above) — real cover, subtitle, series name,
    //   and word count included, now that published_books carries them (see
    //   26_migration_published_books_richer_metadata.sql).
    // - No authorId (the local-only Grand Library, Author Studio — no real account behind these
    //   names at all): fall back to the previous best-effort guess — publishStatus === 'inkroot'
    //   entries from this device's own local project list, filtered to that author credit. This
    //   was never a reliable way to tell who someone actually is (two people can share a display
    //   name), which is exactly why it's now a fallback rather than the only option.
    const publicBooks = (isSelf ? [] : authorId
        ? (remoteBooks || []).map((b) => ({
            id: b.id, title: b.title, subtitle: b.subtitle, seriesName: b.seriesName, cover: b.cover,
            author: remoteProfile ? remoteProfile.name : authorName, wordCount: b.wordCount, updatedAt: b.publishedAt,
            genre: b.genre, blurb: b.blurb, price: b.price,
        }))
        : projects.filter((p) => resolvePublishStatus(p) === 'inkroot'
            && (p.author || '').trim().toLowerCase() === (authorName || '').trim().toLowerCase())
            .map((p) => ({
                id: p.id, title: p.title, subtitle: p.subtitle, seriesName: p.seriesName, cover: p.cover,
                author: p.author, wordCount: p.wordCount || 0, updatedAt: p.updatedAt || 0,
                genre: p.genre || 'Unspecified', blurb: p.blurb || '', price: typeof p.price === 'number' ? p.price : 0,
            }))).sort((a, b) => b.updatedAt - a.updatedAt);
    const [selectedPublicBookId, setSelectedPublicBookId] = useState(null);
    const selectedPublicBook = selectedPublicBookId ? publicBooks.find((b) => b.id === selectedPublicBookId) : null;
    // Same nav.push/pop treatment as GrandLibraryScreen's own book detail — this modal used to be
    // a bare useState toggle that never registered with the Back/breadcrumb stack, so Back could
    // skip past it and the only way out was the Home breadcrumb's full reset.
    const nav = useNav();
    const openPublicBook = (id, title) => {
        nav.push({ label: title || 'Book', undo: () => setSelectedPublicBookId(null) });
        setSelectedPublicBookId(id);
        recordBookDetailView(id, BOOK_VIEW_SOURCES.AUTHOR_PROFILE);
    };
    const closePublicBook = () => nav.pop();
    // This author's own published-book count, for the Reputation formula — but only the ones that
    // clear REPUTATION_QUALITY_MIN_WORDS. A quick, low-effort "published" stub shouldn't earn
    // Reputation just for existing; on your own Hall that's every sufficiently long project of
    // yours marked Published to Inkroot, on someone else's Hall it's the same publicBooks list
    // (already filtered to their author credit above) held to the same bar.
    const myPublishedCount = myPublishedCountFor(projects);
    const qualityPublicBooksCount = publicBooks.filter((b) => b.wordCount >= REPUTATION_QUALITY_MIN_WORDS).length;
    // Real reviews/ratings received across this author's published books, for the same formula —
    // every published listing counts here (not just the ones that clear
    // REPUTATION_QUALITY_MIN_WORDS the way publishedCount above does), since a real reader having
    // actually reviewed the book is itself already a stronger signal than word count alone. On
    // your own Hall that's every one of your own 'inkroot' listings (publicBooks stays [] for
    // isSelf, so it can't supply this); on someone else's Hall it's the same publicBooks list
    // already shown above. fetchAuthorRatingsSummary is the same call the Creator Dashboard's own
    // Ratings tab already uses (see CreatorBookCard/AuthorStudioBookCard in
    // grand-library-cards.jsx) — reviewReputationCountsFrom (author-reputation.jsx) turns its
    // result into the two counts computeAuthorReputation needs.
    const myPublishedBookIds = isSelf ? projects.filter((p) => resolvePublishStatus(p) === 'inkroot').map((p) => p.id) : [];
    const reviewBookIds = isSelf ? myPublishedBookIds : publicBooks.map((b) => b.id);
    const [reviewCounts, setReviewCounts] = useState({ reviewCount: 0, ratingCount: 0 });
    useEffect(() => {
        if (!reviewBookIds.length) { setReviewCounts({ reviewCount: 0, ratingCount: 0 }); return; }
        let cancelled = false;
        fetchAuthorRatingsSummary(reviewBookIds)
            .then((summary) => { if (!cancelled) setReviewCounts(reviewReputationCountsFrom(summary)); })
            .catch((e) => console.warn('Inkroot: fetchAuthorRatingsSummary failed', e));
        return () => { cancelled = true; };
    }, [reviewBookIds.join(',')]);
    // "Completed projects" for the Reputation formula, self only (see below) — held to a real
    // quality bar rather than just the "marked complete" checkbox: long enough to be a genuine
    // book AND at least REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT of its own achievements actually
    // unlocked. legacyBooks already carries both wordCount and achievementPct per finished
    // project, so this reuses that same real data rather than the raw, ungated stats.completedCount.
    const meaningfulCompletedCount = meaningfulCompletedCountFor(legacyBooks);
    // The public Reputation total shown on this Hall (see computeAuthorReputation). Completed
    // projects and guild contributions are only knowable for your OWN Hall — this device has no
    // way to see another author's private project list or their guild activity, so those two
    // sources honestly stay at 0 on anyone else's Hall, same as everywhere else in Inkroot that
    // only shows what's actually public. followCount is the real server-side total (see
    // followerCount above) rather than a binary "does this device follow them" signal, and
    // reviewCount/ratingCount (see reviewCounts above) are the real totals from the reviews table
    // — the diminishing-returns curve inside computeAuthorReputation is what keeps any single
    // large count from dominating the score, not an artificial cap on the count itself.
    const reputation = computeAuthorReputation({
        followCount: followerCount,
        publishedCount: isSelf ? myPublishedCount : qualityPublicBooksCount,
        completedCount: isSelf ? meaningfulCompletedCount : 0,
        guildContribution: isSelf ? (guildReputation || 0) : 0,
        reviewCount: reviewCounts.reviewCount,
        ratingCount: reviewCounts.ratingCount,
    });
    // Writer Rank — driven directly by Reputation (used to be a separate ladder derived from
    // Writer Level instead; see health-checks.jsx). One standing, not two.
    const rank = reputationTitleFor(reputation);
    if (showHall) {
        const lifetimeAchievements = stats ? stats.lifetimeAchievements : [];
        const unlockedInHall = lifetimeAchievements.filter((a) => a.unlocked).length;
        // A second, separate grid below the reward-token achievements above — real Naira payouts.
        // nairaAchievements (state, above) is null on anyone else's Hall or before the fetch
        // resolves; falls back here to the same locked-at-0/false shape every entry always had
        // (see the comment on NAIRA_ACHIEVEMENTS in health-checks.jsx) so this grid never flashes
        // an unrelated shape while loading.
        const displayedNairaAchievements = nairaAchievements || NAIRA_ACHIEVEMENTS.map((a) => ({ ...a, current: 0, unlocked: false }));
        const unlockedNaira = displayedNairaAchievements.filter((a) => a.unlocked).length;
        return React.createElement(React.Fragment, null,
            React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', color: '#EFE7D2', fontFamily: "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif", display: 'flex', justifyContent: 'center' } },
            React.createElement("div", { style: { width: '100%', maxWidth: 640, padding: '48px 24px 72px' } },
                React.createElement("button", { onClick: () => setShowHall(false), style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[13.5], cursor: 'pointer',
                        display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], padding: 0, marginBottom: 28,
                    } }, isSelf ? "\u2039 Profile" : "\u2039 " + (authorName || 'Author')),
                React.createElement("div", { style: { textAlign: 'center', marginBottom: 30 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "Hall of Legends"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 6 } }, "Lifetime achievements across every tale you've told \u2014 these never reset"),
                    stats && React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[8], marginTop: 14 } },
                        React.createElement(RankCrest, { rank: rank, size: 28 }),
                        React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[14], color: '#EFE7D2' } }, rank.name)),
                    stats && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C', marginTop: 8 } }, `${unlockedInHall} / ${lifetimeAchievements.length} unlocked`)),
                stats === null
                    ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[12.5], color: '#5C5C64', padding: '20px 0' } }, "Consulting the archives\u2026")
                    : React.createElement(React.Fragment, null,
                        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SPACE_SCALE[12] } }, lifetimeAchievements.map((a) => React.createElement(AchievementCard, { key: a.id, achievement: a }))),
                        React.createElement("div", { style: { marginTop: 40 } },
                            React.createElement(ArchiveSectionHeading, { icon: "\u20A6", label: "Naira Rewards" }),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', textAlign: 'center', marginTop: 6, marginBottom: 6, lineHeight: 1.5 } }, "Real Naira, paid out once each one is independently verified \u2014 never just from what this device reports"),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C', textAlign: 'center', marginBottom: 18 } }, `${unlockedNaira} / ${displayedNairaAchievements.length} unlocked`),
                            // Naira payouts are gated behind the Inkroot Official Badge (see
                            // grant_naira_achievement() in supabase/history/
                            // 94_migration_official_badge_and_checkins.sql) — progress above still
                            // shows real numbers either way, this just explains why a fully-earned
                            // achievement isn't paying out yet. officialBadge is null while loading
                            // or signed out, so this only renders once we actually know the answer.
                            officialBadge && !officialBadge.earned && React.createElement("div", { style: {
                                    fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', textAlign: 'center', marginBottom: 18,
                                    maxWidth: 420, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.6,
                                } },
                                "Requires the Inkroot Official Badge before any of these pay out. Still needed: ",
                                [
                                    !officialBadge.hasBook && "purchase or publish a book",
                                    !officialBadge.inGuild && "join a guild",
                                    !officialBadge.paidEvent && "enter a paid guild event",
                                    !officialBadge.weekOld && "an account at least a week old",
                                ].filter(Boolean).join(', '), "."),
                            React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SPACE_SCALE[12] } }, displayedNairaAchievements.map((a) => React.createElement(AchievementCard, { key: a.id, achievement: a }))))))));
    }
    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', color: '#EFE7D2', fontFamily: "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif", display: 'flex', justifyContent: 'center' } },
        React.createElement("div", { style: { width: '100%', maxWidth: 640, padding: '48px 24px 72px' } },
            React.createElement(UniversalBackButton, { compact: true, style: { marginBottom: 28 } }),
            React.createElement(Breadcrumbs, null),
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Author's Hall"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 6 } }, isSelf
                    ? "Your personal chamber \u2014 a record kept apart from any single tale"
                    : `${authorName || 'This writer'}'s public chamber \u2014 what every reader can see`)),
            isSelf && onOpenCreatorDashboard && React.createElement("button", { onClick: onOpenCreatorDashboard, style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[8], width: '100%', marginBottom: 22,
                    background: 'none', border: '1px solid #3A3020', color: '#C89B3C',
                    borderRadius: RADIUS_SCALE[10], padding: '11px 18px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                } }, "Open Creator Dashboard"),
            isSelf
                ? React.createElement(WriterIdentityCard, {
                    profile, fileInputRef, handleAvatarFile, avatarError, onSaveProfile, onRemoveAvatar: handleRemoveAvatar, joinDateLabel,
                    reputation, nameError, nameWarning, profileSyncNotice, verified: selfVerified, officialBadge, isModerator, onOpenModerationQueue,
                    isPlatformAdmin, onOpenInkrootEventsAdmin, onOpenManualWithdrawalsAdmin, onOpenManageAdmins, onOpenGuildEventJudging,
                })
                : React.createElement(PublicIdentityCard, {
                    authorName: (remoteProfile && remoteProfile.name) || authorName, authorId,
                    avatar: remoteProfile ? remoteProfile.avatar : null,
                    verified: remoteProfile ? remoteProfile.verified : false,
                    reputation, following: isFollowing, onToggleFollow: handleToggleFollow,
                }),
            isSelf && writerGuildName && React.createElement("div", { style: {
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], marginTop: -14, marginBottom: 30,
                    fontSize: TYPE_SCALE[12], color: '#A6A6AD',
                } }, "\u2666 ", writerGuildName),
            stats === null
                ? React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[12.5], color: '#5C5C64', padding: '20px 0' } }, "Consulting the archives\u2026")
                : React.createElement("div", { style: { marginTop: 12 } },
                    isSelf && React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "scroll", size: 20, style: { display: "inline-block" } }), label: "Lifetime Statistics" }),
                    isSelf && React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: SPACE_SCALE[10], marginTop: 18 } },
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "book", size: 15 }), label: "Projects Created", value: projects.length }),
                        React.createElement(LifetimeStatTile, { icon: "\u2713", label: "Projects Completed", value: stats.completedCount }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "scroll", size: 15 }), label: "Total Words Written", value: stats.totalWords }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "columns", size: 15 }), label: "Chapters Written", value: stats.chapters }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "users", size: 15 }), label: "Characters Created", value: stats.characters }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "library", size: 15 }), label: "World Bible Entries", value: stats.worldEntries }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "map", size: 15 }), label: "Maps Created", value: stats.maps }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "hourglass", size: 15 }), label: "Timeline Events", value: stats.timelineEvents }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "flame", size: 15 }), label: "Writing Days", value: stats.writingDayCount }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "target", size: 15 }), label: "Longest Streak", value: stats.longestStreak }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "trophy", size: 15 }), label: "Total Achievements", value: stats.totalAchievements }),
                        React.createElement(LifetimeStatTile, { icon: React.createElement(InkIcon, { name: "lock", size: 15 }), label: "Secret Achievements", value: stats.secretAchievementsFound })),
                    isSelf && React.createElement("div", { style: { marginTop: 30 } },
                        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "hourglass", size: 20, style: { display: "inline-block" } }), label: "Daily Check-In" }),
                        React.createElement("div", { style: { marginTop: 16, maxWidth: 340, marginLeft: 'auto', marginRight: 'auto' } },
                            React.createElement(CheckInCalendarCard, null))),
                    React.createElement("button", { onClick: () => setShowHall(true), style: {
                            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[8], width: '100%', marginTop: isSelf ? 22 : 0,
                            background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[10], padding: '14px 18px', fontSize: TYPE_SCALE[14], fontWeight: 600, cursor: 'pointer',
                            fontFamily: "'Fraunces', Georgia, serif",
                        } }, React.createElement(InkIcon, { name: "crown", size: 15, style: { marginRight: 4, verticalAlign: "-2px" } }), "Enter the Hall of Legends"),
                    isSelf && React.createElement("div", { style: { marginTop: 40 } },
                        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "archiveBox", size: 20, style: { display: "inline-block" } }), label: "Legacy Shelf" }),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', textAlign: 'center', marginTop: 6, marginBottom: 4 } }, "Every finished tale, kept on display \u2014 select a book to revisit its own Hall of Achievements"),
                        React.createElement(LegacyShelf, { books: legacyBooks || [], onOpenBook: onOpenProjectHall })),
                    !isSelf && React.createElement("div", { style: { marginTop: 40 } },
                        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } }), label: "Published Books" }),
                        publicBooks.length === 0
                            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center', marginTop: 10 } }, `${authorName || 'This writer'} hasn't published anything to the Grand Library yet.`)
                            : React.createElement("div", { className: "ink-grid-cards", style: { marginTop: 16 } },
                                publicBooks.map((book) => React.createElement(LibraryDiscoverCard, {
                                    key: book.id, book, isFavorite: false, onToggleFavorite: () => { },
                                    onRead: (id) => { recordBookReadStart(id, BOOK_VIEW_SOURCES.AUTHOR_PROFILE); onRead(id); },
                                    onPreview: () => openPublicBook(book.id, book.title), myRating: null,
                                })))),
                    !isSelf && selectedPublicBook && React.createElement(BookDetailModal, {
                        book: selectedPublicBook, isFavorite: false, onToggleFavorite: () => { }, myRating: null, onSetRating: () => { },
                        onReadFull: (id) => { recordBookReadStart(id, BOOK_VIEW_SOURCES.AUTHOR_PROFILE); nav.pop(); onRead(id); }, onClose: closePublicBook,
                    })))),
        followNotice && React.createElement(AlertDialog, { title: followNotice.title, message: followNotice.message, onClose: () => setFollowNotice(null) }));
}
