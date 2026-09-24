// ---------- EPUB export ----------
// Builds a real, standards-valid .epub entirely on-device via JSZip (pure JS zip writer — no
// upload anywhere, same policy as every other export path in this file). An EPUB is just a zip
// with a required internal layout (OCF container.xml -> OPF package doc -> XHTML content docs),
// so unlike PDF/DOCX there's no "generator" package to reach for — this hand-builds that layout
// directly, the same way import-export.jsx hand-builds a chapter's stored HTML.
//
// Ships both an EPUB2 toc.ncx AND an EPUB3 nav.xhtml for the table of contents, since plenty of
// real-world readers (older e-readers, some desktop apps) still only understand the older NCX
// form — including both is the standard "works everywhere" approach, not redundant duplication.
//
// Each chapter's own stored HTML (already DOMPurify-sanitized on save — see
// sanitize-html.js) is re-sanitized here with that exact same allowlist before being embedded,
// same defense-in-depth reasoning sanitize-html.js already documents for the reader-mode render
// path: this is a second place chapter HTML reaches an audience beyond the author's own browser.
// The allowed tags (div/br/p/b/strong/i/em/u/s/span/a) are then reserialized as strict XHTML
// (self-closed void elements, real entity-escaped text) since EPUB content docs must be
// well-formed XML, unlike the loose HTML a browser's contentEditable produces.
import JSZip from 'jszip';
import { sanitizeChapterHtml } from '../shared-utils/sanitize-html.js';
import { stripHtml } from '../shared-utils/strip-html.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { MANIFEST_FILENAME, serializeBookManifest } from './book-manifest.js';

function escapeXml(s) {
    return String(s || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Turns the app's own sanitized-but-still-HTML5-loose chapter markup (unclosed <br>, bare &nbsp;,
// ...) into strict XHTML text content suitable for embedding inside an EPUB content document.
// Only ever sees output of sanitizeChapterHtml, so the allowed-tag surface here is exactly that
// function's allowlist — nothing else needs handling.
function toXhtmlFragment(sanitizedHtml) {
    return (sanitizedHtml || '<div><br/></div>')
        .replace(/<br\s*>/gi, '<br/>')
        .replace(/&nbsp;/gi, '&#160;');
}

function chapterFileName(i) {
    return `chapter-${String(i + 1).padStart(3, '0')}.xhtml`;
}

// Loads a cover image's raw bytes + mime type, whichever of the two shapes cover.customImageUrl
// can be (see project-schema-and-backups.jsx's emptyProject): a data: URL (not yet uploaded, or
// upload failed and the raw data URL was kept as a fallback — see import-export.jsx's
// handleImport) or an already-uploaded http(s) URL (see mediaStorage.js). Either way this reads
// it entirely on-device via fetch (data: URLs are fetchable too — the browser handles the
// decoding), matching the "no upload anywhere, everything on-device" policy this module's own
// header already states for every other step of building the EPUB. Returns null (never throws)
// on any failure, so a broken/unreachable cover image degrades the EPUB to "no embedded cover"
// instead of failing the whole export — same fallback policy pdf-export.js's own
// tryEmbedCoverImage already uses for the identical field.
async function loadCoverImageBytes(url) {
    if (!url) return null;
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        const mime = blob.type || 'image/jpeg';
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const ext = mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
        return { bytes, mime, ext };
    } catch {
        return null;
    }
}

const XHTML_HEAD = (title) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="styles.css"/></head>
<body>
`;
const XHTML_TAIL = `</body>
</html>`;

const STYLES_CSS = `body { font-family: Georgia, "Times New Roman", serif; line-height: 1.5; margin: 1.2em; }
h1 { font-size: 1.4em; margin-bottom: 1em; }
.inkroot-title-page { text-align: center; margin-top: 30%; }
.inkroot-title-page h1 { font-size: 2em; }
.inkroot-title-page p { font-style: italic; }
`;

// Returns a Blob (application/epub+zip) — same "hand back a Blob, caller decides how to save it"
// shape as buildManuscriptDocx, since JSZip's generateAsync already produces a browser Blob
// directly with no intermediate bytes step needed.
export async function buildManuscriptEpub(project) {
    const zip = new JSZip();

    // The mimetype file MUST be the first entry in the zip AND stored uncompressed — this is
    // what lets a reader recognize the file as EPUB before parsing any XML at all. JSZip stores
    // in insertion order, so this call has to come before every other zip.file() below.
    zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

    zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

    zip.file('OEBPS/styles.css', STYLES_CSS);

    const title = project.title || 'Untitled Manuscript';
    const author = project.author || 'Unknown';
    const bookId = `urn:uuid:${uuid()}`;
    const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

    // ---- Cover image (optional) ----
    // A real embedded cover — not just the title page's text — so the book's actual cover
    // survives export the same way its title/author/chapters do. Marked with properties=
    // "cover-image" on its manifest item AND a <meta name="cover"> pointer in metadata below:
    // real e-readers use either depending on EPUB2 vs EPUB3 support, so both are included, the
    // same "cover both forms" reasoning this file already applies to toc.ncx vs nav.xhtml.
    const coverImage = await loadCoverImageBytes(project.cover && project.cover.customImageUrl);
    if (coverImage) {
        zip.file(`OEBPS/cover.${coverImage.ext}`, coverImage.bytes);
    }

    // ---- Title page ----
    // linear="no" (set on its spine itemref below) marks this as supplementary front matter, not
    // a readable chapter in the book's own reading order — the same distinction nav.xhtml already
    // gets via its own `properties="nav"` exclusion from spineItems on import (see
    // epub-import.js). Without this, a round-tripped EPUB grew an extra bogus leading "chapter"
    // containing nothing but the title/author text, shifting every real chapter's number down by
    // one — this is what actually keeps that from happening.
    const titleXhtml = `${XHTML_HEAD(title)}<div class="inkroot-title-page">${coverImage ? `<img src="cover.${coverImage.ext}" alt="Cover" style="max-width:100%;margin-bottom:2em;"/>` : ''}<h1>${escapeXml(title)}</h1><p>by ${escapeXml(author)}</p></div>${XHTML_TAIL}`;
    zip.file('OEBPS/title.xhtml', titleXhtml);

    // ---- Book structure manifest ----
    // Not part of the spine (no itemref at all — it's never shown as a page), just an extra
    // manifest resource, the same way a font or an image the spine doesn't reference still gets
    // to be a manifest item. See book-manifest.js for why this exists and how import prefers it.
    zip.file(`OEBPS/${MANIFEST_FILENAME}`, serializeBookManifest(project));

    // ---- Chapters ----
    const chapters = (project.chapters || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));
    const chapterFiles = chapters.map((ch, i) => {
        const chTitle = ch.title || `Chapter ${ch.number || i + 1}`;
        const body = toXhtmlFragment(sanitizeChapterHtml(ch.text));
        const xhtml = `${XHTML_HEAD(chTitle)}<h1>${escapeXml(chTitle)}</h1>\n${body}${XHTML_TAIL}`;
        const fileName = chapterFileName(i);
        zip.file(`OEBPS/${fileName}`, xhtml);
        return { fileName, title: chTitle, id: `chap${i + 1}` };
    });

    // ---- content.opf (package document: metadata, manifest, spine) ----
    const manifestItems = [
        `<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>`,
        `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
        `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
        `<item id="css" href="styles.css" media-type="text/css"/>`,
        `<item id="inkroot-manifest" href="${MANIFEST_FILENAME}" media-type="application/json"/>`,
        ...(coverImage ? [`<item id="cover-img" href="cover.${coverImage.ext}" media-type="${coverImage.mime}" properties="cover-image"/>`] : []),
        ...chapterFiles.map((c) => `<item id="${c.id}" href="${c.fileName}" media-type="application/xhtml+xml"/>`),
    ].join('\n    ');
    // title's itemref is linear="no" — see the comment above titleXhtml: it's front matter, not
    // a chapter, and must NOT be picked up by a spine-order-based chapter import.
    const spineItems = [
        `<itemref idref="title" linear="no"/>`,
        ...chapterFiles.map((c) => `<itemref idref="${c.id}"/>`),
    ].join('\n    ');

    const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(bookId)}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:creator>${escapeXml(author)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
    ${coverImage ? `<meta name="cover" content="cover-img"/>` : ''}
  </metadata>
  <manifest>
    ${manifestItems}
  </manifest>
  <spine toc="ncx">
    ${spineItems}
  </spine>
</package>`;
    zip.file('OEBPS/content.opf', opf);

    // ---- nav.xhtml (EPUB3 table of contents) ----
    const navItems = chapterFiles.map((c) => `<li><a href="${c.fileName}">${escapeXml(c.title)}</a></li>`).join('\n        ');
    const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8"/><title>Table of Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>Contents</h1>
    <ol>
        <li><a href="title.xhtml">${escapeXml(title)}</a></li>
        ${navItems}
    </ol>
  </nav>
</body>
</html>`;
    zip.file('OEBPS/nav.xhtml', nav);

    // ---- toc.ncx (EPUB2-compatible table of contents, for older readers) ----
    const navPoints = chapterFiles.map((c, i) => `<navPoint id="navpoint-${i + 2}" playOrder="${i + 2}">
      <navLabel><text>${escapeXml(c.title)}</text></navLabel>
      <content src="${c.fileName}"/>
    </navPoint>`).join('\n    ');
    const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(bookId)}"/>
  </head>
  <docTitle><text>${escapeXml(title)}</text></docTitle>
  <navMap>
    <navPoint id="navpoint-1" playOrder="1">
      <navLabel><text>${escapeXml(title)}</text></navLabel>
      <content src="title.xhtml"/>
    </navPoint>
    ${navPoints}
  </navMap>
</ncx>`;
    zip.file('OEBPS/toc.ncx', ncx);

    return zip.generateAsync({ type: 'blob', mimeType: 'application/epub+zip' });
}

// Exposed for the "words survived the round trip" sanity check import-export.jsx's export panel
// can optionally surface — same stripHtml a plain-text/PDF export already relies on to know a
// chapter isn't empty.
export function epubChapterWordCount(project) {
    return (project.chapters || []).reduce((sum, ch) => sum + stripHtml(ch.text).trim().split(/\s+/).filter(Boolean).length, 0);
}
