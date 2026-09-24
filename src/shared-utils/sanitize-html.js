import DOMPurify from 'dompurify';

// Shared allowlist for chapter body HTML — covers exactly what the app's own contentEditable
// editor (chapter-editor.jsx) and PDF/.txt import (import-export.jsx's textToChapterHtml) ever
// produce themselves: paragraph-level divs/breaks from typing, basic inline formatting a browser's
// contentEditable can apply or that gets pasted in from Word/Docs, and the app's own mention-link
// spans (data-mention-id / data-mention-type, set by chapter-editor.jsx's insertMention).
//
// Anything outside this allowlist — <script>, <iframe>, <img>, event-handler attributes
// (onerror=, onclick=, ...), javascript: URLs, etc. — is stripped rather than passed through.
// This matters most at read time: PublishedBookReader (author-reputation.jsx) renders a chapter's
// HTML with dangerouslySetInnerHTML in every *reader's* browser, not just the author's own, so
// unsanitized chapter HTML is a stored-XSS path from one account into every reader who opens that
// book. It's also applied at save time in chapter-editor.jsx as defense in depth, so nothing
// unexpected ever lands in a chapter's stored text in the first place.
const ALLOWED_TAGS = ['div', 'br', 'p', 'b', 'strong', 'i', 'em', 'u', 's', 'span', 'a'];
// class/contenteditable are included because chapter-editor.jsx's insertLink() sets both on its
// mention spans ('ref-link' class, contenteditable="false" so a reader/editor caret can't land
// inside the link text) — neither can execute script on its own, unlike style= or on*= handlers,
// which stay off this list.
const ALLOWED_ATTR = ['data-mention-id', 'data-mention-type', 'href', 'class', 'contenteditable'];

export function sanitizeChapterHtml(html) {
    if (!html)
        return html || '';
    // DOMPurify's default ALLOWED_URI_REGEXP already restricts href to safe schemes
    // (http/https/mailto/tel/relative — never javascript:), so no extra URL handling is needed
    // beyond restricting which tags/attributes are allowed at all.
    return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
}
