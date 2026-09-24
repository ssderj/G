// ---------- PDF export ----------
// Produces a real paginated, professionally laid-out PDF via pdf-lib (pure JS, no native deps,
// runs entirely on-device — same "no upload anywhere" policy as every other export/import path
// in this app). Structure: Cover -> Title page -> Table of Contents -> Chapter 1 -> Chapter 2 ->
// ... each chapter always starting on its own fresh page, with consistent margins, typography,
// paragraph indenting, running page numbers, and orphan/widow-aware pagination.
//
// FONT: pdf-lib's built-in standard fonts (Times Roman etc.) can only encode WinAnsi
// (~Latin-1 + a few Windows-1252 extras) and throw the moment you measure/draw anything outside
// that — which used to mean any emoji or non-Latin character anywhere in a project made PDF
// export fail outright (see git history / bug report). We embed a real font — DejaVu Serif —
// via @pdf-lib/fontkit, which covers all of Latin (incl. Vietnamese), Greek, and Cyrillic, so
// the vast majority of real manuscripts need no fallback at all.
// Bundled at src/writing/fonts/DejaVuSerif(.ttf|-Bold.ttf) — Bitstream Vera license, freely
// redistributable (see license text embedded in the font files' own metadata).
// NOT covered: CJK (Chinese/Japanese/Korean) and emoji. Fonts with that coverage run
// 15-25MB+ *per weight* (vs. ~370KB here) — bundling one would balloon the app's download size
// for every user to support a minority case. If CJK manuscripts turn out to be common, the right
// fix is a second, lazily-loaded font used only when a project actually contains CJK text, not
// pulling it into the main bundle. Until then, those characters fall back to "?" (see
// sanitizeForFont below) exactly like any other truly unsupported character, so export still
// always succeeds — it just won't render glyphs we have no font for.
import { PDFDocument, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { stripHtml } from '../shared-utils/strip-html.jsx';
import regularFontUrl from './fonts/DejaVuSerif.ttf?url';
import boldFontUrl from './fonts/DejaVuSerif-Bold.ttf?url';
import { MANIFEST_FILENAME, serializeBookManifest } from './book-manifest.js';

// ---------- Page geometry & typography ----------
// One shared set of constants drives every page (cover excepted, which is purely decorative) so
// margins, type sizes, and spacing stay identical chapter to chapter — the "consistent
// typography/margins/spacing" part of the brief.
const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 72; // 1in on every side
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const CONTENT_TOP = PAGE_HEIGHT - MARGIN;
const CONTENT_BOTTOM = MARGIN; // no body line's baseline is ever drawn below this
const FOOTER_Y = 40; // page-number baseline, safely inside the bottom margin

const BODY_SIZE = 11.5;
const LINE_HEIGHT = 17;
const PARA_INDENT = 18; // first-line indent for every paragraph after a chapter's first

const TITLE_SIZE = 30;
const SUBTITLE_SIZE = 15;
const AUTHOR_SIZE = 13;

const CHAPTER_DROP = 108; // whitespace from the top margin down to the heading block
const EYEBROW_SIZE = 10.5; // small "CHAPTER N" label above a chapter's own title
const CHAPTER_TITLE_SIZE = 20;

const TOC_HEADING_SIZE = 22;
const TOC_ENTRY_SIZE = 12;
const TOC_LINE_HEIGHT = 25;

const FOOTER_SIZE = 9;

async function loadFontBytes(url) {
    const res = await fetch(url);
    return new Uint8Array(await res.arrayBuffer());
}

// Even DejaVu Serif doesn't cover everything (no CJK, no emoji). Rather than let pdf-lib/fontkit
// silently draw blank ".notdef" boxes for those, we check each character's real glyph coverage
// up front — via fontkit's own parsed Font object, independent of the pdf-lib wrapper — and swap
// anything unsupported for "?" (the conventional missing-glyph fallback). Results are cached per
// font since the same characters repeat constantly across a manuscript.
const encodableCache = new WeakMap(); // fontkitFont -> Map<char, boolean>

function canEncode(fontkitFont, char) {
    let cache = encodableCache.get(fontkitFont);
    if (!cache) {
        cache = new Map();
        encodableCache.set(fontkitFont, cache);
    }
    if (cache.has(char)) return cache.get(char);
    const ok = fontkitFont.hasGlyphForCodePoint(char.codePointAt(0));
    cache.set(char, ok);
    return ok;
}

// Replaces any character the given font can't render with "?". Iterates by code point (via
// spread) rather than UTF-16 code unit so surrogate-pair characters like emoji are handled as
// a single unit instead of being split into two mangled halves.
function sanitizeForFont(text, fontkitFont, stats) {
    return [...String(text)]
        .map((char) => {
            if (canEncode(fontkitFont, char)) return char;
            if (stats) stats.replaced += 1;
            return '?';
        })
        .join('');
}

// ---------- Text measuring & wrapping ----------

// Breaks a single word wider than the entire content column (a long URL, a run-on compound with
// no spaces, etc.) into width-safe chunks. Without this, a pathological single word would either
// overflow the page edge (visually clipped) or, worse, infinite-loop the wrapper below since it
// never finds a break point. Rare in real manuscripts, but cheap to guard against.
function splitLongWord(word, font, size, maxWidth) {
    const chars = [...word];
    const chunks = [];
    let current = '';
    chars.forEach((char) => {
        const trial = current + char;
        if (font.widthOfTextAtSize(trial, size) > maxWidth && current) {
            chunks.push(current);
            current = char;
        } else {
            current = trial;
        }
    });
    if (current) chunks.push(current);
    return chunks;
}

// Word-wraps one paragraph to `maxWidth`, optionally narrowing only the FIRST line by `indent`
// (a first-line paragraph indent, drawn by shifting the x position rather than shrinking the
// column — see layoutChapterBody). Returns an array of plain line strings.
function wrapParagraph(text, font, size, maxWidth, indent = 0) {
    const rawWords = text.split(/\s+/).filter(Boolean);
    if (rawWords.length === 0) return [];
    const words = rawWords.flatMap((word) => (
        font.widthOfTextAtSize(word, size) > maxWidth ? splitLongWord(word, font, size, maxWidth) : [word]
    ));
    const lines = [];
    let current = '';
    let widthLimit = maxWidth - indent;
    words.forEach((word) => {
        const trial = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(trial, size) > widthLimit && current) {
            lines.push(current);
            current = word;
            widthLimit = maxWidth; // only the first line is narrowed for the indent
        } else {
            current = trial;
        }
    });
    if (current) lines.push(current);
    return lines;
}

// Splits a chapter's plain text into paragraphs (blank-line or single-newline separated — the
// editor stores one <div> per paragraph, and stripHtml turns each block boundary into its own
// newline; see strip-html.jsx). Matches buildManuscriptText()'s own paragraph rule so every
// export path treats a manuscript's structure identically. Empty paragraphs (stray blank lines)
// are dropped here rather than kept as spacer gaps — with first-line indent doing the visual work
// of separating paragraphs, a leftover blank line only risks stray half-empty pages later on.
function paragraphsOf(plainText) {
    return plainText
        .split(/\n{2,}|\n/)
        .map((p) => p.trim())
        .filter(Boolean);
}

function toRoman(num) {
    const table = [
        [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
        [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
    ];
    let n = num;
    let out = '';
    table.forEach(([value, symbol]) => {
        while (n >= value) {
            out += symbol;
            n -= value;
        }
    });
    return out || 'i';
}

function buildDotLeader(font, size, gapWidth) {
    if (gapWidth <= 0) return '';
    const unit = '. ';
    const unitWidth = font.widthOfTextAtSize(unit, size);
    if (!(unitWidth > 0)) return '';
    const count = Math.max(0, Math.floor(gapWidth / unitWidth));
    return unit.repeat(count);
}

// Draws text letter-spaced (pdf-lib has no native tracking support) — used sparingly, for the
// small-caps-style labels (chapter eyebrows, cover byline) where real books use tracking to
// distinguish a label from body prose.
function trackedTextWidth(text, font, size, tracking) {
    const chars = [...text];
    let w = 0;
    chars.forEach((char, i) => {
        w += font.widthOfTextAtSize(char, size);
        if (i < chars.length - 1) w += tracking;
    });
    return w;
}

function drawTrackedText(page, text, font, size, x, y, color, tracking) {
    let cx = x;
    [...text].forEach((char) => {
        page.drawText(char, { x: cx, y, size, font, color });
        cx += font.widthOfTextAtSize(char, size) + tracking;
    });
}

function drawFooter(page, text, font) {
    const w = font.widthOfTextAtSize(text, FOOTER_SIZE);
    page.drawText(text, { x: (PAGE_WIDTH - w) / 2, y: FOOTER_Y, size: FOOTER_SIZE, font, color: rgb(0.45, 0.45, 0.47) });
}

// ---------- Chapter body pagination ----------
// Pure layout pass: given a chapter's paragraphs and the y-coordinate its first page's text may
// start at (below the heading block — see computeChapterHeadingLayout), returns the FINAL page
// breakdown as an array of pages, each an array of { text, indent } draw lines. No PDFPage is
// touched here — this same structure is both counted (to know how many pages a chapter takes,
// for the Table of Contents) and, unchanged, drawn onto real pages afterward. Computing it once
// and reusing it for both guarantees the TOC's page numbers can never drift from what's actually
// printed.
//
// Includes orphan/widow control: a paragraph is never split such that only its first line is
// stranded at the bottom of a page (orphan) or only its last line is stranded alone at the top of
// the next (widow) — in both cases the split point shifts by one line so at least two lines of a
// broken paragraph stay together. Combined with every chapter starting on its own fresh page,
// this is what keeps headings from ever landing at the bottom of a page and avoids the
// mid-paragraph breaks that read as sloppy in a plain word-processor export.
function layoutChapterBody(paragraphs, font, size, lineHeight, contentWidth, firstPageTop, laterPageTop, contentBottom) {
    const pages = [];
    let current = [];
    let y = firstPageTop;

    function pushPage() {
        pages.push(current);
        current = [];
        y = laterPageTop;
    }

    paragraphs.forEach((para, paraIdx) => {
        const indent = paraIdx === 0 ? 0 : PARA_INDENT;
        let lines = wrapParagraph(para, font, size, contentWidth, indent);
        if (lines.length === 0) return;

        while (lines.length > 0) {
            const availableLines = Math.max(0, Math.floor((y - contentBottom) / lineHeight));
            if (availableLines === 0) {
                pushPage();
                continue;
            }
            if (lines.length <= availableLines) {
                lines.forEach((text, i) => {
                    current.push({ text, indent: indent > 0 && i === 0 });
                    y -= lineHeight;
                });
                lines = [];
                continue;
            }
            // Paragraph must split across a page boundary.
            let take = availableLines;
            if (take === 1 && lines.length > 1 && current.length > 0) {
                // Orphan: only one line would fit here, stranding it away from the rest of its
                // paragraph. Push the whole paragraph to the next page instead — unless this is
                // already the very first thing on the page, in which case there's nowhere better
                // to put it.
                pushPage();
                continue;
            }
            const remainderAfterTake = lines.length - take;
            if (remainderAfterTake === 1 && take > 1) {
                // Widow: exactly one line would be left alone at the top of the next page. Hold
                // one extra line back so at least two lines move together.
                take -= 1;
            }
            for (let i = 0; i < take; i++) {
                current.push({ text: lines[i], indent: indent > 0 && i === 0 });
                y -= lineHeight;
            }
            lines = lines.slice(take);
            pushPage();
        }
    });

    if (current.length > 0 || pages.length === 0) pages.push(current);
    return pages;
}

// A chapter heading is always the first thing on a fresh page (see buildManuscriptPdf), so it can
// never land at the bottom of a page — this function just computes exactly where its pieces sit
// and where the body text may start beneath them. Reused verbatim by both the pagination pass
// (which only needs `bodyStartY`) and the draw pass (which also draws `steps`), so the two can
// never disagree about how much room the heading takes up.
function computeChapterHeadingLayout(eyebrowText, titleLines) {
    const steps = [];
    let y = CONTENT_TOP - CHAPTER_DROP;
    if (eyebrowText) {
        steps.push({ type: 'eyebrow', text: eyebrowText, y });
        y -= EYEBROW_SIZE + 16;
    }
    titleLines.forEach((line) => {
        steps.push({ type: 'title', text: line, y });
        y -= CHAPTER_TITLE_SIZE + 6;
    });
    y -= 8;
    steps.push({ type: 'rule', y });
    y -= 26;
    return { steps, bodyStartY: y };
}

// ---------- Table of contents pagination ----------
// Same "compute once, draw from the same structure" approach as chapter bodies. Entries almost
// always fit on a single TOC page for a normal-length manuscript, but this still paginates
// correctly (with a continued page, no heading repeated) for a project with dozens of chapters.
function layoutToc(entries, font) {
    const pages = [];
    let current = [];
    let y = CONTENT_TOP - (TOC_HEADING_SIZE + 34);
    const labelWidth = CONTENT_WIDTH - 60; // leaves room for the page-number column

    function pushPage() {
        pages.push(current);
        current = [];
        y = CONTENT_TOP;
    }

    entries.forEach((entry) => {
        const labelLines = wrapParagraph(entry.label, font, TOC_ENTRY_SIZE, labelWidth, 0);
        const entryHeight = Math.max(1, labelLines.length) * TOC_LINE_HEIGHT;
        if (y - entryHeight < CONTENT_BOTTOM) pushPage();
        current.push({ labelLines, pageNum: entry.pageNum });
        y -= entryHeight;
    });

    if (current.length > 0 || pages.length === 0) pages.push(current);
    return pages;
}

// ---------- Cover page ----------
// Mirrors COVER_ACCENTS in worldbuilding/book-cover.jsx as its own small copy, rather than
// importing that module directly — this file is dynamically imported specifically to keep
// pdf-lib/fontkit/the bundled font out of the main app bundle (see the callers), and book-cover.jsx
// pulls in React plus a full set of motif JSX/world-field data this cover doesn't need. Keep this
// in sync if the app's cover accent palette ever changes.
const PDF_COVER_ACCENTS = {
    gold: { light: '#C89B3C', mid: '#8a6a2e', deep: '#3d2f14' },
    crimson: { light: '#c96b6b', mid: '#7a2e2e', deep: '#2c1414' },
    forest: { light: '#7fa98a', mid: '#2e4a3a', deep: '#141f19' },
    navy: { light: '#7c93b8', mid: '#25344c', deep: '#10161f' },
    plum: { light: '#a97cc6', mid: '#4a2e5c', deep: '#1c1220' },
    charcoal: { light: '#9a9aa2', mid: '#3a3a42', deep: '#161619' },
};

function hexToRgbComponents(hex) {
    const clean = hex.replace('#', '');
    const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
    const num = parseInt(full, 16);
    return { r: ((num >> 16) & 255) / 255, g: ((num >> 8) & 255) / 255, b: (num & 255) / 255 };
}

function hexToColor(hex) {
    const { r, g, b } = hexToRgbComponents(hex);
    return rgb(r, g, b);
}

function drawVerticalGradient(page, x, y, width, height, topHex, bottomHex, steps) {
    const top = hexToRgbComponents(topHex);
    const bottom = hexToRgbComponents(bottomHex);
    const bandHeight = height / steps;
    for (let i = 0; i < steps; i++) {
        const t = steps === 1 ? 0 : i / (steps - 1);
        const r = top.r + (bottom.r - top.r) * t;
        const g = top.g + (bottom.g - top.g) * t;
        const b = top.b + (bottom.b - top.b) * t;
        const bandY = y + height - (i + 1) * bandHeight;
        // A hair of overlap (+0.5) between bands hides antialiasing seams between them.
        page.drawRectangle({ x, y: bandY, width, height: bandHeight + 0.5, color: rgb(r, g, b) });
    }
}

// Tries to embed the project's custom cover image (a data: URL from readLocalImageFile, or an
// uploaded-media URL — see image-utils.jsx / mediaStorage.js). Returns null on any failure (a
// stale blob URL, an unsupported format, a network hiccup fetching it) so the caller can fall
// back to the generated cover instead of failing the whole export over a cover image.
async function tryEmbedCoverImage(pdfDoc, url) {
    try {
        let bytes;
        let isPng;
        if (url.startsWith('data:')) {
            isPng = url.startsWith('data:image/png');
            const base64 = url.slice(url.indexOf(',') + 1);
            bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        } else {
            const res = await fetch(url);
            bytes = new Uint8Array(await res.arrayBuffer());
            isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
        }
        const image = isPng ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
        return image;
    } catch (err) {
        console.warn('PDF export: could not embed custom cover image, using generated cover instead.', err);
        return null;
    }
}

function drawGeneratedCover(page, project, font, boldFont, clean, regularFK, boldFK) {
    const cover = project.cover || {};
    const accent = PDF_COVER_ACCENTS[cover.accent] || PDF_COVER_ACCENTS.gold;
    const isLight = cover.style === 'parchment';
    const topHex = isLight ? '#EFE3C4' : accent.mid;
    const bottomHex = isLight ? accent.light : accent.deep;
    drawVerticalGradient(page, 0, 0, PAGE_WIDTH, PAGE_HEIGHT, topHex, bottomHex, 48);

    const titleColor = isLight ? hexToColor(accent.deep) : rgb(0.96, 0.93, 0.86);
    const subtleColor = isLight ? hexToColor(accent.deep) : hexToColor(accent.light);
    const borderColor = hexToColor(accent.light);

    page.drawRectangle({ x: 28, y: 28, width: PAGE_WIDTH - 56, height: PAGE_HEIGHT - 56, borderColor, borderWidth: 1.5 });
    page.drawRectangle({ x: 34, y: 34, width: PAGE_WIDTH - 68, height: PAGE_HEIGHT - 68, borderColor, borderWidth: 0.5, borderOpacity: 0.6 });

    const seriesName = clean((project.seriesName || '').trim(), regularFK);
    const title = clean((project.title || 'Untitled Novel').trim(), boldFK);
    const subtitle = clean((project.subtitle || '').trim(), regularFK);
    const author = clean((project.author || '').trim(), regularFK);

    let y = PAGE_HEIGHT / 2 + 70;
    if (seriesName) {
        const text = seriesName.toUpperCase();
        const w = trackedTextWidth(text, font, 11, 2);
        drawTrackedText(page, text, font, 11, (PAGE_WIDTH - w) / 2, y, subtleColor, 2);
        y -= 30;
    }
    const titleLines = wrapParagraph(title.toUpperCase(), boldFont, TITLE_SIZE, PAGE_WIDTH - 160, 0);
    titleLines.forEach((line) => {
        const w = boldFont.widthOfTextAtSize(line, TITLE_SIZE);
        page.drawText(line, { x: (PAGE_WIDTH - w) / 2, y, size: TITLE_SIZE, font: boldFont, color: titleColor });
        y -= TITLE_SIZE + 6;
    });
    if (subtitle) {
        y -= 8;
        const subLines = wrapParagraph(subtitle, font, 14, PAGE_WIDTH - 180, 0);
        subLines.forEach((line) => {
            const w = font.widthOfTextAtSize(line, 14);
            page.drawText(line, { x: (PAGE_WIDTH - w) / 2, y, size: 14, font, color: subtleColor });
            y -= 20;
        });
    }
    if (author) {
        const text = `by ${author}`.toUpperCase();
        const w = trackedTextWidth(text, font, 11, 1.5);
        drawTrackedText(page, text, font, 11, (PAGE_WIDTH - w) / 2, 90, subtleColor, 1.5);
    }
}

async function drawCoverPage(pdfDoc, page, project, font, boldFont, clean, regularFK, boldFK) {
    const cover = project.cover || {};
    if (cover.customImageUrl) {
        const image = await tryEmbedCoverImage(pdfDoc, cover.customImageUrl);
        if (image) {
            // "Cover fit": scale to fill the page completely (cropping overflow) rather than
            // letterboxing, matching how BookCover's CSS backgroundSize:'cover' treats the same
            // image everywhere else in the app.
            const scale = Math.max(PAGE_WIDTH / image.width, PAGE_HEIGHT / image.height);
            const drawW = image.width * scale;
            const drawH = image.height * scale;
            page.drawImage(image, { x: (PAGE_WIDTH - drawW) / 2, y: (PAGE_HEIGHT - drawH) / 2, width: drawW, height: drawH });
            return;
        }
    }
    drawGeneratedCover(page, project, font, boldFont, clean, regularFK, boldFK);
}

// ---------- Title page ----------
function drawTitlePage(page, project, font, boldFont, clean, regularFK, boldFK) {
    const seriesName = clean((project.seriesName || '').trim(), regularFK);
    const title = clean((project.title || 'Untitled Novel').trim(), boldFK);
    const subtitle = clean((project.subtitle || '').trim(), regularFK);
    const author = clean((project.author || '').trim(), regularFK);

    let y = PAGE_HEIGHT / 2 + 80;
    if (seriesName) {
        const text = seriesName.toUpperCase();
        const w = trackedTextWidth(text, font, 11, 2);
        drawTrackedText(page, text, font, 11, (PAGE_WIDTH - w) / 2, y, rgb(0.42, 0.42, 0.44), 2);
        y -= 28;
    }
    const titleLines = wrapParagraph(title.toUpperCase(), boldFont, TITLE_SIZE, CONTENT_WIDTH, 0);
    titleLines.forEach((line) => {
        const w = boldFont.widthOfTextAtSize(line, TITLE_SIZE);
        page.drawText(line, { x: (PAGE_WIDTH - w) / 2, y, size: TITLE_SIZE, font: boldFont, color: rgb(0.08, 0.08, 0.09) });
        y -= TITLE_SIZE + 8;
    });
    if (subtitle) {
        y -= 6;
        const subLines = wrapParagraph(subtitle, font, SUBTITLE_SIZE, CONTENT_WIDTH, 0);
        subLines.forEach((line) => {
            const w = font.widthOfTextAtSize(line, SUBTITLE_SIZE);
            page.drawText(line, { x: (PAGE_WIDTH - w) / 2, y, size: SUBTITLE_SIZE, font, color: rgb(0.32, 0.32, 0.34) });
            y -= SUBTITLE_SIZE + 6;
        });
    }
    const ruleY = Math.min(y - 14, PAGE_HEIGHT / 2 - 50);
    page.drawLine({ start: { x: PAGE_WIDTH / 2 - 40, y: ruleY }, end: { x: PAGE_WIDTH / 2 + 40, y: ruleY }, thickness: 0.75, color: rgb(0.6, 0.6, 0.6) });
    if (author) {
        const text = `by ${author}`;
        const w = font.widthOfTextAtSize(text, AUTHOR_SIZE);
        page.drawText(text, { x: (PAGE_WIDTH - w) / 2, y: ruleY - 26, size: AUTHOR_SIZE, font, color: rgb(0.25, 0.25, 0.27) });
    }
}

// ---------- Table of contents drawing ----------
function drawTocPages(pdfDoc, tocPages, font, boldFont) {
    tocPages.forEach((entries, pageIdx) => {
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        let y = CONTENT_TOP;
        if (pageIdx === 0) {
            const heading = 'Contents';
            const w = boldFont.widthOfTextAtSize(heading, TOC_HEADING_SIZE);
            page.drawText(heading, { x: (PAGE_WIDTH - w) / 2, y, size: TOC_HEADING_SIZE, font: boldFont, color: rgb(0.08, 0.08, 0.09) });
            y -= TOC_HEADING_SIZE + 34;
        }
        entries.forEach((entry) => {
            entry.labelLines.forEach((line, i) => {
                const isLast = i === entry.labelLines.length - 1;
                page.drawText(line, { x: MARGIN, y, size: TOC_ENTRY_SIZE, font, color: rgb(0.15, 0.15, 0.17) });
                if (isLast) {
                    const pageNumStr = String(entry.pageNum);
                    const pageNumWidth = font.widthOfTextAtSize(pageNumStr, TOC_ENTRY_SIZE);
                    const labelWidth = font.widthOfTextAtSize(line, TOC_ENTRY_SIZE);
                    const dotsStartX = MARGIN + labelWidth + 6;
                    const dotsEndX = (PAGE_WIDTH - MARGIN) - pageNumWidth - 6;
                    if (dotsEndX > dotsStartX) {
                        const dots = buildDotLeader(font, TOC_ENTRY_SIZE, dotsEndX - dotsStartX);
                        page.drawText(dots, { x: dotsStartX, y, size: TOC_ENTRY_SIZE, font, color: rgb(0.62, 0.62, 0.64) });
                    }
                    page.drawText(pageNumStr, { x: PAGE_WIDTH - MARGIN - pageNumWidth, y, size: TOC_ENTRY_SIZE, font, color: rgb(0.15, 0.15, 0.17) });
                }
                y -= TOC_LINE_HEIGHT;
            });
        });
        // Front matter (title page + TOC) is numbered in lowercase roman, conventional for
        // prelims in printed books; the title page itself is counted but its number stays
        // unprinted (also conventional), so the TOC's own first page is "ii".
        drawFooter(page, toRoman(pageIdx + 2), font);
    });
}

// ---------- Chapter drawing ----------
function drawChapterPages(pdfDoc, heading, bodyPages, startPageNum, font, boldFont) {
    bodyPages.forEach((linesOnPage, pageIdx) => {
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        if (pageIdx === 0) {
            heading.steps.forEach((step) => {
                if (step.type === 'eyebrow') {
                    const w = trackedTextWidth(step.text, boldFont, EYEBROW_SIZE, 2.2);
                    drawTrackedText(page, step.text, boldFont, EYEBROW_SIZE, (PAGE_WIDTH - w) / 2, step.y, rgb(0.5, 0.44, 0.3), 2.2);
                } else if (step.type === 'title') {
                    const w = boldFont.widthOfTextAtSize(step.text, CHAPTER_TITLE_SIZE);
                    page.drawText(step.text, { x: (PAGE_WIDTH - w) / 2, y: step.y, size: CHAPTER_TITLE_SIZE, font: boldFont, color: rgb(0.08, 0.08, 0.09) });
                } else if (step.type === 'rule') {
                    page.drawLine({ start: { x: PAGE_WIDTH / 2 - 26, y: step.y }, end: { x: PAGE_WIDTH / 2 + 26, y: step.y }, thickness: 0.75, color: rgb(0.65, 0.6, 0.5) });
                }
            });
        }
        let y = pageIdx === 0 ? heading.bodyStartY : CONTENT_TOP;
        linesOnPage.forEach((item) => {
            const x = MARGIN + (item.indent ? PARA_INDENT : 0);
            page.drawText(item.text, { x, y, size: BODY_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
            y -= LINE_HEIGHT;
        });
        drawFooter(page, String(startPageNum + pageIdx), font);
    });
}

// Returns { bytes, unsupportedCharCount }. bytes is the Uint8Array PDF; unsupportedCharCount is
// >0 if any character had no glyph in DejaVu Serif (CJK, emoji, etc.) and was swapped for "?", so
// callers can surface a soft warning instead of pretending the export was pixel-perfect.
export async function buildManuscriptPdf(project, options = {}) {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);

    const [regularBytes, boldBytes] = await Promise.all([
        loadFontBytes(regularFontUrl),
        loadFontBytes(boldFontUrl),
    ]);
    // subset: true keeps the output PDF small by embedding only the glyphs actually used,
    // rather than DejaVu Serif's full ~3,400-glyph set in every exported file.
    const font = await pdfDoc.embedFont(regularBytes, { subset: true });
    const boldFont = await pdfDoc.embedFont(boldBytes, { subset: true });
    // Parsed directly via fontkit (not through the pdf-lib wrapper) purely to ask "does this
    // font have a glyph for this character?" — see canEncode above.
    const regularFK = fontkit.create(regularBytes);
    const boldFK = fontkit.create(boldBytes);

    const stats = { replaced: 0 };
    const clean = (text, fk) => sanitizeForFont(text, fk, stats);

    const chapters = (project.chapters || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0));

    // ---- Compute every chapter's heading + body pagination up front (no PDF pages yet) ----
    // This is the single source of truth both the Table of Contents and the actual chapter pages
    // draw from, so the two can never disagree about where a chapter starts.
    const chapterPlans = chapters.map((ch, idx) => {
        const chapterNumber = ch.number || idx + 1;
        const hasCustomTitle = !!(ch.title && ch.title.trim());
        const titleText = clean(hasCustomTitle ? ch.title.trim() : `Chapter ${chapterNumber}`, boldFK);
        const eyebrowText = hasCustomTitle ? clean(`Chapter ${chapterNumber}`.toUpperCase(), boldFK) : '';
        const titleLines = wrapParagraph(titleText, boldFont, CHAPTER_TITLE_SIZE, CONTENT_WIDTH, 0);
        const heading = computeChapterHeadingLayout(eyebrowText, titleLines);

        const bodyText = clean(stripHtml(ch.text).trim(), regularFK);
        const paragraphs = paragraphsOf(bodyText);
        const bodyPages = layoutChapterBody(paragraphs, font, BODY_SIZE, LINE_HEIGHT, CONTENT_WIDTH, heading.bodyStartY, CONTENT_TOP, CONTENT_BOTTOM);

        return { tocLabel: hasCustomTitle ? `Chapter ${chapterNumber} \u2014 ${titleText}` : `Chapter ${chapterNumber}`, heading, bodyPages };
    });

    let runningPage = 1;
    chapterPlans.forEach((plan) => {
        plan.startPage = runningPage;
        runningPage += plan.bodyPages.length;
    });

    const tocPages = chapterPlans.length
        ? layoutToc(chapterPlans.map((plan) => ({ label: plan.tocLabel, pageNum: plan.startPage })), font)
        : [];

    // ---- Draw, in document order: Cover -> Title -> Contents -> Chapters ----
    const coverPage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    await drawCoverPage(pdfDoc, coverPage, project, font, boldFont, clean, regularFK, boldFK);

    const titlePage = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    drawTitlePage(titlePage, project, font, boldFont, clean, regularFK, boldFK);

    if (tocPages.length) drawTocPages(pdfDoc, tocPages, font, boldFont);

    chapterPlans.forEach((plan) => {
        drawChapterPages(pdfDoc, plan.heading, plan.bodyPages, plan.startPage, font, boldFont);
    });

    // ---- Book structure manifest, embedded as a file attachment ----
    // The rendered Cover/Title/Contents/Chapter pages above are for a human reading the PDF —
    // laid out, paginated, and thus inherently lossy to read back (see pdf-import.js's own
    // heading-regex fallback for a foreign PDF, which has no better source of truth to work
    // from). This attachment is a second, hidden channel carrying the exact structure — title,
    // author, cover, and every chapter's real number/title/HTML content — so importing a PDF
    // Inkroot itself exported can restore it exactly instead of re-guessing it from extracted
    // text. Invisible to and unaffected by any PDF viewer; see pdf-import.js for how it's read
    // back. Uses pdf-lib's own attach() (a real PDF/A-3 "embedded file"), not a custom hack.
    const manifestBytes = new TextEncoder().encode(serializeBookManifest(project));
    await pdfDoc.attach(manifestBytes, MANIFEST_FILENAME, {
        mimeType: 'application/json',
        description: 'Inkroot book structure — used to restore this book exactly on re-import. Safe to ignore.',
        creationDate: new Date(),
        modificationDate: new Date(),
    });

    const bytes = await pdfDoc.save();
    return { bytes, unsupportedCharCount: stats.replaced };
}
