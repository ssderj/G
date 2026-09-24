import React, { useEffect, useRef } from 'react';
import { ArchiveDivider, ProgressBar } from '../shared-ui/ui-cards.jsx';
import { stripHtml, wordCount } from '../shared-utils/strip-html.jsx';
import { todayKey } from '../shared-utils/truncate.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { BookCover, worldCategoryMeta } from '../worldbuilding/book-cover.jsx';
import { ACHIEVEMENT_CATEGORIES, RARITY_META, RankCrest, computeAchievements, computeDailyDeltas, computeLifetimeAchievements, computeLongestStreak, computeStreak, computeWeeklyWritingDayCount, runHealthChecks } from './health-checks.jsx';
import { chapterLabel } from './project-schema-and-backups.jsx';
import { playAchievementSound } from './reading-and-sound-settings.jsx';
import { formatNaira } from '../lib/payments.js';


// Pools stats and achievements across every saved project into one lifetime picture for the
// Writer Profile. Takes full project objects (not the lightweight index) since it needs each
// project's chapters/characters/world/stats — callers load those from storage first.
export function aggregateWriterStats(fullProjects) {
    let totalWords = 0, chapters = 0, characters = 0, worldEntries = 0, maps = 0, timelineEvents = 0;
    let completedCount = 0, projectsWithTimeline = 0;
    const dayTotals = {};
    const categoriesFullyCompleted = new Set();
    let allAchievements = [];
    fullProjects.forEach((p) => {
        const words = p.chapters.reduce((s, c) => s + wordCount(c.text), 0);
        totalWords += words;
        chapters += p.chapters.length;
        characters += p.characters.length;
        worldEntries += p.world.length;
        maps += p.maps.length;
        timelineEvents += p.timeline.length;
        if (p.completed)
            completedCount++;
        if (p.timeline.length > 0)
            projectsWithTimeline++;
        const log = (p.stats && p.stats.log) || {};
        const deltas = computeDailyDeltas(log);
        Object.entries(deltas).forEach(([day, delta]) => {
            if (delta > 0)
                dayTotals[day] = (dayTotals[day] || 0) + delta;
        });
        const streak = computeStreak(log);
        const health = runHealthChecks(p);
        const projectAchievements = computeAchievements(p, { totalWords: words, streak, healthScore: health.score, totalHealthIssues: health.totalIssues });
        allAchievements = allAchievements.concat(projectAchievements);
        ACHIEVEMENT_CATEGORIES.forEach((cat) => {
            const items = projectAchievements.filter((a) => a.group === cat.key);
            if (items.length && items.every((a) => a.unlocked))
                categoriesFullyCompleted.add(cat.key);
        });
    });
    const writingDays = Object.keys(dayTotals);
    const longestStreak = computeLongestStreak(writingDays);
    const weeklyWritingDayCount = computeWeeklyWritingDayCount(dayTotals);
    const lifetimeAchievements = computeLifetimeAchievements({
        completedCount, totalWords, worldEntries, projectsWithTimeline, maps, characters, longestStreak,
        categoriesCompleted: categoriesFullyCompleted.size,
    });
    // Used to also spread a computeWriterProgress() result in here (totalXP/level/rank) —
    // removed along with Writer Level. Writer Rank is now Reputation-driven (see
    // reputationTitleFor in library/author-reputation.jsx) rather than anything this function
    // computes; achievements.xp is a reward-token value now, not leveling currency, so nothing
    // here needs to sum it.
    return {
        totalWords, chapters, characters, worldEntries, maps, timelineEvents, completedCount,
        writingDayCount: writingDays.length, longestStreak, weeklyWritingDayCount,
        totalAchievements: allAchievements.filter((a) => a.unlocked).length + lifetimeAchievements.filter((a) => a.unlocked).length,
        secretAchievementsFound: allAchievements.filter((a) => a.unlocked && a.secret).length,
        lifetimeAchievements,
    };
}


// A carved, medallion-style frame for one achievement's icon. Unlocked medals take the rarity's
// color and get a soft outer glow (a slow pulse for epic/legendary, so the rarest badges read as
// quietly prestigious rather than static). Locked medals render as a dim, grayscale silhouette —
// present enough to hint at the shape, not enough to give away much before it's earned.
export function AchievementMedal({ icon, rarity, unlocked, size = 56 }) {
    const meta = RARITY_META[rarity] || RARITY_META.common;
    const premium = unlocked && (rarity === 'epic' || rarity === 'legendary');
    return React.createElement("div", { className: premium ? 'medal-glow' : undefined, style: {
            width: size, height: size, borderRadius: '50%', flexShrink: 0, position: 'relative',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: unlocked
                ? `radial-gradient(circle at 34% 28%, ${meta.color}55, #17140F 72%)`
                : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
            border: `2px solid ${unlocked ? meta.color : '#3A362C'}`,
            boxShadow: unlocked
                ? `0 0 0 3px #100E0A, 0 0 0 4px ${meta.glow}, 0 3px 10px rgba(0,0,0,0.5), inset 0 2px 3px rgba(255,255,255,0.25), inset 0 -4px 7px rgba(0,0,0,0.45)`
                : `0 0 0 3px #100E0A, inset 0 2px 3px rgba(255,255,255,0.04), inset 0 -3px 6px rgba(0,0,0,0.5)`,
            filter: unlocked ? 'none' : 'grayscale(1)',
            opacity: unlocked ? 1 : 0.5,
            transition: 'opacity var(--ink-dur) var(--ink-ease), filter var(--ink-dur) var(--ink-ease)',
            '--medal-glow': meta.glow,
        } },
        React.createElement("span", { style: { fontSize: Math.round(size * 0.42) } }, icon),
        !unlocked && React.createElement("span", { style: {
                position: 'absolute', bottom: -2, right: -2, width: 20, height: 20, borderRadius: '50%',
                background: '#100E0A', border: '1px solid #3A362C', display: 'flex', alignItems: 'center', justifyContent: 'center',
            } }, React.createElement(InkIcon, { name: "lock", size: 10, color: "#8A8272" })));
}


export function RarityChip({ rarity }) {
    const meta = RARITY_META[rarity] || RARITY_META.common;
    return React.createElement("span", { style: {
            fontSize: TYPE_SCALE[10], fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase',
            color: meta.color, border: `1px solid ${meta.color}66`, borderRadius: RADIUS_SCALE[20], padding: '2px 8px',
        } }, meta.label);
}


export function AchievementCard({ achievement }) {
    const { id, icon, title, desc, current, target, unlocked, rarity, xp, nairaReward, secret } = achievement;
    const meta = RARITY_META[rarity] || RARITY_META.common;
    const isMystery = secret && !unlocked;
    // Naira-reward achievements (see NAIRA_ACHIEVEMENTS in health-checks.jsx) show the real payout
    // amount instead of the cosmetic reward-token text. Every one of them except nairaWelcome is
    // now server-verified and can genuinely be earned and paid out (see health-checks.jsx's own
    // comment on NAIRA_ACHIEVEMENTS for exactly which migration backs each one) — nairaWelcome
    // alone is still stuck honestly at 0/false, since one of its criteria (following Inkroot on
    // Instagram) has no real verification path yet. So only nairaWelcome gets the explanatory
    // "Not yet available" note; every other naira achievement that isn't unlocked behaves exactly
    // like a normal achievement — a progress bar toward the real target, same as below.
    const isNaira = nairaReward != null;
    const isUnverifiable = id === 'nairaWelcome';
    const rewardText = isNaira
        ? (isMystery ? '??? Naira reward' : formatNaira(nairaReward))
        : (isMystery ? '??? reward points' : `+${xp} reward points`);
    return React.createElement("div", { className: "achievement-card" + (unlocked ? ' unlocked' : ''), style: {
            background: unlocked ? 'linear-gradient(160deg, #221D14, #17140F)' : 'linear-gradient(160deg, #1B1B1F, #17171B)',
            border: `1px solid ${unlocked ? meta.color + '55' : '#2A2A30'}`,
            borderRadius: RADIUS_SCALE[12], padding: '16px 16px', display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start',
        } },
        React.createElement(AchievementMedal, { icon: isMystery ? '\u2753' : icon, rarity: rarity, unlocked: unlocked }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginBottom: 3 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: unlocked ? '#EFE7D2' : '#8A8A90' } }, isMystery ? 'Secret Achievement' : title),
                React.createElement(RarityChip, { rarity: rarity })),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', lineHeight: 1.5, fontStyle: isMystery ? 'italic' : 'normal' } }, isMystery ? 'Its nature is unknown until earned.' : desc),
            !unlocked && !secret && !isUnverifiable && target > 1 && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4], marginTop: 10 } },
                React.createElement(ProgressBar, { value: current, max: target, color: meta.color }),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, `${current.toLocaleString()} / ${target.toLocaleString()}`)),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 10 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: unlocked ? meta.color : '#5C5C64' } }, rewardText),
                unlocked && React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: meta.color, fontWeight: 600 } }, "Unlocked \u2713")),
            !unlocked && isNaira && isUnverifiable && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 6, lineHeight: 1.4 } }, "Not yet available")));
}


// One category's heading in the Achievements page: emblem + tracked title + a slim gold rule
// whose fill reflects how much of that category is unlocked, closed off by the usual fleuron.
export function AchievementCategoryHeading({ icon, label, unlocked, total }) {
    const pct = total > 0 ? Math.round((unlocked / total) * 100) : 0;
    return React.createElement("div", { style: { textAlign: 'center', marginBottom: 4 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[19], marginBottom: 6, opacity: 0.9 } }, icon),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], letterSpacing: '0.22em', textTransform: 'uppercase', color: '#EFE7D2', fontWeight: 600 } }, label),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C', marginTop: 4, letterSpacing: '0.04em' } }, `${unlocked} / ${total} \u00B7 ${pct}%`),
        React.createElement("div", { style: { maxWidth: 160, margin: '8px auto 0' } }, React.createElement(ProgressBar, { value: unlocked, max: total, color: '#C89B3C' })),
        React.createElement(ArchiveDivider, null));
}


// REMOVED — WriterLevelBanner, AchievementUnlockOverlay (the full-screen version of this),
// LevelUpOverlay, LevelUpMiniToast, RankPromotionOverlay, and RARITY_UNLOCK_FX (only ever used by
// the overlay just removed). This small corner toast is the only unlock notice left — it still
// tells the writer what they earned without a full-screen interrupt. See project-workspace.jsx
// for what replaced the old unlock-queue plumbing that used to also cue those overlays.
export function AchievementUnlockToast({ achievement, onView }) {
    const meta = RARITY_META[achievement.rarity] || RARITY_META.common;
    const particles = Array.from({ length: 12 }, (_, i) => i);
    // The toast fades into view at 15% of its 2000ms entrance (see .aunlock-toast-in), so the
    // sound is timed to land right as the medal actually becomes visible rather than on mount.
    useEffect(() => {
        const timer = setTimeout(() => playAchievementSound(achievement.rarity), 300);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [achievement.id]);
    return React.createElement("div", { className: "aunlock-toast-in", onClick: onView, style: {
            position: 'fixed', top: 22, left: '50%', transform: 'translateX(-50%)', zIndex: 3000,
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[14], padding: '14px 22px 14px 14px', borderRadius: RADIUS_SCALE[14],
            background: 'linear-gradient(160deg, #241F14, #17140F)', border: `1px solid ${meta.color}77`,
            boxShadow: `0 10px 30px rgba(0,0,0,0.55), 0 0 24px ${meta.glow}`,
            cursor: onView ? 'pointer' : 'default',
        } },
        React.createElement("div", { style: { position: 'relative', width: 56, height: 56, flexShrink: 0 } },
            particles.map((i) => React.createElement("span", { key: i, className: "gold-particle", style: { '--a': `${Math.round((360 / particles.length) * i)}deg`, animationDelay: `${i * 14}ms` } })),
            React.createElement(AchievementMedal, { icon: achievement.icon, rarity: achievement.rarity, unlocked: true, size: 56 })),
        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], letterSpacing: '0.14em', textTransform: 'uppercase', color: meta.color, fontWeight: 700 } }, "Achievement Unlocked"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2', marginTop: 2 } }, achievement.title),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: meta.color, marginTop: 2, fontWeight: 600 } }, achievement.nairaReward != null ? formatNaira(achievement.nairaReward) : `+${achievement.xp} reward points`)));
}


export function useDailyLog(project, ready, setProject) {
    const timer = useRef(null);
    useEffect(() => {
        if (!ready || !project)
            return;
        if (timer.current)
            clearTimeout(timer.current);
        timer.current = setTimeout(() => {
            const key = todayKey();
            const total = project.chapters.reduce((s, c) => s + wordCount(c.text), 0);
            setProject((p) => {
                if (!p)
                    return p;
                const log = (p.stats && p.stats.log) || {};
                if (log[key] === total)
                    return p;
                const next = structuredClone(p);
                if (!next.stats)
                    next.stats = { log: {} };
                next.stats.log[key] = total;
                return next;
            });
        }, 800);
        return () => clearTimeout(timer.current);
    }, [project, ready]);
}


export function searchAllEntities(query, characters, locations, world, glossary, timeline) {
    const q = (query || '').toLowerCase();
    const matches = (x, field) => (x[field] || '').toLowerCase().includes(q) || (x.tags || []).some((t) => t.toLowerCase().includes(q));
    const byField = (list, field, type) => list
        .filter((x) => matches(x, field))
        .map((x) => ({ id: x.id, name: x[field], type }));
    return [
        ...byField(characters, 'name', 'character'),
        ...byField(locations, 'name', 'location'),
        ...byField(world, 'topic', 'world'),
        ...byField(glossary, 'term', 'glossary'),
        ...byField(timeline || [], 'what', 'timeline'),
    ];
}


// Builds a short excerpt centered on the first match of `q` inside `text`, so a search result can
// show *why* it matched rather than just its title. Falls back to the start of the text if the
// match isn't found in this particular field (title already matched instead).
export function makeSnippet(text, q, radius) {
    if (!text)
        return '';
    const plain = text.replace(/\s+/g, ' ').trim();
    const idx = plain.toLowerCase().indexOf(q.toLowerCase());
    if (idx === -1)
        return plain.slice(0, radius * 2);
    const start = Math.max(0, idx - radius);
    const end = Math.min(plain.length, idx + q.length + radius);
    return (start > 0 ? '…' : '') + plain.slice(start, end) + (end < plain.length ? '…' : '');
}


// Searches the whole project — manuscript, characters, locations, world-bible entries (split into
// Organizations / Items / everything-else), notes, timeline, and glossary — and groups matches by
// category. Each group is an array of { id, title, snippet } ready to render and jump to.
export function globalSearch(project, query) {
    const q = (query || '').trim().toLowerCase();
    const empty = { manuscript: [], characters: [], locations: [], organizations: [], items: [], world: [], notes: [], timeline: [], glossary: [] };
    if (!q || !project)
        return empty;
    const hit = (...fields) => fields.filter(Boolean).join(' \u2014 ').toLowerCase().includes(q);
    const results = { ...empty };
    (project.chapters || []).forEach((c, idx) => {
        const plain = stripHtml(c.text);
        if (plain.toLowerCase().includes(q) || (c.title || '').toLowerCase().includes(q)) {
            results.manuscript.push({ id: c.id, title: chapterLabel(project.chapters, c.id), snippet: makeSnippet(plain, q, 40) });
        }
    });
    (project.characters || []).forEach((c) => {
        if (hit(c.name, c.alias, c.occupation, c.status, c.goals, c.personality, c.biography, c.notes, ...(c.tags || []))) {
            results.characters.push({ id: c.id, title: c.name || 'Unnamed', snippet: makeSnippet([c.biography, c.notes, c.goals, c.personality].filter(Boolean).join(' \u2014 '), q, 50) });
        }
    });
    (project.locations || []).forEach((l) => {
        if (hit(l.name, l.description)) {
            results.locations.push({ id: l.id, title: l.name || 'Unnamed', snippet: makeSnippet(l.description, q, 50) });
        }
    });
    (project.world || []).forEach((w) => {
        if (hit(w.topic, w.detail)) {
            const entry = { id: w.id, title: w.topic || 'Unnamed', snippet: makeSnippet(w.detail, q, 50) };
            if (w.category === 'organizations')
                results.organizations.push(entry);
            else if (w.category === 'artifacts')
                results.items.push(entry);
            else
                results.world.push({ ...entry, meta: worldCategoryMeta(w.category).label });
        }
    });
    (project.notes || []).forEach((n) => {
        if (hit(n.title, n.body)) {
            results.notes.push({ id: n.id, title: n.title || 'Untitled note', snippet: makeSnippet(n.body, q, 50) });
        }
    });
    (project.timeline || []).forEach((ev) => {
        if (hit(ev.when, ev.what)) {
            results.timeline.push({ id: ev.id, title: ev.what || 'Untitled event', snippet: ev.when || '' });
        }
    });
    (project.glossary || []).forEach((g) => {
        if (hit(g.term, g.definition)) {
            results.glossary.push({ id: g.id, title: g.term || 'Untitled term', snippet: makeSnippet(g.definition, q, 50) });
        }
    });
    return results;
}


export const SEARCH_GROUPS = [
    { key: 'manuscript', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), label: 'Manuscript' },
    { key: 'characters', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), label: 'Characters' },
    { key: 'locations', icon: React.createElement(InkIcon, { name: 'castle', size: 15 }), label: 'Locations' },
    { key: 'organizations', icon: React.createElement(InkIcon, { name: 'columns', size: 15 }), label: 'Organizations' },
    { key: 'items', icon: React.createElement(InkIcon, { name: 'archiveBox', size: 15 }), label: 'Items' },
    { key: 'world', icon: React.createElement(InkIcon, { name: 'globe', size: 15 }), label: 'World Bible' },
    { key: 'notes', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), label: 'Notes' },
    { key: 'timeline', icon: React.createElement(InkIcon, { name: 'hourglass', size: 15 }), label: 'Timeline' },
    { key: 'glossary', icon: React.createElement(InkIcon, { name: 'tag', size: 15 }), label: 'Glossary' },
];
