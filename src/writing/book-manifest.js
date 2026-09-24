// ---------- Book Manifest ----------
// The single canonical description of "the structure of a book" that every export format and
// every importer agrees on: Cover, Book title, Author, and an ordered list of Chapters (number,
// title, content). This is deliberately a *small* subset of the full project schema (see
// project-schema-and-backups.jsx) — it excludes characters/world/timeline/notes/etc, all of
// which already round-trip perfectly via the project JSON backup in Settings. This manifest only
// exists to solve the narrower problem this module is about: reading/writing formats meant to
// leave Inkroot (.txt/.pdf/.docx/.epub) without losing the *book's own* shape in the process.
//
// Every export format embeds this manifest (buildBookManifest below) in whatever way that
// format allows a machine-readable, human-invisible payload to travel with the human-readable
// document — see the "embed" comments in pdf-export.js/epub-export.js. Every importer looks for
// that embedded manifest FIRST (readBookManifest below does the shape validation) and, when
// found, uses it directly instead of re-deriving structure by guessing at headings in extracted
// text. That's what makes a file Inkroot itself exported come back through import with its
// title, author, cover, and every chapter's exact number/title/content intact — the lossy
// heading-regex/spine-guessing path (see splitIntoChapters in import-export.jsx) only ever runs
// for files that didn't come from Inkroot, where no better source of truth exists.
export const MANIFEST_FILENAME = 'inkroot-manifest.json';
export const MANIFEST_VERSION = 1;

// Builds the manifest payload for a project. Chapters are emitted in their real, current order
// (already the single source of truth — see renumberChapters in project-schema-and-backups.jsx)
// rather than trusting `.number`, so a manifest can never disagree with what the editor/preview
// themselves would show for chapter order.
export function buildBookManifest(project) {
    const chapters = (project.chapters || [])
        .slice()
        .sort((a, b) => (a.number || 0) - (b.number || 0))
        .map((ch, i) => ({
            id: ch.id,
            number: typeof ch.number === 'number' ? ch.number : i + 1,
            title: ch.title || '',
            text: ch.text || '',
        }));
    return {
        manifestVersion: MANIFEST_VERSION,
        title: project.title || '',
        subtitle: project.subtitle || '',
        seriesName: project.seriesName || '',
        author: project.author || '',
        cover: project.cover ? {
            style: project.cover.style || null,
            accent: project.cover.accent || null,
            motif: project.cover.motif || null,
            // Embedded verbatim — could be a data: URL or an already-uploaded storage URL. What
            // an importer does with it (re-upload, use as-is, offer it as a suggestion) is that
            // importer's own call; the manifest just carries it through unchanged.
            customImageUrl: project.cover.customImageUrl || '',
        } : null,
        chapters,
    };
}

export function serializeBookManifest(project) {
    return JSON.stringify(buildBookManifest(project), null, 2);
}

// Validates and normalizes a parsed manifest object (already JSON.parse'd by the caller — each
// embedding format has its own way of getting bytes/text out, so parsing itself isn't shared
// here). Returns null for anything that isn't recognizably a book manifest, so every importer
// can treat "no usable manifest" and "not a manifest at all" the same way: fall back to that
// format's own structural/heading-based parsing.
export function readBookManifest(parsed) {
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.chapters))
        return null;
    const chapters = parsed.chapters
        .filter((c) => c && typeof c === 'object')
        .map((c, i) => ({
            title: typeof c.title === 'string' ? c.title : '',
            text: typeof c.text === 'string' ? c.text : '',
            number: typeof c.number === 'number' ? c.number : i + 1,
        }));
    if (chapters.length === 0)
        return null;
    return {
        title: typeof parsed.title === 'string' ? parsed.title : '',
        subtitle: typeof parsed.subtitle === 'string' ? parsed.subtitle : '',
        seriesName: typeof parsed.seriesName === 'string' ? parsed.seriesName : '',
        author: typeof parsed.author === 'string' ? parsed.author : '',
        cover: (parsed.cover && typeof parsed.cover === 'object') ? {
            style: parsed.cover.style || null,
            accent: parsed.cover.accent || null,
            motif: parsed.cover.motif || null,
            customImageUrl: typeof parsed.cover.customImageUrl === 'string' ? parsed.cover.customImageUrl : '',
        } : null,
        chapters,
        fromManifest: true,
    };
}
