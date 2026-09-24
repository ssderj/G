import React from 'react';


// ---------- Text helpers ----------
// Converts a chapter's stored HTML (one <div> per paragraph/line, as written by the editor and
// by textToChapterHtml on import — see import-export.jsx) into plain text for every export path
// (buildManuscriptText, buildManuscriptPdf) and every other plain-text consumer (word count,
// search snippets, library previews).
//
// Block boundaries (</div>, </p>, </li>, </h1>-</h6>, <br>) become real newlines here, BEFORE
// the generic tag-stripping pass. They used to fall through to that generic pass, which replaces
// every tag with a single space — collapsing an entire chapter's paragraph structure into one
// continuous run-on block of text on export, with no blank lines or line breaks left anywhere.
//
// The editor can also store a soft line break *inside* a single paragraph as a literal Unicode
// LINE/PARAGRAPH SEPARATOR character (U+2028/U+2029) rather than markup. Our bundled PDF export
// font has no glyph for either, so left alone they render as a literal "?" wherever the writer
// used one — see buildManuscriptPdf's sanitizeForFont. Normalizing them to real newlines here,
// upstream of every export path, means they behave like the line breaks they actually are
// instead of corrupting the exported text.
export function stripHtml(html) {
    return (html || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(div|p|li|h[1-6])>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/[\u2028\u2029]/g, '\n')
        .replace(/[ \t]+/g, ' ')
        .replace(/ ?\n ?/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^[ \t]+|[ \t]+$/gm, '');
}


export function wordCount(text) {
    const t = stripHtml(text).trim();
    return t ? t.split(/\s+/).length : 0;
}
