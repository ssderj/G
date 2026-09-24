// ---------- EPUB import ----------
// Extracts chapters from an uploaded .epub entirely on-device via JSZip (same zip-reading
// library epub-export.js uses to write one) — no upload anywhere, same policy as every other
// import path in this file. Unlike .txt/PDF/.docx import, this does NOT go through
// splitIntoChapters' "Chapter 3" heading regex: an EPUB already segments its own reading order
// into separate content documents (its spine), which is a strictly more reliable chapter
// boundary than guessing from a heading line, so each spine document becomes exactly one
// imported chapter, in spine order, titled from its own first heading.
//
// SECURITY: an .epub is just a zip of arbitrary HTML the uploader controls — nothing here is
// assumed trustworthy. Every content document's body is run through the app's own
// sanitizeChapterHtml() (the same allowlist chapter-editor.jsx and the reader-mode render path
// both already rely on) before it's returned, so a crafted EPUB can't smuggle a <script>,
// event-handler attribute, or javascript: link into a project via import.
import JSZip from 'jszip';
import { sanitizeChapterHtml } from '../shared-utils/sanitize-html.js';
import { stripHtml } from '../shared-utils/strip-html.jsx';
import { MANIFEST_FILENAME, readBookManifest } from './book-manifest.js';

function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) {
        throw new Error('Malformed XML in EPUB');
    }
    return doc;
}

function dirOf(path) {
    const i = path.lastIndexOf('/');
    return i === -1 ? '' : path.slice(0, i + 1);
}

// Resolves a manifest href (which may itself contain ../ segments) against the OPF's own
// directory into a real path inside the zip.
function resolvePath(base, href) {
    const parts = (base + href).split('/');
    const out = [];
    parts.forEach((part) => {
        if (part === '' || part === '.') return;
        if (part === '..') out.pop();
        else out.push(part);
    });
    return out.join('/');
}

async function readZipText(zip, path) {
    const entry = zip.file(path) || zip.file(path.replace(/^\//, ''));
    if (!entry) throw new Error(`EPUB is missing ${path}`);
    return entry.async('text');
}

// Turns a zip entry's bytes into a data: URL — used for a fallback-detected cover image (the
// manifest-based path never needs this: it just carries cover.customImageUrl through verbatim,
// see book-manifest.js).
async function zipEntryToDataUrl(zip, path, mediaType) {
    const entry = zip.file(path) || zip.file(path.replace(/^\//, ''));
    if (!entry) return null;
    const base64 = await entry.async('base64');
    return `data:${mediaType || 'image/jpeg'};base64,${base64}`;
}

export async function parseEpubManuscript(arrayBuffer) {
    const zip = await JSZip.loadAsync(arrayBuffer);

    // 1. META-INF/container.xml points at the real package document (its path isn't fixed by
    // spec — "OEBPS/content.opf" is just the overwhelmingly common convention, including the
    // one epub-export.js itself uses).
    const containerXml = await readZipText(zip, 'META-INF/container.xml');
    const containerDoc = parseXml(containerXml);
    const rootfile = containerDoc.getElementsByTagName('rootfile')[0];
    const opfPath = rootfile && rootfile.getAttribute('full-path');
    if (!opfPath) throw new Error('EPUB container.xml has no rootfile');
    const opfDir = dirOf(opfPath);

    // 2. The package document: metadata, manifest (id -> href/media-type), and spine (reading
    // order).
    const opfXml = await readZipText(zip, opfPath);
    const opfDoc = parseXml(opfXml);
    const dcTitle = opfDoc.getElementsByTagName('dc:title')[0];
    const dcCreator = opfDoc.getElementsByTagName('dc:creator')[0];
    const opfTitle = dcTitle ? dcTitle.textContent.trim() : '';
    const opfAuthor = dcCreator ? dcCreator.textContent.trim() : '';

    const manifestById = {};
    Array.from(opfDoc.getElementsByTagName('item')).forEach((item) => {
        manifestById[item.getAttribute('id')] = {
            href: item.getAttribute('href'),
            mediaType: item.getAttribute('media-type') || '',
            properties: item.getAttribute('properties') || '',
        };
    });

    // 2a. Book structure manifest (see book-manifest.js): if this EPUB is one Inkroot itself
    // exported, it embedded an exact, lossless description of title/author/cover/chapters as an
    // unreferenced manifest resource — try that FIRST. It's not tied to any fixed id (manifest
    // items only need unique ids within their own file), so find it by filename instead.
    const manifestItem = Object.values(manifestById).find((item) => item.href && item.href.endsWith(MANIFEST_FILENAME));
    if (manifestItem) {
        try {
            const manifestPath = resolvePath(opfDir, manifestItem.href);
            const manifestJson = await readZipText(zip, manifestPath);
            const manifest = readBookManifest(JSON.parse(manifestJson));
            if (manifest) {
                return {
                    title: manifest.title,
                    subtitle: manifest.subtitle,
                    seriesName: manifest.seriesName,
                    author: manifest.author,
                    coverDataUrl: (manifest.cover && manifest.cover.customImageUrl) || null,
                    chapters: manifest.chapters,
                    fromManifest: true,
                };
            }
        } catch (err) {
            // A corrupted/edited-by-hand manifest shouldn't block import entirely — fall through
            // to the structural spine-based parse below, same as every other "best source of
            // truth failed, degrade gracefully" fallback in this app's import paths.
            console.warn('Inkroot: EPUB manifest present but unreadable, falling back to spine parsing.', err);
        }
    }

    // 2b. Cover image, detected the standard EPUB3 way (a manifest item with
    // properties="cover-image") with an EPUB2 fallback (<meta name="cover" content="...">) —
    // covers whichever an outside EPUB (not from Inkroot) used, same "cover both forms" policy
    // epub-export.js documents for its own toc.ncx/nav.xhtml.
    let coverDataUrl = null;
    const coverManifestItem = Object.values(manifestById).find((item) => item.properties.includes('cover-image'));
    let coverItem = coverManifestItem;
    if (!coverItem) {
        const coverMeta = Array.from(opfDoc.getElementsByTagName('meta')).find((m) => m.getAttribute('name') === 'cover');
        const coverId = coverMeta && coverMeta.getAttribute('content');
        coverItem = coverId ? manifestById[coverId] : null;
    }
    if (coverItem && /^image\//.test(coverItem.mediaType)) {
        coverDataUrl = await zipEntryToDataUrl(zip, resolvePath(opfDir, coverItem.href), coverItem.mediaType).catch(() => null);
    }

    // 3. Reading-order spine, EXCLUDING anything marked linear="no" (front matter like a title
    // page — see epub-export.js's own title itemref) and the nav document — an EPUB's spine is a
    // strictly more reliable chapter boundary than guessing from a heading line, so each
    // remaining spine document becomes exactly one imported chapter, in spine order.
    const spineItems = Array.from(opfDoc.getElementsByTagName('itemref'))
        .filter((ref) => ref.getAttribute('linear') !== 'no')
        .map((ref) => manifestById[ref.getAttribute('idref')])
        .filter((item) => item && /html|xml/i.test(item.mediaType) && !item.properties.includes('nav'));

    if (spineItems.length === 0) throw new Error('EPUB has no readable chapters in its spine');

    // 4. Each spine document becomes one chapter: first heading (or <title>) for the chapter
    // title, sanitized body HTML for its text — same {title, text} shape splitIntoChapters
    // produces for every other import path, so ImportWorkPanel's preview/handleImport needs no
    // special-casing for where a chapter came from.
    const chapters = [];
    for (let i = 0; i < spineItems.length; i++) {
        const path = resolvePath(opfDir, spineItems[i].href);
        const html = await readZipText(zip, path);
        const dom = new DOMParser().parseFromString(html, 'text/html');
        const heading = dom.querySelector('h1, h2, h3, h4, h5, h6');
        const titleTag = dom.querySelector('title');
        const rawTitle = (heading && heading.textContent.trim()) || (titleTag && titleTag.textContent.trim()) || '';
        const title = rawTitle && rawTitle.length <= 120 ? rawTitle : `Chapter ${chapters.length + 1}`;

        const bodyHtml = dom.body ? dom.body.innerHTML : html;
        const text = sanitizeChapterHtml(bodyHtml);

        // Skip genuinely blank spine entries (a separator/blank page some EPUB tools insert) —
        // never skip on length alone, only on truly no content, matching splitIntoChapters'
        // "never silently discard real content" policy for its own leading-content case.
        if (stripHtml(text).trim() === '') continue;

        chapters.push({ title, text });
    }
    if (chapters.length === 0) throw new Error('EPUB had no non-empty chapters to import');
    return { title: opfTitle, author: opfAuthor, coverDataUrl, chapters, fromManifest: false };
}
