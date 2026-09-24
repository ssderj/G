import React from 'react';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { dateKey, truncate } from '../shared-utils/truncate.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { CHARACTER_ROLES, MENTION_TYPE_LABELS, NATIVE_WORLD_KEYS, worldCategoryMeta } from '../worldbuilding/book-cover.jsx';
import { fetchNairaAchievementProgress } from '../lib/naira-achievements.js';
import { addonHealthRules } from './addon-data.jsx';
import { chapterLabel } from './project-schema-and-backups.jsx';


export function chaptersContainingMentionType(chapters, id, type) {
    return chapters.filter((c) => {
        const div = document.createElement('div');
        div.innerHTML = c.text || '';
        return Array.from(div.querySelectorAll(`[data-mention-type="${type}"]`))
            .some((el) => el.getAttribute('data-mention-id') === id);
    }).map((c) => ({ id: c.id, title: c.title }));
}


// PERFORMANCE: every Story Health check below needs to know which @mentions exist across the
// whole manuscript, and each used to answer that independently by re-parsing every chapter's
// HTML from scratch (one `div.innerHTML = ...` + querySelectorAll per chapter, per check). With
// eight checks that meant the full manuscript got parsed eight separate times on every run —
// fine for a short story, painfully slow for a very large (e.g. ~1M word) manuscript. This
// builds that mention list ONCE per chapter and every check below reads from it instead of
// touching the DOM again. Nothing about what each check reports changes — only how many times
// the manuscript gets parsed to find out. Accepts an already-built index too (see
// runHealthChecks) so a single index can be shared across an entire check run.
export function buildManuscriptMentionIndex(chapters) {
    return chapters.map((c) => {
        const div = document.createElement('div');
        div.innerHTML = c.text || '';
        const mentions = Array.from(div.querySelectorAll('[data-mention-id]')).map((el) => ({
            type: el.getAttribute('data-mention-type') || '',
            id: el.getAttribute('data-mention-id') || '',
            text: el.textContent || 'Unnamed',
        }));
        return { chapterId: c.id, mentions };
    });
}


// ---------- Story Health: Broken Links ----------
// An @mention is "broken" once the character/location/world/glossary entry it points to has
// been deleted, but the mention span (with its old display text) is still sitting in the
// manuscript. Groups by chapter+type+id so a mention repeated several times in one chapter
// shows up as a single row with a count, instead of one row per occurrence.
export function findBrokenLinks(project, index) {
    const validIds = {
        character: new Set(project.characters.map((c) => c.id)),
        location: new Set(project.locations.map((l) => l.id)),
        world: new Set(project.world.map((w) => w.id)),
        glossary: new Set(project.glossary.map((g) => g.id)),
        timeline: new Set(project.timeline.map((t) => t.id)),
    };
    const grouped = new Map();
    (index || buildManuscriptMentionIndex(project.chapters)).forEach(({ chapterId, mentions }) => {
        mentions.forEach((m) => {
            const validSet = validIds[m.type];
            if (validSet && validSet.has(m.id))
                return; // still points to something real
            const key = chapterId + '|' + m.type + '|' + m.id;
            if (!grouped.has(key)) {
                grouped.set(key, { chapterId, type: m.type, id: m.id, text: m.text, count: 0 });
            }
            grouped.get(key).count += 1;
        });
    });
    return Array.from(grouped.values());
}


// Total @mention occurrences in the manuscript (valid + broken) — the population Broken Links
// checks against. Used as that check's contribution to the denominator of the overall score.
export function countMentionOccurrences(project, index) {
    return (index || buildManuscriptMentionIndex(project.chapters)).reduce((n, c) => n + c.mentions.length, 0);
}


// Wraps findBrokenLinks with the { issues, checkedCount } shape every check's run() returns.
export function checkBrokenLinks(project, index) {
    return { issues: findBrokenLinks(project, index), checkedCount: countMentionOccurrences(project, index) };
}


// Shared by every "Unused X" check below: walks the (possibly shared) mention index once,
// collecting the ids mentioned as the given type, then returns whichever entries in `list`
// never showed up that way.
function findUnusedByType(project, index, type, list) {
    const mentioned = new Set();
    (index || buildManuscriptMentionIndex(project.chapters)).forEach(({ mentions }) => {
        mentions.forEach((m) => { if (m.type === type) mentioned.add(m.id); });
    });
    return list.filter((item) => !mentioned.has(item.id));
}


// ---------- Story Health: Unused Characters ----------
// A character counts as "used" the moment they appear at least once as a linked @mention
// anywhere in the manuscript — plain-text occurrences of their name don't count, only the
// actual mention link. Everyone in the Characters database who never shows up that way gets
// flagged, so writers can spot characters they created but never actually wrote into a scene.
export function findUnusedCharacters(project, index) {
    return findUnusedByType(project, index, 'character', project.characters);
}


export function checkUnusedCharacters(project, index) {
    return { issues: findUnusedCharacters(project, index), checkedCount: project.characters.length };
}


// ---------- Story Health: Unused Locations ----------
// Same rule as Unused Characters: a location counts as used the moment it appears at least once
// as a linked mention anywhere in the manuscript. Everyone in the Locations database who never
// shows up that way gets flagged.
export function findUnusedLocations(project, index) {
    return findUnusedByType(project, index, 'location', project.locations);
}


export function checkUnusedLocations(project, index) {
    return { issues: findUnusedLocations(project, index), checkedCount: project.locations.length };
}


// ---------- Story Health: Unused Timeline Events ----------
// Same rule again: a timeline event counts as used only once it's been linked into the
// manuscript as an actual mention — being tied to a character via the Timeline tab's own
// "character" dropdown doesn't count, only a linked reference inside the prose does.
export function findUnusedTimelineEvents(project, index) {
    return findUnusedByType(project, index, 'timeline', project.timeline);
}


export function checkUnusedTimelineEvents(project, index) {
    return { issues: findUnusedTimelineEvents(project, index), checkedCount: project.timeline.length };
}


// ---------- Story Health: Unused World Bible Entries ----------
// Same rule as the others: a World Bible entry (organizations, items, magic, religions,
// creatures, houses, general lore — everything stored in project.world) counts as used only
// once it's linked into the manuscript as an actual mention.
export function findUnusedWorldEntries(project, index) {
    return findUnusedByType(project, index, 'world', project.world);
}


export function checkUnusedWorldEntries(project, index) {
    return { issues: findUnusedWorldEntries(project, index), checkedCount: project.world.length };
}


// ---------- Story Health: Unused Glossary Terms ----------
// Same rule again: a glossary term counts as used only once it's linked into the manuscript
// as an actual mention.
export function findUnusedGlossaryTerms(project, index) {
    return findUnusedByType(project, index, 'glossary', project.glossary);
}


export function checkUnusedGlossaryTerms(project, index) {
    return { issues: findUnusedGlossaryTerms(project, index), checkedCount: project.glossary.length };
}


// ---------- Story Health: Duplicate Entries ----------
// Metadata per database this check scans — `nameField` is what each entry's "name" actually
// lives under, `key` doubles as the project's array key (so p[category] filters the right list),
// and `label`/`singular` are just for display.
export const DUPLICATE_CATEGORY_META = {
    characters: { label: 'Characters', singular: 'character', nameField: 'name' },
    locations: { label: 'Locations', singular: 'location', nameField: 'name' },
    timeline: { label: 'Timeline Events', singular: 'timeline event', nameField: 'what' },
    world: { label: 'World Bible Entries', singular: 'world bible', nameField: 'topic' },
    glossary: { label: 'Glossary Terms', singular: 'glossary', nameField: 'term' },
};


// Groups one database's entries by name, normalized (lowercased, trimmed) so "Draven" and
// " draven " count as the same name. Any group with more than one entry is a set of duplicates.
// Untitled entries (empty name) are never compared against each other.
export function findDuplicateGroups(list, nameField) {
    const groups = new Map();
    list.forEach((item) => {
        const norm = (item[nameField] || '').trim().toLowerCase();
        if (!norm)
            return;
        if (!groups.has(norm))
            groups.set(norm, []);
        groups.get(norm).push(item);
    });
    return Array.from(groups.values()).filter((g) => g.length > 1);
}


export function checkDuplicateEntries(project) {
    const issues = [];
    Object.keys(DUPLICATE_CATEGORY_META).forEach((category) => {
        const meta = DUPLICATE_CATEGORY_META[category];
        findDuplicateGroups(project[category], meta.nameField).forEach((entries) => issues.push({ category, entries }));
    });
    const checkedCount = Object.keys(DUPLICATE_CATEGORY_META).reduce((sum, category) => sum + project[category].length, 0);
    return { issues, checkedCount };
}


// ---------- Story Health: Empty Chapters ----------
// A chapter counts as empty once its body has zero words after stripping HTML tags and
// whitespace — wordCount() already collapses "no text", "just spaces", and "just line breaks"
// to the same zero, and it only ever looks at the chapter's text, never its title.
export function findEmptyChapters(project) {
    return project.chapters.filter((c) => wordCount(c.text) === 0);
}


export function checkEmptyChapters(project) {
    return { issues: findEmptyChapters(project), checkedCount: project.chapters.length };
}


// Strips any inline `color` (and stray `background-color`) styling from a chapter's saved HTML.
// Manuscript text should only ever get its color from the active reading theme — but pasted
// content (from Word, Google Docs, another app) brings its own inline colors along, and those
// silently override the theme forever after. Stripping them at save time means it can't happen
// again, on top of the CSS override that already forces the theme color at render time.
export function stripInlineTextColor(html) {
    if (!html)
        return html;
    const div = document.createElement('div');
    div.innerHTML = html;
    div.querySelectorAll('[style]').forEach((el) => {
        el.style.removeProperty('color');
        el.style.removeProperty('background-color');
        if (!el.getAttribute('style'))
            el.removeAttribute('style');
    });
    return div.innerHTML;
}


// Un-links every broken mention matching (type, id) in one chapter's HTML, turning each back
// into plain text so the sentence still reads fine — it just stops pointing anywhere.
export function removeBrokenMentionsInChapter(text, type, id) {
    const div = document.createElement('div');
    div.innerHTML = text || '';
    Array.from(div.querySelectorAll(`[data-mention-type="${type}"][data-mention-id="${id}"]`)).forEach((el) => {
        el.replaceWith(document.createTextNode(el.textContent || ''));
    });
    return div.innerHTML;
}


// ---------- Story Health: addon-defined rules ----------
// Declarative rules an installed addon can contribute (see contains.healthRules in
// addon-studio.jsx). Deliberately NOT arbitrary code — a small, fixed vocabulary the existing
// mention index and project lists already support, same { issues, checkedCount } shape as every
// built-in check:
//   requiredField — flag entries of `appliesTo` whose `param` field is empty.
//   mentionCount  — flag entries of `appliesTo` mentioned fewer than `param` times in total.
// An unrecognized/incomplete rule (bad appliesTo, missing param, typo'd rule name) just reports
// nothing rather than throwing — a rule is user/addon-authored data, not code Inkroot controls,
// and a malformed one shouldn't be able to break the whole Story Health run.
const RULE_ENTITY_LISTS = { character: (p) => p.characters, location: (p) => p.locations, world: (p) => p.world, glossary: (p) => p.glossary, timeline: (p) => p.timeline };
const RULE_ENTITY_LABELS = { character: (e) => e.name, location: (e) => e.name, world: (e) => e.topic, glossary: (e) => e.term, timeline: (e) => e.what };

export function runAddonRule(rule, project, index) {
    const listFor = RULE_ENTITY_LISTS[rule.appliesTo];
    if (!listFor)
        return { issues: [], checkedCount: 0 };
    const list = listFor(project) || [];
    const labelOf = RULE_ENTITY_LABELS[rule.appliesTo] || ((e) => e.name);
    if (rule.rule === 'requiredField') {
        const field = (rule.param || '').trim();
        if (!field)
            return { issues: [], checkedCount: 0 };
        const fieldKey = field.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || field;
        const issues = list.filter((e) => !String(e[fieldKey] ?? e[field] ?? '').trim())
            .map((e) => ({ id: e.id, name: labelOf(e) || 'Unnamed', type: rule.appliesTo }));
        return { issues, checkedCount: list.length };
    }
    if (rule.rule === 'mentionCount') {
        const min = Math.max(0, Number(rule.param) || 1);
        const counts = new Map();
        (index || buildManuscriptMentionIndex(project.chapters)).forEach(({ mentions }) => {
            mentions.forEach((m) => { if (m.type === rule.appliesTo) counts.set(m.id, (counts.get(m.id) || 0) + 1); });
        });
        const issues = list.filter((e) => (counts.get(e.id) || 0) < min)
            .map((e) => ({ id: e.id, name: labelOf(e) || 'Unnamed', type: rule.appliesTo, count: counts.get(e.id) || 0 }));
        return { issues, checkedCount: list.length };
    }
    return { issues: [], checkedCount: 0 };
}


// Turns every declarative rule installed in this project into one HEALTH_CHECKS-shaped entry, so
// runHealthChecks below can treat addon checks exactly like built-in ones (same scoring, same
// { issues, checkedCount } contract). Namespaced by addon id so two addons can each ship a check
// with the same label without colliding.
export function addonHealthChecks(project) {
    return addonHealthRules(project).map((rule, i) => ({
        key: `addon:${rule.sourceAddonId}:${i}`,
        label: rule.label,
        icon: React.createElement(InkIcon, { name: 'puzzle', size: 15 }),
        run: (p, index) => runAddonRule(rule, p, index),
        emptyText: `Every ${rule.appliesTo} passes "${rule.label}" (added by ${rule.sourceAddonName}).`,
    }));
}


// ---------- Story Health: check registry ----------
// Every Story Health check is registered here as { key, label, icon, run(project), emptyText }.
// `run` returns { issues, checkedCount } — issues found, and how many things of that kind exist
// to check in the first place (e.g. total @mentions for Broken Links). It never knows about
// React or click handlers, so the exact same registry can power a lightweight score on the home
// screen (which only has the raw project data, no UI callbacks) and the full interactive page
// inside a project (which needs "go to chapter" / "fix" buttons). Adding a future check —
// Unused Characters, Unused Locations, Duplicate Entries, Empty Chapters, Timeline Problems —
// means adding one entry here (with its own checkedCount, e.g. total characters, total
// chapters) plus one small "turn raw results into issues" function; nothing about the page
// layout, the home-screen card, or any other check needs to change.
export const HEALTH_CHECKS = [
    { key: 'brokenLinks', label: 'Broken Links', icon: React.createElement(InkIcon, { name: 'link', size: 15 }), run: checkBrokenLinks, emptyText: "No broken links found. Every @mention in your manuscript points to a character, location, world entry, or glossary term that still exists." },
    { key: 'unusedCharacters', label: 'Unused Characters', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), run: checkUnusedCharacters, emptyText: "Every character you've created appears at least once as a linked mention in the manuscript." },
    { key: 'unusedLocations', label: 'Unused Locations', icon: React.createElement(InkIcon, { name: 'pin', size: 15 }), run: checkUnusedLocations, emptyText: "Every location you've created appears at least once as a linked mention in the manuscript." },
    { key: 'unusedTimelineEvents', label: 'Unused Timeline Events', icon: React.createElement(InkIcon, { name: 'hourglass', size: 15 }), run: checkUnusedTimelineEvents, emptyText: "Every timeline event you've created appears at least once as a linked mention in the manuscript." },
    { key: 'unusedWorldEntries', label: 'Unused World Bible Entries', icon: React.createElement(InkIcon, { name: 'globe', size: 15 }), run: checkUnusedWorldEntries, emptyText: "Every World Bible entry you've created appears at least once as a linked mention in the manuscript." },
    { key: 'unusedGlossaryTerms', label: 'Unused Glossary Terms', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), run: checkUnusedGlossaryTerms, emptyText: "Every glossary term you've created appears at least once as a linked mention in the manuscript." },
    { key: 'duplicateEntries', label: 'Duplicate Entries', icon: React.createElement(InkIcon, { name: 'restore', size: 15 }), run: checkDuplicateEntries, emptyText: "No duplicate names found across your characters, locations, timeline events, World Bible entries, or glossary terms." },
    { key: 'emptyChapters', label: 'Empty Chapters', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), run: checkEmptyChapters, emptyText: "No empty chapters. Every chapter you've created has some content in it." },
];


// Runs every registered check once and returns both the per-check raw results (for the
// interactive page) and one aggregate score, so the two can never disagree. The score is simply
// 1 − (total issues ÷ total things checked) across every check, as a percentage — a check that
// has nothing to check yet (checkedCount 0, e.g. no @mentions written yet) just doesn't
// contribute rather than counting as broken.
export function runHealthChecks(project) {
    let totalChecked = 0;
    let totalIssues = 0;
    // Built once and handed to every check (see buildManuscriptMentionIndex) so a full run
    // parses the manuscript a single time no matter how many mention-based checks exist.
    const index = buildManuscriptMentionIndex(project.chapters);
    const allChecks = [...HEALTH_CHECKS, ...addonHealthChecks(project)];
    const sections = allChecks.map((check) => {
        const result = check.run(project, index);
        totalChecked += result.checkedCount;
        totalIssues += result.issues.length;
        return { key: check.key, label: check.label, icon: check.icon, emptyText: check.emptyText, raw: result.issues };
    });
    const score = totalChecked === 0 ? 100 : Math.max(0, Math.min(100, Math.round(100 * (1 - totalIssues / totalChecked))));
    return { sections, score, totalIssues };
}


// Converts one check's raw results into the generic { id, title, subtitle, actions } shape the
// Story Health page renders. Only checks that need interactive buttons (jump to a chapter, fix
// something) need an entry here — a future read-only check can simply skip it and fall back to
// a bare title/subtitle with no actions.
export function buildHealthIssues(checkKey, rawResults, project, helpers) {
    if (checkKey === 'brokenLinks') {
        return rawResults.map((b) => ({
            id: `${b.chapterId}|${b.type}|${b.id}`,
            title: `\u201C${b.text}\u201D`,
            subtitle: `${MENTION_TYPE_LABELS[b.type] || 'Link'} no longer exists \u00B7 in ${chapterLabel(project.chapters, b.chapterId)}${b.count > 1 ? ` \u00B7 appears ${b.count} times` : ''}`,
            actions: [
                { key: 'go', label: 'Go to chapter', variant: 'default', onClick: () => helpers.jumpToChapter(b.chapterId) },
                { key: 'fix', label: 'Remove link', variant: 'danger', onClick: () => helpers.update((p) => {
                        const ch = p.chapters.find((c) => c.id === b.chapterId);
                        if (ch)
                            ch.text = removeBrokenMentionsInChapter(ch.text, b.type, b.id);
                    }) },
            ],
        }));
    }
    if (checkKey === 'unusedCharacters') {
        return rawResults.map((c) => ({
            id: c.id,
            title: c.name && c.name.trim() ? c.name.trim() : 'Unnamed',
            subtitle: 'Created but never used.',
            actions: [
                { key: 'go', label: 'Go to Character', variant: 'default', onClick: () => helpers.goToCharacter(c.id) },
                { key: 'delete', label: 'Delete', variant: 'danger', onClick: () => {
                        const label = c.name && c.name.trim() ? `"${c.name.trim()}"` : 'this character';
                        helpers.askConfirm(`Delete ${label}? Their profile, relationships, and linked life events will be permanently lost.`, () => {
                            helpers.update((p) => { p.characters = p.characters.filter((x) => x.id !== c.id); });
                        });
                    } },
            ],
        }));
    }
    if (checkKey === 'unusedLocations') {
        return rawResults.map((l) => ({
            id: l.id,
            title: l.name && l.name.trim() ? l.name.trim() : 'Unnamed',
            subtitle: 'Created but never used.',
            actions: [
                { key: 'go', label: 'Go to Location', variant: 'default', onClick: () => helpers.goToLocation(l.id) },
                { key: 'delete', label: 'Delete', variant: 'danger', onClick: () => {
                        const label = l.name && l.name.trim() ? `"${l.name.trim()}"` : 'this location';
                        helpers.askConfirm(`Delete ${label}? Its profile will be permanently lost.`, () => {
                            helpers.update((p) => {
                                p.locations = p.locations.filter((x) => x.id !== l.id);
                                p.locations.forEach((x) => { if (x.parentLocationId === l.id)
                                    x.parentLocationId = ''; });
                                p.locationConnections = p.locationConnections.filter((c) => c.fromId !== l.id && c.toId !== l.id);
                            });
                        });
                    } },
            ],
        }));
    }
    if (checkKey === 'unusedTimelineEvents') {
        return rawResults.map((ev) => ({
            id: ev.id,
            title: ev.what && ev.what.trim() ? ev.what.trim() : (ev.when && ev.when.trim() ? ev.when.trim() : 'Untitled event'),
            subtitle: 'Created but never used.',
            actions: [
                { key: 'go', label: 'Go to Event', variant: 'default', onClick: () => helpers.handleJump('timeline', ev.id) },
                { key: 'delete', label: 'Delete Event', variant: 'danger', onClick: () => {
                        const label = ev.what && ev.what.trim() ? `"${ev.what.trim()}"` : 'this event';
                        helpers.askConfirm(`Delete ${label}? This cannot be undone.`, () => {
                            helpers.update((p) => { p.timeline = p.timeline.filter((x) => x.id !== ev.id); });
                        });
                    } },
            ],
        }));
    }
    if (checkKey === 'unusedWorldEntries') {
        return rawResults.map((w) => ({
            id: w.id,
            title: w.topic && w.topic.trim() ? w.topic.trim() : 'Unnamed',
            subtitle: 'Created but never used.',
            actions: [
                { key: 'go', label: 'Go to Entry', variant: 'default', onClick: () => helpers.handleJump('world', w.id) },
                { key: 'delete', label: 'Delete', variant: 'danger', onClick: () => {
                        const label = w.topic && w.topic.trim() ? w.topic.trim() : 'this entry';
                        helpers.askConfirm(`Delete "${label}"? This cannot be undone.`, () => {
                            helpers.update((p) => { p.world = p.world.filter((x) => x.id !== w.id); });
                        });
                    } },
            ],
        }));
    }
    if (checkKey === 'unusedGlossaryTerms') {
        return rawResults.map((g) => ({
            id: g.id,
            title: g.term && g.term.trim() ? g.term.trim() : 'Unnamed',
            subtitle: 'Created but never used.',
            actions: [
                { key: 'go', label: 'Go to Term', variant: 'default', onClick: () => helpers.handleJump('glossary', g.id) },
                { key: 'delete', label: 'Delete', variant: 'danger', onClick: () => {
                        const label = g.term && g.term.trim() ? g.term.trim() : 'this term';
                        helpers.askConfirm(`Delete "${label}"? This cannot be undone.`, () => {
                            helpers.update((p) => { p.glossary = p.glossary.filter((x) => x.id !== g.id); });
                        });
                    } },
            ],
        }));
    }
    if (checkKey === 'duplicateEntries') {
        return rawResults.map((group) => {
            const meta = DUPLICATE_CATEGORY_META[group.category];
            const displayName = (group.entries[0][meta.nameField] || '').trim() || 'Untitled';
            return {
                id: `${group.category}|${displayName.toLowerCase()}`,
                title: displayName,
                subtitle: `${meta.label} \u00B7 Duplicate ${meta.singular} entries found.${group.entries.length > 2 ? ` \u00B7 ${group.entries.length} copies` : ''}`,
                actions: [
                    { key: 'view', label: group.entries.length === 2 ? 'View Both Entries' : 'View All Entries', variant: 'default', onClick: () => helpers.viewDuplicateGroup(group.category) },
                    { key: 'deleteOne', label: 'Delete One', variant: 'danger', onClick: () => {
                            const toDelete = group.entries[group.entries.length - 1];
                            helpers.askConfirm(`Delete one "${displayName}" entry? This cannot be undone.`, () => {
                                helpers.update((p) => { p[group.category] = p[group.category].filter((x) => x.id !== toDelete.id); });
                            });
                        } },
                ],
            };
        });
    }
    if (checkKey === 'emptyChapters') {
        return rawResults.map((c) => ({
            id: c.id,
            title: chapterLabel(project.chapters, c.id),
            subtitle: 'No content written yet.',
            actions: [
                { key: 'go', label: 'Go to Chapter', variant: 'default', onClick: () => helpers.jumpToChapter(c.id) },
            ],
        }));
    }
    if (checkKey.startsWith('addon:')) {
        return rawResults.map((r) => ({
            id: r.id,
            title: r.name || 'Unnamed',
            subtitle: r.count !== undefined ? `Mentioned ${r.count} time${r.count === 1 ? '' : 's'} \u2014 fewer than this check expects.` : 'Missing a field this check requires.',
            actions: [
                { key: 'go', label: 'Go to Entry', variant: 'default', onClick: () => helpers.handleJump(r.type, r.id) },
            ],
        }));
    }
    return rawResults.map((r, i) => ({ id: String(i), title: String(r), subtitle: '', actions: [] }));
}


// A big score number plus its "N issues" line — shared by the home-screen card and the top of
// the in-project Story Health page so the two always read the same way.
// Maps a score to a simple status label, so it updates automatically wherever the score is
// shown — no separate healthy/unhealthy logic to keep in sync elsewhere.
export function healthStatus(score) {
    if (score >= 90)
        return { dot: '🟢', label: 'Excellent' };
    if (score >= 70)
        return { dot: '🟡', label: 'Good' };
    if (score >= 50)
        return { dot: '🟠', label: 'Needs Attention' };
    return { dot: '🔴', label: 'Critical' };
}


// `compact` collapses the same score/status/issue-count/tapHint information (nothing is
// dropped) into a single condensed row instead of the full stacked, large-type layout — used
// by the home-screen card so Story Health reads as a secondary glanceable strip rather than a
// headline card, while the in-project Story Health page keeps the full prominent version.
export function HealthScoreSummary({ score, totalIssues, tapHint, compact }) {
    const status = healthStatus(score);
    const healthy = totalIssues === 0;
    if (compact) {
        // This compact strip has exactly one caller (Home's storyHealthCard, see home-screen.jsx)
        // and it sits directly beneath the warm gold "Continue Writing" card — the full,
        // non-compact layout below is the dedicated in-project Story Health page, which stays
        // exactly as it was (its 🟢🟡🟠🔴 dot and ⚠️ glyph are the right amount of alarm for a
        // page you visit specifically to review problems). Here, that same status.dot (whose
        // 🟡/🟠 are baked-in amber/orange pixels no CSS color can retint) and an unconditional
        // ⚠️ on any nonzero issue count meant even a project in great shape — 95%, "Excellent",
        // one trivial issue — showed a colored warning icon right under the page's one gold
        // highlight, reading as an error interrupting an otherwise warm screen. So this strip
        // computes its own severity instead of borrowing the full page's: score 70+ (Good or
        // better) stays in the same gold/muted-tan palette as the rest of Home regardless of
        // issue count, and only a score that's actually dropped into "Needs Attention" (50-69,
        // amber) or "Critical" (below 50, red) — the tiers the in-project page itself treats as
        // worth flagging — earns an amber/red accent and the ⚠️ glyph here too.
        const severity = (healthy || score >= 70) ? 'none' : score >= 50 ? 'attention' : 'critical';
        const accentColor = severity === 'critical' ? '#D98A8A' : severity === 'attention' ? '#E0A659' : '#C89B3C';
        const issueText = healthy
            ? 'No issues'
            : severity === 'none'
                ? `${totalIssues} issue${totalIssues === 1 ? '' : 's'} to review`
                : `⚠️ ${totalIssues} issue${totalIssues === 1 ? '' : 's'}`;
        return (React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15], fontWeight: 700, color: '#EFE7D2', fontFamily: "'Fraunces', Georgia, serif" } }, `${score}%`),
            React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[12], fontWeight: 600, color: '#9C9280' } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: accentColor } }, "\u25CF"),
                status.label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600, color: accentColor } }, issueText),
            tapHint && React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginLeft: 'auto' } }, tapHint)));
    }
    return (React.createElement("div", null,
        React.createElement("div", { style: { fontSize: TYPE_SCALE[28], fontWeight: 700, color: '#EFE7D2', fontFamily: "'Fraunces', Georgia, serif" } }, `${score}%`),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2', marginTop: 6 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[13] } }, status.dot),
            status.label),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, color: healthy ? '#7FA98A' : '#D98A8A', marginTop: 10 } }, healthy ? 'No issues found.' : `⚠️ ${totalIssues} Issue${totalIssues === 1 ? '' : 's'} Found`),
        tapHint && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 8 } }, tapHint)));
}


// One check's worth of the Story Health page: a header row (icon, label, count badge) and its
// list of issues, or an empty state. Every check renders through this same component, so the
// page never needs section-specific layout code.
export function HealthSection({ icon, label, issues, emptyText }) {
    return (React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 14 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[16] } }, icon),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600 } }, label),
            React.createElement("span", { style: {
                    fontSize: TYPE_SCALE[12], fontWeight: 600, borderRadius: RADIUS_SCALE[10], padding: '2px 9px',
                    color: issues.length ? '#D98A8A' : '#7FA98A', background: '#1F1F24',
                } }, issues.length)),
        issues.length === 0
            ? React.createElement(EmptyState, { text: emptyText || `No issues found.` })
            : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 640 } }, issues.map((issue) => (React.createElement("div", { key: issue.id, style: {
                    border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: '12px 14px',
                    display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], flexWrap: 'wrap',
                } },
                React.createElement("div", { style: { flex: '1 1 220px', minWidth: 0 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[14], color: '#EFE7D2', fontWeight: 600 } }, issue.title),
                    issue.subtitle && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginTop: 3 } }, issue.subtitle)),
                (issue.actions || []).map((a) => React.createElement("button", { key: a.key, onClick: a.onClick, style: {
                        background: 'none', border: a.variant === 'danger' ? '1px solid #5C2A2A' : '1px solid #2A2A30',
                        color: a.variant === 'danger' ? '#D98A8A' : '#A6A6AD', borderRadius: RADIUS_SCALE[6],
                        padding: '6px 10px', fontSize: TYPE_SCALE[12], cursor: 'pointer', whiteSpace: 'nowrap',
                    } }, a.label))))))));
}


export function buildEntityPreview(type, id, ctx) {
    const { characters, locations, world, glossary, chapters } = ctx;
    const appearsIn = chaptersContainingMentionType(chapters, id, type).length;
    const base = { type, id, appearsIn };
    if (type === 'character') {
        const c = characters.find((x) => x.id === id);
        if (!c)
            return null;
        const roleMeta = CHARACTER_ROLES.find((r) => r.key === c.role);
        const rows = [];
        if (c.occupation)
            rows.push({ label: 'Occupation', value: c.occupation });
        if (c.status)
            rows.push({ label: 'Status', value: c.status });
        else if (c.lifeStatus)
            rows.push({ label: 'Status', value: c.lifeStatus === 'alive' ? 'Alive' : c.lifeStatus === 'dead' ? 'Dead' : '' });
        return { ...base, name: c.name || 'Unnamed', badge: roleMeta ? roleMeta.label : 'Character', rows: rows.filter((r) => r.value), tags: c.tags || [], portraitUrl: c.portraitUrl || '' };
    }
    if (type === 'location') {
        const l = locations.find((x) => x.id === id);
        if (!l)
            return null;
        const rulingHouse = l.rulingHouseId ? (world.find((w) => w.id === l.rulingHouseId) || {}).topic : '';
        const occupyingFaction = l.occupyingFactionId ? (world.find((w) => w.id === l.occupyingFactionId) || {}).topic : '';
        const rows = [];
        if (rulingHouse)
            rows.push({ label: 'Ruling House', value: rulingHouse });
        if (occupyingFaction)
            rows.push({ label: 'Occupying Faction', value: occupyingFaction });
        if (l.previousOwner)
            rows.push({ label: 'Previous Owner', value: l.previousOwner });
        if (l.government)
            rows.push({ label: 'Government', value: l.government });
        if (l.region)
            rows.push({ label: 'Region', value: l.region });
        if (l.population)
            rows.push({ label: 'Population', value: l.population });
        return { ...base, name: l.name || 'Unnamed', badge: rulingHouse || occupyingFaction || l.government || 'Location', rows, tags: l.tags || [] };
    }
    if (type === 'world') {
        const w = world.find((x) => x.id === id);
        if (!w)
            return null;
        const meta = worldCategoryMeta(w.category);
        const rows = w.detail ? [{ label: 'Detail', value: truncate(w.detail, 90) }] : [];
        return { ...base, name: w.topic || 'Unnamed', badge: meta.label, rows, tags: [], portraitUrl: w.category === 'houses' ? (w.crestUrl || '') : '' };
    }
    if (type === 'glossary') {
        const g = glossary.find((x) => x.id === id);
        if (!g)
            return null;
        const rows = g.definition ? [{ label: 'Definition', value: truncate(g.definition, 90) }] : [];
        return { ...base, name: g.term || 'Unnamed', badge: 'Term', rows, tags: [] };
    }
    if (type === 'timeline') {
        const ev = (ctx.timeline || []).find((x) => x.id === id);
        if (!ev)
            return null;
        const rows = ev.when ? [{ label: 'When', value: ev.when }] : [];
        return { ...base, name: ev.what || 'Untitled event', badge: 'Timeline event', rows, tags: [] };
    }
    return null;
}


export function EntityPreviewCard({ cardRef, data, top, left, onOpen, readingMode, theme }) {
    // This card pops up over the manuscript when a linked mention is clicked, so in Reading Mode
    // it needs to follow the active reading theme just like everything else in the reader —
    // otherwise it stays a dark, un-themed island over a Light or Sepia page.
    const t = readingMode && theme;
    const cardBg = t ? t.panel : '#1D1D22';
    const cardBorder = t ? t.border : '#2A2A30';
    const textColor = t ? t.text : '#EFE7D2';
    const mutedColor = t ? t.muted : '#7A7A82';
    const rowValueColor = t ? t.text : '#D9D2BE';
    const accent = t ? t.link : '#C89B3C';
    const tagBg = t ? t.border : '#232328';
    const tagColor = t ? t.muted : '#A6A6AD';
    const portraitBg = t ? t.border : '#232328';
    return (React.createElement("div", { ref: cardRef, style: {
            position: 'fixed', top, left, background: cardBg, border: `1px solid ${cardBorder}`,
            borderRadius: RADIUS_SCALE[10], padding: '14px 16px', minWidth: 210, maxWidth: 270,
            boxShadow: '0 16px 32px rgba(0,0,0,0.5)', zIndex: 1200,
        } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 4 } },
            data.portraitUrl && (React.createElement("div", { style: { width: 34, height: 34, borderRadius: RADIUS_SCALE[8], overflow: 'hidden', flexShrink: 0, background: portraitBg } },
                React.createElement("img", { src: data.portraitUrl, style: { width: '100%', height: '100%', objectFit: 'cover' }, onError: (e) => { e.currentTarget.style.display = 'none'; } }))),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: textColor } }, data.name)),
        data.badge && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: accent, fontWeight: 600, marginTop: 2, marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' } }, data.badge),
        data.rows.map((r, i) => (React.createElement("div", { key: i, style: { marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: mutedColor } }, r.label),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: rowValueColor, marginTop: 1 } }, r.value)))),
        data.tags && data.tags.length > 0 && (React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[4], marginBottom: 10 } }, data.tags.map((tag, i) => (React.createElement("span", { key: i, style: { fontSize: TYPE_SCALE[10.5], color: tagColor, background: tagBg, borderRadius: RADIUS_SCALE[10], padding: '2px 7px' } }, tag))))),
        React.createElement("div", { style: { marginBottom: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: mutedColor } }, "Appears in"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: rowValueColor, marginTop: 1 } },
                data.appearsIn,
                " Chapter",
                data.appearsIn === 1 ? '' : 's')),
        React.createElement("button", { onClick: () => onOpen(data.type, data.id), style: {
                background: 'none', border: 'none', color: accent, fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', padding: 0,
            } }, "Open \u2192")));
}


export function computeDailyDeltas(log) {
    const dates = Object.keys(log).sort();
    const deltas = {};
    let prevVal = 0;
    dates.forEach((d) => {
        deltas[d] = log[d] - prevVal;
        prevVal = log[d];
    });
    return deltas;
}


export function computeStreak(log) {
    const deltas = computeDailyDeltas(log);
    let streak = 0;
    const cursor = new Date();
    if ((deltas[dateKey(cursor)] || 0) > 0)
        streak++;
    cursor.setDate(cursor.getDate() - 1);
    while ((deltas[dateKey(cursor)] || 0) > 0) {
        streak++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
}


// Longest run of consecutive calendar days in a set of "YYYY-MM-DD" strings — used for the
// Writer Profile's all-time longest streak, which (unlike the per-project current streak above)
// needs the single longest run anywhere in the writer's whole history, not just a live count.
export function computeLongestStreak(dayStrings) {
    if (!dayStrings.length)
        return 0;
    const sorted = [...new Set(dayStrings)].sort();
    let longest = 1, run = 1;
    for (let i = 1; i < sorted.length; i++) {
        const prev = new Date(sorted[i - 1] + 'T00:00:00');
        const cur = new Date(sorted[i] + 'T00:00:00');
        const diffDays = Math.round((cur - prev) / 86400000);
        run = diffDays === 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
    }
    return longest;
}


// Sums the word-count deltas for today plus the previous 6 days (a rolling 7-day window).
export function computeWeeklyTotal(log) {
    const deltas = computeDailyDeltas(log);
    const cursor = new Date();
    let total = 0;
    for (let i = 0; i < 7; i++) {
        total += deltas[dateKey(cursor)] || 0;
        cursor.setDate(cursor.getDate() - 1);
    }
    return total;
}


// How many of the last 7 calendar days (today plus the previous 6) had any words written at
// all, across every project combined — the day-level counterpart to computeWeeklyTotal's word
// count.
export function computeWeeklyWritingDayCount(dayTotals) {
    const cursor = new Date();
    let count = 0;
    for (let i = 0; i < 7; i++) {
        if ((dayTotals[dateKey(cursor)] || 0) > 0)
            count++;
        cursor.setDate(cursor.getDate() - 1);
    }
    return count;
}


// ---------- Achievements ----------
// Entirely derived from data the project already has (word counts, streaks, chapter/character/
// world-entry totals) — nothing new is written to the project's schema, so there's no migration
// to worry about and a badge simply unlocks the moment the underlying data crosses its target.
export const RARITY_META = {
    common: { label: 'Common', color: '#B08D57', glow: 'rgba(176,141,87,0.4)' },
    uncommon: { label: 'Uncommon', color: '#C7CCD6', glow: 'rgba(199,204,214,0.4)' },
    rare: { label: 'Rare', color: '#C89B3C', glow: 'rgba(200,155,60,0.5)' },
    epic: { label: 'Epic', color: '#A184D6', glow: 'rgba(161,132,214,0.5)' },
    legendary: { label: 'Legendary', color: '#E8C468', glow: 'rgba(232,196,104,0.75)' },
};


export const ACHIEVEMENT_CATEGORIES = [
    { key: 'Writing', icon: React.createElement(InkIcon, { name: 'scroll', size: 19 }), label: 'Writing' },
    { key: 'Worldbuilding', icon: React.createElement(InkIcon, { name: 'castle', size: 19 }), label: 'Worldbuilding' },
    { key: 'Lore', icon: React.createElement(InkIcon, { name: 'sparkle', size: 19 }), label: 'Lore' },
    { key: 'Mastery', icon: React.createElement(InkIcon, { name: 'crossedSwords', size: 19 }), label: 'Mastery' },
    { key: 'Special', icon: React.createElement(InkIcon, { name: 'trophy', size: 19 }), label: 'Special' },
];


export const ACHIEVEMENTS = [
    // Writing
    { id: 'firstWords', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), title: 'First Words', desc: 'Write your first words in the manuscript.', group: 'Writing', rarity: 'common', xp: 65, target: 1, current: (p, d) => d.totalWords },
    { id: 'words1k', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), title: '1,000 Words', desc: 'Reach 1,000 words written.', group: 'Writing', rarity: 'common', xp: 105, target: 1000, current: (p, d) => d.totalWords },
    { id: 'words10k', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), title: '10,000 Words', desc: 'Reach 10,000 words written.', group: 'Writing', rarity: 'uncommon', xp: 255, target: 10000, current: (p, d) => d.totalWords },
    { id: 'words50k', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), title: 'Novella Length', desc: 'Reach 50,000 words written.', group: 'Writing', rarity: 'rare', xp: 640, target: 50000, current: (p, d) => d.totalWords },
    { id: 'words100k', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), title: 'Novel Length', desc: 'Reach 100,000 words written.', group: 'Writing', rarity: 'epic', xp: 1275, target: 100000, current: (p, d) => d.totalWords },
    { id: 'chapters5', icon: React.createElement(InkIcon, { name: 'columns', size: 15 }), title: 'Five Chapters', desc: 'Have 5 chapters in your manuscript.', group: 'Writing', rarity: 'common', xp: 130, target: 5, current: (p) => p.chapters.length },
    { id: 'chapters10', icon: React.createElement(InkIcon, { name: 'columns', size: 15 }), title: 'Ten Chapters', desc: 'Have 10 chapters in your manuscript.', group: 'Writing', rarity: 'uncommon', xp: 255, target: 10, current: (p) => p.chapters.length },
    { id: 'streak3', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), title: '3-Day Streak', desc: 'Write on 3 consecutive days.', group: 'Writing', rarity: 'common', xp: 85, target: 3, current: (p, d) => d.streak },
    { id: 'streak7', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), title: '7-Day Streak', desc: 'Write on 7 consecutive days.', group: 'Writing', rarity: 'uncommon', xp: 210, target: 7, current: (p, d) => d.streak },
    { id: 'streak30', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), title: '30-Day Streak', desc: 'Write on 30 consecutive days.', group: 'Writing', rarity: 'rare', xp: 640, target: 30, current: (p, d) => d.streak },
    // Worldbuilding
    { id: 'firstCharacter', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), title: 'First Character', desc: 'Add your first character.', group: 'Worldbuilding', rarity: 'common', xp: 65, target: 1, current: (p) => p.characters.length },
    { id: 'fullCast', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), title: 'Full Cast', desc: 'Add 10 characters.', group: 'Worldbuilding', rarity: 'uncommon', xp: 190, target: 10, current: (p) => p.characters.length },
    { id: 'firstLocation', icon: React.createElement(InkIcon, { name: 'pin', size: 15 }), title: 'First Location', desc: 'Add your first location.', group: 'Worldbuilding', rarity: 'common', xp: 65, target: 1, current: (p) => p.locations.length },
    { id: 'cartographer', icon: React.createElement(InkIcon, { name: 'map', size: 15 }), title: 'Cartographer', desc: 'Create your first map.', group: 'Worldbuilding', rarity: 'uncommon', xp: 170, target: 1, current: (p) => p.maps.length },
    { id: 'timelineStarted', icon: React.createElement(InkIcon, { name: 'hourglass', size: 15 }), title: 'Timeline Started', desc: 'Add your first timeline event.', group: 'Worldbuilding', rarity: 'common', xp: 65, target: 1, current: (p) => p.timeline.length },
    { id: 'glossary5', icon: React.createElement(InkIcon, { name: 'tag', size: 15 }), title: 'Lexicon', desc: 'Add 5 glossary terms.', group: 'Worldbuilding', rarity: 'uncommon', xp: 170, target: 5, current: (p) => p.glossary.length },
    { id: 'notes5', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), title: 'Note Taker', desc: 'Jot down 5 notes.', group: 'Worldbuilding', rarity: 'common', xp: 105, target: 5, current: (p) => p.notes.length },
    // Lore
    { id: 'houseFounded', icon: React.createElement(InkIcon, { name: 'crown', size: 15 }), title: 'House Founded', desc: 'Add a House or Clan.', group: 'Lore', rarity: 'rare', xp: 340, target: 1, current: (p) => p.world.filter((w) => w.category === 'houses').length },
    { id: 'faction', icon: React.createElement(InkIcon, { name: 'shield', size: 15 }), title: 'Faction Leader', desc: 'Add an Organization.', group: 'Lore', rarity: 'rare', xp: 340, target: 1, current: (p) => p.world.filter((w) => w.category === 'organizations').length },
    { id: 'archmage', icon: React.createElement(InkIcon, { name: 'sparkle', size: 15 }), title: 'Archmage', desc: 'Define a system of Magic.', group: 'Lore', rarity: 'epic', xp: 510, target: 1, current: (p) => p.world.filter((w) => w.category === 'magic').length },
    { id: 'pantheon', icon: React.createElement(InkIcon, { name: 'candle', size: 15 }), title: 'Pantheon', desc: 'Add a Religion or deity.', group: 'Lore', rarity: 'epic', xp: 510, target: 1, current: (p) => p.world.filter((w) => w.category === 'religions').length },
    { id: 'relicHunter', icon: React.createElement(InkIcon, { name: 'archiveBox', size: 15 }), title: 'Relic Hunter', desc: 'Add an Artifact.', group: 'Lore', rarity: 'epic', xp: 510, target: 1, current: (p) => p.world.filter((w) => w.category === 'artifacts').length },
    // Mastery — bigger, cross-category milestones
    { id: 'worldBuilder', icon: React.createElement(InkIcon, { name: 'globe', size: 15 }), title: 'World Builder', desc: 'Fill your World Bible with 10 entries.', group: 'Mastery', rarity: 'rare', xp: 640, target: 10, current: (p) => p.world.length },
    { id: 'fullBible', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), title: 'Complete World Bible', desc: 'Add at least one House, Organization, Magic system, Religion, and Artifact.', group: 'Mastery', rarity: 'legendary', xp: 1490, target: 5, current: (p) => NATIVE_WORLD_KEYS.filter((k) => p.world.some((w) => w.category === k)).length },
    { id: 'storyteller', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), title: 'Storyteller', desc: 'Reach 50,000 words across 10 or more chapters.', group: 'Mastery', rarity: 'legendary', xp: 1275, target: 1, current: (p, d) => (d.totalWords >= 50000 && p.chapters.length >= 10) ? 1 : 0 },
    { id: 'chronicler', icon: React.createElement(InkIcon, { name: 'hourglass', size: 15 }), title: 'Chronicler', desc: 'Log 10 events on your timeline.', group: 'Mastery', rarity: 'rare', xp: 425, target: 10, current: (p) => p.timeline.length },
    { id: 'castOfThousands', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), title: 'Cast of Thousands', desc: 'Add 20 characters to your story.', group: 'Mastery', rarity: 'legendary', xp: 1060, target: 20, current: (p) => p.characters.length },
    // Special
    { id: 'firstLight', icon: React.createElement(InkIcon, { name: 'candle', size: 15 }), title: 'First Light', desc: 'Name your novel and claim authorship.', group: 'Special', rarity: 'common', xp: 85, target: 1, current: (p) => (p.title && p.title !== 'Untitled Novel' && p.author) ? 1 : 0 },
    { id: 'cleanSlate', icon: React.createElement(InkIcon, { name: 'sparkle', size: 15 }), title: 'Clean Slate', desc: 'Reach a perfect Story Health score with no open issues.', group: 'Special', rarity: 'epic', xp: 640, secret: true, target: 1, current: (p, d) => (d.healthScore === 100 && d.totalHealthIssues === 0) ? 1 : 0 },
];


export function computeAchievements(project, derived) {
    const base = ACHIEVEMENTS.map((a) => {
        const current = Math.max(0, Math.round(a.current(project, derived) || 0));
        return { ...a, current, unlocked: current >= a.target };
    });
    // The Completionist depends on every other achievement's state, so it's computed as a final
    // pass over the list above rather than living in the static array.
    const unlockedCount = base.filter((a) => a.unlocked).length;
    const completionist = {
        id: 'completionist', icon: React.createElement(InkIcon, { name: 'crown', size: 15 }), title: 'The Completionist', desc: 'Unlock every other achievement in the Archive.',
        group: 'Special', rarity: 'legendary', xp: 2125, secret: true, target: base.length, current: unlockedCount, unlocked: unlockedCount >= base.length,
    };
    return [...base, completionist];
}


// REMOVED — Writer Level/XP and the level-derived Writer Rank ladder (WRITER_LEVEL_MAX/
// _THRESHOLDS, writerLevelFloor/Span/ForXP, computeWriterProgress, WRITER_RANKS,
// writerRankForLevel). Writer Rank is now driven directly by Reputation instead — see
// reputationTitleFor / REPUTATION_TITLES in library/author-reputation.jsx, which already existed
// as a second, independent rank ladder and is now the only one. ACHIEVEMENTS above (and each
// achievement's `xp` field) are unchanged — that field is a reward-token value now, not leveling
// currency; nothing here ever summed it into a level.
//
// WRITER_RANKS is kept, unchanged, purely as flavor vocabulary for the Living Universe's simulated
// activity feed (see living-universe-screen.jsx / inbox-and-living-universe.jsx) — it's just a
// list of rank names/icons for generated flavor text there, not something any real writer's rank
// is computed from anymore.
export const WRITER_RANKS = [
    { tier: 1, name: 'Novice Scribe', icon: '\uD83E\uDEB6', color: '#8A7355' },
    { tier: 2, name: 'Village Storyteller', icon: '\uD83D\uDCD6', color: '#A8916A' },
    { tier: 3, name: 'Guild Author', icon: '\uD83D\uDD8B\uFE0F', color: '#B08D57' },
    { tier: 4, name: 'Master Storyteller', icon: '\uD83D\uDCDA', color: '#C7CCD6' },
    { tier: 5, name: 'Lore Keeper', icon: '\uD83D\uDDDD\uFE0F', color: '#C9BE8D' },
    { tier: 6, name: 'Chronicler', icon: '\u231B', color: '#C89B3C' },
    { tier: 7, name: 'Grand Archivist', icon: '\uD83D\uDCDC', color: '#D4A63A' },
    { tier: 8, name: 'Legend Weaver', icon: '\u2694\uFE0F', color: '#A184D6' },
    { tier: 9, name: 'Mythmaker', icon: '\u2728', color: '#7FB2C9' },
    { tier: 10, name: 'Inkroot Grandmaster', icon: '\uD83D\uDC51', color: '#E8C468' },
];


// A carved crest for a rank/title object shaped like { tier, color, icon } — used for both Writer
// Rank (see reputationTitleFor) and Guild Rank (see computeGuildRankTitle in guild-progression.jsx).
// Higher tiers get more rings and a soft glow, and
// the top rank (Inkroot Grandmaster) gets a slow-turning gold aura behind it — the "more
// elaborate badge and decorative crest" each rank unlocks. `forceGlow` overrides the tier-based
// glow decision. Both REPUTATION_TITLES and GUILD_REPUTATION_TITLES are 6-tier ladders, so the
// thresholds below are calibrated to that scale (grand aura on the top tier only).
export function RankCrest({ rank, size = 44, forceGlow }) {
    const ringCount = rank.tier >= 5 ? 3 : rank.tier >= 3 ? 2 : 1;
    const glow = forceGlow !== undefined ? forceGlow : rank.tier >= 4;
    const grand = rank.tier >= 6;
    const rings = [`0 0 0 3px #100E0A`];
    if (ringCount >= 2)
        rings.push(`0 0 0 5px ${rank.color}33`);
    if (ringCount >= 3)
        rings.push(`0 0 0 7px ${rank.color}1a`);
    rings.push('0 3px 10px rgba(0,0,0,0.5)', 'inset 0 2px 3px rgba(255,255,255,0.25)', 'inset 0 -4px 7px rgba(0,0,0,0.45)');
    return React.createElement("div", { style: { position: 'relative', width: size, height: size, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } },
        grand && React.createElement("div", { className: "rank-aura", style: {
                position: 'absolute', inset: -8, borderRadius: '50%',
                background: `conic-gradient(${rank.color}, transparent 30%, ${rank.color} 55%, transparent 85%, ${rank.color})`,
            } }),
        React.createElement("div", { className: glow ? 'medal-glow' : undefined, style: {
                position: 'relative', width: size, height: size, borderRadius: '50%',
                background: `radial-gradient(circle at 34% 28%, ${rank.color}55, #17140F 72%)`,
                border: `2px solid ${rank.color}`, boxShadow: rings.join(', '),
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                '--medal-glow': `${rank.color}77`,
            } }, React.createElement("span", { style: { fontSize: Math.round(size * 0.44) } }, rank.icon)));
}


// ---------- Hall of Legends (lifetime, cross-project achievements) ----------
// Unlike ACHIEVEMENTS above (evaluated per project), these are evaluated once against the pooled
// totals from every project combined — they never reset when a single manuscript is deleted or
// restarted. Same reward-token xp field as ACHIEVEMENTS, same caveat: not leveling currency.
export const LIFETIME_ACHIEVEMENTS = [
    { id: 'lifetimeWriter', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), title: 'Lifetime Writer', desc: 'Complete 5 novels.', rarity: 'legendary', xp: 2125, target: 5, current: (d) => d.completedCount },
    { id: 'millionWords', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), title: 'Million Words', desc: 'Write one million words.', rarity: 'legendary', xp: 2550, target: 1000000, current: (d) => d.totalWords },
    { id: 'masterWorldbuilder', icon: React.createElement(InkIcon, { name: 'globe', size: 15 }), title: 'Master Worldbuilder', desc: 'Create 500 World Bible entries.', rarity: 'legendary', xp: 1910, target: 500, current: (d) => d.worldEntries },
    { id: 'legendMaker', icon: React.createElement(InkIcon, { name: 'hourglass', size: 15 }), title: 'Legend Maker', desc: 'Complete 20 timelines.', rarity: 'epic', xp: 1490, target: 20, current: (d) => d.projectsWithTimeline },
    { id: 'cartographerLifetime', icon: React.createElement(InkIcon, { name: 'map', size: 15 }), title: 'Cartographer', desc: 'Create 100 maps.', rarity: 'epic', xp: 1490, target: 100, current: (d) => d.maps },
    { id: 'characterMaster', icon: React.createElement(InkIcon, { name: 'users', size: 15 }), title: 'Character Master', desc: 'Create 500 characters.', rarity: 'epic', xp: 1700, target: 500, current: (d) => d.characters },
    { id: 'ironQuill', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), title: 'Iron Quill', desc: 'Maintain a 100-day writing streak.', rarity: 'legendary', xp: 1910, target: 100, current: (d) => d.longestStreak },
    { id: 'archivist', icon: React.createElement(InkIcon, { name: 'crown', size: 15 }), title: 'Archivist', desc: 'Fully complete every achievement category in at least one project.', rarity: 'legendary', xp: 2975, target: 5, current: (d) => d.categoriesCompleted },
];


export function computeLifetimeAchievements(derived) {
    return LIFETIME_ACHIEVEMENTS.map((a) => {
        const current = Math.max(0, Math.round(a.current(derived) || 0));
        return { ...a, current, unlocked: current >= a.target };
    });
}


// ---------- Naira Achievement Rewards ----------
// A second, separate reward tier alongside the reward-points achievements above: each of these
// pays out real Naira (see formatNaira / checkoutBook in src/lib/payments.js) instead of a
// cosmetic reward-token number, so they need a materially higher bar before anything is marked
// "earned." None of it is trustworthy coming from this device's own local computation — a client
// can edit its own local project JSON or localStorage, and Naira is real money.
//
// Tier 1 — nairaFirstPurchase/nairaBookCollector/nairaGrandCollector (buyer purchase counts),
// nairaRookieMerchant/nairaHustler/nairaSeniorMan (author sale counts), and
// nairaFirstPublication (a real, sufficiently-long published_books/guild_published_books row) —
// are server-verified. See supabase/history/52_migration_naira_achievement_grants.sql.
//
// Tier 2 — nairaDedicatedWriter/nairaMasterWriter/nairaFirstBook (real synced manuscript content,
// derived word count, day-capped credit ledger — closes both "is the number real" and "can real
// content still be gamed by pasting a finished draft in one sync") and nairaReader/nairaLoyal
// (server-throttled reading heartbeats + a streak over the union of active writing/reading days)
// are also server-verified now. See
// supabase/history/53_migration_naira_writing_and_reading_signals.sql — including the product
// decision made there for nairaFirstBook (redefined around the same day-capped word signal as
// the other two, since its only local candidate, project.completed, is a one-tap boolean with no
// real signal behind it).
//
// ../lib/naira-achievements.js: computeNairaAchievements() below calls a read-only RPC
// (naira_achievement_progress) that checks the real rows itself and is also the moment an
// eligible achievement actually gets granted server-side — there's no separate "claim" step in
// this UI.
//
// Still locked, still honestly at 0/false: nairaWelcome ("complete your profile") now has 5 of
// its 6 agreed criteria for real (pen name, avatar, motto, guild membership, 3+ follows, a paid
// guild-event entry — see supabase/history/54_migration_naira_welcome_and_profile_motto.sql,
// which also finally syncs motto to the server at all, closing a gap that existed independent of
// this achievement). The 6th, following Inkroot's official Instagram account, has no real
// verification path yet — Instagram's public API doesn't expose "does user X follow account Y"
// to third parties without a real OAuth + Business-account integration — so nairaWelcome is kept
// deliberately unwired from the payout path rather than granted on 5 of 6 criteria while quietly
// skipping the 6th. computeNairaAchievements() leaves it exactly as it was — current: 0,
// unlocked: false — until that's resolved.
export const NAIRA_ACHIEVEMENTS = [
    { id: 'nairaWelcome', icon: React.createElement(InkIcon, { name: 'gift', size: 15 }), title: 'Welcome to Inkroot', desc: 'Complete your profile.', rarity: 'common', nairaReward: 500, target: 1 },
    { id: 'nairaDedicatedWriter', icon: React.createElement(InkIcon, { name: 'scroll', size: 15 }), title: 'Dedicated Writer', desc: 'Write 50,000 words.', rarity: 'common', nairaReward: 500, target: 50000 },
    { id: 'nairaMasterWriter', icon: React.createElement(InkIcon, { name: 'library', size: 15 }), title: 'Master Writer', desc: 'Write 100,000 words.', rarity: 'uncommon', nairaReward: 1000, target: 100000 },
    { id: 'nairaFirstBook', icon: React.createElement(InkIcon, { name: 'book', size: 15 }), title: 'First Book', desc: 'Complete your first manuscript.', rarity: 'common', nairaReward: 500, target: 1 },
    { id: 'nairaFirstPublication', icon: React.createElement(InkIcon, { name: 'sealedLetter', size: 15 }), title: 'First Publication', desc: 'Publish your first book of at least 30,000 words.', rarity: 'uncommon', nairaReward: 1000, target: 1 },
    { id: 'nairaReader', icon: React.createElement(InkIcon, { name: 'candle', size: 15 }), title: 'Reader', desc: 'Read for 5 verified hours.', rarity: 'common', nairaReward: 500, target: 5 },
    { id: 'nairaLoyal', icon: React.createElement(InkIcon, { name: 'flame', size: 15 }), title: 'Loyal Reader or Writer', desc: 'Maintain a 7-day active reading or writing streak.', rarity: 'uncommon', nairaReward: 1000, target: 7 },
    { id: 'nairaFirstPurchase', icon: React.createElement(InkIcon, { name: 'cart', size: 15 }), title: 'First Purchase', desc: 'Purchase your first book.', rarity: 'common', nairaReward: 100, target: 1 },
    { id: 'nairaBookCollector', icon: React.createElement(InkIcon, { name: 'archiveBox', size: 15 }), title: 'Book Collector', desc: 'Purchase 50 books.', rarity: 'rare', nairaReward: 5000, target: 50 },
    { id: 'nairaGrandCollector', icon: React.createElement(InkIcon, { name: 'archiveBox', size: 15 }), title: 'Grand Collector', desc: 'Purchase 100 books.', rarity: 'epic', nairaReward: 10000, target: 100 },
    { id: 'nairaRookieMerchant', icon: React.createElement(InkIcon, { name: 'coin', size: 15 }), title: 'Rookie Merchant', desc: 'Make 10 sales.', rarity: 'uncommon', nairaReward: 1000, target: 10 },
    { id: 'nairaHustler', icon: React.createElement(InkIcon, { name: 'moneybag', size: 15 }), title: 'Hustler', desc: 'Make 50 sales.', rarity: 'rare', nairaReward: 5000, target: 50 },
    { id: 'nairaSeniorMan', icon: React.createElement(InkIcon, { name: 'crown', size: 15 }), title: 'Senior Man', desc: 'Make 100 sales.', rarity: 'legendary', nairaReward: 15000, target: 100 },
];


// Now async — see the comment on NAIRA_ACHIEVEMENTS above. Fetches real, server-verified
// progress for every id except nairaWelcome and merges it onto each definition; nairaWelcome
// falls back to the same locked-at-0 shape this function always returned, as does everything
// else when signed out/offline (fetchNairaAchievementProgress returns null in both cases).
// Shaped the same way computeLifetimeAchievements()'s result is (current/unlocked spread onto
// each def), so callers only need to await this now, not restructure how the result is consumed.
export async function computeNairaAchievements() {
    const progress = await fetchNairaAchievementProgress();
    return NAIRA_ACHIEVEMENTS.map((a) => {
        const real = progress && progress.get(a.id);
        return { ...a, current: real ? real.current : 0, unlocked: real ? real.unlocked : false };
    });
}
