import { PACK_CATEGORY_KEYS } from '../worldbuilding/book-cover.jsx';

// Builds the payload for published_book_content — the public reader-facing mirror written
// alongside every book publish (see lib/publish-flow.js's publishBookRemoteFlow and
// 70_migration_published_book_content.sql). Shaped exactly like what PublishedBookReader
// (author-reputation.jsx) expects, so openReaderBook can hand a fetched row straight to
// patchProjectDefaults with no further lookup. Chapters are trimmed to only the fields a reader
// ever sees — never the author's own project-only fields (notes, backups, etc.).
//
// `authorName` is passed in rather than read off the project itself — project.author is never
// actually populated by either publishing entry point (Author Studio's writerProfile.penName /
// writerProfile.name, looked up from the top-level writer identity, is the real source of truth;
// see ink-root.jsx and project-workspace.jsx's own callers).
//
// Pulled out into its own module (publishing reliability pass, fix-tracker item 27) so Author
// Studio (ink-root.jsx) and a project's own Publishing Hub (project-workspace.jsx) build this
// mirror identically instead of each keeping a private copy that can drift.
export function buildPublishedBookContent(proj, authorName) {
  return {
    title: proj.title,
    subtitle: proj.subtitle,
    seriesName: proj.seriesName,
    author: authorName || '',
    cover: proj.cover,
    storyFormat: proj.storyFormat || 'book',
    chapters: (proj.chapters || []).map((c) => ({ id: c.id, title: c.title, text: c.text })),
  };
}

// Builds the payload for published_pack_content (migration 85, fix-tracker item 20) — pulls FULL
// raw entries (every field the project's own World Bible editors already store), not the
// name/snippet teaser packSummaryForIndex's `categories` carries. Routes each PACK_CATEGORY_KEYS
// key to the same source array worldBibleEntries() (book-cover.jsx) itself reads from, so a
// pack's downloaded content matches exactly what the author selected in the Pack Builder.
export function buildPublishedPackContent(proj, pack) {
  const rawSource = (key) => {
    if (key === 'characters') return proj.characters || [];
    if (key === 'locations') return proj.locations || [];
    if (key === 'timeline') return proj.timeline || [];
    if (key === 'glossary') return proj.glossary || [];
    return (proj.world || []).filter((w) => w.category === key);
  };
  const categories = PACK_CATEGORY_KEYS.map((key) => {
    const ids = (pack.selection && pack.selection[key]) || [];
    const entries = rawSource(key).filter((e) => ids.includes(e.id));
    return { key, entries };
  }).filter((c) => c.entries.length > 0);
  return { title: pack.title, description: pack.description || '', categories };
}
