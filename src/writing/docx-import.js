// ---------- DOCX import ----------
// Extracts real structure from a Word document entirely on-device via mammoth's convertToHtml
// (pure JS .docx parser — no upload anywhere, same "no upload anywhere" policy as every other
// import path in this file).
//
// This used to call mammoth's extractRawText and hand the flattened plain text to the same
// "Chapter 3" heading-regex splitter .txt/PDF import use (see splitIntoChapters in
// import-export.jsx). That meant a chapter boundary only survived a round trip if its title
// happened to start with the literal word "Chapter" — any manuscript using its own chapter
// titles (the overwhelmingly common case) came back from import as one single giant chapter,
// with every real chapter break silently lost.
//
// A .docx already has real structure for this: paragraph styles. docx-export.js gives the book
// title the built-in "Title" style and every chapter heading the built-in "Heading 1" style —
// exactly the same styles Word's own outline/navigation pane already understands. Splitting on
// those style boundaries (via a styleMap, below) is a structural signal that doesn't care what
// the title text itself says — the same reason epub-import.js already prefers an EPUB's own
// spine over guessing from a heading line.
import mammoth from 'mammoth';
import { sanitizeChapterHtml } from '../shared-utils/sanitize-html.js';

// Maps Word's built-in "Title" and "Heading 1" paragraph styles to distinctly-classed <h1>s so
// they can be told apart from each other (and from plain text someone typed to look like a
// heading without applying a real style) after mammoth's conversion. `:fresh` starts a new
// element per paragraph rather than merging adjacent same-style paragraphs into one.
const STYLE_MAP = [
    "p[style-name='Title'] => h1.inkroot-book-title:fresh",
    "p[style-name='Heading 1'] => h1.inkroot-chapter-title:fresh",
];

export async function extractDocxText(arrayBuffer) {
    const { value } = await mammoth.extractRawText({ arrayBuffer });
    return value;
}

// splitIntoChapters is passed in by the caller (only used for the unstyled-document fallback
// below) rather than imported directly here, to avoid a circular import with import-export.jsx
// (which imports parseDocxManuscript from this file) — the same pattern pdf-import.js already
// uses for parsePdfManuscript, for the same reason.
export async function parseDocxManuscript(arrayBuffer, splitIntoChapters) {
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer }, { styleMap: STYLE_MAP });
    const dom = new DOMParser().parseFromString(html, 'text/html');
    const nodes = Array.from(dom.body.childNodes);

    const chapterStarts = [];
    nodes.forEach((node, i) => {
        if (node.nodeType === 1 && node.classList && node.classList.contains('inkroot-chapter-title'))
            chapterStarts.push(i);
    });

    if (chapterStarts.length === 0) {
        // No real "Heading 1" paragraphs in this document at all — an unstyled manuscript, most
        // likely. Fall back to the same plain-text heading-regex splitter every other import
        // path uses, rather than importing the whole document as a single chapter unnecessarily.
        const chapters = splitIntoChapters(await extractDocxText(arrayBuffer));
        return { title: '', author: '', chapters, fromManifest: false };
    }

    // Everything before the first real chapter heading is front matter, not chapter content —
    // the book title (the "Title"-styled paragraph, if present) and, immediately after it, an
    // author line ("by <name>"). This mirrors exactly what docx-export.js itself writes (see its
    // Title/`by ${author}` paragraphs), so an Inkroot-exported .docx round-trips its title/author
    // instead of them becoming a bogus leading chapter the way an unrecognized heading used to.
    let title = '';
    let author = '';
    nodes.slice(0, chapterStarts[0]).forEach((node) => {
        if (node.nodeType !== 1) return;
        const text = (node.textContent || '').trim();
        if (!text) return;
        if (node.classList && node.classList.contains('inkroot-book-title')) {
            title = text;
        } else if (!title) {
            // A Title-styled paragraph didn't come first (or doesn't exist) — treat the first
            // non-blank front-matter line as the title anyway, same "best guess, never discard"
            // policy splitIntoChapters already applies to unrecognized leading content.
            title = text;
        } else if (/^by\s+/i.test(text)) {
            author = text.replace(/^by\s+/i, '').trim();
        }
    });

    const chapters = chapterStarts.map((startIdx, i) => {
        const endIdx = i + 1 < chapterStarts.length ? chapterStarts[i + 1] : nodes.length;
        const headingNode = nodes[startIdx];
        const chapterTitle = (headingNode.textContent || '').trim() || `Chapter ${i + 1}`;
        const bodyNodes = nodes.slice(startIdx + 1, endIdx);
        const bodyHtml = bodyNodes.map((n) => (n.outerHTML || (n.textContent ? `<div>${n.textContent}</div>` : ''))).join('');
        return { title: chapterTitle, text: sanitizeChapterHtml(bodyHtml || '<div><br></div>') };
    });

    return { title, author, chapters, fromManifest: false };
}
