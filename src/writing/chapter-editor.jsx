import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LinkPicker, MentionDropdown } from '../shared-ui/form-fields.jsx';
import { IconSearch, IconX } from '../shared-ui/icons.jsx';
import { SectionLabel } from '../shared-ui/ui-cards.jsx';
import { SettingSegmented, SettingSlider, SettingToggle } from '../shared-ui/ui-primitives.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { SEARCH_GROUPS, globalSearch, searchAllEntities } from './achievements.jsx';
import { EntityPreviewCard, buildEntityPreview, stripInlineTextColor } from './health-checks.jsx';
import { sanitizeChapterHtml } from '../shared-utils/sanitize-html.js';
import { chapterLabel, createRangeFromCharOffsets, getTextBeforeCaret } from './project-schema-and-backups.jsx';
import { DEFAULT_READING_SETTINGS, READING_FONT_STACKS, READING_PAGE_WIDTHS, READING_PAGE_WIDTH_ORDER, READING_THEMES } from './reading-and-sound-settings.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';


// PERFORMANCE: onChangeHtml is what tells the parent project to store this chapter's new text —
// which (see ProjectWorkspace) rebuilds project state and re-triggers every manuscript-wide
// derived computation (co-mention edges, Story Health, word totals, autosave). Calling it on
// every single keystroke is what made very large (e.g. ~1M word) manuscripts feel laggy while
// typing: each keystroke was paying for a full project update cycle. The editor's own contenteditable
// div is uncontrolled (its DOM is only ever reset from React on chapter switch, see the effect
// below), so nothing about the *visible* typing experience depends on how quickly onChangeHtml
// itself fires — only autosave/backups and cross-manuscript features (Story Health, co-mention
// graph, search) need the parent to catch up, and those are fine catching up a moment later.
// So plain typing buffers its HTML locally and commits after a short pause; anything that isn't
// "just typing" — inserting a mention/link, switching chapters, or leaving the editor — commits
// immediately so nothing is ever silently dropped or delayed past the moment it actually matters.
const COMMIT_DEBOUNCE_MS = 400;


// The Reading Settings panel — a popover reachable via the ⚙ icon while Reading Mode is active.
// Every change is applied through onChange, which the caller persists to localStorage immediately.
export function ReadingSettingsPanel({ settings, onChange, onClose }) {
    const widthIndex = READING_PAGE_WIDTH_ORDER.indexOf(settings.pageWidth);
    // Derive the panel's own colors from the currently selected reading theme, so the
    // settings popover itself (not just the manuscript behind it) switches with Light/Sepia/Dark.
    const t = READING_THEMES[settings.theme] || READING_THEMES.dark;
    return React.createElement(React.Fragment, null,
        React.createElement("div", { onClick: onClose, style: { position: 'fixed', inset: 0, zIndex: 2400 } }),
        React.createElement("div", { className: "scrollbox ink-dropdown-in", style: {
                position: 'fixed', top: 58, right: 16, zIndex: 2401, width: 300, maxHeight: 'calc(100vh - 74px)', overflowY: 'auto',
                background: t.panel, border: `1px solid ${t.border}`, borderRadius: RADIUS_SCALE[12], boxShadow: '0 12px 36px rgba(0,0,0,0.5)',
                padding: 18, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[18],
                transition: 'background var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease)',
            } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: t.text } }, "Reading Settings"),
                React.createElement("button", { onClick: onClose, "aria-label": "Close", style: { background: 'none', border: 'none', color: t.muted, cursor: 'pointer', display: 'flex', padding: 2 } }, React.createElement(IconX, { width: "16", height: "16" }))),
            React.createElement("div", null,
                React.createElement(SectionLabel, null, "Font"),
                React.createElement(SettingSegmented, { theme: t, options: [
                        { value: 'serif', label: 'Serif' },
                        { value: 'sans', label: 'Sans Serif' },
                        { value: 'mono', label: 'Monospace' },
                    ], value: settings.fontFamily, onChange: (v) => onChange({ fontFamily: v }) })),
            React.createElement(SettingSlider, { theme: t, label: "Font size", value: settings.fontSize, min: 14, max: 28, step: 1, display: `${settings.fontSize}px`, onChange: (v) => onChange({ fontSize: v }) }),
            React.createElement(SettingSlider, { theme: t, label: "Line spacing", value: settings.lineSpacing, min: 1.3, max: 2.6, step: 0.05, display: settings.lineSpacing.toFixed(2), onChange: (v) => onChange({ lineSpacing: v }) }),
            React.createElement(SettingSlider, { theme: t, label: "Paragraph spacing", value: settings.paragraphSpacing, min: 0, max: 2.5, step: 0.1, display: `${settings.paragraphSpacing.toFixed(1)}em`, onChange: (v) => onChange({ paragraphSpacing: v }) }),
            React.createElement(SettingSlider, { theme: t, label: "Page width", value: widthIndex, min: 0, max: 2, step: 1, display: READING_PAGE_WIDTH_ORDER[widthIndex].replace(/^./, (c) => c.toUpperCase()), onChange: (v) => onChange({ pageWidth: READING_PAGE_WIDTH_ORDER[Math.round(v)] }) }),
            React.createElement("div", null,
                React.createElement(SectionLabel, null, "Text Alignment"),
                React.createElement(SettingSegmented, { theme: t, options: [
                        { value: 'left', label: 'Left' },
                        { value: 'justify', label: 'Justified' },
                    ], value: settings.textAlign, onChange: (v) => onChange({ textAlign: v }) })),
            React.createElement("div", null,
                React.createElement(SectionLabel, null, "Theme"),
                React.createElement(SettingSegmented, { theme: t, options: [
                        { value: 'light', label: 'Light', swatch: READING_THEMES.light.bg },
                        { value: 'sepia', label: 'Sepia', swatch: READING_THEMES.sepia.bg },
                        { value: 'dark', label: 'Dark', swatch: READING_THEMES.dark.bg },
                    ], value: settings.theme, onChange: (v) => onChange({ theme: v }) })),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], borderTop: `1px solid ${t.border}`, paddingTop: 14 } },
                React.createElement(SettingToggle, { theme: t, label: "Show chapter title", checked: settings.showChapterTitle, onChange: (v) => onChange({ showChapterTitle: v }) }),
                React.createElement(SettingToggle, { theme: t, label: "Immersive full-screen reading", checked: settings.immersive, onChange: (v) => onChange({ immersive: v }) }))));
}


// ---------- Manuscript editor with @mentions ----------
export function ChapterEditor({ chapter, onChangeHtml, onWordCountChange, characters, world, locations, glossary, timeline, chapters, onJump, readingMode, readingSettings, unitTerm }) {
    const editorRef = useRef(null);
    const toolbarRef = useRef(null);
    const pickerRef = useRef(null);
    const previewRef = useRef(null);
    const activeLinkEl = useRef(null); // the DOM span currently marked "open" while its preview card is showing
    // Buffers a not-yet-committed HTML edit while its debounce timer is pending (see
    // COMMIT_DEBOUNCE_MS above). null whenever there's nothing waiting to be committed.
    const pendingHtmlRef = useRef(null);
    const commitTimerRef = useRef(null);
    const [mention, setMention] = useState({ active: false, query: '', queryStart: -1, top: 0, left: 0 });
    const [mentionIndex, setMentionIndex] = useState(0);
    const [selectionInfo, setSelectionInfo] = useState(null); // { top, left, text, range }
    const [linkQuery, setLinkQuery] = useState(null); // string once the picker is open, else null
    const [preview, setPreview] = useState(null); // { type, id, top, left }
    // Clears the "open" highlight from whichever link span currently has it, then closes the card.
    const closePreview = () => {
        if (activeLinkEl.current) {
            activeLinkEl.current.classList.remove('link-open');
            activeLinkEl.current = null;
        }
        setPreview(null);
    };
    // Commits immediately and drops any pending debounced commit — used for anything that isn't
    // plain typing (mention/link insertion), where the parent needs to catch up right away.
    const commitNow = (html) => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
        }
        pendingHtmlRef.current = null;
        onChangeHtml(html);
    };
    // Buffers `html` and (re)starts the debounce timer; used for ordinary typing so the parent's
    // (expensive) project update doesn't run on every keystroke, only after a short typing pause.
    const scheduleCommit = (html) => {
        pendingHtmlRef.current = html;
        if (commitTimerRef.current)
            clearTimeout(commitTimerRef.current);
        commitTimerRef.current = setTimeout(() => {
            commitTimerRef.current = null;
            const pending = pendingHtmlRef.current;
            pendingHtmlRef.current = null;
            if (pending !== null)
                onChangeHtml(pending);
        }, COMMIT_DEBOUNCE_MS);
    };
    // Commits any buffered edit right away without cancelling anything further — used when
    // focus leaves the editor (e.g. blur), so a paused-but-not-yet-debounced edit isn't left
    // sitting unsaved for the full debounce window while the user is looking elsewhere.
    const flushPendingCommit = () => {
        if (commitTimerRef.current) {
            clearTimeout(commitTimerRef.current);
            commitTimerRef.current = null;
        }
        const pending = pendingHtmlRef.current;
        pendingHtmlRef.current = null;
        if (pending !== null)
            onChangeHtml(pending);
    };
    useEffect(() => {
        if (editorRef.current)
            editorRef.current.innerHTML = (chapter === null || chapter === void 0 ? void 0 : chapter.text) || '';
        // Switching chapters replaces the editor's DOM, so any element we were tracking is gone.
        activeLinkEl.current = null;
        setPreview(null);
        // Flush any edit still buffered for the chapter we're leaving — onChangeHtml is bound to
        // that chapter's id (see the caller), so this must run before that binding is gone, or
        // the last moments of typing before a chapter switch would be silently lost. This cleanup
        // also covers the editor unmounting entirely (e.g. leaving the Manuscript tab).
        return () => {
            if (commitTimerRef.current) {
                clearTimeout(commitTimerRef.current);
                commitTimerRef.current = null;
            }
            const pending = pendingHtmlRef.current;
            pendingHtmlRef.current = null;
            if (pending !== null)
                onChangeHtml(pending);
        };
    }, [chapter === null || chapter === void 0 ? void 0 : chapter.id]);
    const mentionItems = useMemo(() => searchAllEntities(mention.query, characters, locations, world, glossary, timeline).slice(0, 8), [mention.query, characters, world, locations, glossary, timeline]);
    const linkItems = useMemo(() => (linkQuery === null ? [] : searchAllEntities(linkQuery, characters, locations, world, glossary, timeline)), [linkQuery, characters, world, locations, glossary, timeline]);
    const previewData = useMemo(() => (preview ? buildEntityPreview(preview.type, preview.id, { characters, locations, world, glossary, timeline, chapters }) : null), [preview, characters, locations, world, glossary, timeline, chapters]);
    // Close the preview card on any click outside it.
    useEffect(() => {
        if (!preview)
            return;
        const handler = (e) => {
            if (previewRef.current && previewRef.current.contains(e.target))
                return;
            closePreview();
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [preview]);
    // Close the select-to-link toolbar/picker on any click outside them.
    useEffect(() => {
        if (!selectionInfo && linkQuery === null)
            return;
        const handler = (e) => {
            if (toolbarRef.current && toolbarRef.current.contains(e.target))
                return;
            if (pickerRef.current && pickerRef.current.contains(e.target))
                return;
            setSelectionInfo(null);
            setLinkQuery(null);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [selectionInfo, linkQuery]);
    const checkSelection = () => {
        if (readingMode)
            return;
        const sel = window.getSelection();
        if (!sel || sel.rangeCount === 0 || sel.isCollapsed)
            return;
        const range = sel.getRangeAt(0);
        if (!editorRef.current || !editorRef.current.contains(range.commonAncestorContainer))
            return;
        const text = range.toString();
        if (!text.trim())
            return;
        const container = range.commonAncestorContainer;
        const el = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
        if (el && el.closest && el.closest('[data-mention-id]'))
            return; // already linked
        const rect = range.getBoundingClientRect();
        setSelectionInfo({ top: rect.top, left: rect.left + rect.width / 2, text, range: range.cloneRange() });
        setLinkQuery(null);
    };
    const handleInput = (e) => {
        if (readingMode)
            return;
        const div = e.currentTarget;
        const html = sanitizeChapterHtml(stripInlineTextColor(div.innerHTML));
        // Word count is cheap here — it's only ever this one chapter's text, not the whole
        // manuscript — so it stays instant even though the full project commit below is
        // debounced. See onWordCountChange's caller for how this is displayed.
        if (onWordCountChange)
            onWordCountChange(wordCount(html));
        scheduleCommit(html);
        setSelectionInfo(null);
        setLinkQuery(null);
        const textBefore = getTextBeforeCaret(div);
        const match = textBefore.match(/@([a-zA-Z0-9' -]{0,30})$/);
        if (match) {
            const sel = window.getSelection();
            const range = sel.getRangeAt(0).cloneRange();
            const rect = range.getBoundingClientRect();
            setMention({
                active: true, query: match[1], queryStart: textBefore.length - match[0].length,
                top: (rect.bottom || 0) + 6, left: rect.left || 0,
            });
            setMentionIndex(0);
        }
        else if (mention.active) {
            setMention((m) => ({ ...m, active: false, queryStart: -1 }));
        }
    };
    const insertMention = (item) => {
        const div = editorRef.current;
        if (!div || mention.queryStart < 0)
            return;
        // Build the range to replace purely from character offsets tracked in state — the start of
        // "@" (queryStart) and its end (queryStart + "@".length + the query text typed since). This
        // never touches window.getSelection() here, so it can't be thrown off by a tap on the
        // suggestion list moving or clearing the live selection/focus before this runs, which is
        // what let the typed "@query" text survive untouched alongside the newly inserted mention
        // (the visible duplicate).
        const range = createRangeFromCharOffsets(div, mention.queryStart, mention.queryStart + 1 + mention.query.length);
        if (!range)
            return;
        range.deleteContents();
        const span = document.createElement('span');
        span.setAttribute('data-mention-id', item.id);
        span.setAttribute('data-mention-type', item.type);
        span.setAttribute('contenteditable', 'false');
        span.className = 'mention-chip';
        span.textContent = item.name || 'Unnamed';
        range.insertNode(span);
        const space = document.createTextNode('\u00A0');
        const after = document.createRange();
        after.setStartAfter(span);
        after.collapse(true);
        after.insertNode(space);
        after.setStartAfter(space);
        after.collapse(true);
        const sel = window.getSelection();
        if (sel) {
            sel.removeAllRanges();
            sel.addRange(after);
        }
        setMention((m) => ({ ...m, active: false, queryStart: -1 }));
        const html = sanitizeChapterHtml(stripInlineTextColor(div.innerHTML));
        if (onWordCountChange)
            onWordCountChange(wordCount(html));
        commitNow(html);
        div.focus();
    };
    const insertLink = (item) => {
        const div = editorRef.current;
        if (!selectionInfo || !div)
            return;
        try {
            const range = selectionInfo.range;
            const text = selectionInfo.text;
            range.deleteContents();
            const span = document.createElement('span');
            span.setAttribute('data-mention-id', item.id);
            span.setAttribute('data-mention-type', item.type);
            span.setAttribute('contenteditable', 'false');
            span.className = 'ref-link';
            span.textContent = text;
            range.insertNode(span);
            const html = sanitizeChapterHtml(stripInlineTextColor(div.innerHTML));
            if (onWordCountChange)
                onWordCountChange(wordCount(html));
            commitNow(html);
        }
        catch (e) {
            // Selection range went stale (rare) — just drop the attempt quietly.
        }
        setSelectionInfo(null);
        setLinkQuery(null);
        const sel = window.getSelection();
        if (sel)
            sel.removeAllRanges();
        div.focus();
    };
    const handleKeyDown = (e) => {
        if (readingMode)
            return;
        if (mention.active) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => Math.min(mentionItems.length - 1, i + 1));
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => Math.max(0, i - 1));
                return;
            }
            if (e.key === 'Enter') {
                if (mentionItems.length) {
                    e.preventDefault();
                    insertMention(mentionItems[mentionIndex]);
                }
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                setMention((m) => ({ ...m, active: false }));
                return;
            }
        }
        if (e.key === 'Escape' && (selectionInfo || linkQuery !== null)) {
            setSelectionInfo(null);
            setLinkQuery(null);
        }
        if (e.key === 'Escape' && preview) {
            closePreview();
        }
    };
    const handleClick = (e) => {
        const el = e.target.closest && e.target.closest('[data-mention-id]');
        if (!el) {
            closePreview();
            return;
        }
        const id = el.getAttribute('data-mention-id');
        const type = el.getAttribute('data-mention-type');
        const rect = el.getBoundingClientRect();
        if (activeLinkEl.current && activeLinkEl.current !== el) {
            activeLinkEl.current.classList.remove('link-open');
        }
        el.classList.add('link-open');
        activeLinkEl.current = el;
        setPreview({ type, id, top: rect.bottom + 8, left: rect.left });
    };
    const rs = readingSettings || DEFAULT_READING_SETTINGS;
    const theme = readingMode ? (READING_THEMES[rs.theme] || READING_THEMES.dark) : null;
    const readingFontFamily = readingMode ? (READING_FONT_STACKS[rs.fontFamily] || READING_FONT_STACKS.serif) : "'Fraunces', Georgia, serif";
    const pageWidthPx = READING_PAGE_WIDTHS[rs.pageWidth] || READING_PAGE_WIDTHS.medium;
    return (React.createElement(React.Fragment, null,
        React.createElement("div", { style: readingMode ? { maxWidth: pageWidthPx, margin: '0 auto', '--ink-para-gap': `${rs.paragraphSpacing}em` } : undefined },
            readingMode && rs.showChapterTitle && (React.createElement("div", { style: {
                    fontFamily: readingFontFamily, fontSize: TYPE_SCALE[15], fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase',
                    color: theme.muted, marginBottom: 22, textAlign: rs.textAlign === 'justify' ? 'center' : rs.textAlign,
                } }, chapterLabel(chapters, chapter === null || chapter === void 0 ? void 0 : chapter.id, unitTerm))),
            React.createElement("div", { ref: editorRef, contentEditable: !readingMode, spellCheck: !readingMode, suppressContentEditableWarning: true, "data-placeholder": "Begin writing\u2026 (type @ to link, or select existing words to link them)", onInput: handleInput, onKeyDown: handleKeyDown, onKeyUp: checkSelection, onMouseUp: checkSelection, onClick: handleClick, onBlur: () => { setMention((m) => ({ ...m, active: false })); flushPendingCommit(); }, className: readingMode ? 'reading-content' : undefined, style: {
                    width: '100%', minHeight: '68vh', color: readingMode ? theme.text : '#EFE7D2',
                    fontFamily: readingFontFamily, fontSize: readingMode ? rs.fontSize : 18, lineHeight: readingMode ? rs.lineSpacing : 1.8, outline: 'none',
                    textAlign: readingMode ? rs.textAlign : 'left',
                    caretColor: readingMode ? 'transparent' : 'auto', cursor: readingMode ? 'default' : 'text',
                } })),
        mention.active && (React.createElement(MentionDropdown, { items: mentionItems, activeIndex: mentionIndex, top: mention.top, left: mention.left, onSelect: insertMention })),
        preview && previewData && (React.createElement(EntityPreviewCard, { cardRef: previewRef, data: previewData, top: preview.top, left: preview.left, onOpen: (type, id) => { closePreview(); onJump(type, id); }, readingMode: readingMode, theme: theme })),
        selectionInfo && linkQuery === null && (React.createElement("div", { ref: toolbarRef, onMouseDown: (e) => { e.preventDefault(); setLinkQuery(selectionInfo.text); }, style: {
                position: 'fixed', top: selectionInfo.top - 42, left: selectionInfo.left, transform: 'translateX(-50%)',
                background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: '7px 12px',
                fontSize: TYPE_SCALE[13], color: '#EFE7D2', cursor: 'pointer', boxShadow: '0 8px 20px rgba(0,0,0,0.4)', zIndex: 1000,
                whiteSpace: 'nowrap',
            } },
            "Link \"",
            selectionInfo.text.length > 22 ? selectionInfo.text.slice(0, 22) + '…' : selectionInfo.text,
            "\"")),
        selectionInfo && linkQuery !== null && (React.createElement("div", { ref: pickerRef },
            React.createElement(LinkPicker, { top: selectionInfo.top - 42, left: selectionInfo.left, query: linkQuery, onQueryChange: setLinkQuery, items: linkItems, onSelect: insertLink })))));
}


// ---------- Global search ----------
export function GlobalSearchOverlay({ project, onClose, onJumpResult }) {
    const [query, setQuery] = useState('');
    const inputRef = useRef(null);
    useEffect(() => { if (inputRef.current)
        inputRef.current.focus(); }, []);
    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape')
            onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);
    // Recomputes live on every keystroke — there's no separate "search" action to trigger it.
    const results = useMemo(() => globalSearch(project, query), [project, query]);
    const totalCount = SEARCH_GROUPS.reduce((n, g) => n + results[g.key].length, 0);
    const q = query.trim();
    const renderResultRow = (groupKey, item, i) => {
        return React.createElement("div", { key: item.id, onClick: () => onJumpResult(groupKey, item.id), className: "hoverable ink-row-in", style: { padding: '10px 10px', borderRadius: RADIUS_SCALE[8], cursor: 'pointer', marginBottom: 2, '--i': Math.min(i, 8) } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14.5], color: '#EFE7D2', fontWeight: 600 } }, item.title),
            item.snippet ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 2, lineHeight: 1.4 } }, item.snippet) : null);
    };
    const renderResultGroup = (group) => {
        const items = results[group.key];
        if (!items.length)
            return null;
        const header = React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], padding: '14px 4px 8px', position: 'sticky', top: 0, background: '#17171B' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, group.icon),
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13], letterSpacing: '0.08em', textTransform: 'uppercase', color: '#C89B3C', fontWeight: 600 } }, group.label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, items.length));
        return React.createElement("div", { key: group.key, style: { marginBottom: 18 } }, header, items.map((item, i) => renderResultRow(group.key, item, i)));
    };
    const header = React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '14px 16px', borderBottom: '1px solid #2A2A30', flexShrink: 0 } },
        React.createElement(IconSearch, { style: { color: '#7A7A82', flexShrink: 0 } }),
        React.createElement("input", { ref: inputRef, value: query, onChange: (e) => setQuery(e.target.value), placeholder: "Search your entire project\u2026", style: { flex: 1, background: 'transparent', border: 'none', outline: 'none', color: '#EFE7D2', fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], minWidth: 0 } }),
        React.createElement("button", { onClick: onClose, "aria-label": "Close search", style: { background: 'none', border: 'none', color: '#A6A6AD', cursor: 'pointer', display: 'flex', flexShrink: 0, padding: 4 } }, React.createElement(IconX, null)));
    const emptyState = !q
        ? React.createElement("div", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13.5], padding: '24px 4px' } }, "Start typing to search chapters, characters, locations, organizations, items, notes, timeline events, and more.")
        : (totalCount === 0 ? React.createElement("div", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13.5], padding: '24px 4px' } }, "No results for \u201C" + q + "\u201D.") : null);
    const body = React.createElement("div", { className: "scrollbox", style: { flex: 1, overflowY: 'auto', padding: '8px 16px 40px' } },
        emptyState,
        q ? SEARCH_GROUPS.map(renderResultGroup) : null);
    return React.createElement("div", { className: "ink-overlay-in", style: { position: 'fixed', inset: 0, background: '#17171B', zIndex: 3000, display: 'flex', flexDirection: 'column', color: '#EFE7D2' } }, header, body);
}
