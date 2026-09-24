import React, { useState, useRef, useEffect } from 'react';
import { IconGear, IconX, IconDownload } from '../shared-ui/icons.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ReadingSettingsPanel } from '../writing/chapter-editor.jsx';
import { chapterLabel } from '../writing/project-schema-and-backups.jsx';
import { READING_FONT_STACKS, READING_PAGE_WIDTHS, READING_SETTINGS_KEY, READING_THEMES, loadReadingSettings } from '../writing/reading-and-sound-settings.jsx';
import { bookFormatTerm, isSerialFormat, resolvePublishStatus } from './publishing.jsx';
import { computeAchievements, computeStreak, runHealthChecks } from '../writing/health-checks.jsx';
import { sanitizeChapterHtml } from '../shared-utils/sanitize-html.js';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { recordReadingHeartbeat } from '../lib/rising-stars.js';
import { downloadBookFile } from '../lib/library.js';
import { downloadBlob } from '../writing/import-export.jsx';


// ---------- Published Book Reader (what a reader sees, not what the author sees) ----------
// The screen a tap on a book in the Grand Library or a Guild's bookshelf opens. Deliberately its
// own top-level screen — a sibling of ProjectWorkspace, not a "mode" inside it — so there is no
// path from here into the author's characters, locations, maps, timeline, world bible, glossary,
// notes, story health, progress, achievements, or settings: those stay reachable only by opening
// the project from the author's own Home shelf or Author Studio (see InkRoot's `currentId`
// branch and GrandLibraryScreen's Author Studio view). This component only ever receives the
// finished chapters and a title/author to show; it has no way to reach anything else even if it
// wanted to. Reading preferences (font, theme, spacing…) reuse the same device-level settings the
// author's own in-editor Reading Mode uses — there's no meaningful per-reader account to key them
// to differently here.
export function PublishedBookReader({ project, bookId, downloadable, onBack }) {
    const chapters = (project && project.chapters) || [];
    // 'idle' | 'pdf' | 'epub' while a download-book Edge Function call is in flight, keyed to
    // which format was requested so both buttons can show their own loading state independently.
    // See lib/library.js's downloadBookFile for why this is a server round trip rather than
    // building the file from `project` (already in memory) directly.
    const [downloadState, setDownloadState] = useState('idle');
    const [downloadError, setDownloadError] = useState(null);
    const handleDownload = async (format) => {
        setDownloadState(format);
        setDownloadError(null);
        try {
            const { blob, filename } = await downloadBookFile(bookId, format);
            downloadBlob(filename, blob);
        }
        catch (e) {
            setDownloadError((e && e.message) || 'Could not download this book.');
        }
        finally {
            setDownloadState('idle');
        }
    };
    // A reader lands on the book's own front cover first — a dedicated "page" before chapter
    // one, not a detail she has to go looking for elsewhere. `showCover` is that page; it's
    // false the moment she moves past it (Start Reading, a swipe/Next, or picking a chapter from
    // the list) and true again if she swipes/Previous's back past chapter one. This mirrors the
    // PDF export, where the same cover is always page 1 ahead of the manuscript (see
    // buildManuscriptPdf's drawCoverPage in pdf-export.js) — the reading experience was the one
    // place that skipped straight past it into chapter text, as if the cover were just another
    // shelf thumbnail rather than the book's actual front cover.
    // Gate the cover screen behind there actually being something to read past it — with no
    // chapters yet, showing a "Start Reading" cover with no working button behind it would trap
    // a reader there instead of surfacing the existing "doesn't have any chapters yet" message.
    const [showCover, setShowCover] = useState(chapters.length > 0);
    const [activeChapterId, setActiveChapterId] = useState(chapters[0] ? chapters[0].id : null);
    const [readingSettings, setReadingSettingsState] = useState(() => loadReadingSettings());
    const [readingSettingsOpen, setReadingSettingsOpen] = useState(false);
    // The reader-facing episode/chapter list — see EpisodeListPanel below. A short serialized
    // story and a traditional book both browse through the exact same list; only the label
    // ("Episode"/"Chapter", from the project's own storyFormat — see bookFormatTerm) differs.
    const [episodeListOpen, setEpisodeListOpen] = useState(false);
    const unitTerm = bookFormatTerm(project);
    const unitTermPlural = bookFormatTerm(project, true);
    // Toward nairaReader/nairaLoyal's verified-reading-minutes signal (see
    // supabase/history/53_migration_naira_writing_and_reading_signals.sql). Pings roughly once a
    // minute, but only while this tab is actually the visible one — document.visibilityState is
    // checked fresh at every tick rather than once at mount, so backgrounding the tab partway
    // through a session stops heartbeats immediately rather than only on the next open. This is
    // a bound on the obvious "leave it open overnight" abuse, not a guarantee against a modified
    // client — record_reading_heartbeat's own server-side throttle and daily cap are what
    // actually limit the damage either way, this is just the honest-client half of that.
    // Deliberately keyed to bookId (the same id logBookRead above already uses), not project.id —
    // the local project object has no id field of its own; see ink-root.jsx's openReaderBook.
    useEffect(() => {
        if (!bookId) return;
        const interval = setInterval(() => {
            if (document.visibilityState === 'visible') recordReadingHeartbeat(bookId);
        }, 60000);
        return () => clearInterval(interval);
    }, [bookId]);
    const updateReadingSettings = (patch) => {
        setReadingSettingsState((prev) => {
            const next = { ...prev, ...patch };
            try {
                localStorage.setItem(READING_SETTINGS_KEY, JSON.stringify(next));
            }
            catch (e) { }
            return next;
        });
    };
    const activeIndex = chapters.findIndex((c) => c.id === activeChapterId);
    const chapter = activeIndex >= 0 ? chapters[activeIndex] : null;
    const theme = READING_THEMES[readingSettings.theme] || READING_THEMES.dark;
    const fontFamily = READING_FONT_STACKS[readingSettings.fontFamily] || READING_FONT_STACKS.serif;
    const pageWidthPx = READING_PAGE_WIDTHS[readingSettings.pageWidth] || READING_PAGE_WIDTHS.medium;
    // goPrev/goNext now also cover the transition into and out of the cover page, so the same
    // Previous/Next buttons and the same swipe gesture below (unchanged) carry a reader from the
    // cover to chapter one and back, instead of the cover being reachable only on first load.
    const goPrev = () => {
        if (showCover) return;
        if (activeIndex > 0) setActiveChapterId(chapters[activeIndex - 1].id);
        else setShowCover(true);
    };
    const goNext = () => {
        if (showCover) {
            if (chapters.length > 0) setShowCover(false);
            return;
        }
        if (activeIndex >= 0 && activeIndex < chapters.length - 1) setActiveChapterId(chapters[activeIndex + 1].id);
    };
    // Swipe-to-turn-page: track the horizontal start point of a touch and, on release, compare
    // against a distance/angle threshold so a mostly-horizontal drag changes chapters while a
    // vertical scroll (or a diagonal scroll-ish gesture) is left alone.
    const touchStart = useRef(null);
    const handleTouchStart = (e) => {
        const t = e.touches[0];
        touchStart.current = { x: t.clientX, y: t.clientY };
    };
    const handleTouchEnd = (e) => {
        if (!touchStart.current)
            return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touchStart.current.x;
        const dy = t.clientY - touchStart.current.y;
        touchStart.current = null;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5)
            return;
        if (dx < 0)
            goNext();
        else
            goPrev();
    };
    return React.createElement("div", { style: {
            minHeight: '100vh', background: theme.bg, color: theme.text,
            fontFamily: "ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif",
            display: 'flex', flexDirection: 'column',
            transition: 'background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease)',
        } },
        React.createElement("style", null, `
            .inkroot-reader-body > p, .inkroot-reader-body > div { margin: 0 0 ${readingSettings.paragraphSpacing}em 0; }
            /* Some paragraphs carry their own inline color (left over from pasted content, or from
               edits made before the theme system existed). An inline style always beats a class
               rule, so without !important here those paragraphs keep whatever color they were
               saved with — invisible on Light, barely visible on Sepia — regardless of the theme
               picked here. Force every descendant back to the active theme's text color, the same
               fix already applied to the author's in-editor Reading Mode. */
            .inkroot-reader-body * { color: ${theme.text} !important; }
        `),
        !readingSettings.immersive && React.createElement("div", { style: {
                padding: '14px 16px', borderBottom: `1px solid ${theme.border}`,
                position: 'sticky', top: 0, zIndex: 20, background: theme.bg,
                transition: 'background var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease)',
            } },
            // The bar itself stays full-width (so its background/border reach the edges of the
            // screen), but its controls are capped and centered to the same comfortable width as
            // the reading column below — otherwise on a wide desktop window Back/Episodes/Settings
            // would end up pinned to opposite edges of the browser, far from the text they act on.
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[8], flexWrap: 'wrap', maxWidth: 1100, margin: '0 auto' } },
                React.createElement("button", { onClick: onBack, style: {
                        display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none',
                        border: `1px solid ${theme.border}`, color: theme.muted, borderRadius: RADIUS_SCALE[8],
                        padding: '7px 13px', fontSize: TYPE_SCALE[13], cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
                    } }, "\u2190 Back to Library"),
                React.createElement("div", { style: { textAlign: 'center', flex: '1 1 auto', minWidth: 0 } },
                    React.createElement("div", { style: {
                            fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: theme.text,
                            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        } }, (project && project.title && project.title.trim()) || 'Untitled Novel'),
                    project && project.author && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: theme.muted, marginTop: 1 } }, "by " + project.author)),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], flexShrink: 0 } },
                    project && project.id && React.createElement(ReportButton, {
                        // content_type is 'published_book' regardless of whether this book was opened from
                        // the Grand Library or a Guild's bookshelf — this reader has no guildId prop to
                        // distinguish the two (see ink-root.jsx's single readingBookProject caller), and a
                        // project's id is the same value either way (guild "Promote to Inkroot" reuses the
                        // same record, no re-upload — see GuildBookFeedbackModal), so a moderator can still
                        // find the right listing from content_id alone.
                        contentType: "published_book", contentId: project.id,
                    }),
                    chapters.length > 1 && React.createElement("button", { onClick: () => { setReadingSettingsOpen(false); setEpisodeListOpen(true); }, title: `${unitTermPlural} list`, "aria-label": `${unitTermPlural} list`, style: {
                            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: `1px solid ${theme.border}`, color: theme.muted,
                            borderRadius: RADIUS_SCALE[8], padding: '0 12px', height: 32, fontSize: TYPE_SCALE[12.5], cursor: 'pointer', fontFamily: 'inherit',
                        } }, "\u2630", isSerialFormat(project) ? ' Episodes' : ' Chapters'),
                    React.createElement("button", { onClick: () => setReadingSettingsOpen((o) => { if (!o) setEpisodeListOpen(false); return !o; }), title: "Reading Settings", "aria-label": "Reading Settings", style: {
                            background: 'none', border: `1px solid ${theme.border}`, color: theme.muted, borderRadius: RADIUS_SCALE[8],
                            width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0,
                        } }, React.createElement(IconGear, null))))),
        readingSettings.immersive && React.createElement("button", { onClick: () => updateReadingSettings({ immersive: false }), title: "Exit immersive reading", "aria-label": "Exit immersive reading", style: {
                position: 'fixed', top: 14, right: 14, zIndex: 30, background: theme.panel, border: `1px solid ${theme.border}`,
                color: theme.muted, borderRadius: RADIUS_SCALE[8], width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            } }, React.createElement(IconX, { width: "15", height: "15" })),
        readingSettings.immersive && chapters.length > 1 && React.createElement("button", { onClick: () => { setReadingSettingsOpen(false); setEpisodeListOpen(true); }, title: `${unitTermPlural} list`, "aria-label": `${unitTermPlural} list`, style: {
                position: 'fixed', top: 14, right: 58, zIndex: 30, background: theme.panel, border: `1px solid ${theme.border}`,
                color: theme.muted, borderRadius: RADIUS_SCALE[8], width: 32, height: 32, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
            } }, "\u2630"),
        readingSettingsOpen && React.createElement(ReadingSettingsPanel, { settings: readingSettings, onChange: updateReadingSettings, onClose: () => setReadingSettingsOpen(false) }),
        episodeListOpen && React.createElement(EpisodeListPanel, {
            project, chapters, activeChapterId: showCover ? null : activeChapterId, theme, unitTerm, unitTermPlural,
            onSelect: (id) => { setShowCover(false); setActiveChapterId(id); setEpisodeListOpen(false); },
            onClose: () => setEpisodeListOpen(false),
        }),
        showCover
            ? React.createElement("div", { className: "scrollbox", onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd, style: {
                    flex: 1, overflowY: 'auto', padding: '40px 16px', display: 'flex', flexDirection: 'column',
                    alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[26], textAlign: 'center',
                } },
                // The book's actual front cover — same BookCover component and same `project.cover`
                // the author set in Settings and the PDF export embeds as its own page 1 (see
                // book-cover.jsx). Rendered at the new 'xl' size so it reads as a cover, not a
                // shelf thumbnail. No title/author text is drawn over a custom uploaded image here
                // either (BookCover already skips that whenever cover.customImageUrl is set) —
                // an uploaded cover that already carries its own title lettering is never doubled up.
                React.createElement(BookCover, { title: project.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author, cover: project.cover, size: 'xl' }),
                chapters.length > 0 && React.createElement("button", { onClick: () => setShowCover(false), style: {
                        background: '#C89B3C', border: '1px solid #C89B3C', color: '#17171B', fontWeight: 600,
                        borderRadius: RADIUS_SCALE[8], padding: '11px 28px', fontSize: TYPE_SCALE[14], cursor: 'pointer', fontFamily: 'inherit',
                    } }, isSerialFormat(project) ? `Start Reading ${unitTerm}s` : 'Start Reading'),
                // Only shown when the author opted this specific book into downloads (see the
                // publishing wizard's Step 3 toggle) — most books won't show this at all.
                downloadable && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SPACE_SCALE[8] } },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: theme.muted } }, "Also available to keep and read offline"),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                        ['pdf', 'epub'].map((format) => React.createElement("button", {
                            key: format,
                            onClick: () => handleDownload(format),
                            disabled: downloadState !== 'idle',
                            style: {
                                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                                background: 'none', border: `1px solid ${theme.border}`, color: theme.muted, fontWeight: 600,
                                borderRadius: RADIUS_SCALE[8], padding: '9px 18px', fontSize: TYPE_SCALE[12.5],
                                cursor: downloadState !== 'idle' ? 'default' : 'pointer', fontFamily: 'inherit',
                                opacity: downloadState !== 'idle' && downloadState !== format ? 0.5 : 1,
                            },
                        }, React.createElement(IconDownload, null), downloadState === format ? 'Preparing\u2026' : format.toUpperCase()))),
                    downloadError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A', maxWidth: 320 } }, downloadError)))
            : React.createElement("div", { className: "scrollbox", onTouchStart: handleTouchStart, onTouchEnd: handleTouchEnd, style: { flex: 1, overflowY: 'auto', padding: '28px 16px' } },
            React.createElement("div", { style: { maxWidth: pageWidthPx, margin: '0 auto' } },
                readingSettings.showChapterTitle && chapter && React.createElement("div", { style: {
                        fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontWeight: 600, textAlign: 'center',
                        marginBottom: 26, color: theme.text,
                    } }, chapterLabel(chapters, chapter.id, unitTerm)),
                chapter
                    ? React.createElement("div", { className: "inkroot-reader-body", dangerouslySetInnerHTML: { __html: sanitizeChapterHtml(chapter.text) }, style: {
                            fontFamily, fontSize: readingSettings.fontSize, lineHeight: readingSettings.lineSpacing,
                            textAlign: readingSettings.textAlign, color: theme.text,
                        } })
                    : React.createElement(EmptyState, { text: `This ${(isSerialFormat(project) ? 'story' : 'book')} doesn't have any ${unitTermPlural.toLowerCase()} yet.` }),
                chapters.length > 0 && React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', marginTop: 36, paddingTop: 20, borderTop: `1px solid ${theme.border}` } },
                    // Previous is only truly disabled once there's nowhere left to go — chapter one's
                    // "Previous" now steps back to the cover (see goPrev) instead of being a dead end.
                    React.createElement("button", { onClick: goPrev, style: {
                            background: 'none', border: `1px solid ${theme.border}`, color: theme.text,
                            borderRadius: RADIUS_SCALE[8], padding: '8px 16px', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                        } }, "\u2190 Previous"),
                    React.createElement("button", { onClick: goNext, disabled: activeIndex >= chapters.length - 1, style: {
                            background: 'none', border: `1px solid ${theme.border}`, color: theme.text,
                            borderRadius: RADIUS_SCALE[8], padding: '8px 16px', fontSize: TYPE_SCALE[13], cursor: activeIndex >= chapters.length - 1 ? 'default' : 'pointer', opacity: activeIndex >= chapters.length - 1 ? 0.4 : 1,
                        } }, "Next \u2192")))));
}


// ---------- Episode / Chapter list panel ----------
// What a reader opens (via the \u2630 button above) to see this story's full table of contents and
// jump straight to any installment — the concrete answer to "readers should be able to see the
// story's episode/chapter list and open individual episodes." Same list for a traditional book
// and a serialized story; only the heading and each row's label (see chapterLabel's `term`
// argument) change, driven by the project's own storyFormat (see bookFormatTerm). Styled as a
// right-hand drawer, echoing CartDrawer and the Guild's own panels elsewhere in Inkroot, so it
// reads as part of the same literary-publishing shell rather than a bolted-on picker.
function EpisodeListPanel({ project, chapters, activeChapterId, theme, unitTerm, unitTermPlural, onSelect, onClose }) {
    // Same z-index band as ReadingSettingsPanel (chapter-editor.jsx) — the two are mutually
    // exclusive by construction (each toggle closes the other before opening; see the header
    // buttons above), but keeping both overlays in the same stacking band means that stays true
    // even if that mutual-exclusion guard is ever loosened, instead of one silently burying the
    // other under the reader's sticky header (zIndex 20) the way a much lower number would.
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 2400, background: 'rgba(10,9,7,0.6)', backdropFilter: 'blur(2px)',
            display: 'flex', alignItems: 'stretch', justifyContent: 'flex-end',
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: 'min(360px, 88vw)', maxHeight: '100vh', overflowY: 'auto',
                background: theme.panel, borderLeft: `1px solid ${theme.border}`,
                padding: '20px 16px', boxShadow: '-16px 0 44px rgba(0,0,0,0.45)',
                position: 'relative', zIndex: 2401,
            } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
                React.createElement("div", null,
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: theme.text } }, unitTermPlural),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: theme.muted, marginTop: 2 } }, (project && project.title && project.title.trim()) || 'Untitled Novel')),
                React.createElement("button", { onClick: onClose, "aria-label": "Close", style: {
                        background: 'none', border: 'none', color: theme.muted, fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            React.createElement("div", { style: { marginTop: 16, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
                chapters.map((c, idx) => {
                    const active = c.id === activeChapterId;
                    const words = wordCount(c.text);
                    const custom = c.title ? c.title.trim() : '';
                    return React.createElement("button", { key: c.id, onClick: () => onSelect(c.id), style: {
                            display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 2, textAlign: 'left', width: '100%',
                            background: active ? 'rgba(232,196,104,0.12)' : 'transparent', border: active ? '1px solid #C89B3C' : `1px solid transparent`,
                            borderRadius: RADIUS_SCALE[8], padding: '9px 11px', cursor: 'pointer', fontFamily: 'inherit',
                        } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[13], fontWeight: active ? 700 : 500, color: active ? '#E8C468' : theme.text } },
                            `${unitTerm} ${typeof c.number === 'number' ? c.number : idx + 1}`, custom ? `: ${custom}` : ''),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: theme.muted } }, `${words.toLocaleString()} word${words === 1 ? '' : 's'}`));
                }))));
}


// Tiny deterministic string hash — used to derive a stable per-book size variant for the
// shelf (same project always gets the same subtle size, rather than reshuffling on every
// re-render the way Math.random() would).
export function hashSeed(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
        h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h);
}


// ---------- Writer Profile (lives outside every project) ----------
export function LifetimeStatTile({ icon, label, value }) {
    return React.createElement("div", { style: {
            background: 'linear-gradient(160deg, #1F1B12, #17140F)', border: '1px solid #2E2A1E', borderRadius: RADIUS_SCALE[10],
            padding: '14px 12px', textAlign: 'center',
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[18], marginBottom: 4, opacity: 0.85 } }, icon),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#E8C468' } }, value.toLocaleString()),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A8A90', marginTop: 3, letterSpacing: '0.02em' } }, label));
}


// The Legacy Shelf: every completed project as an illustrated book on a wooden shelf. Reuses the
// same visual language as the Home Screen's bookshelf (walnut ledge, turned bookends, ambient
// shadow) but keeps its own scoped <style> block, since this screen and Home are never mounted
// at the same time — the shelf naturally grows wider as more books are added to shelf-scroll.
export function LegacyShelf({ books, onOpenBook }) {
    return React.createElement("div", { style: { marginTop: 12 } },
        React.createElement("style", null, `
      .legacy-shelf-stage { position: relative; margin: 4px -24px 20px -24px; }
      .legacy-shelf-ambient {
        position: absolute; left: 8px; right: 8px; top: 18px; height: 150px; z-index: 0;
        pointer-events: none; filter: blur(20px);
        background: radial-gradient(ellipse at center, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 68%);
      }
      .legacy-shelf-wood {
        position: absolute; left: 24px; right: 24px; top: 155px; height: 20px; border-radius: 3px; z-index: 1;
        background:
          repeating-linear-gradient(90deg,
            rgba(0,0,0,0.09) 0px, rgba(0,0,0,0.09) 1px, transparent 1px, transparent 5px,
            rgba(0,0,0,0.05) 5px, rgba(0,0,0,0.05) 6px, transparent 6px, transparent 13px,
            rgba(0,0,0,0.07) 13px, rgba(0,0,0,0.07) 14px, transparent 14px, transparent 24px),
          linear-gradient(120deg, rgba(255,241,214,0.06) 0%, rgba(255,241,214,0) 35%),
          linear-gradient(90deg, rgba(0,0,0,0.10) 0%, rgba(0,0,0,0) 16%, rgba(0,0,0,0) 84%, rgba(0,0,0,0.10) 100%),
          linear-gradient(180deg, #4A3220 0%, #35210F 50%, #281709 100%);
        box-shadow: 0 5px 10px -3px rgba(0,0,0,0.42), inset 0 1px 0 rgba(212,177,116,0.3), inset 0 1px 2px rgba(255,255,255,0.04), inset 0 -5px 7px -5px rgba(0,0,0,0.55);
      }
      .legacy-bookend {
        position: absolute; top: 8px; width: 14px; height: 168px; border-radius: 6px 6px 3px 3px; z-index: 1; pointer-events: none;
        background: linear-gradient(100deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 26%), linear-gradient(180deg, #4E3624 0%, #382312 55%, #241408 100%);
        box-shadow: 0 6px 12px rgba(0,0,0,0.4), inset 0 1px 0 rgba(212,177,116,0.28), inset -2px 0 4px rgba(0,0,0,0.35), inset 2px 0 3px rgba(255,255,255,0.04);
      }
      .legacy-bookend::before {
        content: ''; position: absolute; top: -5px; left: 50%; transform: translateX(-50%); width: 21px; height: 9px; border-radius: 5px;
        background: linear-gradient(180deg, #5C4230 0%, #3C2814 100%); box-shadow: 0 1px 2px rgba(0,0,0,0.4), inset 0 1px 0 rgba(216,181,120,0.35);
      }
      .legacy-bookend::after { content: ''; position: absolute; left: 2px; right: 2px; top: 30px; height: 1.5px; border-radius: 1px; background: rgba(212,177,116,0.28); }
      .legacy-bookend-left { left: 8px; } .legacy-bookend-right { right: 8px; }
      .legacy-shelf-scroll {
        position: relative; z-index: 2; display: flex; align-items: flex-start; gap: 20px;
        overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity; -webkit-overflow-scrolling: touch;
        scrollbar-width: none; padding: 16px 24px 6px 24px;
      }
      .legacy-shelf-scroll::-webkit-scrollbar { display: none; }
      .legacy-book { cursor: pointer; position: relative; display: flex; flex-direction: column; align-items: center; flex-shrink: 0; scroll-snap-align: start; width: 108px; }
      .legacy-book-cover { position: relative; transition: transform var(--ink-dur) var(--ink-ease); }
      .legacy-book:hover .legacy-book-cover { transform: translateY(-3px); }
      .legacy-book-cover::after {
        content: ''; position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%); width: 74%; height: 10px;
        pointer-events: none; filter: blur(1px);
        background:
          radial-gradient(ellipse at center, rgba(0,0,0,0.5) 0%, rgba(0,0,0,0) 40%),
          radial-gradient(ellipse at center, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0) 72%);
      }
      .legacy-seal {
        position: absolute; top: -6px; right: -6px; width: 26px; height: 26px; border-radius: 50%; z-index: 3;
        background: radial-gradient(circle at 34% 28%, #E8C468, #8A6B25 78%); border: 1.5px solid #100E0A;
        box-shadow: 0 0 0 2px #C89B3C88, 0 2px 6px rgba(0,0,0,0.5);
        display: flex; align-items: center; justify-content: center; font-size: 12;
      }
      .legacy-caption { margin-top: 22px; text-align: center; width: 108px; }
      @keyframes inkLegacyBookIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      .legacy-book-in { animation: inkLegacyBookIn 480ms var(--ink-ease) both; animation-delay: calc(var(--i, 0) * 60ms); }
    `),
        React.createElement("div", { className: "legacy-shelf-stage" },
            React.createElement("div", { className: "legacy-shelf-ambient" }),
            React.createElement("div", { className: "legacy-shelf-wood" }),
            React.createElement("div", { className: "legacy-bookend legacy-bookend-left" }),
            React.createElement("div", { className: "legacy-bookend legacy-bookend-right" }),
            React.createElement("div", { className: "legacy-shelf-scroll" }, books.length
                ? books.map((b, i) => {
                    const dateLabel = b.completedAt ? new Date(b.completedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Undated';
                    return React.createElement("div", { key: b.id, className: "legacy-book legacy-book-in", style: { '--i': i }, onClick: () => onOpenBook(b.id) },
                        React.createElement("div", { className: "legacy-book-cover" },
                            React.createElement(BookCover, { title: b.title, subtitle: b.subtitle, seriesName: b.seriesName, author: b.author, cover: b.cover, size: "sm" }),
                            React.createElement("div", { className: "legacy-seal", title: "Completed" }, React.createElement(InkIcon, { name: "medal", size: 13 }))),
                        React.createElement("div", { className: "legacy-caption" },
                            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: '#EFE7D2', lineHeight: 1.25 } }, b.title || 'Untitled'),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#7A7A82', marginTop: 3 } }, dateLabel),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#7A7A82', marginTop: 1 } }, `${b.wordCount.toLocaleString()} words`),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#C89B3C', marginTop: 1 } }, `${b.achievementPct}% achievements`),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#7A7A82', marginTop: 1 } }, `Health ${b.healthScore}`)));
                })
                : React.createElement("div", { style: { padding: '30px 24px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64', fontStyle: 'italic' } }, "Your legacy shelf is empty \u2014 mark a project completed in its Settings to place the first book here."))));
}


// ---------- Author Reputation (public-facing; replaces the old follower count) ----------
// A single prestige number shown on every Author's Hall in place of a raw follower count — meant
// to read as a writer's LASTING LEGACY, not a live activity meter. Two design rules follow from
// that and shape everything below:
//   1. Nothing here should be farmable. Repeating the same action faster or more often must earn
//      LESS per repetition, not the same amount every time (see diminishingPoints).
//   2. Nothing here should be free. Every source that can be gamed by volume alone (publishing
//      filler, "completing" trivial projects) is gated behind a real quality bar before it counts
//      at all (see REPUTATION_QUALITY_MIN_WORDS / REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT).
// Only the finished total is ever displayed (see PublicIdentityCard / WriterIdentityCard) — the
// sources and curve that built it stay private, same as a credit score never shows its inputs.
export const REPUTATION_VALUES = {
    follow: 2,
    purchase: 4,
    rating: 3,
    review: 8,
    publishedBook: 40,
    completedProject: 10,
    // Guild contribution already carries its own per-source weighting (see
    // computeGuildReputation in guild/guild-progression.jsx) — this is a pass-through multiplier on that finished score,
    // not a second, separate points-per-action value.
    guildContribution: 1,
    marketplaceSale: 6,
    communityEvent: 20,
    // Deliberately the single largest per-action value here — a Featured Work is Inkroot itself
    // vouching for the piece (editorial curation, not something a writer can trigger by acting
    // more), so it's weighted like the rare, meaningful recognition it's meant to be.
    featuredWork: 120,
};


// Which sources actually have a real, on-device signal behind them today, same honesty policy as
// GUILD_REPUTATION_SOURCES elsewhere. Book purchases, marketplace sales, community events, and
// featured works still have no backing system to draw on, so they stay at zero rather than being
// invented. Follows, published books, completed projects, guild contributions, ratings, and
// reviews are all real signals this device can actually observe, so those are live — ratings and
// reviews both come from the one real `reviews` table (see submitReview/fetchAuthorRatingsSummary
// in src/lib/library.js), which always carries a 1-5 rating alongside an optional written body:
// `review` counts every row (a reader engaged enough to leave real feedback at all), `rating`
// counts only the 4-5★ subset of those same rows (a reader who left a genuinely positive one) —
// two different qualities of the same underlying signal, not two independent ones, which is why
// `rating`'s per-action value is lower than `review`'s (see REPUTATION_VALUES above).
export const REPUTATION_SOURCES = [
    { key: 'follow', label: 'Genuine reader follows', live: true },
    { key: 'publishedBook', label: 'High-quality published books', live: true },
    { key: 'completedProject', label: 'Completed projects', live: true },
    { key: 'guildContribution', label: 'Guild contributions', live: true },
    { key: 'rating', label: 'Positive ratings', live: true },
    { key: 'review', label: 'Genuine reviews', live: true },
    { key: 'purchase', label: 'Book purchases', live: false },
    { key: 'marketplaceSale', label: 'Marketplace sales', live: false },
    { key: 'communityEvent', label: 'Community events', live: false },
    { key: 'featuredWork', label: 'Featured works', live: false },
];


// A book has to actually be a book — long enough that publishing it reflects real, sustained
// work — before it can add to Reputation at all. Stops a burst of near-empty "published" stubs
// from generating Reputation just by existing. ~15k words is roughly novella length.
export const REPUTATION_QUALITY_MIN_WORDS = 15000;


// A "completed project" only counts toward Reputation once it clears both a length bar (same
// REPUTATION_QUALITY_MIN_WORDS as publishing) AND a real quality bar — at least 40% of its own
// achievements unlocked (see computeAchievements/Legacy Shelf) — so marking a rushed, half-broken
// draft "complete" can't be used to farm points the way finishing an actual book can earn them.
export const REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT = 40;


// The core anti-farm mechanic: diminishing returns. `count` repeats of a source are worth
// `value * sqrt(count)` in total, not `value * count` — so the marginal Nth+1 repeat is always
// worth less than the Nth, and worth almost nothing once count gets large. A writer's first
// handful of published books, follows, or guild contributions each still move the needle in a
// meaningful way; the hundredth low-effort repeat of the same action barely moves it at all. This
// is what makes grinding out the same action a genuinely bad way to raise Reputation, while a
// steady handful of real achievements across MANY different sources — the actual shape of a
// long-term legacy — keeps compounding.
export function diminishingPoints(perActionValue, count) {
    if (!count || count <= 0)
        return 0;
    return perActionValue * Math.sqrt(count);
}


// The one formula every Reputation number on screen goes through. Unknown/not-yet-live counts
// default to 0, and even if a caller passes one in, REPUTATION_SOURCES keeps it from contributing
// until that source is real — so this can be wired up to purchases, ratings, reviews, community
// events, and featured works later without changing the formula, the diminishing curve, or the
// quality gates above it. Every count passed in here is expected to already be deduplicated and
// quality-gated by the caller (see myPublishedCount / meaningfulCompletedCount in
// AuthorsHallScreen) — this function's only job is applying the shared diminishing curve and
// summing the result, so "prevent duplicate rewards" and "gate on quality" only ever have to be
// implemented once per source, at the point that source's real count is produced.
export function computeAuthorReputation({ followCount = 0, purchaseCount = 0, ratingCount = 0, reviewCount = 0, publishedCount = 0, completedCount = 0, guildContribution = 0, marketplaceSaleCount = 0, communityEventCount = 0, featuredWorkCount = 0 } = {}) {
    const counts = {
        follow: followCount, purchase: purchaseCount, rating: ratingCount, review: reviewCount,
        publishedBook: publishedCount, completedProject: completedCount,
        guildContribution: guildContribution, marketplaceSale: marketplaceSaleCount,
        communityEvent: communityEventCount, featuredWork: featuredWorkCount,
    };
    const raw = REPUTATION_SOURCES.reduce((total, source) => total + (source.live ? diminishingPoints(REPUTATION_VALUES[source.key], counts[source.key]) : 0), 0);
    return Math.round(raw);
}


// ---------- Shared "own Rank" inputs — one source of truth ----------
// Home (ink-root.jsx's writerRank) and this writer's own Author's Hall (the `reputation` computed
// below in AuthorsHallScreen) both show a Rank derived from computeAuthorReputation for the exact
// same writer, but used to independently build its inputs from the project list and drifted:
// Author's Hall held publishedCount/completedCount to the real quality gates
// (REPUTATION_QUALITY_MIN_WORDS / REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT) and included followCount;
// Home passed raw stats.completedCount for BOTH publishedCount and completedCount and never passed
// followCount at all. That's why the same writer could see two different Rank numbers on two
// screens showing the same standing. The three helpers below are the exact per-project logic
// Author's Hall already used — pulled out so every caller shares one implementation instead of
// reimplementing the quality gates. Author's Hall is the reference: it already had the more
// complete/accurate input set.

// This writer's own published-book count, gated the same way as Author's Hall: only listings that
// clear REPUTATION_QUALITY_MIN_WORDS count. `projects` is the project meta index (the same shape
// already passed to AuthorsHallScreen and kept in ink-root.jsx's own `projects` state) — no need
// for the full loaded project bodies, since the index already carries wordCount/publishStatus.
export function myPublishedCountFor(projects) {
    return (projects || []).filter((p) => resolvePublishStatus(p) === 'inkroot' && (p.wordCount || 0) >= REPUTATION_QUALITY_MIN_WORDS).length;
}


// Per-finished-project wordCount/achievementPct, computed from full (not just meta) project
// bodies — the same shape Author's Hall's own legacyBooks state builds. Callers that already have
// a legacyBooks-shaped list (Author's Hall does) can skip this and pass their own straight to
// meaningfulCompletedCountFor below instead of recomputing it.
export function buildLegacyBooksForReputation(fullProjects) {
    return (fullProjects || []).filter((p) => p.completed).map((p) => {
        const words = (p.chapters || []).reduce((s, c) => s + wordCount(c.text), 0);
        const streak = computeStreak((p.stats && p.stats.log) || {});
        const health = runHealthChecks(p);
        const ach = computeAchievements(p, { totalWords: words, streak, healthScore: health.score, totalHealthIssues: health.totalIssues });
        const achievementPct = ach.length ? Math.round((ach.filter((a) => a.unlocked).length / ach.length) * 100) : 0;
        return { wordCount: words, achievementPct };
    });
}


// "Completed projects" for the Reputation formula, held to the real quality bar — long enough to
// be a genuine book AND at least REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT of its own achievements
// actually unlocked — rather than just the raw "marked complete" count.
export function meaningfulCompletedCountFor(legacyBooks) {
    return (legacyBooks || []).filter((b) => b.wordCount >= REPUTATION_QUALITY_MIN_WORDS && b.achievementPct >= REPUTATION_QUALITY_MIN_ACHIEVEMENT_PCT).length;
}


// Turns a fetchAuthorRatingsSummary(bookIds) result (src/lib/library.js — one entry per book,
// each carrying that book's full review rows) into the two real counts computeAuthorReputation's
// `review`/`rating` sources need: every review counts toward `review`; only the 4-5★ subset of
// those same rows counts toward `rating` (see the comment on REPUTATION_SOURCES above for why
// that's not double-counting). Shared so authors-hall-screen.jsx (isSelf and someone else's Hall
// alike) and ink-root.jsx's own writerRank build this from the exact same rule.
export function reviewReputationCountsFrom(ratingsSummary) {
    let reviewCount = 0;
    let positiveRatingCount = 0;
    for (const entry of (ratingsSummary || [])) {
        const reviews = entry.reviews || [];
        reviewCount += reviews.length;
        positiveRatingCount += reviews.filter((r) => r.rating >= 4).length;
    }
    return { reviewCount, ratingCount: positiveRatingCount };
}


// ---------- Reputation titles — milestones, not a meter ----------
// Each title requires a dramatically larger total than the last (not a flat step), so climbing
// from Respected to Renowned is nowhere near as far as climbing from Legendary to Mythic — the
// ladder itself enforces that higher standing has to represent significantly more accumulated
// legacy than the rank below it, on top of the diminishing-returns curve that already makes each
// point harder to earn than the last.
// `tier` (added alongside the existing name/min/icon/color) is what RankCrest (see
// health-checks.jsx) uses to decide ring count / glow / the top-tier gold aura — it's the same
// role WRITER_RANKS' old `tier` field used to play, now that Writer Rank is this ladder rather
// than a separate level-derived one.
export const REPUTATION_TITLES = [
    { name: 'Unproven', min: 0, tier: 1, icon: "\u2726", color: '#7A7A82' },
    { name: 'Respected', min: 250, tier: 2, icon: "\uD83C\uDF31", color: '#8FA37A' },
    { name: 'Renowned', min: 750, tier: 3, icon: "\u2728", color: '#A8916A' },
    { name: 'Esteemed', min: 2000, tier: 4, icon: "\uD83C\uDFF5\uFE0F", color: '#C89B3C' },
    { name: 'Legendary', min: 5000, tier: 5, icon: "\u2694\uFE0F", color: '#E8C468' },
    { name: 'Mythic', min: 12000, tier: 6, icon: "\uD83D\uDC51", color: '#F2D98B' },
];


export function reputationTitleFor(rep) {
    let tier = REPUTATION_TITLES[0];
    for (const t of REPUTATION_TITLES) {
        if (rep >= t.min)
            tier = t;
    }
    return tier;
}


// ---------- Author follows (local-only; this device is the only reader Inkroot has today) ----------
// Which authors this device's reader currently follows (drives the "Follow Author" button's own
// on/off state — following can be toggled off again) kept separate from which authors this device
// has EVER followed at least once (drives the Reputation point — awarded once, permanently, and
// never re-awarded or clawed back by a later unfollow/refollow, and never inflated by rapidly
// toggling the button). Splitting the two is what actually prevents duplicate Reputation from
// repeated follows by the same account — every other live source (publishedBook,
// completedProject) is naturally immune to the same problem because it's read fresh off a
// deduplicated, quality-gated list every time rather than incremented by an event, so there's
// nothing to double-fire in the first place.
export const AUTHOR_FOLLOWS_KEY = 'inkroot:authorFollows';


export const AUTHOR_EVER_FOLLOWED_KEY = 'inkroot:authorEverFollowed';


export function authorKeyFor(name) {
    return (name || '').trim().toLowerCase();
}


export function readAuthorFollowMap(key) {
    try {
        return JSON.parse(localStorage.getItem(key) || '{}');
    }
    catch (e) {
        return {};
    }
}


export function writeAuthorFollowMap(key, map) {
    try {
        localStorage.setItem(key, JSON.stringify(map));
    }
    catch (e) { }
}
