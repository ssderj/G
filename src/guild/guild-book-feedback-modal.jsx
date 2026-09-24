import React, { useState, useEffect, useRef } from 'react';
import { supabase } from '../lib/supabaseClient.js';
import { addGuildBookFeedback, fetchGuildBookFeedback, fetchGuildPublishedBooks } from '../lib/library-guild.js';
import { BOOK_VIEW_SOURCES, recordBookDetailView, recordBookReadStart } from '../lib/analytics.js';
import { GrandLibraryShelfRow, GrandLibraryShelfStyles, LibraryAuthorLink, estimateReadingTime, resolvePublishStatus } from '../library/publishing.jsx';
import { ArchiveSectionHeading } from '../shared-ui/ui-cards.jsx';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { MessagingSafetyBanner } from '../shared-ui/messaging-safety-banner.jsx';
import { formatRelativeTime } from '../shared-utils/format-duration.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ComingSoonNotice } from '../writing/coming-soon-notice.jsx';


// A book detail modal for a Guild publication — opened from GuildBookshelf. Shows the book, a
// "Promote to Inkroot" shortcut (same project record, no re-upload), and a real feedback thread
// guildmates can post to. Same dual-mode approach as FiresideBoard, minus the realtime
// subscription — this is a modal someone opens, reads, and closes, not a persistent feed, so
// fetch-on-open plus refetch-after-posting covers it without the added complexity of a live
// subscription. Local-only (unsigned-in, or no active guild) still works exactly as before.
// Real for a Founder Guild or a self-founded/joined Player Guild alike, since
// 92_migration_player_guild_book_publishing.sql — guildId is whichever kind is active, the
// caller (GuildBookshelf) doesn't distinguish.
export function GuildBookFeedbackModal({ book, feedback, writerName, onAddFeedback, onPromote, onOpenBook, onClose, onOpenAuthor, guildId }) {
    const [stars, setStars] = useState(0);
    const [note, setNote] = useState('');
    const [posted, setPosted] = useState(false);
    const postedTimer = useRef(null);
    const [mode, setMode] = useState('checking'); // 'checking' | 'remote' | 'local'
    const [remoteFeedback, setRemoteFeedback] = useState(null);
    useEffect(() => () => { if (postedTimer.current)
        clearTimeout(postedTimer.current); }, []);
    const refetchRemote = React.useCallback(() => {
        fetchGuildBookFeedback(guildId, book.id)
            .then((rows) => setRemoteFeedback(rows.map((r) => ({ id: r.id, author: r.author_name, authorVerified: r.author_verified, authorId: r.author_id, stars: r.stars, note: r.note, at: new Date(r.created_at).getTime() }))))
            .catch((e) => console.warn('Inkroot: guild feedback fetch failed', e));
    }, [guildId, book.id]);
    useEffect(() => {
        let cancelled = false;
        if (!guildId) {
            setMode('local');
            return;
        }
        supabase.auth.getUser().then(({ data }) => {
            if (cancelled) return;
            if (data.user) {
                setMode('remote');
            } else {
                setMode('local');
            }
        });
        return () => { cancelled = true; };
    }, [guildId]);
    useEffect(() => {
        if (mode === 'remote') refetchRemote();
    }, [mode, refetchRemote]);
    const activeFeedback = mode === 'remote' ? (remoteFeedback || []) : feedback;
    const handlePost = () => {
        if (!note.trim())
            return;
        if (mode === 'remote') {
            addGuildBookFeedback(guildId, book.id, stars || null, note.trim().slice(0, 500)).then(refetchRemote).catch((e) => console.warn('Inkroot: guild feedback post failed', e));
        } else {
            onAddFeedback(book.id, { author: writerName || 'Unnamed Writer', stars: stars || null, note: note.trim().slice(0, 500), at: Date.now() });
        }
        setNote('');
        setStars(0);
        setPosted(true);
        if (postedTimer.current)
            clearTimeout(postedTimer.current);
        postedTimer.current = setTimeout(() => setPosted(false), 2200);
    };
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 440, maxHeight: '86vh', overflowY: 'auto',
                background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16],
                padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[16], marginTop: -8 } },
                React.createElement(BookCover, { title: book.title, subtitle: book.subtitle, seriesName: book.seriesName, author: book.author, cover: book.cover, size: 'sm' }),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2' } }, book.title || 'Untitled Novel'),
                    React.createElement(LibraryAuthorLink, { author: book.author, onOpenAuthor, verified: book.authorVerified, authorId: book.authorId }),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                        React.createElement("span", null, book.genre),
                        React.createElement("span", null, `${book.wordCount.toLocaleString()} words`),
                        React.createElement("span", null, estimateReadingTime(book.wordCount))),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 10, flexWrap: 'wrap' } },
                        React.createElement("button", { onClick: () => onOpenBook(book.id), style: {
                                background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                                borderRadius: RADIUS_SCALE[8], padding: '6px 13px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                            } }, "Read & review"),
                        React.createElement("button", { onClick: () => onPromote(book.id), style: {
                                background: 'none', border: '1px solid #3A3020', color: '#C89B3C',
                                borderRadius: RADIUS_SCALE[8], padding: '6px 13px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                            } }, React.createElement(InkIcon, { name: "book", size: 12, style: { display: "inline-block", verticalAlign: "-2px", marginRight: 5 } }), "Promote to Inkroot")))),
            book.blurb && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#C9BE8D', marginTop: 16, lineHeight: 1.6, fontStyle: 'italic' } }, book.blurb),
            React.createElement("div", { style: { marginTop: 20, paddingTop: 16, borderTop: '1px solid #2A2417' } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10 } }, "Guild feedback"),
                mode === 'remote' && React.createElement(MessagingSafetyBanner, { context: "guild feedback" }),
                activeFeedback.length === 0
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', marginBottom: 12 } }, "No feedback yet \u2014 be the first to weigh in.")
                    : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], marginBottom: 14 } },
                        activeFeedback.map((f, i) => React.createElement("div", { key: f.id || i, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
                            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
                                React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: 4 } },
                                    f.author
                                        ? React.createElement("span", {
                                            onClick: onOpenAuthor ? () => onOpenAuthor(f.author, f.authorId) : undefined,
                                            role: onOpenAuthor ? 'button' : undefined, tabIndex: onOpenAuthor ? 0 : undefined,
                                            className: onOpenAuthor ? "gl-author-link" : undefined,
                                            style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#C9BE8D', cursor: onOpenAuthor ? 'pointer' : 'default' },
                                        }, f.author)
                                        : React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#C9BE8D' } }, 'A guildmate'),
                                    // Anti-impersonation badge, piece 2 — see supabase schema.sql's
                                    // `profiles.verified` and lib/profile.js's fetchVerifiedIds.
                                    f.authorVerified && React.createElement("span", { title: "Verified account", style: { color: '#6FAE8F', fontSize: TYPE_SCALE[11] } }, '\u2713')),
                                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
                                    React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64' } }, formatRelativeTime(f.at)),
                                    // Local-only feedback (unsigned-in / no active guild) has no server-side
                                    // row for content_reports to point to — only a real remote row is reportable.
                                    mode === 'remote' && f.id && React.createElement(ReportButton, {
                                        contentType: "guild_book_feedback", contentId: f.id, guildId, label: "",
                                        buttonStyle: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', fontSize: TYPE_SCALE[11], padding: 0 },
                                    }))),
                            f.stars > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#E8C468', marginBottom: 4 } }, "\u2605".repeat(f.stars) + "\u2606".repeat(5 - f.stars)),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, f.note)))),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[4], marginBottom: 8 } },
                    [1, 2, 3, 4, 5].map((n) => React.createElement("button", { key: n, onClick: () => setStars(n === stars ? 0 : n), style: {
                            background: 'none', border: 'none', cursor: 'pointer', fontSize: TYPE_SCALE[18], padding: 0,
                            color: n <= stars ? '#E8C468' : '#3A3A42',
                        } }, "\u2605"))),
                React.createElement("textarea", { value: note, onChange: (e) => setNote(e.target.value), maxLength: 500, rows: 3,
                        placeholder: "Share feedback for the writer \u2014 what's working, what's not, anything a beta reader would flag\u2026", style: {
                        width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2',
                        borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[12.5], resize: 'vertical', fontFamily: 'inherit',
                    } }),
                React.createElement("button", { onClick: handlePost, disabled: !note.trim(), style: {
                        marginTop: 8, background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22',
                        color: note.trim() ? '#E8C468' : '#5C5C64', borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12],
                        cursor: note.trim() ? 'pointer' : 'default', fontWeight: 600,
                    } }, posted ? 'Posted \u2713' : 'Post feedback'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } },
                    mode === 'remote' ? "Shared with the rest of your guild." : "Saved on this device today \u2014 sign in to share feedback with the rest of your guild."))));
}


// The Guild Bookshelf — sits under the Fireside. Books the writer (or, once Inkroot has a shared
// guild service, any guildmate) has published to this Guild rather than the open Grand Library,
// so they can collect feedback before a wider release. Reuses the same shelf visuals and Coming
// Soon notice pattern as the Grand Library, since it's the same kind of "real today, more real
// later" feature. Clicking a cover opens GuildBookFeedbackModal for feedback + one-click promotion.
export function GuildBookshelf({ projects, writerName, guildName, feedback, onAddFeedback, onSetPublishStatus, onOpen, onOpenAuthor, guildId }) {
    const [selectedId, setSelectedId] = useState(null);
    // This device's own guild-published projects — always available immediately, offline-safe,
    // and what the shelf showed exclusively before this phase. Still the source of truth for
    // "my own" books even once remote is loaded, since a just-edited local project may not have
    // finished round-tripping to guild_published_books yet.
    const localBooks = projects.filter((p) => resolvePublishStatus(p) === 'guild').map((p) => ({
        id: p.id, title: p.title, subtitle: p.subtitle, seriesName: p.seriesName, cover: p.cover,
        author: (p.author && p.author.trim()) || writerName || 'Unnamed Writer',
        wordCount: p.wordCount || 0, updatedAt: p.updatedAt || 0,
        genre: p.genre || 'Unspecified', blurb: p.blurb || '',
    }));
    // Every guildmate's guild-published book (Phase 7, extended to Player Guilds by
    // 92_migration_player_guild_book_publishing.sql) — same dual-mode approach as
    // GuildBookFeedbackModal and FiresideBoard: local-only unless signed in to an active guild.
    // guildId is generic here — the caller (home-screen.jsx) resolves it to whichever guild type
    // (Founder slug, or a Player/Joined Guild's real player_guilds.id) is actually active.
    const [mode, setMode] = useState('checking'); // 'checking' | 'remote' | 'local'
    const [remoteBooks, setRemoteBooks] = useState(null);
    const refetchRemote = React.useCallback(() => {
        fetchGuildPublishedBooks(guildId).then(setRemoteBooks).catch((e) => console.warn('Inkroot: guild bookshelf fetch failed', e));
    }, [guildId]);
    useEffect(() => {
        let cancelled = false;
        if (!guildId) {
            setMode('local');
            return;
        }
        supabase.auth.getUser().then(({ data }) => {
            if (cancelled) return;
            setMode(data.user ? 'remote' : 'local');
        });
        return () => { cancelled = true; };
    }, [guildId]);
    useEffect(() => {
        if (mode === 'remote') refetchRemote();
    }, [mode, refetchRemote]);
    // Remote entries win when a book appears in both (they're what the rest of the guild
    // actually sees); any local-only book not yet reflected remotely is added alongside so a
    // writer never loses sight of their own just-published book while the push is in flight.
    const books = (mode === 'remote' && remoteBooks)
        ? [...remoteBooks, ...localBooks.filter((lb) => !remoteBooks.some((rb) => rb.id === lb.id))].sort((a, b) => b.updatedAt - a.updatedAt)
        : [...localBooks].sort((a, b) => b.updatedAt - a.updatedAt);
    const selected = selectedId ? books.find((b) => b.id === selectedId) : null;
    return React.createElement("div", { style: { marginTop: 34, marginBottom: 8 } },
        React.createElement(GrandLibraryShelfStyles, null),
        React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: "library", size: 20, style: { display: "inline-block" } }), label: "The Guild Bookshelf" }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 6, marginBottom: 16, fontStyle: 'italic' } }, `Books published privately to ${guildName || 'your Guild'} for feedback, competitions, beta reading, and guild events.`),
        React.createElement(GrandLibraryShelfRow, {
            icon: React.createElement(InkIcon, { name: "archiveBox", size: 15 }), label: "Published here", books,
            onSelectBook: (b) => { setSelectedId(b.id); recordBookDetailView(b.id, BOOK_VIEW_SOURCES.GUILD_BOOKSHELF); },
            emptyText: "No guild publications yet \u2014 in Author Studio, publish a completed book and choose your Guild as the destination.",
        }),
        mode !== 'remote' && React.createElement(ComingSoonNotice, {
            text: guildId
                ? "This shelf still shows what's published on this device \u2014 sign in to see every guildmate's guild publications and open feedback."
                : "Every current guildmate's own publications and feedback, synced across devices \u2014 available once you're in a Guild and signed in. For now this shelf shows what's saved on this device.",
        }),
        selected && React.createElement(GuildBookFeedbackModal, {
            book: selected, feedback: feedback[selected.id] || [], writerName, guildId,
            onAddFeedback, onPromote: (id) => { onSetPublishStatus(id, 'inkroot'); setSelectedId(null); },
            onOpenBook: (id) => { recordBookReadStart(id, BOOK_VIEW_SOURCES.GUILD_BOOKSHELF); setSelectedId(null); onOpen(id); },
            onClose: () => setSelectedId(null), onOpenAuthor,
        }));
}
