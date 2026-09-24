import React, { useState } from 'react';
import { EmptyState, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { stripHtml } from '../shared-utils/strip-html.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { parsePdfManuscript } from './pdf-import.js';
import { parseDocxManuscript } from './docx-import.js';
import { parseEpubManuscript } from './epub-import.js';
import { uploadImageDataUrl, isUploadedMediaUrl, deleteUploadedImage } from '../lib/mediaStorage.js';
import { renumberChapters } from './project-schema-and-backups.jsx';
import { serializeBookManifest } from './book-manifest.js';


// ---------- Import Work ----------
// Plain-text (.txt) manuscripts are fully supported: read entirely on-device with FileReader,
// no upload anywhere. If the text contains lines that look like chapter headings ("Chapter 3",
// "Chapter Two \u2014 Homecoming"\u2026) it's split into real chapters with real titles; otherwise the
// whole file becomes a single chapter, exactly as the user wrote it \u2014 text is never trimmed,
// summarized, or rewritten. PDF (pdf-import.js, via pdfjs-dist) and DOCX (docx-import.js, via
// mammoth) import both extract plain text and share this exact same splitting logic. EPUB
// (epub-import.js, via JSZip) is different in kind, not degree: an EPUB already segments its
// own reading order into separate files, so it skips the heading-regex splitter entirely and
// uses that existing structure instead \u2014 see epub-import.js for why that's more reliable,
// not a shortcut. Every import path runs entirely on-device; none of them upload the file
// anywhere.
//
// Separator class covers ':', a plain hyphen, en dash (\u2013), em dash (\u2014), AND a trailing
// period. The period was missing even though "CHAPTER 47." (number followed by a bare period,
// no title) is one of the most common heading styles in real books. Without it, the period fell
// through into the captured title group instead of being consumed, so a plain "CHAPTER 47."
// heading parsed as title "." instead of falling back to "Chapter 47".
const CHAPTER_HEADING_RE = /^\s*chapter\s+([A-Za-z0-9]+)\s*[:\-.\u2013\u2014]?\s*(.*)$/i;

// A real chapter heading is a short title ("Chapter 1", "Chapter 2: The Journey"), never a full
// sentence. Some authors open a chapter's own body text with a line like "Chapter One: Exile —
// The wind howled…" as a stylistic in-prose heading. When that line gets word-wrapped by PDF
// export, the wrapped line can still start with "Chapter One:" and run on for a full sentence
// or more before the line breaks — which CHAPTER_HEADING_RE alone would happily match, treating
// the rest of that sentence as a "chapter title" and splitting it into its own bogus chapter,
// leaving the real Chapter 1 (the app's own short auto-heading line, immediately above it) empty.
// Capping how long a matched line is allowed to be filters this out: real headings are always
// short, so anything past this length is body prose that merely starts with the word "chapter".
const MAX_HEADING_LINE_LENGTH = 80;

// Matches a line against CHAPTER_HEADING_RE and applies the length sanity check above. Returns
// the regex match array, or null if the line isn't a real heading (no match, or too long to be
// a plausible title). Centralized here so both passes below (finding heading indices, and
// re-deriving each heading's title/number) use the exact same rule.
function matchChapterHeading(line) {
    if (line.trim().length > MAX_HEADING_LINE_LENGTH)
        return null;
    return line.match(CHAPTER_HEADING_RE);
}


function escapeHtmlText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}


function textToChapterHtml(paragraphs) {
    return paragraphs.filter((p) => p.trim() !== '').map((p) => `<div>${escapeHtmlText(p)}</div>`).join('') || '<div><br></div>';
}


// Splits raw text content (from .txt OR PDF-extracted text) into { title, text } chapters.
// Falls back to a single chapter containing everything when no "Chapter \u2026" headings are found.
// Shared by both import paths so a "Chapter 3" heading is recognized identically either way.
export function splitIntoChapters(raw) {
    const lines = (raw || '').replace(/\r\n/g, '\n').split('\n');
    const headingIdx = [];
    lines.forEach((line, i) => { if (matchChapterHeading(line))
        headingIdx.push(i); });
    if (headingIdx.length === 0) {
        return [{ title: 'Chapter 1', text: textToChapterHtml(lines) }];
    }
    const chapters = [];
    // Content before the first recognized heading used to be silently discarded here — if an
    // early chapter's heading didn't match CHAPTER_HEADING_RE (e.g. a PDF-extraction artifact
    // scrambling a decorative chapter-opener's text run order), every chapter before the first
    // successful match vanished on import with no error. Now that content is kept as its own
    // chapter instead of being lost. It's titled from its own first non-blank line — in the
    // unmatched-heading case that's often the mangled heading itself — rather than guessing a
    // chapter number we can't verify.
    const leading = lines.slice(0, headingIdx[0]);
    if (leading.some((l) => l.trim() !== '')) {
        const firstLine = leading.find((l) => l.trim() !== '').trim();
        const title = firstLine.length > 0 && firstLine.length <= 60 ? firstLine : 'Untitled';
        chapters.push({ title, text: textToChapterHtml(leading) });
    }
    headingIdx.forEach((startIdx, i) => {
        const endIdx = i + 1 < headingIdx.length ? headingIdx[i + 1] : lines.length;
        const m = matchChapterHeading(lines[startIdx]);
        const title = (m[2] && m[2].trim()) || `Chapter ${m[1]}`;
        const body = lines.slice(startIdx + 1, endIdx);
        chapters.push({ title, text: textToChapterHtml(body) });
    });
    return chapters;
}

// Back-compat name for the .txt path specifically \u2014 identical behavior to splitIntoChapters.
export const parseTxtManuscript = splitIntoChapters;


// Recognizes the "Title: \u2026" / "Author: \u2026" front-matter lines buildManuscriptText writes at
// the very top of a .txt export (see below), and strips them off before the rest of the file
// ever reaches splitIntoChapters. Without this, that front matter was itself "content before the
// first recognized heading" \u2014 which splitIntoChapters keeps as its own leading chapter rather
// than discarding (a deliberate, correct choice for genuinely unrecognized content \u2014 see its own
// comment) \u2014 so re-importing an Inkroot .txt export used to grow a bogus extra chapter titled
// after the book's own title line, ahead of every real chapter. A foreign .txt file (no "Title:"/
// "Author:" lines at the very top) is completely unaffected: this only ever strips lines matching
// that exact convention, so its whole first paragraph still becomes the same leading chapter it
// always did.
const FRONT_MATTER_LINE_RE = /^(Title|Author):\s*(.*)$/i;

export function parseManuscriptText(raw) {
    const lines = (raw || '').replace(/\r\n/g, '\n').split('\n');
    let title = '';
    let author = '';
    let i = 0;
    while (i < lines.length) {
        const m = lines[i].match(FRONT_MATTER_LINE_RE);
        if (!m) break;
        if (/^title$/i.test(m[1])) title = m[2].trim();
        else author = m[2].trim();
        i++;
    }
    if (i === 0) {
        // No front matter at all \u2014 not an Inkroot export (or a very old one, from before this
        // existed). Every line is manuscript content.
        return { title: '', author: '', chapters: splitIntoChapters(raw) };
    }
    // Skip exactly one blank separator line after the front-matter block, if present, so it
    // doesn't become a leading blank line inside the first real chapter.
    if (i < lines.length && lines[i].trim() === '') i++;
    const body = lines.slice(i).join('\n');
    return { title, author, chapters: splitIntoChapters(body) };
}


export function ImportWorkPanel({ project, update }) {
    const [preview, setPreview] = useState(null); // { fileName, title, author, chapters, coverDataUrl? } | null
    const [imported, setImported] = useState(false);
    const [pdfError, setPdfError] = useState(null);
    const [pdfBusy, setPdfBusy] = useState(false);
    const [docxError, setDocxError] = useState(null);
    const [docxBusy, setDocxBusy] = useState(false);
    const [epubError, setEpubError] = useState(null);
    const [epubBusy, setEpubBusy] = useState(false);
    const [useCover, setUseCover] = useState(false);
    const [coverBusy, setCoverBusy] = useState(false);
    // Title/author and "replace instead of append" both default OFF — same non-destructive-by-
    // default posture the cover checkbox already has. Together they're what makes a clean
    // CREATE → EXPORT → IMPORT → EXPORT round trip possible: importing can now fully take on the
    // imported book's title/author/chapters instead of only ever appending chapters after
    // whatever was already in the project.
    const [useTitleAuthor, setUseTitleAuthor] = useState(false);
    const [replaceChapters, setReplaceChapters] = useState(false);
    const handleFile = (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setImported(false);
        const reader = new FileReader();
        reader.onload = () => {
            const { title, author, chapters } = parseManuscriptText(String(reader.result || ''));
            setPreview({ fileName: file.name, title, author, chapters });
            setUseTitleAuthor(!!(title || author));
        };
        reader.readAsText(file);
    };
    const handlePdfFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setImported(false);
        setPdfError(null);
        setPdfBusy(true);
        setUseCover(false);
        try {
            const buffer = await file.arrayBuffer();
            const { title, author, coverDataUrl, chapters } = await parsePdfManuscript(buffer, splitIntoChapters, { detectCover: true });
            setPreview({ fileName: file.name, title, author, chapters, coverDataUrl });
            setUseTitleAuthor(!!(title || author));
        } catch (err) {
            setPdfError("Couldn't read that PDF \u2014 it may be scanned/image-only or password-protected.");
        } finally {
            setPdfBusy(false);
        }
    };
    const handleDocxFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setImported(false);
        setDocxError(null);
        setDocxBusy(true);
        try {
            const buffer = await file.arrayBuffer();
            const { title, author, chapters } = await parseDocxManuscript(buffer, splitIntoChapters);
            setPreview({ fileName: file.name, title, author, chapters });
            setUseTitleAuthor(!!(title || author));
        } catch (err) {
            setDocxError("Couldn't read that Word document \u2014 make sure it's a real .docx file, not a renamed .doc.");
        } finally {
            setDocxBusy(false);
        }
    };
    const handleEpubFile = async (e) => {
        const file = e.target.files && e.target.files[0];
        e.target.value = '';
        if (!file)
            return;
        setImported(false);
        setEpubError(null);
        setEpubBusy(true);
        try {
            const buffer = await file.arrayBuffer();
            const { title, author, coverDataUrl, chapters } = await parseEpubManuscript(buffer);
            setPreview({ fileName: file.name, title, author, chapters, coverDataUrl });
            setUseTitleAuthor(!!(title || author));
        } catch (err) {
            setEpubError("Couldn't read that EPUB \u2014 it may be corrupted or not a standard .epub file.");
        } finally {
            setEpubBusy(false);
        }
    };
    const handleImport = async () => {
        if (!preview)
            return;
        // Cover upload happens first and separately from the chapters update() below — a failed
        // upload (offline, etc.) should never block the text import that's the main point of
        // this button; it just falls back to the raw data URL, same as CoverPicker's own upload
        // path always has.
        let newCoverUrl = null;
        if (useCover && preview.coverDataUrl) {
            setCoverBusy(true);
            try {
                newCoverUrl = await uploadImageDataUrl(preview.coverDataUrl, 'book-covers') || preview.coverDataUrl;
            } catch { newCoverUrl = preview.coverDataUrl; }
            setCoverBusy(false);
        }
        update((p) => {
            if (replaceChapters) {
                // Cleanly discards this project's existing chapters in favor of the imported
                // ones — chapter order/numbering is then derived entirely from the imported
                // file, exactly as it was in the source. Off by default (see useState above):
                // appending after what's already here remains the safe default behavior.
                p.chapters = preview.chapters.map((ch) => ({ id: uuid(), title: ch.title, text: ch.text, isCopy: false }));
            } else {
                preview.chapters.forEach((ch) => {
                    p.chapters.push({ id: uuid(), title: ch.title, text: ch.text, isCopy: false });
                });
            }
            renumberChapters(p.chapters);
            if (useTitleAuthor) {
                if (preview.title) p.title = preview.title;
                if (preview.author) p.author = preview.author;
            }
            if (newCoverUrl) {
                const previousCoverUrl = p.cover && p.cover.customImageUrl;
                p.cover = { ...(p.cover || {}), customImageUrl: newCoverUrl };
                if (isUploadedMediaUrl(previousCoverUrl) && previousCoverUrl !== newCoverUrl)
                    deleteUploadedImage(previousCoverUrl);
            }
        });
        setImported(true);
        setPreview(null);
        setUseCover(false);
        setUseTitleAuthor(false);
        setReplaceChapters(false);
    };
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Import Work"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "Bring an existing manuscript into this project. Chapters, text, and any \"Chapter \u2026\" headings are preserved \u2014 imported chapters are added after what's already here, never replacing it."),
        React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 560, marginBottom: 20 } },
            React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2', marginBottom: 4 } }, "Plain text (.txt)"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12, lineHeight: 1.5 } }, "Lines like \"Chapter 3\" or \"Chapter Two \u2014 Homecoming\" become real chapter breaks; otherwise the whole file imports as one chapter."),
                React.createElement("label", { style: {
                        display: 'inline-block', background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    } }, "Choose a .txt file\u2026",
                    React.createElement("input", { type: "file", accept: ".txt,text/plain", onChange: handleFile, style: { display: 'none' } }))),
            React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2', marginBottom: 4 } }, "PDF (.pdf)"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12, lineHeight: 1.5 } }, "Text is extracted on-device \u2014 the same \"Chapter \u2026\" heading rules as .txt apply. Scanned/image-only PDFs won't have extractable text."),
                React.createElement("label", { style: {
                        display: 'inline-block', background: pdfBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                        border: '1px solid #4A3D22', color: pdfBusy ? '#7A7A82' : '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                        cursor: pdfBusy ? 'default' : 'pointer',
                    } }, pdfBusy ? "Reading PDF\u2026" : "Choose a .pdf file\u2026",
                    React.createElement("input", { type: "file", accept: ".pdf,application/pdf", onChange: handlePdfFile, disabled: pdfBusy, style: { display: 'none' } })),
                pdfError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 10 } }, pdfError)),
            React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2', marginBottom: 4 } }, "Word (.docx)"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12, lineHeight: 1.5 } }, "Text is extracted on-device \u2014 the same \"Chapter \u2026\" heading rules as .txt apply. Older .doc files aren't supported \u2014 only .docx."),
                React.createElement("label", { style: {
                        display: 'inline-block', background: docxBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                        border: '1px solid #4A3D22', color: docxBusy ? '#7A7A82' : '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                        cursor: docxBusy ? 'default' : 'pointer',
                    } }, docxBusy ? "Reading document\u2026" : "Choose a .docx file\u2026",
                    React.createElement("input", { type: "file", accept: ".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document", onChange: handleDocxFile, disabled: docxBusy, style: { display: 'none' } })),
                docxError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 10 } }, docxError)),
            React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2', marginBottom: 4 } }, "EPUB (.epub)"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12, lineHeight: 1.5 } }, "Each chapter file in the EPUB becomes its own imported chapter, titled from its own first heading \u2014 no \"Chapter \u2026\" guessing needed."),
                React.createElement("label", { style: {
                        display: 'inline-block', background: epubBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                        border: '1px solid #4A3D22', color: epubBusy ? '#7A7A82' : '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                        cursor: epubBusy ? 'default' : 'pointer',
                    } }, epubBusy ? "Reading EPUB\u2026" : "Choose a .epub file\u2026",
                    React.createElement("input", { type: "file", accept: ".epub,application/epub+zip", onChange: handleEpubFile, disabled: epubBusy, style: { display: 'none' } })),
                epubError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 10 } }, epubError))),
        preview && React.createElement("div", { style: { maxWidth: 560, background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, color: '#EFE7D2', marginBottom: 6 } }, preview.fileName),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#A6A6AD', marginBottom: 14 } },
                `${preview.chapters.length} chapter${preview.chapters.length === 1 ? '' : 's'} found \u2014 ` +
                (replaceChapters
                    ? `will replace this project's existing ${project.chapters.length} chapter${project.chapters.length === 1 ? '' : 's'}.`
                    : `will be added after this project's existing ${project.chapters.length} chapter${project.chapters.length === 1 ? '' : 's'}.`)),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4], marginBottom: 14, maxHeight: 160, overflowY: 'auto' } },
                preview.chapters.map((ch, i) => React.createElement("div", { key: i, style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82' } }, `${i + 1}. ${ch.title}`))),
            React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 10, cursor: 'pointer' } },
                React.createElement("input", { type: "checkbox", checked: replaceChapters, onChange: (e) => setReplaceChapters(e.target.checked) }),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#EFE7D2' } }, "Replace this project's chapters instead of adding after them")),
            (preview.title || preview.author) && React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 14, cursor: 'pointer' } },
                React.createElement("input", { type: "checkbox", checked: useTitleAuthor, onChange: (e) => setUseTitleAuthor(e.target.checked) }),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#EFE7D2' } },
                    `Use the detected title/author \u2014 ${preview.title || '(untitled)'}${preview.author ? ` by ${preview.author}` : ''}`)),
            preview.coverDataUrl && React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 14, cursor: 'pointer' } },
                React.createElement("img", { src: preview.coverDataUrl, alt: "Detected cover", style: { width: 44, height: 60, objectFit: 'cover', borderRadius: RADIUS_SCALE[5], border: '1px solid #2A2A30' } }),
                React.createElement("div", { style: { flex: 1 } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#EFE7D2' } },
                        React.createElement("input", { type: "checkbox", checked: useCover, onChange: (e) => setUseCover(e.target.checked), style: { marginRight: 8 } }),
                        "Use this as the project's cover"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 2 } }, "Replaces the current cover \u2014 you can always change it again in Settings."))),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10] } },
                React.createElement("button", { disabled: coverBusy, onClick: handleImport, style: {
                        background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: coverBusy ? 'default' : 'pointer', opacity: coverBusy ? 0.6 : 1,
                    } }, coverBusy ? "Importing\u2026" : "Import into this project"),
                React.createElement("button", { onClick: () => { setPreview(null); setUseCover(false); setUseTitleAuthor(false); setReplaceChapters(false); }, style: {
                        background: 'none', border: '1px solid #2A2A30', color: '#A6A6AD', borderRadius: RADIUS_SCALE[8],
                        padding: '9px 16px', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                    } }, "Cancel"))),
        imported && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#8FCB8F', maxWidth: 560 } }, "Imported \u2014 the new chapters are now in this project's Manuscript."));
}


// ---------- Export Work ----------
// A manuscript export is a *copy of the writing itself* for use outside Inkroot \u2014 separate
// from the Settings tab's "Download backup (.json)" button, which saves this project's entire
// working data (characters, world, timeline, everything) so it can be restored back into Inkroot.
// The two never merge: exporting a manuscript here never replaces or touches that JSON backup.
// Plain text export is real, on-device, no dependencies. PDF (pdf-export.js, via pdf-lib), DOCX
// (docx-export.js, via the docx package), and EPUB (epub-export.js, via JSZip) each load their
// generator library as its own lazily-fetched chunk \u2014 see the dynamic import()s below \u2014 so
// picking one export format doesn't pull the other two libraries into everyone's initial bundle.
function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


// Exported (not just used internally by ExportWorkPanel below) so other export entry points —
// e.g. ManuscriptTab's own "Export PDF" button in project-workspace.jsx — can save a
// buildManuscriptPdf() result to disk the exact same way, without duplicating this Blob/anchor
// dance a second time.
export function downloadBinaryFile(filename, bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


// Same anchor/Blob dance as downloadBinaryFile, for generators (docx's Packer.toBlob, JSZip's
// generateAsync({type:'blob'})) that already hand back a Blob directly rather than raw bytes \u2014
// so callers never need to round-trip a Blob through an ArrayBuffer just to reuse one helper.
export function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}


export function buildManuscriptText(project) {
    const parts = [];
    // "Title: \u2026" / "Author: \u2026" \u2014 a plain, human-readable convention that parseManuscriptText
    // (above) recognizes and strips back off on import, so the book's title/author survive a
    // .txt round trip instead of becoming a bogus leading chapter (see that function's comment).
    if (project.title)
        parts.push(`Title: ${project.title}`);
    if (project.author)
        parts.push(`Author: ${project.author}`);
    parts.push('');
    (project.chapters || []).slice().sort((a, b) => (a.number || 0) - (b.number || 0)).forEach((ch, i) => {
        // Always prefixed with "Chapter N: " \u2014 not just when the title happens to already start
        // with the word "Chapter". splitIntoChapters (used on re-import) can only recognize a
        // chapter boundary by matching that exact pattern (see CHAPTER_HEADING_RE above); a
        // chapter titled e.g. "The Beginning" written out bare, as this used to do, came back
        // from import as an unrecognized heading \u2014 which collapsed the ENTIRE manuscript into
        // one single chapter instead of the real per-chapter structure. Prefixing here guarantees
        // every chapter is recognized as its own heading on re-import regardless of what its
        // title says, while the real title (everything after the colon) still round-trips
        // exactly \u2014 matchChapterHeading captures it back out into m[2] unchanged.
        const number = ch.number || i + 1;
        const title = ch.title || `Chapter ${number}`;
        // Skip the redundant ": Chapter N" suffix for a chapter that's still using its default,
        // un-renamed title \u2014 keeps the common case's output exactly as clean as before, since
        // "Chapter 1" alone already round-trips fine (matchChapterHeading's own fallback title is
        // literally "Chapter N" when nothing follows the colon).
        parts.push(title === `Chapter ${number}` ? title : `Chapter ${number}: ${title}`);
        parts.push('');
        parts.push(stripHtml(ch.text).trim());
        parts.push('');
        parts.push('');
    });
    return parts.join('\n');
}


export function ExportWorkPanel({ project }) {
    const [pdfBusy, setPdfBusy] = useState(false);
    const [pdfError, setPdfError] = useState(null);
    const [pdfWarning, setPdfWarning] = useState(null);
    const [docxBusy, setDocxBusy] = useState(false);
    const [docxError, setDocxError] = useState(null);
    const [epubBusy, setEpubBusy] = useState(false);
    const [epubError, setEpubError] = useState(null);
    const filenameBase = () => (project.title || 'manuscript').trim().toLowerCase().replace(/\s+/g, '-');
    const handleTxt = () => {
        downloadTextFile(`${filenameBase()}.txt`, buildManuscriptText(project));
    };
    const handlePdf = async () => {
        setPdfError(null);
        setPdfWarning(null);
        setPdfBusy(true);
        try {
            // Dynamic import: pdf-lib + @pdf-lib/fontkit (and the bundled DejaVu Serif font) are
            // real weight and only ever needed here, so they're kept out of the app's main bundle
            // and fetched as their own chunk the first time someone actually exports a PDF.
            const { buildManuscriptPdf } = await import('./pdf-export.js');
            const { bytes, unsupportedCharCount } = await buildManuscriptPdf(project);
            downloadBinaryFile(`${filenameBase()}.pdf`, bytes, 'application/pdf');
            if (unsupportedCharCount > 0) {
                setPdfWarning(`Note: ${unsupportedCharCount} character${unsupportedCharCount === 1 ? '' : 's'} (e.g. emoji or non-Latin script) couldn't be rendered in this font and ${unsupportedCharCount === 1 ? 'was' : 'were'} shown as "?".`);
            }
        } catch (err) {
            console.error('PDF export failed:', err);
            setPdfError("Couldn't generate the PDF \u2014 please try again.");
        } finally {
            setPdfBusy(false);
        }
    };
    const handleDocx = async () => {
        setDocxError(null);
        setDocxBusy(true);
        try {
            // Dynamic import: the docx package is only ever needed here \u2014 same "own lazily
            // fetched chunk" reasoning as handlePdf above.
            const { buildManuscriptDocx } = await import('./docx-export.js');
            const blob = await buildManuscriptDocx(project);
            downloadBlob(`${filenameBase()}.docx`, blob);
        } catch (err) {
            console.error('DOCX export failed:', err);
            setDocxError("Couldn't generate the Word document \u2014 please try again.");
        } finally {
            setDocxBusy(false);
        }
    };
    const handleEpub = async () => {
        setEpubError(null);
        setEpubBusy(true);
        try {
            // Dynamic import: JSZip is only ever needed here \u2014 same reasoning as handlePdf/
            // handleDocx above.
            const { buildManuscriptEpub } = await import('./epub-export.js');
            const blob = await buildManuscriptEpub(project);
            downloadBlob(`${filenameBase()}.epub`, blob);
        } catch (err) {
            console.error('EPUB export failed:', err);
            setEpubError("Couldn't generate the EPUB \u2014 please try again.");
        } finally {
            setEpubBusy(false);
        }
    };
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Export Work"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "Export this manuscript for reading or editing outside Inkroot. This is separate from the project backup in Settings, which saves everything (characters, world, timeline) so it can be restored back into Inkroot."),
        project.chapters.length === 0
            ? React.createElement(EmptyState, { text: "Nothing to export yet \u2014 add a chapter first." })
            : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 560 } },
                React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2' } }, "Plain text (.txt)"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, "All chapters, in order, as plain text.")),
                    React.createElement("button", { onClick: handleTxt, style: {
                            background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                        } }, "Export .txt")),
                React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2' } }, "PDF (.pdf)"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, "All chapters, paginated, generated on-device."),
                        pdfError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 6 } }, pdfError),
                        pdfWarning && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C9A24B', marginTop: 6 } }, pdfWarning)),
                    React.createElement("button", { onClick: handlePdf, disabled: pdfBusy, style: {
                            background: pdfBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                            border: '1px solid #4A3D22', color: pdfBusy ? '#7A7A82' : '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                            cursor: pdfBusy ? 'default' : 'pointer', flexShrink: 0,
                        } }, pdfBusy ? "Generating\u2026" : "Export .pdf")),
                React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2' } }, "Word (.docx)"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, "All chapters, generated on-device \u2014 ready to keep editing in Word."),
                        docxError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 6 } }, docxError)),
                    React.createElement("button", { onClick: handleDocx, disabled: docxBusy, style: {
                            background: docxBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                            border: '1px solid #4A3D22', color: docxBusy ? '#7A7A82' : '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                            cursor: docxBusy ? 'default' : 'pointer', flexShrink: 0,
                        } }, docxBusy ? "Generating\u2026" : "Export .docx")),
                React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2' } }, "EPUB (.epub)"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, "All chapters, generated on-device \u2014 a real e-reader file, one chapter per spine entry."),
                        epubError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginTop: 6 } }, epubError)),
                    React.createElement("button", { onClick: handleEpub, disabled: epubBusy, style: {
                            background: epubBusy ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)',
                            border: '1px solid #4A3D22', color: epubBusy ? '#7A7A82' : '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                            cursor: epubBusy ? 'default' : 'pointer', flexShrink: 0,
                        } }, epubBusy ? "Generating\u2026" : "Export .epub"))));
}
