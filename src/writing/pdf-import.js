// ---------- PDF import ----------
// Extracts plain text from a PDF entirely on-device via pdfjs-dist (Mozilla's pdf.js) — no
// upload anywhere, same policy as the .txt import path in import-export.jsx. The extracted
// text is handed to the same chapter-splitting logic .txt import already uses (see
// splitIntoChapters in import-export.jsx), so a "Chapter 3" heading in a PDF is recognized
// exactly the same way it is in a .txt file.
//
// Cover detection (options.detectCover): rather than hunting for an embedded image XObject on
// page 1 — unreliable, since a cover's art is often several layered/masked objects rather than
// one clean image, and page 1 isn't even guaranteed to have one — this rasterizes page 1 itself
// via pdf.js's own page.render(), the same rendering path a PDF viewer uses. For the overwhelming
// majority of manuscript PDFs, page 1 IS the cover (full-bleed art or a title page), so this is
// far more robust than XObject-hunting for the same result: an image the caller can offer as
// project.cover.customImageUrl. Never applied automatically — see ImportWorkPanel, which shows
// it as a suggestion the writer can accept or dismiss.
import * as pdfjsLib from 'pdfjs-dist';
// Vite-friendly worker import — bundles the worker as its own asset and gives us a URL for it.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { MANIFEST_FILENAME, readBookManifest } from './book-manifest.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Reads the hidden book-structure attachment pdf-export.js embeds (see its own comment on
// pdfDoc.attach) via pdf.js's own file-attachment API. Returns null (never throws) when it's
// missing or unreadable — a PDF from outside Inkroot, or an older Inkroot export from before
// this existed, simply has none, and the caller falls back to text extraction.
async function readEmbeddedManifest(pdf) {
    try {
        const attachments = await pdf.getAttachments();
        const entry = attachments && attachments[MANIFEST_FILENAME];
        if (!entry || !entry.content) return null;
        const json = new TextDecoder('utf-8').decode(entry.content);
        return readBookManifest(JSON.parse(json));
    } catch {
        return null;
    }
}

// Reads a PDF (ArrayBuffer) and returns its text, page breaks joined with a blank line so
// paragraph-splitting downstream behaves the same as a .txt file with blank lines between them.
export async function extractPdfText(arrayBuffer) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        // items are individual text runs; join with spaces, keep pdf.js's own line breaks
        // (hasEOL) so wrapped lines don't get glued into one giant run.
        let pageText = '';
        content.items.forEach((item) => {
            pageText += item.str + (item.hasEOL ? '\n' : ' ');
        });
        pageTexts.push(pageText.trim());
    }
    return pageTexts.join('\n\n');
}

// Renders page 1 to an off-DOM canvas and returns it as a JPEG data URL, capped at maxWidth on
// the long edge (covers are shown small, so there's no reason to keep a huge raster around —
// matches the 1000px cap CoverPicker's own upload path already uses for the same reason).
// Returns null for a PDF with no pages (shouldn't happen for a real manuscript, but a corrupt or
// truncated upload is exactly the kind of thing this should degrade out of rather than throw on).
async function extractPdfPage1Image(pdf, maxWidth = 900) {
    if (pdf.numPages < 1)
        return null;
    const page = await pdf.getPage(1);
    const unscaled = page.getViewport({ scale: 1 });
    const scale = Math.min(2, maxWidth / unscaled.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.85);
}

// A TOC page (see pdf-export.js's layoutToc) reads as "Chapter 1", "Chapter 2 — Title", ... one
// right after another with no body text between them — which matchChapterHeading (see
// import-export.jsx) happily recognizes as real chapter headings, since it can't tell a table of
// contents entry from an actual chapter opener. Left alone, that turns one real chapter into two
// bogus chapters (the TOC-line entry, empty, plus the real one right after) for every chapter in
// the book. This drops any non-final chapter whose body is genuinely empty — a TOC entry always
// qualifies; an author's real chapter placeholder almost never does, and even then only the
// final one (still being drafted) is worth keeping around as visibly empty.
function dropTocArtifacts(chapters) {
    return chapters.filter((ch, i) => {
        const isLast = i === chapters.length - 1;
        const isEmpty = !ch.text || ch.text.replace(/<[^>]*>/g, '').trim() === '';
        return isLast || !isEmpty;
    });
}

// options: { detectCover } — when true, also rasterizes page 1 (see extractPdfPage1Image above)
// and returns it alongside the parsed chapters as coverDataUrl (null if rendering fails for any
// reason — a broken cover render should never block a text import that otherwise worked fine).
// Returned shape is always { title, author, coverDataUrl, chapters, fromManifest } — same shape
// every other import path (docx/epub) returns, so ImportWorkPanel never needs to special-case
// where a chapter came from.
export async function parsePdfManuscript(arrayBuffer, splitIntoChapters, options = {}) {
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer.slice(0) }).promise;

    // Prefer the exact, embedded book-structure manifest (see book-manifest.js and pdf-export.js's
    // pdfDoc.attach call) over re-deriving structure from rendered/extracted text — only a PDF
    // Inkroot itself exported has one, and when it's there it's authoritative: exact title,
    // author, cover, and every chapter's real HTML content, immune to the heading-regex/TOC
    // pitfalls the text-extraction path below has to work around.
    const manifest = await readEmbeddedManifest(pdf);
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

    const pageTexts = [];
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        let pageText = '';
        content.items.forEach((item) => { pageText += item.str + (item.hasEOL ? '\n' : ' '); });
        pageTexts.push(pageText.trim());
    }
    const chapters = dropTocArtifacts(splitIntoChapters(pageTexts.join('\n\n')));
    const coverDataUrl = options.detectCover ? await extractPdfPage1Image(pdf).catch(() => null) : null;
    return { title: '', author: '', coverDataUrl, chapters, fromManifest: false };
}

