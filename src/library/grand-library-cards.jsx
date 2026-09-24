import React, { useState, useEffect, useRef, useMemo } from 'react';
import { storage } from '../lib/storage.js';
import { deleteBookDiscussionPost, fetchAuthorRatingsSummary, fetchBookDiscussion, fetchBookStats, postBookDiscussion, subscribeBookDiscussionRealtime, submitReview, fetchPublishedBookSample } from '../lib/library.js';
import { fetchBookViewSummary } from '../lib/analytics.js';
import { useSync } from '../shell/sync-context.jsx';
import { IdentityPlaque } from '../guild/guild-hall.jsx';
import { hashSeed } from './author-reputation.jsx';
import { LibraryAuthorLink, LibraryCardBadge, LibraryCardRating, LibraryQuickActions, LibrarySectionHeading, SeriesTag, estimateReadingTime, formatLibraryPrice, getLibraryBadge, isSerialFormat, resolvePublishStatus } from './publishing.jsx';
import { formatRelativeTime } from '../shared-utils/format-duration.jsx';
import { projectKey } from '../shared-utils/storage-keys.jsx';
import { stripHtml, wordCount } from '../shared-utils/strip-html.jsx';
import { truncate } from '../shared-utils/truncate.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { IconTrash } from '../shared-ui/icons.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ComingSoonNotice } from '../writing/coming-soon-notice.jsx';
import { WRITER_RANKS } from '../writing/health-checks.jsx';
import { checkoutBook, checkoutPack, formatNaira, formatNairaBalance, koboToNaira } from '../lib/payments.js';
import { checkPackDownloadAccess, fetchPublishedPackContent } from '../lib/worldbuilding-packs.js';
import { patchProjectDefaults } from '../writing/project-schema-and-backups.jsx';


// "Book Discussion Hall" — a real, shared, live thread of every reader's posts about a book
// (migration 67, book_discussion_posts), not just this device's own. Used to be device-local
// (see this file's git history / README Phase 67 entry for the honesty note that used to live
// here); fetchBookDiscussion/postBookDiscussion/subscribeBookDiscussionRealtime (lib/library.js)
// are the real backend now.
export function DiscussionHallModal({ book, onClose }) {
    const sync = useSync();
    const myId = sync && sync.session && sync.session.user && sync.session.user.id;
    const [state, setState] = useState({ loading: true, posts: [] });
    const [note, setNote] = useState('');
    const [posting, setPosting] = useState(false);
    const [postError, setPostError] = useState(null);
    const [deletingId, setDeletingId] = useState(null);
    const handleDelete = (postId) => {
        setDeletingId(postId);
        deleteBookDiscussionPost(postId)
            .then(() => setState((s) => ({ ...s, posts: s.posts.filter((p) => p.id !== postId) })))
            .catch((e) => setPostError(e.message || "Couldn't delete that post."))
            .finally(() => setDeletingId(null));
    };
    useEffect(() => {
        let cancelled = false;
        const reload = () => fetchBookDiscussion(book.id).then((posts) => { if (!cancelled) setState({ loading: false, posts }); });
        setState({ loading: true, posts: [] });
        reload().catch(() => { if (!cancelled) setState({ loading: false, posts: [] }); });
        const unsubscribe = subscribeBookDiscussionRealtime(book.id, () => reload().catch(() => {}));
        return () => { cancelled = true; unsubscribe(); };
    }, [book.id]);
    const handlePost = () => {
        if (!note.trim())
            return;
        setPosting(true);
        setPostError(null);
        postBookDiscussion(book.id, note)
            .then(() => setNote(''))
            .catch((e) => setPostError(e.message || 'That didn\u2019t go through.'))
            .finally(() => setPosting(false));
    };
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 460, maxHeight: '86vh', overflowY: 'auto',
                background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16],
                padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: -8 } },
                React.createElement(InkIcon, { name: "chat", size: 17, color: "#C89B3C" }),
                React.createElement("div", null,
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, "Discussion Hall"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD' } }, book.title || 'Untitled Novel'))),
            React.createElement("div", { style: { marginTop: 18 } },
                state.loading
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic' } }, "Opening the Hall\u2026")
                    : state.posts.length === 0
                        ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic' } }, "No posts yet — start the conversation.")
                        : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], marginBottom: 14 } },
                            state.posts.map((p) => React.createElement("div", { key: p.id, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
                                React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 } },
                                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#C9BE8D' } }, p.author_name),
                                    React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64' } }, formatRelativeTime(new Date(p.created_at).getTime()))),
                                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, p.body),
                                React.createElement("div", { style: { marginTop: 6, display: 'flex', justifyContent: 'flex-end' } },
                                    myId && p.author_id === myId
                                        ? React.createElement("button", { onClick: () => handleDelete(p.id), disabled: deletingId === p.id, style: {
                                                background: 'none', border: 'none', color: '#7A7A82', cursor: 'pointer', fontSize: TYPE_SCALE[11], padding: 0,
                                            } }, deletingId === p.id ? 'Deleting\u2026' : 'Delete')
                                        : React.createElement(ReportButton, {
                                            contentType: "book_discussion_post", contentId: p.id, label: "",
                                            buttonStyle: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', fontSize: TYPE_SCALE[11], padding: 0 },
                                        })))))),
            postError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63', marginBottom: 8 } }, postError),
            React.createElement("textarea", { value: note, onChange: (e) => setNote(e.target.value), maxLength: 500, rows: 3,
                    placeholder: "Share a thought about this book…", style: {
                    width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2',
                    borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[12.5], resize: 'vertical', fontFamily: 'inherit',
                } }),
            React.createElement("button", { onClick: handlePost, disabled: !note.trim() || posting, style: {
                    marginTop: 8, background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22',
                    color: (note.trim() && !posting) ? '#E8C468' : '#5C5C64', borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12],
                    cursor: (note.trim() && !posting) ? 'pointer' : 'default', fontWeight: 600,
                } }, posting ? "Posting\u2026" : "Post"),
            React.createElement("div", { style: { marginTop: 14, fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Live \u2014 shared with every reader, not just you.")));
}


// The Cart — a real, persisted queue of books a reader means to buy (see LIBRARY_CART_KEY),
// opened from the Search Bar / Cart / Notifications row at the top of Discover. The queue itself
// is genuine, and so is checkout: it goes through the real Paystack integration (see
// src/lib/payments.js's checkoutBook and the paystack-* Edge Functions) — this stale comment
// used to say checkout couldn't charge anyone until Inkroot had a payment processor, which it
// now does (fix-tracker item 32 fixed this same stale claim elsewhere but missed this file).
// Checks out the cart one book at a time — real Naira payments (see src/lib/payments.js's
// checkoutBook), each going straight to that book's own author. A paid item is removed from the
// cart (via the same onRemove the ✕ button already uses) the moment its purchase confirms, so a
// reader who bails out partway through still keeps whatever they already paid for out of the
// queue and can resume with just what's left later.
export function CartDrawer({ items, onClose, onRemove, onOpenBook }) {
    const total = items.reduce((sum, it) => sum + (it.price > 0 ? it.price : 0), 0);
    const [checkoutState, setCheckoutState] = useState('idle'); // idle | paying | error
    const [checkoutError, setCheckoutError] = useState(null);
    const [payingId, setPayingId] = useState(null);

    const handleCheckout = async () => {
        setCheckoutState('paying');
        setCheckoutError(null);
        const payable = items.filter((it) => it.price > 0);
        for (const item of payable) {
            setPayingId(item.id);
            try {
                const outcome = await checkoutBook({ bookId: item.id, kind: 'book' });
                if (outcome === 'success' || outcome === 'pending') {
                    onRemove(item.id);
                } else {
                    setCheckoutError(`"${item.title}" wasn't charged — payment didn't complete. Remaining items in your cart are untouched.`);
                    setCheckoutState('error');
                    setPayingId(null);
                    return;
                }
            } catch (e) {
                // Already owned (bought on another device/tab): nothing to charge — drop it from the
                // cart and carry on with the rest instead of blocking checkout on it.
                if (/already own/i.test(e.message || '')) {
                    onRemove(item.id);
                    continue;
                }
                setCheckoutError(`"${item.title}": ${e.message}`);
                setCheckoutState('error');
                setPayingId(null);
                return;
            }
        }
        setPayingId(null);
        setCheckoutState('idle');
    };

    // Every item is a distinct book and addToCart already guards against duplicates (see
    // GrandLibraryScreen), so quantity per line is always exactly 1 — there's no stepper to wire
    // up. Still surfaced as its own "Qty 1" field below so the row reads like the familiar
    // cart-line-item pattern (cover · title/author · price · qty · remove) instead of leaving
    // quantity implicit.
    const itemCount = items.length;

    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end', padding: 0,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: 'min(400px, 92vw)', minHeight: '100vh', maxHeight: '100vh', overflowY: 'auto', boxSizing: 'border-box',
                background: 'linear-gradient(160deg, #201B12, #15120C)', borderLeft: '1px solid #4A3D22',
                padding: 22, boxShadow: '-20px 0 50px rgba(0,0,0,0.5)', display: 'flex', flexDirection: 'column',
            } },
            // Sticky + negative-margined to fully cover the panel's own top padding: the parent
            // div above is the Cart's *only* scroll container (overflowY: 'auto' spans the whole
            // panel, header included), so with a normal-flow header the exit control used to
            // scroll away the moment the cart had enough items to need scrolling — leaving no
            // visible way out short of hunting for the sliver of backdrop beside the drawer.
            // Pinning it here keeps Close reachable no matter how far down the list is scrolled.
            React.createElement("div", { style: {
                    position: 'sticky', top: 0, zIndex: 2, margin: '-22px -22px 18px', padding: '18px 22px 14px',
                    background: '#1B160E', borderBottom: '1px solid #2A2417',
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#EFE7D2', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                    React.createElement(InkIcon, { name: "cart", size: 16 }), " Cart", itemCount > 0 && React.createElement("span", { style: {
                            fontFamily: "'Inter', sans-serif", fontSize: TYPE_SCALE[11], fontWeight: 700, color: '#17130E',
                            background: '#E8C468', borderRadius: RADIUS_SCALE[999], padding: '1px 8px', minWidth: 20, textAlign: 'center',
                        } }, itemCount)),
                React.createElement("button", { onClick: onClose, title: "Close cart", "aria-label": "Close cart", style: {
                        background: 'rgba(255,255,255,0.06)', border: '1px solid #3A3226', color: '#EFE7D2', fontSize: TYPE_SCALE[16],
                        cursor: 'pointer', lineHeight: 1, width: 32, height: 32, borderRadius: RADIUS_SCALE[999],
                        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                    } }, "\u2715")),
            items.length === 0
                ? React.createElement("div", { style: {
                        flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                        textAlign: 'center', padding: '50px 14px', gap: SPACE_SCALE[6],
                    } },
                    React.createElement("div", { style: { marginBottom: 6, display: "flex", justifyContent: "center" } }, React.createElement(InkIcon, { name: "cart", size: 34, color: "#5C5C64" })),
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, "Your cart is empty"),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8A92', maxWidth: 260, lineHeight: 1.5, marginBottom: 10 } },
                        "Browse the Grand Library and tap Buy on a book to add it here."),
                    React.createElement("button", { onClick: onClose, style: {
                            background: 'rgba(232,196,104,0.10)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[999], padding: '9px 20px', fontSize: TYPE_SCALE[12.5], fontWeight: 700, cursor: 'pointer',
                        } }, "Continue Shopping"))
                : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[12] } },
                    items.map((it) => React.createElement("div", { key: it.id, style: {
                            display: 'flex', gap: SPACE_SCALE[12], background: '#1D1D22', border: '1px solid #2A2A30',
                            borderRadius: RADIUS_SCALE[10], padding: 12,
                        } },
                        React.createElement("div", { onClick: () => onOpenBook(it.id), style: { cursor: 'pointer', flexShrink: 0 } },
                            React.createElement(BookCover, { title: it.title, subtitle: it.subtitle, seriesName: it.seriesName, author: it.author, cover: it.cover, size: 'xs' })),
                        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
                            React.createElement("div", { onClick: () => onOpenBook(it.id), style: { cursor: 'pointer' } },
                                React.createElement("div", { style: {
                                        fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: '#EFE7D2',
                                        lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                                    } }, it.title || 'Untitled Novel'),
                                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#8A8A92', marginTop: 3 } }, it.author || 'Unknown author')),
                            React.createElement("div", { style: {
                                    marginTop: 'auto', paddingTop: 10, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[8],
                                } },
                                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                                    React.createElement("span", { style: { fontSize: TYPE_SCALE[13], fontWeight: 700, color: it.price > 0 ? '#E8C468' : '#8FCB8F' } }, formatLibraryPrice(it.price))),
                                React.createElement("button", { onClick: () => onRemove(it.id), "aria-label": `Remove "${it.title}" from cart`, style: {
                                        display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4],
                                        background: 'rgba(217,138,138,0.08)', border: '1px solid rgba(217,138,138,0.35)', color: '#D98A8A',
                                        borderRadius: RADIUS_SCALE[999], padding: '5px 10px', fontSize: TYPE_SCALE[11], fontWeight: 600, cursor: 'pointer', flexShrink: 0,
                                    } }, React.createElement(IconTrash, null), "Remove")))))),
            items.length > 0 && React.createElement("div", { style: {
                    position: 'sticky', bottom: 0, marginTop: 18, marginLeft: -22, marginRight: -22, padding: '16px 22px',
                    background: '#1B160E', borderTop: '1px solid #2A2417',
                } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#A6A6AD' } }, `Subtotal (${itemCount} ${itemCount === 1 ? 'item' : 'items'})`),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[17], fontWeight: 700, color: '#EFE7D2', fontFamily: "'Fraunces', Georgia, serif" } }, formatLibraryPrice(total))),
                checkoutError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10, lineHeight: 1.5 } }, checkoutError),
                total > 0
                    ? React.createElement("button", { disabled: checkoutState === 'paying', onClick: handleCheckout, style: {
                            width: '100%', border: 'none', borderRadius: RADIUS_SCALE[10], padding: '13px 0',
                            background: 'linear-gradient(160deg, #E8C468, #C89B3C)', color: '#17130E', fontSize: TYPE_SCALE[13.5], fontWeight: 700,
                            cursor: checkoutState === 'paying' ? 'default' : 'pointer', opacity: checkoutState === 'paying' ? 0.7 : 1,
                            boxShadow: '0 6px 18px rgba(232,196,104,0.25)',
                        } }, checkoutState === 'paying'
                            ? `Paying for "${(items.find((it) => it.id === payingId) || {}).title || '...'}"\u2026`
                            : `Proceed to Checkout \u2014 ${formatLibraryPrice(total)}`)
                    : React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center' } }, "Everything here is free \u2014 open any of them to start reading."))));
}


// The single Featured Chronicle spotlighted above New Releases — always exactly one book, picked
// from what's actually published: the reader's own highest-rated pick if they've rated anything
// (see ratedBooks in GrandLibraryScreen), otherwise the newest release. The star row shown here
// is that same personal rating, since a reader's own rating is the only rating data that's real
// today (see BookDetailModal) — an unrated book shows five empty stars rather than a number
// invented for the occasion. The golden glow and the soft light drifting above it (see the
// .gl-featured-card / .gl-lamp-light keyframes) are purely atmospheric, echoing the chandelier
// hanging over the rest of the Grand Library (see GrandLibraryAtmosphere).
export function FeaturedChronicleCard({ book, myRating, onRead, onViewDetails, onOpenAuthor, following, inCart, onToggleFollow, onBuy, onTip, onRate, onDiscuss, onSample }) {
    const stars = (myRating && myRating.stars) || 0;
    const badge = getLibraryBadge(book);
    return React.createElement("div", { className: "gl-featured-card", style: {
            position: 'relative', display: 'flex', gap: SPACE_SCALE[22], alignItems: 'flex-start', flexWrap: 'wrap',
            background: 'linear-gradient(160deg, #2A2317, #17130E)', border: '1px solid #4A3D22',
            borderRadius: RADIUS_SCALE[18], padding: '26px 28px', marginBottom: 30,
        } },
        React.createElement("div", { className: "gl-lamp-light", style: {
                position: 'absolute', top: -50, left: '50%', width: 170, height: 220, zIndex: 0, pointerEvents: 'none',
                background: 'linear-gradient(180deg, rgba(255,224,153,0.30), rgba(255,224,153,0.05) 55%, transparent)',
                filter: 'blur(12px)',
            } }),
        React.createElement("div", { style: { position: 'relative', zIndex: 1, flexShrink: 0, margin: '0 auto' } },
            React.createElement(BookCover, { title: book.title, subtitle: book.subtitle, seriesName: book.seriesName, author: book.author, cover: book.cover, size: 'lg' })),
        React.createElement("div", { style: { position: 'relative', zIndex: 1, flex: 1, minWidth: 220 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#C89B3C', marginBottom: 8 } }, "\u2726 Featured Chronicle"),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[24], fontWeight: 600, color: '#EFE7D2', lineHeight: 1.2 } }, book.title || 'Untitled Novel'),
                React.createElement(LibraryCardBadge, { badge }),
                isSerialFormat(book) && React.createElement(SeriesTag, null)),
            React.createElement(LibraryAuthorLink, { author: book.author, authorId: book.authorId, onOpenAuthor }),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 16, flexWrap: 'wrap' } },
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                        padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                    } }, book.genre),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: stars > 0 ? '#E8C468' : '#4A4A50', letterSpacing: 1 } }, "\u2605".repeat(stars) + "\u2606".repeat(5 - stars)),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: book.price > 0 ? '#E8C468' : '#8FCB8F' } }, formatLibraryPrice(book.price))),
            book.blurb && React.createElement("div", { style: {
                    fontSize: TYPE_SCALE[13], color: '#C9BE8D', marginTop: 14, lineHeight: 1.6, fontStyle: 'italic', maxWidth: 480,
                    display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
                } }, book.blurb),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], marginTop: 20, flexWrap: 'wrap' } },
                React.createElement("button", { onClick: onRead, style: {
                        background: 'linear-gradient(160deg, #E8C468, #C89B3C)', border: 'none', color: '#17171B',
                        borderRadius: RADIUS_SCALE[9], padding: '10px 20px', fontSize: TYPE_SCALE[13], fontWeight: 700, cursor: 'pointer',
                        boxShadow: '0 4px 14px rgba(200,155,60,0.35)',
                    } }, "Read Now"),
                React.createElement("button", { onClick: onViewDetails, style: {
                        background: 'none', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[9], padding: '10px 20px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                    } }, "View Details")),
            React.createElement("div", { style: { maxWidth: 420 } },
                React.createElement(LibraryQuickActions, {
                    book, following, inCart, onToggleFollow, onBuy, onTip, onRate, onDiscuss, onSample,
                }))));
}


// A Coming Soon section — same heading treatment as a real shelf, but with a row of faint,
// unlit "ghost" spines standing in for books that can't be shown yet, plus the honest notice
// explaining why (it needs a shared backend service Inkroot doesn't have today).
export function ComingSoonShelf({ icon, label, description }) {
    return React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon, label }),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], marginBottom: 10 } },
            [0, 1, 2, 3, 4].map((i) => React.createElement("div", { key: i, style: {
                    width: 40, height: 60, borderRadius: '2px 5px 5px 2px', flexShrink: 0,
                    background: 'linear-gradient(160deg, rgba(122,122,130,0.10), rgba(122,122,130,0.03))',
                    border: '1px solid rgba(122,122,130,0.14)',
                } }))),
        React.createElement(ComingSoonNotice, { icon: React.createElement(InkIcon, { name: "lock", size: 12 }), text: description }));
}


// Deterministic per-book physical variation for the Browse & Search bookcase (see
// LibraryBookcase/LibraryDiscoverCard below) — same hashSeed technique Home's own shelf already
// uses for its size variety, so the same book always comes out looking the same way rather than
// reshuffling on every re-render. Nothing here touches title/author/price/etc.; it only feeds
// BookCover's optional depthScale/tiltDeg/leanDeg (see book3DShell in book-cover.jsx, all
// backward-compatible additions) plus a size scale and a faint wear filter applied outside it, so
// a shelf of these reads as individually different physical volumes instead of identical stamped
// covers. A custom uploaded cover image gets a uniform (non-stretching) scale so its artwork is
// never distorted; only the generated pattern covers get independent width/height variety.
function bookPhysicalVariation(book) {
    const seed = hashSeed(book.id || book.title || '');
    const hasCustomCoverImage = !!(book.cover && book.cover.customImageUrl);
    // Narrowed from 0.92–1.08/0.93–1.09 — a caller-side scale() transform never grows the flex
    // item's own layout box, so the old wider range could visually outgrow the fresh reserved
    // footprint BookCover now sets aside for it (see coverReservePx in book-cover.jsx).
    const scaleW = 0.94 + ((seed % 13) / 12) * 0.12; // ~0.94–1.06
    const scaleH = 0.95 + (((seed >> 4) % 11) / 10) * 0.12; // ~0.95–1.07, independent of width
    const uniformScale = (scaleW + scaleH) / 2;
    // Narrowed from 0.7–1.4 for the same reason — the extreme end was pushing this bookcase's
    // page-edge/spine layers past even the reserved footprint, into the compartment's own walls.
    const depthScale = 0.85 + (((seed >> 8) % 17) / 16) * 0.4; // ~0.85–1.25 — an independently thin or thick spine
    const tiltDeg = -4 - (((seed >> 12) % 8) / 7) * 7; // ~-4 to -11deg idle angle, instead of one fixed tilt
    const leanDeg = (((seed >> 16) % 11) - 5) * 0.55; // ~-2.75 to 2.75deg — some books lean either way, most nearly upright
    const brightness = 0.94 + (((seed >> 20) % 9) / 8) * 0.1; // ~0.94–1.04 — a hint of uneven wear/lighting
    const saturate = 0.9 + (((seed >> 24) % 9) / 8) * 0.18; // ~0.9–1.08
    return {
        coverScaleX: hasCustomCoverImage ? uniformScale : scaleW,
        coverScaleY: hasCustomCoverImage ? uniformScale : scaleH,
        depthScale, tiltDeg, leanDeg,
        filter: `brightness(${brightness.toFixed(3)}) saturate(${saturate.toFixed(3)})`,
    };
}


// A discovery card for Reader mode — the same shelf-card shape as the old Guild Library's
// LibraryBookCard, plus the two things a marketplace listing actually adds: a genre badge (already
// present) and a blurb, and a real (if unenforceable) price in place of the hardcoded "Free".
export function LibraryDiscoverCard({ book, isFavorite, onToggleFavorite, onRead, onPreview, myRating, onOpenAuthor, following, inCart, onToggleFollow, onBuy, onTip, onRate, onDiscuss, onSample }) {
    const badge = getLibraryBadge(book);
    const v = bookPhysicalVariation(book);
    // No card chrome here on purpose — this now sits directly inside a recessed bookcase
    // compartment (see LibraryBookcase below), which already supplies the background, depth
    // shadows, and shelf ledge. Wrapping this in its own flat panel again would just recreate
    // the "floating card" look the bookcase replaced.
    return React.createElement("div", { className: "gl-book-cover", style: {
            position: 'relative', display: 'flex', gap: SPACE_SCALE[14], textAlign: 'left',
        } },
        React.createElement("div", { onClick: onPreview, style: { cursor: onPreview ? 'pointer' : 'default', filter: v.filter }, title: onPreview ? 'View details' : undefined },
            React.createElement("div", { style: { transform: `scale(${v.coverScaleX}, ${v.coverScaleY})`, transformOrigin: 'center bottom' } },
                React.createElement(BookCover, {
                    title: book.title, subtitle: book.subtitle, seriesName: book.seriesName, author: book.author, cover: book.cover, size: 'sm',
                    depthScale: v.depthScale, tiltDeg: v.tiltDeg, leanDeg: v.leanDeg,
                }))),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8] } },
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], flexWrap: 'wrap', cursor: onPreview ? 'pointer' : 'default' }, onClick: onPreview },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, book.title || 'Untitled Novel'),
                        React.createElement(LibraryCardBadge, { badge }),
                        isSerialFormat(book) && React.createElement(SeriesTag, null)),
                    React.createElement(LibraryAuthorLink, { author: book.author, authorId: book.authorId, onOpenAuthor })),
                React.createElement("button", { onClick: () => onToggleFavorite(book.id), title: "Save to My Library", style: {
                        background: 'none', border: 'none', cursor: 'pointer', fontSize: TYPE_SCALE[16], color: isFavorite ? '#E8C468' : '#4A4A52', flexShrink: 0,
                    } }, isFavorite ? "\u2605" : "\u2606")),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 12, flexWrap: 'wrap' } },
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                        padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                    } }, book.genre),
                React.createElement(LibraryCardRating, { myRating })),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                isSerialFormat(book) && book.chapterCount
                    ? React.createElement("span", null, `${book.chapterCount} episode${book.chapterCount === 1 ? '' : 's'}`)
                    : React.createElement("span", null, `${book.wordCount.toLocaleString()} words`),
                React.createElement("span", null, estimateReadingTime(book.wordCount)),
                book.guildName && React.createElement("span", null, "\u2666 ", book.guildName)),
            book.blurb && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 8, lineHeight: 1.5, fontStyle: 'italic' } }, book.blurb),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 'auto', paddingTop: 12 } },
                React.createElement("span", { title: formatLibraryPrice(book.price), style: {
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 30, height: 30, borderRadius: '50%',
                        fontSize: TYPE_SCALE[14], fontWeight: 700, textAlign: 'center', lineHeight: 1,
                        color: book.price > 0 ? '#E8C468' : '#8FCB8F',
                        background: 'radial-gradient(circle at 34% 30%, #241F14, #17130E 75%)',
                        border: `1px solid ${book.price > 0 ? '#4A3D22' : '#2E4A2E'}`,
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 2px 6px rgba(0,0,0,0.4)',
                    } }, book.price > 0 ? "\u20A6" : "\u2726"),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600, color: book.price > 0 ? '#E8C468' : '#8FCB8F' } }, formatLibraryPrice(book.price)),
                React.createElement("button", { onClick: () => onRead(book.id), style: {
                        position: 'relative', overflow: 'visible', background: 'linear-gradient(160deg, #241F14, #17140F)',
                        border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer', marginLeft: 'auto',
                    } }, "Open the tome",
                    React.createElement("span", { className: "gl-page-corner", style: {
                            display: 'inline-block', marginLeft: 6, transformOrigin: 'left center',
                        } }, "\u276F"))),
            React.createElement(LibraryQuickActions, {
                book, following, inCart, onToggleFollow, onBuy, onTip,
                onRate: onRate || onPreview, onDiscuss, onSample: onSample || onPreview,
            })));
}


// ---------- The Browse & Search bookcase ----------
// The physical shell around the full Browse & Search results list: a carved wooden case built
// from stacked, recessed compartments — one per book — rather than a grid of flat cards. Each
// compartment gets its own sunken back panel and shadowed side walls (depth), and sits on a real
// wood ledge (see .gl-bookcase-ledge, same plank language as the New Releases/Trending/etc.
// shelves above it via GrandLibraryShelfRow) so every book reads as resting inside the case, not
// pasted on top of it. This component is purely structural — it supplies the wood, not the
// content: whatever's passed in `items[].content` (LibraryDiscoverCard, unchanged) still carries
// every bit of existing data and every action (favorite, buy, tip, follow, rate, discuss,
// sample). Stacked as a single column on purpose for now — a narrow case you scroll down, which
// is what makes it feel solid and substantial on a phone-width screen; a wider multi-book-per-
// shelf layout can build on top of this same structure later.
export function LibraryBookcase({ items }) {
    return React.createElement("div", { className: "gl-bookcase" },
        items.map((it) => {
            // A couple of extra pixels of gap under some compartments (deterministic per book,
            // same hashSeed technique as bookPhysicalVariation above) so the case doesn't scan as
            // a perfectly uniform repeating unit — a little natural unevenness, the way real
            // shelving never sits perfectly flush.
            const extraGap = hashSeed(it.key) % 5;
            return React.createElement("div", {
                key: it.key, className: "gl-bookcase-compartment", style: extraGap ? { marginBottom: extraGap } : undefined,
            },
                React.createElement("div", { className: "gl-bookcase-compartment-back" }),
                React.createElement("div", { className: "gl-bookcase-compartment-content" }, it.content),
                React.createElement("div", { className: "gl-bookcase-ledge" }));
        }));
}


// One book in Author Studio — a Publish button (completed projects only) opening the shared
// Publishing Wizard (see PublishingWizard), plus a "Manage listing" button to reopen that same
// wizard once published, so the listing (title, description, category, tags, price) is always
// edited through the same four-step flow. A Guild publication shows a one-click "Promote to
// Inkroot" instead, since it's the same project record either way — no duplicate upload.
export function AuthorStudioBookCard({ project, writerGuildName, onSetPublishStatus, onOpenPublishWizard, onOpen }) {
    const publishStatus = resolvePublishStatus(project);
    return React.createElement("div", { style: { background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: 16 } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start' } },
            React.createElement(BookCover, { title: project.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author, cover: project.cover, size: 'sm' }),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, project.title || 'Untitled Novel'),
                    isSerialFormat(project) && React.createElement(SeriesTag, null)),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 2 } }, isSerialFormat(project) && project.chapterCount
                    ? `${project.chapterCount} ${project.chapterCount === 1 ? 'episode' : 'episodes'}`
                    : `${(project.wordCount || 0).toLocaleString()} words`),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 10, flexWrap: 'wrap' } },
                    React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                            padding: '3px 9px', borderRadius: RADIUS_SCALE[999],
                            background: project.completed ? 'rgba(143,203,143,0.12)' : 'rgba(122,122,130,0.14)',
                            color: project.completed ? '#8FCB8F' : '#A6A6AD',
                        } }, project.completed ? 'Completed' : 'In Progress'),
                    project.completed && publishStatus !== 'none' && React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                            padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                        } }, publishStatus === 'inkroot' ? 'Published \u00B7 Inkroot' : `Published \u00B7 ${writerGuildName || 'Guild'}`),
                    project.completed && publishStatus === 'none' && React.createElement("button", { onClick: () => onOpenPublishWizard(project.id, 'book'), style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        } }, "Publish"),
                    project.completed && publishStatus !== 'none' && React.createElement("button", { onClick: () => onOpenPublishWizard(project.id, 'book'), style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        } }, "Manage listing"),
                    project.completed && publishStatus === 'guild' && React.createElement("button", { onClick: () => onSetPublishStatus(project.id, 'inkroot'), style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        } }, "Promote to Inkroot"),
                    project.completed && publishStatus !== 'none' && React.createElement("button", { onClick: () => onSetPublishStatus(project.id, 'none'), style: {
                            background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0,
                        } }, "Unpublish"),
                    !project.completed && React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic' } }, "Mark as completed in Settings to publish"),
                    project.completed && React.createElement("button", { onClick: () => onOpen(project.id), style: {
                            background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0,
                        } }, "Open")),
                project.completed && publishStatus !== 'none' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], marginTop: 10, flexWrap: 'wrap' } },
                    [['Readers', React.createElement(InkIcon, { name: "users", size: 12 })], ['Rating', React.createElement(InkIcon, { name: "star", size: 12 })], ['Sales', React.createElement(InkIcon, { name: "moneybag", size: 12 })], ['Earnings', React.createElement(InkIcon, { name: "coin", size: 12 })]].map(([label, icon]) => React.createElement("div", { key: label, style: {
                            fontSize: TYPE_SCALE[10.5], color: '#5C5C64', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4],
                        } }, React.createElement("span", null, icon), React.createElement("span", null, `${label}: \u2014`)))))));
}


// Reviews from other readers — real now (see 61_migration_reviews_rating_column.sql and
// src/lib/library.js's submitReview/fetchBookStats). Deliberately separate from the private
// on-device "Your rating" section above it in BookDetailModal: that one is a personal note kept
// only on this device (feeds the reader's own Highest Rated shelf / Featured Chronicle pick);
// this one is a real, public, one-per-reader review (rating + optional text), visible to anyone
// who opens the book, anywhere. The two never merge into one number — a reader can rate privately
// without ever posting a public review, or vice versa.
//
// fetchBookStats fails honestly (see its own comment in library.js) — `stats` stays `undefined`
// while loading, and drops to `null` on any error (offline, RLS surprise, etc.), which renders a
// small "couldn't load" note rather than an empty "no reviews yet" that would be misleading.
function PublicReviewsSection({ bookId }) {
    const sync = useSync();
    const isSignedIn = !!(sync && sync.session);
    const myId = sync && sync.session && sync.session.user && sync.session.user.id;
    const [stats, setStats] = useState(undefined); // undefined = loading, null = failed to load
    const [stars, setStars] = useState(0);
    const [body, setBody] = useState('');
    const [seeded, setSeeded] = useState(false);
    const [submitState, setSubmitState] = useState('idle'); // idle | saving | error
    const [submitError, setSubmitError] = useState(null);
    const savedTimer = useRef(null);

    const load = () => {
        fetchBookStats(bookId)
            .then((s) => setStats(s))
            .catch(() => setStats(null));
    };
    useEffect(() => {
        load();
        return () => { if (savedTimer.current) clearTimeout(savedTimer.current); };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bookId]);

    const myReview = stats && myId ? stats.reviews.find((r) => r.reviewer_id === myId) : null;
    useEffect(() => {
        if (myReview && !seeded) {
            setStars(myReview.rating);
            setBody(myReview.body || '');
            setSeeded(true);
        }
    }, [myReview, seeded]);

    const handleSubmit = async () => {
        if (stars === 0) return;
        setSubmitState('saving');
        setSubmitError(null);
        try {
            await submitReview(bookId, stars, body.trim());
            setSubmitState('idle');
            if (savedTimer.current) clearTimeout(savedTimer.current);
            load();
        } catch (e) {
            setSubmitState('error');
            setSubmitError(e.message || 'Could not post your review.');
        }
    };

    const otherReviews = stats ? stats.reviews.filter((r) => !myReview || r.id !== myReview.id) : [];

    return React.createElement("div", null,
        stats === undefined && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic' } }, "Loading reviews\u2026"),
        stats === null && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic' } }, "Couldn't load reviews right now."),
        stats && React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 12 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: stats.reviewCount > 0 ? '#E8C468' : '#3A3A42', letterSpacing: 1 } },
                "\u2605".repeat(Math.round(stats.avgRating || 0)) + "\u2606".repeat(5 - Math.round(stats.avgRating || 0))),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } },
                stats.reviewCount > 0 ? `${stats.avgRating.toFixed(1)} \u00B7 ${stats.reviewCount} review${stats.reviewCount === 1 ? '' : 's'}` : 'No reviews yet')),
        stats && otherReviews.length > 0 && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], marginBottom: 16 } },
            otherReviews.map((r) => React.createElement("div", { key: r.id, style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: 10 } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: SPACE_SCALE[4] } },
                    React.createElement("span", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], fontWeight: 600, color: '#C9BE8D' } }, r.reviewer_name || 'A reader'),
                        r.reviewer_verified && React.createElement("span", { title: "Verified account", style: { color: '#6FAE8F', fontSize: TYPE_SCALE[12] } }, "\u2713")),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#E8C468', letterSpacing: 1 } }, "\u2605".repeat(r.rating) + "\u2606".repeat(5 - r.rating))),
                r.body && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, r.body),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 4 } }, formatRelativeTime(new Date(r.created_at).getTime()))))),
        !isSignedIn && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic' } }, "Sign in to post a public review."),
        isSignedIn && React.createElement("div", { style: { marginTop: 4 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 6 } }, myReview ? "Edit your review" : "Leave a public review"),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[4], marginBottom: 6 } },
                [1, 2, 3, 4, 5].map((n) => React.createElement("button", { key: n, onClick: () => setStars(n), style: {
                        background: 'none', border: 'none', cursor: 'pointer', fontSize: TYPE_SCALE[18], padding: 0,
                        color: n <= stars ? '#E8C468' : '#3A3A42',
                    } }, "\u2605"))),
            React.createElement("textarea", { value: body, onChange: (e) => setBody(e.target.value), maxLength: 4000, rows: 2,
                    placeholder: "Share what you thought (optional)\u2026", style: {
                    width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2',
                    borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[12.5], resize: 'vertical', fontFamily: 'inherit',
                } }),
            submitError && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 6 } }, submitError),
            React.createElement("button", { onClick: handleSubmit, disabled: stars === 0 || submitState === 'saving', style: {
                    marginTop: 8, background: 'none', border: '1px solid #3A3020',
                    color: stars === 0 ? '#5C5C64' : '#C89B3C', borderRadius: RADIUS_SCALE[8], padding: '6px 14px', fontSize: TYPE_SCALE[12],
                    cursor: stars === 0 ? 'default' : 'pointer', fontWeight: 600,
                } }, submitState === 'saving' ? 'Posting\u2026' : myReview ? 'Update my review' : 'Post review')));
}


// The book detail modal — opened from a shelf row or a search-result card. Brings everything a
// reader might want onto one page: the listing (blurb/genre/price), a real on-demand sample of
// the opening prose, a way to read the full book — free immediately, or gated behind a completed
// purchase for a priced one (see the note above the search bar in GrandLibraryScreen, and
// checkBookReadAccess in lib/library.js, which is what the reader screen actually enforces this
// with), a personal star rating saved to this device, a working Buy action for priced books (see
// LibraryQuickActions/CartDrawer — real Naira checkout, not a placeholder), and real public
// reviews from other readers.
export function BookDetailModal({ book, isFavorite, onToggleFavorite, myRating, onSetRating, onReadFull, onClose, onOpenAuthor, following, inCart, onToggleFollow, onBuy, onTip, onDiscuss }) {
    const [sample, setSample] = useState(null); // null = not loaded yet, '' = loaded but empty, string = text
    const [sampleLoading, setSampleLoading] = useState(false);
    const [stars, setStars] = useState((myRating && myRating.stars) || 0);
    const [note, setNote] = useState((myRating && myRating.note) || '');
    const [ratingSaved, setRatingSaved] = useState(false);
    const savedTimer = useRef(null);
    const ratingSectionRef = useRef(null);
    useEffect(() => () => { if (savedTimer.current)
        clearTimeout(savedTimer.current); }, []);
    const loadSample = async () => {
        if (sample !== null || sampleLoading)
            return;
        setSampleLoading(true);
        try {
            const res = await storage.get(projectKey(book.id));
            if (res) {
                // Local IndexedDB only has this project's data on the author's own device —
                // build the sample straight from it, same as always.
                const proj = patchProjectDefaults(JSON.parse(res.value));
                const firstChapter = Array.isArray(proj.chapters) ? proj.chapters.find((c) => stripHtml(c.text).trim().length > 0) : null;
                const plain = firstChapter ? stripHtml(firstChapter.text).trim() : '';
                setSample(plain ? (plain.slice(0, 640) + (plain.length > 640 ? '\u2026' : '')) : '');
                return;
            }
            // Every other reader — not this book's own author's device. Reads the small,
            // always-public sample mirror (89_migration_paid_book_content_access.sql's
            // published_book_samples) rather than fetchPublishedBookContent's full manuscript:
            // that table is now gated by purchase for a priced book, and even for a free book
            // there's no reason for a 640-character preview to pull the whole thing over the
            // wire just to truncate it client-side. The database keeps this sample in sync with
            // the real content automatically (see sync_published_book_sample()), so nothing here
            // needs to know or care whether the book is free or paid.
            const sampleText = await fetchPublishedBookSample(book.id);
            setSample(sampleText || '');
        }
        catch (e) {
            setSample('');
        }
        setSampleLoading(false);
    };
    const handleSaveRating = () => {
        onSetRating(book.id, { stars, note: note.slice(0, 300) });
        setRatingSaved(true);
        if (savedTimer.current)
            clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setRatingSaved(false), 2200);
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
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2' } }, book.title || 'Untitled Novel'),
                        isSerialFormat(book) && React.createElement(SeriesTag, null)),
                    React.createElement(LibraryAuthorLink, { author: book.author, authorId: book.authorId, onOpenAuthor }),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                        React.createElement("span", null, book.genre),
                        isSerialFormat(book) && book.chapterCount
                            ? React.createElement("span", null, `${book.chapterCount} episode${book.chapterCount === 1 ? '' : 's'}`)
                            : React.createElement("span", null, `${book.wordCount.toLocaleString()} words`),
                        React.createElement("span", null, estimateReadingTime(book.wordCount)),
                        book.guildName && React.createElement("span", null, "\u2666 ", book.guildName)),
                    React.createElement("button", { onClick: () => onToggleFavorite(book.id), style: {
                            marginTop: 10, background: 'none', border: '1px solid #3A3020', color: isFavorite ? '#E8C468' : '#A6A6AD',
                            borderRadius: RADIUS_SCALE[8], padding: '5px 11px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                        } }, isFavorite ? "\u2605 Saved to My Library" : "\u2606 Save to My Library"))),
            React.createElement(LibraryQuickActions, {
                book, following, inCart, onToggleFollow, onBuy, onTip, onDiscuss,
                onRate: () => ratingSectionRef.current && ratingSectionRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' }),
                onSample: loadSample,
            }),
            book.blurb && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#C9BE8D', marginTop: 16, lineHeight: 1.6, fontStyle: 'italic' } }, book.blurb),
            React.createElement("div", { style: { marginTop: 24 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 } }, "Read a sample"),
                sample === null
                    ? React.createElement("button", { onClick: loadSample, disabled: sampleLoading, style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '7px 14px', fontSize: TYPE_SCALE[12], cursor: sampleLoading ? 'default' : 'pointer', fontWeight: 600,
                        } }, sampleLoading ? 'Opening the pages\u2026' : "Peek at the opening")
                    : React.createElement("div", { style: { position: 'relative' } },
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#D9D2BE', lineHeight: 1.7, maxHeight: 160, overflow: 'hidden' } }, sample || 'This book has no written pages yet.'),
                        sample && React.createElement("div", { style: {
                                position: 'absolute', left: 0, right: 0, bottom: 0, height: 40,
                                background: 'linear-gradient(180deg, transparent, #17130E)',
                            } }))),
            React.createElement("div", { style: { marginTop: 24, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, color: book.price > 0 ? '#E8C468' : '#8FCB8F' } }, formatLibraryPrice(book.price)),
                    React.createElement("button", { onClick: () => onReadFull(book.id), style: {
                            background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '8px 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                        } }, "Read the full book")),
                book.price > 0
                    ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic' } }, "Tap Buy above to purchase in Naira \u2014 reading the full book requires a completed purchase.")
                    : React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic' } }, "Free \u2014 no purchase needed.")),
            React.createElement("div", { ref: ratingSectionRef, style: { marginTop: 24 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 } }, "Your rating"),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[4], marginBottom: 8 } },
                    [1, 2, 3, 4, 5].map((n) => React.createElement("button", { key: n, onClick: () => setStars(n), style: {
                            background: 'none', border: 'none', cursor: 'pointer', fontSize: TYPE_SCALE[20], padding: 0,
                            color: n <= stars ? '#E8C468' : '#3A3A42',
                        } }, "\u2605"))),
                React.createElement("textarea", { value: note, onChange: (e) => setNote(e.target.value), maxLength: 300, rows: 2,
                        placeholder: "A private note to yourself about this book (optional)\u2026", style: {
                        width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2',
                        borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[12.5], resize: 'vertical', fontFamily: 'inherit',
                    } }),
                React.createElement("button", { onClick: handleSaveRating, disabled: stars === 0, style: {
                        marginTop: 8, alignSelf: 'flex-start', background: 'none', border: '1px solid #3A3020',
                        color: stars === 0 ? '#5C5C64' : '#C89B3C', borderRadius: RADIUS_SCALE[8], padding: '6px 14px', fontSize: TYPE_SCALE[12],
                        cursor: stars === 0 ? 'default' : 'pointer', fontWeight: 600,
                    } }, ratingSaved ? 'Saved \u2713' : 'Save my rating'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 6, fontStyle: 'italic' } }, "Kept privately on this device.")),
            React.createElement("div", { style: { marginTop: 24 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 8 } }, "Reviews from other readers"),
                React.createElement(PublicReviewsSection, { bookId: book.id }))));
}


// Purely decorative backdrop for the Grand Library: a stone-block wall, two tall arched windows
// with warm light pouring in, a hanging candle chandelier, and drifting dust motes. Renders as an
// absolutely-positioned layer (z-index 0) behind whatever's passed as children (z-index 1), so
// none of it ever intercepts clicks or scroll on the real screen content above it. The dust mote
// positions/timings are randomized once per mount via useMemo rather than re-rolled on every
// render, so they don't visibly jump around as the reader filters or sorts books.
export function GrandLibraryAtmosphere({ children }) {
    const dustMotes = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
        id: i,
        left: 4 + Math.random() * 92,
        size: 2 + Math.random() * 3,
        delay: Math.random() * 6,
        duration: 7 + Math.random() * 6,
    })), []);
    return React.createElement("div", { style: { position: 'relative', borderRadius: RADIUS_SCALE[18], overflow: 'hidden', isolation: 'isolate' } },
        React.createElement("div", { style: {
                position: 'absolute', inset: 0, zIndex: 0,
                background: 'radial-gradient(ellipse at 50% 0%, rgba(232,196,104,0.16), transparent 55%),' +
                    'repeating-linear-gradient(0deg, rgba(0,0,0,0.22) 0px, rgba(0,0,0,0.22) 2px, transparent 2px, transparent 46px),' +
                    'repeating-linear-gradient(90deg, rgba(0,0,0,0.14) 0px, rgba(0,0,0,0.14) 2px, transparent 2px, transparent 64px),' +
                    'linear-gradient(160deg, #322C24, #1D1A15)',
            } }),
        React.createElement("div", { className: "gl-window-light", style: {
                position: 'absolute', top: -20, left: '4%', width: 70, height: 220, zIndex: 0,
                background: 'linear-gradient(180deg, rgba(255,224,153,0.28), rgba(255,224,153,0.04) 70%, transparent)',
                borderRadius: '50% 50% 6px 6px / 30% 30% 6px 6px', border: '1px solid rgba(200,155,60,0.25)',
                filter: 'blur(1px)',
            } }),
        React.createElement("div", { className: "gl-window-light", style: {
                position: 'absolute', top: -20, right: '4%', width: 70, height: 220, zIndex: 0, animationDelay: '1.2s',
                background: 'linear-gradient(180deg, rgba(255,224,153,0.24), rgba(255,224,153,0.03) 70%, transparent)',
                borderRadius: '50% 50% 6px 6px / 30% 30% 6px 6px', border: '1px solid rgba(200,155,60,0.2)',
                filter: 'blur(1px)',
            } }),
        React.createElement("div", { className: "gl-chandelier", style: { position: 'absolute', top: 0, left: '50%', zIndex: 0 } },
            React.createElement("div", { style: { width: 1, height: 22, background: 'linear-gradient(180deg, #4A3D22, #2A2418)', margin: '0 auto' } }),
            React.createElement("div", { style: { width: 92, height: 6, borderRadius: RADIUS_SCALE[3], background: 'linear-gradient(160deg, #C89B3C, #7A5E24)', boxShadow: '0 2px 8px rgba(0,0,0,0.4)' } }),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', width: 92, marginTop: -2 } },
                [0, 1, 2].map((i) => React.createElement("div", { key: i, style: { display: 'flex', flexDirection: 'column', alignItems: 'center' } },
                    React.createElement("div", { style: { width: 1, height: 10, background: '#4A3D22' } }),
                    React.createElement("div", { style: { width: 5, height: 12, borderRadius: '2px 2px 1px 1px', background: 'linear-gradient(180deg, #EFE7D2, #C9BE8D)' } }),
                    React.createElement("div", { className: "gl-flame", style: {
                            width: 5, height: 9, marginTop: -1, borderRadius: '50% 50% 50% 50% / 60% 60% 40% 40%',
                            background: 'radial-gradient(circle at 50% 30%, #FFF3C4, #E8C468 55%, #C25E2E 100%)',
                            boxShadow: '0 0 8px 2px rgba(232,196,104,0.6), 0 0 16px 4px rgba(232,196,104,0.25)',
                        } }))))),
        React.createElement("div", { style: { position: 'absolute', inset: 0, zIndex: 0, pointerEvents: 'none' } },
            dustMotes.map((m) => React.createElement("span", { key: m.id, className: "gl-dust-mote", style: {
                    position: 'absolute', left: `${m.left}%`, bottom: 0, width: m.size, height: m.size, borderRadius: '50%',
                    background: 'radial-gradient(circle, rgba(255,238,200,0.9), rgba(255,238,200,0))',
                    animationDuration: `${m.duration}s`, animationDelay: `${m.delay}s`,
                } }))),
        React.createElement("div", { style: { position: 'relative', zIndex: 1, padding: '46px 8px 8px' } }, children));
}


// The Grand Library screen itself: a small segmented switch between Reader and Author Studio,
// each rendering into the same wrapper so the two modes read as one place, not two pages.
// Reader mode: browse curated shelves (New Releases, Highest Rated) and Coming Soon sections
// (Most Read, Editor's Choice, Guild Collections, Hall of Legends — all need a shared backend
// this on-device app doesn't have), search/filter/sort the full catalog, and open any book in a
// BookDetailModal for a sample, a personal rating, saving to My Library, and reading in full.
// Author Studio: publish/unpublish, edit the marketplace listing, and see (currently Coming Soon)
// readers/reviews/ratings/sales/earnings for each published book. The architecture stays modular
// on purpose — every backend-shaped feature reads its data from one clearly-marked spot
// (ComingSoonNotice / ComingSoonShelf) so a real service can slot in later without touching the
// surrounding layout.
// ---------- Worldbuilding Packs in the Grand Library ----------
// Every card and modal below works from the lightweight pack summary mirrored onto a project's
// Home-screen index entry (see packSummaryForIndex) — never the full project file — the same way
// a book's blurb/genre/price already live at the index level. That's what lets a pack be browsed,
// and unpublished, from the Grand Library without opening the project that owns it.
export function formatPackPrice(price) {
    return (!price || price <= 0) ? 'Free' : formatNaira(price);
}


// A reader-facing card for the Browse & Search grid — same shape as LibraryDiscoverCard, but for
// a pack rather than a book: no reading-time/word-count (that's a book metric), a category
// breakdown instead of a genre, and "View Pack" opens the full contents rather than reading prose.
export function WorldbuildingPackLibraryCard({ pack, onOpen }) {
    return React.createElement("div", { style: {
            display: 'flex', gap: SPACE_SCALE[14], background: 'linear-gradient(160deg, #211C13, #17130E)',
            borderLeft: '4px solid #4A3D22', borderRadius: '4px 14px 14px 4px',
            padding: 16, textAlign: 'left', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 6px 16px rgba(0,0,0,0.3)',
        } },
        React.createElement("div", { onClick: onOpen, style: {
                width: 52, height: 72, borderRadius: RADIUS_SCALE[8], flexShrink: 0, cursor: 'pointer', overflow: 'hidden',
                background: pack.coverImageUrl ? `center/cover url(${pack.coverImageUrl})` : 'radial-gradient(circle at 34% 30%, #2A2115, #17130E 75%)',
                border: '1px solid #4A3D22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[22],
            } }, !pack.coverImageUrl && React.createElement(InkIcon, { name: "package", size: 24, color: "#5C5245" })),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            React.createElement("div", { onClick: onOpen, style: { cursor: 'pointer' } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, pack.title || 'Untitled Pack'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 2 } }, "From ", pack.projectTitle || 'a project', " \u00B7 ", pack.author)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                pack.categories.map((c) => React.createElement("span", { key: c.key }, c.icon, " ", c.entries.length))),
            pack.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 8, lineHeight: 1.5, fontStyle: 'italic' } }, truncate(pack.description, 140)),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 'auto', paddingTop: 12 } },
                React.createElement("span", { style: {
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 30, minWidth: 30, padding: '0 8px', borderRadius: RADIUS_SCALE[15],
                        fontSize: pack.price > 0 ? 11 : 14, fontWeight: 700, color: pack.price > 0 ? '#E8C468' : '#8FCB8F',
                        background: 'radial-gradient(circle at 34% 30%, #241F14, #17130E 75%)', border: `1px solid ${pack.price > 0 ? '#4A3D22' : '#2E4A2E'}`,
                    } }, pack.price > 0 ? formatPackPrice(pack.price) : "\u2726"),
                React.createElement("button", { onClick: onOpen, style: {
                        background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer', marginLeft: 'auto',
                    } }, React.createElement(InkIcon, { name: "package", size: 13 }), " View Pack"))));
}


// The full-contents view for one published pack: description, price, and every category it
// includes with the entries' names and short snippets — enough to see what's in it without
// duplicating a full World Bible browser here.
// Buy/Download section (migration 85, fix-tracker item 20) — checks access on mount (author of
// their own pack, or a reader with a settled purchases row — see checkPackDownloadAccess), then
// either offers Buy (checkoutPack) or Download (fetchPublishedPackContent, saved to disk as a
// plain JSON file — "download" being exactly the word the fix-tracker item itself used, not an
// import-into-my-own-project merge, which is a different, much larger feature this doesn't
// attempt). Self-contained rather than routed through the Cart/CartDrawer above: that queue is
// shaped for books specifically (bookId/price/title, one checkoutBook call per line), and a pack
// is always a single-item purchase, so a second, pack-shaped queue would be more machinery than
// this needs.
function PackPurchaseSection({ pack, packId, signedIn }) {
    const [access, setAccess] = useState(null); // null while loading, else { allowed, price }
    const [buying, setBuying] = useState(false);
    const [downloading, setDownloading] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        let cancelled = false;
        checkPackDownloadAccess(packId).then((res) => { if (!cancelled) setAccess(res); });
        return () => { cancelled = true; };
    }, [packId]);

    const handleBuy = async () => {
        setBuying(true);
        setError(null);
        try {
            const outcome = await checkoutPack({ packId });
            if (outcome === 'success' || outcome === 'pending') {
                setAccess({ allowed: true, price: pack.price });
            } else {
                setError("Payment didn't complete — you haven't been charged.");
            }
        } catch (e) {
            setError(e.message);
        } finally {
            setBuying(false);
        }
    };

    const handleDownload = async () => {
        setDownloading(true);
        setError(null);
        try {
            const content = await fetchPublishedPackContent(packId);
            if (!content) {
                setError("Couldn't load this pack's contents — try again in a moment.");
                return;
            }
            const blob = new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${(pack.title || 'worldbuilding-pack').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e) {
            setError(e.message);
        } finally {
            setDownloading(false);
        }
    };

    if (access === null) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', textAlign: 'center', padding: '10px 0' } }, "Checking access\u2026");
    }

    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], marginTop: 4 } },
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C97B63' } }, error),
        access.allowed
            ? React.createElement("button", { onClick: handleDownload, disabled: downloading, style: {
                    background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                    borderRadius: RADIUS_SCALE[8], padding: '10px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                    cursor: downloading ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[8],
                } }, React.createElement(InkIcon, { name: "download", size: 14 }), downloading ? 'Downloading\u2026' : 'Download Pack')
            : !signedIn
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', textAlign: 'center' } }, "Sign in to buy this pack.")
                : React.createElement("button", { onClick: handleBuy, disabled: buying, style: {
                        background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '10px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                        cursor: buying ? 'default' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[8],
                    } }, buying ? 'Processing\u2026' : (pack.price > 0 ? `Buy \u2014 ${formatNaira(pack.price)}` : 'Get for Free')));
}


export function WorldbuildingPackDetailModal({ pack, onClose }) {
    const sync = useSync();
    const signedIn = !!(sync && sync.session && sync.session.user);
    const packId = `${pack.projectId}:${pack.id}`;
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(10,9,7,0.78)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 16px', overflowY: 'auto',
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 560, background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22',
                borderRadius: RADIUS_SCALE[16], padding: 24, boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[12], marginBottom: 4 } },
                React.createElement("div", null,
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[19], fontWeight: 600, color: '#EFE7D2' } }, pack.title || 'Untitled Pack'),
                    pack.subtitle && React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#A6A6AD', marginTop: 3, fontStyle: 'italic' } }, pack.subtitle),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 6 } }, "From ", pack.projectTitle || 'a project', pack.author ? ` \u00B7 ${pack.author}` : '')),
                React.createElement("button", { onClick: onClose, style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0 } }, "\u2715")),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], margin: '14px 0' } },
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[12.5], fontWeight: 700, padding: '4px 12px', borderRadius: RADIUS_SCALE[999],
                        color: pack.price > 0 ? '#E8C468' : '#8FCB8F', background: 'rgba(200,155,60,0.10)', border: `1px solid ${pack.price > 0 ? '#4A3D22' : '#2E4A2E'}`,
                    } }, formatPackPrice(pack.price)),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82' } }, pack.totalEntries, " entries across ", pack.categories.length, " categories")),
            pack.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#A6A6AD', lineHeight: 1.6, marginBottom: 18 } }, pack.description),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[16] } },
                pack.categories.map((cat) => React.createElement("div", { key: cat.key },
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#C89B3C', marginBottom: 8 } }, cat.icon, " ", cat.label),
                    React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[5] } },
                        cat.entries.map((e, i) => React.createElement("div", { key: i, style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[10], fontSize: TYPE_SCALE[12.5], padding: '5px 0', borderBottom: '1px solid #2A2417' } },
                            React.createElement("span", { style: { color: '#EFE7D2' } }, e.name),
                            e.snippet && React.createElement("span", { style: { color: '#7A7A82', textAlign: 'right' } }, e.snippet)))))),
            React.createElement(PackPurchaseSection, { pack, packId, signedIn }))));
}


// Reader-facing browse cards for the Template and Add-on marketplaces, in the Grand Library
// itself (audit finding #2, post-fix-tracker session) — items 21/22 built real
// publish/discover backends for both, but only wired a browse-and-add surface into the Writing
// tool's own panels (AddonStudioPanel/TemplatesPanel), leaving the Grand Library's own
// Templates/Add-ons shelves showing stale "coming soon" copy for a feature that already existed
// elsewhere. These two cards + grand-library-screen.jsx's templatesShelf/addonsShelf close that
// gap: same fetchDiscoverTemplates/fetchDiscoverAddons data, same "Add" write into this device's
// own local readTemplates/writeTemplates or readAddons/writeAddons list as the Writing-tool
// browsers already use — a template or addon added from here shows up in that panel too, since
// both read from the same local list. No separate detail modal, unlike a Worldbuilding Pack:
// neither a template nor an addon carries enough content (no full-text preview, no priced
// purchase step) to justify one — what's on the card is everything there is to see before adding.

export function TemplateLibraryCard({ template, added, onAdd }) {
    const typeLabel = (TEMPLATE_TYPE_LABELS[template.type] || template.type);
    return React.createElement("div", { style: {
            display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8], background: 'linear-gradient(160deg, #211C13, #17130E)',
            borderLeft: '4px solid #3A3020', borderRadius: '4px 14px 14px 4px', padding: 16,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 6px 16px rgba(0,0,0,0.3)',
        } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, template.name || 'Untitled template'),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#A6A6AD' } }, `${typeLabel} \u00B7 by ${template.author}`),
        React.createElement("div", { style: { marginTop: 'auto', paddingTop: 6 } },
            added
                ? React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8272', fontWeight: 600 } }, "Added to My Templates \u2713")
                : React.createElement("button", { onClick: onAdd, style: {
                        background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer',
                    } }, "Add to My Templates")));
}

const TEMPLATE_TYPE_LABELS = { book: 'Book', chapter: 'Chapter', character: 'Character', worldbuilding: 'Worldbuilding' };


export function AddonLibraryCard({ addon, added, onAdd }) {
    return React.createElement("div", { style: {
            display: 'flex', gap: SPACE_SCALE[12], background: 'linear-gradient(160deg, #211C13, #17130E)',
            borderLeft: '4px solid #3A3020', borderRadius: '4px 14px 14px 4px', padding: 16,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.03), 0 6px 16px rgba(0,0,0,0.3)',
        } },
        React.createElement("div", { style: { fontSize: 24, flexShrink: 0 } }, addon.icon || React.createElement(InkIcon, { name: "puzzle", size: 22, color: "#8A8272" })),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            React.createElement("div", null,
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, addon.name || 'Untitled addon'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#A6A6AD' } }, `${addon.category} \u00B7 v${addon.version || '0.1.0'} \u00B7 by ${addon.author}`)),
            addon.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', lineHeight: 1.5, fontStyle: 'italic' } }, truncate(addon.description, 120)),
            React.createElement("div", { style: { marginTop: 'auto', paddingTop: 2 } },
                added
                    ? React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8272', fontWeight: 600 } }, "Added to My Addons \u2713")
                    : React.createElement("button", { onClick: onAdd, style: {
                            background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer',
                        } }, "Add to My Addons"))));
}


// One project's Worldbuilding Packs, in Author Studio — cross-project, so this only shows what's
// already mirrored to the index (see packSummaryForIndex). Publishing a new pack, or editing what
// it includes, still happens inside the project itself; from here an author can only unpublish,
// or jump back into the project to manage it.
export function AuthorStudioPackCard({ projectId, projectTitle, pack, onOpen, onUnpublish, onOpenPublishWizard }) {
    const published = pack.publishStatus && pack.publishStatus !== 'none';
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: 16, alignItems: 'flex-start' } },
        React.createElement("div", { style: {
                width: 44, height: 44, borderRadius: RADIUS_SCALE[9], flexShrink: 0, overflow: 'hidden',
                background: pack.coverImageUrl ? `center/cover url(${pack.coverImageUrl})` : 'radial-gradient(circle at 34% 30%, #2A2115, #17130E 75%)',
                border: '1px solid #4A3D22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[18],
            } }, !pack.coverImageUrl && React.createElement(InkIcon, { name: "package", size: 19, color: "#5C5245" })),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], fontWeight: 600, color: '#EFE7D2' } }, pack.title || 'Untitled Pack'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 2 } }, projectTitle, " \u00B7 ", pack.totalEntries, " entries"),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 10, flexWrap: 'wrap' } },
                React.createElement("span", { style: {
                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', padding: '3px 9px', borderRadius: RADIUS_SCALE[999],
                        background: published ? 'rgba(200,155,60,0.12)' : 'rgba(122,122,130,0.14)', color: published ? '#C89B3C' : '#A6A6AD',
                    } }, published ? 'Published \u00B7 Inkroot' : 'Unpublished'),
                !published && pack.totalEntries > 0 && React.createElement("button", { onClick: () => onOpenPublishWizard(projectId, 'pack', pack.id), style: { background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600 } }, "Publish"),
                published && React.createElement("button", { onClick: () => onOpenPublishWizard(projectId, 'pack', pack.id), style: { background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600 } }, "Manage listing"),
                published && React.createElement("button", { onClick: () => onUnpublish(projectId, pack.id), style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0 } }, "Unpublish"),
                React.createElement("button", { onClick: () => onOpen(projectId), style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0 } }, "Manage in project"))));
}


// ---------- Creator Dashboard ----------
// A professional control room inside Author Studio: who-you-are at a glance up top (avatar, name,
// rank, and reputation — the exact same lifetime figures the Writer Profile already tracks; see
// WriterIdentityCard), five overview cards, and eight tabs covering every facet of running a
// catalog on Inkroot. Only Published Books
// and World Packs have real data behind them today (they're a restyle of the data
// AuthorStudioBookCard / AuthorStudioPackCard already show); the other six tabs are honestly
// marked Coming Soon rather than inventing numbers — same policy as ComingSoonNotice/ComingSoonShelf
// elsewhere in the Grand Library.
export const CREATOR_DASHBOARD_TABS = [
    { key: 'books', label: 'Published Books', icon: React.createElement(InkIcon, { name: "library", size: 15 }) },
    { key: 'packs', label: 'World Packs', icon: React.createElement(InkIcon, { name: "package", size: 15 }) },
    { key: 'templates', label: 'Templates', icon: React.createElement(InkIcon, { name: "puzzle", size: 15 }) },
    { key: 'addons', label: 'Add-ons', icon: React.createElement(InkIcon, { name: "sparkle", size: 15 }) },
    { key: 'analytics', label: 'Analytics', icon: React.createElement(InkIcon, { name: "chart", size: 15 }) },
    { key: 'earnings', label: 'Earnings', icon: React.createElement(InkIcon, { name: "coin", size: 15 }) },
    { key: 'withdrawals', label: 'Withdrawals', icon: React.createElement(InkIcon, { name: "cash", size: 15 }) },
    { key: 'ratings', label: 'Ratings', icon: React.createElement(InkIcon, { name: "star", size: 15 }) },
    { key: 'readers', label: 'Readers', icon: React.createElement(InkIcon, { name: "users", size: 15 }) },
    { key: 'referrals', label: 'Referrals', icon: React.createElement(InkIcon, { name: "gift", size: 15 }) },
];


// Scoped styles for the dashboard's own interactive chrome (tab pills, overview/book cards, quick
// action buttons). Namespaced "cd-" and self-contained like GrandLibraryShelfStyles above it, so
// this can mount without depending on Home's own <style> tag being present.
export function CreatorDashboardStyles() {
    return React.createElement("style", null, `
      .cd-tab-scroll { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; -webkit-overflow-scrolling: touch; padding-bottom: 2px; }
      .cd-tab-scroll::-webkit-scrollbar { display: none; }
      .cd-tab-btn {
        flex-shrink: 0; border: 1px solid #3A3020; border-radius: 999px; padding: 8px 15px; font-size: 12px; font-weight: 600;
        cursor: pointer; background: none; color: #A6A6AD; white-space: nowrap; letter-spacing: 0.02em; font-family: inherit;
        transition: background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease);
      }
      .cd-tab-btn.active {
        background: linear-gradient(160deg, #3A2F1C, #241E12); color: #E8C468; border-color: #4A3D22;
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.06), 0 0 14px rgba(232,196,104,0.28);
      }
      .cd-overview-card { transition: transform var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease); }
      .cd-overview-card:hover { transform: translateY(-2px); border-color: #4A3D22; }
      .cd-book-card { transition: transform var(--ink-dur) var(--ink-ease), border-color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease); }
      .cd-book-card:hover { transform: translateY(-2px); border-color: #4A3D22; box-shadow: 0 10px 26px rgba(0,0,0,0.35); }
      .cd-metric { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 52px; }
      .cd-action-btn {
        background: none; border: 1px solid #3A3020; color: #C89B3C; border-radius: 8px; padding: 6px 13px;
        font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: inherit;
        transition: border-color var(--ink-dur) var(--ink-ease);
      }
      .cd-action-btn.danger { color: #7A7A82; border-color: transparent; text-decoration: underline; padding-left: 2px; padding-right: 2px; }
    `);
}


// Small circular author avatar for the dashboard header — same fallback treatment (a soft radial
// vignette plus a faint silhouette glyph) as every other avatar spot in the app (WriterIdentityCard,
// MemberCard, HomeScreen's own profile shortcut), just sized for a compact dashboard header rather
// than a full profile card.
export function CreatorAvatar({ avatar, size }) {
    const s = size || 52;
    return React.createElement("div", { style: {
            width: s, height: s, borderRadius: '50%', flexShrink: 0,
            background: avatar ? `center/cover url(${avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
            border: '2px solid #C89B3C', boxShadow: '0 0 0 2px #100E0A, 0 0 16px rgba(200,155,60,0.28)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
        } }, !avatar && React.createElement(InkIcon, { name: "users", size: Math.round(s * 0.36), color: "#8A8272" }));
}


// The dashboard's top identity strip: avatar, writer name, and the same Rank / Reputation
// plaques WriterIdentityCard shows on the full Writer Profile (see IdentityPlaque above) — reused
// here rather than re-invented, so a writer's standing always reads identically everywhere it
// appears. Used to also show a "Creator Level" plaque — removed along with Writer Level; Rank is
// Reputation-driven now, so there's one standing shown, not two.
export function CreatorDashboardHeader({ profile, rank, reputation }) {
    const name = (profile && (profile.penName || profile.name)) || 'Unnamed Writer';
    const rk = rank || WRITER_RANKS[0];
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[16], flexWrap: 'wrap',
            background: 'radial-gradient(ellipse at 50% 0%, rgba(200,155,60,0.12), transparent 65%), linear-gradient(160deg, #211C13, #17130E)',
            border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16], padding: '18px 20px', marginBottom: 20,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 26px rgba(0,0,0,0.32)',
        } },
        React.createElement(CreatorAvatar, { avatar: profile && profile.avatar, size: 52 }),
        React.createElement("div", { style: { flex: '1 1 160px', minWidth: 0 } },
            React.createElement("div", { style: {
                    fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2',
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                } }, name),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 2, letterSpacing: '0.03em', textTransform: 'uppercase' } }, "Creator Dashboard")),
        React.createElement("div", { style: { display: 'flex', alignItems: 'stretch', gap: SPACE_SCALE[4], flex: '2 1 260px', minWidth: 0 } },
            React.createElement(IdentityPlaque, { icon: rk.icon, label: "Rank", value: rk.name, valueColor: rk.color }),
            React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            React.createElement(IdentityPlaque, {
                icon: "\u231B", label: "Reputation", value: (reputation === null || reputation === undefined) ? "\u2014" : reputation,
                valueColor: '#7A7A82', caption: (reputation === null || reputation === undefined) ? 'not yet chronicled' : null,
            })));
}


// One overview stat card (Total Sales, Total Revenue, Total Readers, Average Rating, Published
// Works). Honest by default: a card only shows a real number when the caller has one (today, only
// Published Works does — it's a straight count of this writer's own published books and packs);
// everything else reads "\u2014" with a plain caption rather than a fabricated figure.
export function CreatorOverviewCard({ icon, label, value, caption, valueColor }) {
    return React.createElement("div", { className: "cd-overview-card", style: {
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: 14,
        } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 8 } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, icon),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], letterSpacing: '0.05em', textTransform: 'uppercase', color: '#7A7A82' } }, label)),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontWeight: 600, color: valueColor || '#E8C468' } }, value),
        caption && React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', fontStyle: 'italic', marginTop: 4 } }, caption));
}


export function CreatorOverviewRow({ publishedWorksCount }) {
    const notTracked = { value: "\u2014", caption: 'not tracked yet', valueColor: '#5C5C64' };
    return React.createElement("div", { style: {
            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(128px, 1fr))', gap: SPACE_SCALE[12], marginBottom: 22,
        } },
        React.createElement(CreatorOverviewCard, Object.assign({ icon: React.createElement(InkIcon, { name: "moneybag", size: 15 }), label: "Total Sales" }, notTracked)),
        React.createElement(CreatorOverviewCard, Object.assign({ icon: React.createElement(InkIcon, { name: "coin", size: 15 }), label: "Total Revenue" }, notTracked)),
        React.createElement(CreatorOverviewCard, Object.assign({ icon: React.createElement(InkIcon, { name: "users", size: 15 }), label: "Total Readers" }, notTracked)),
        React.createElement(CreatorOverviewCard, Object.assign({ icon: React.createElement(InkIcon, { name: "star", size: 15 }), label: "Average Rating" }, notTracked)),
        React.createElement(CreatorOverviewCard, { icon: React.createElement(InkIcon, { name: "library", size: 15 }), label: "Published Works", value: publishedWorksCount, valueColor: '#E8C468' }));
}


// The eight-tab switch itself — a horizontally-scrollable pill row so it degrades gracefully on
// narrow phone widths instead of wrapping into a ragged multi-line block.
export function CreatorTabBar({ activeTab, onSelect }) {
    return React.createElement("div", { className: "cd-tab-scroll", style: { marginBottom: 20 } },
        CREATOR_DASHBOARD_TABS.map((t) => React.createElement("button", {
            key: t.key, className: `cd-tab-btn${activeTab === t.key ? ' active' : ''}`, onClick: () => onSelect(t.key),
        }, t.icon, " ", t.label)));
}


// One readers/rating/sales/earnings figure on a Published Books card. Rating draws on the real
// ratingStats passed in below (see fetchAuthorRatingsSummary in src/lib/library.js); Readers,
// Sales, and Earnings still read "\u2014" since there's no shared backend tallying those yet (same
// honesty policy as AuthorStudioBookCard's own metric row, which this replaces with a nicer
// dashboard layout).
export function CreatorMetric({ icon, label, value }) {
    return React.createElement("div", { className: "cd-metric" },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[13] } }, icon),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: '#C9BE8D' } }, value),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[8.5], letterSpacing: '0.05em', textTransform: 'uppercase', color: '#5C5C64' } }, label));
}


// One project on the Published Books tab: cover, title, status, the four metrics above, and a row
// of quick actions (Edit / View / Manage Listing / Unpublish), plus the same Publish flow
// AuthorStudioBookCard already offers for a completed-but-unpublished project. Edit opens the
// project workspace itself (onOpen); View reads it exactly as a reader would (onRead) — no
// separate preview system, so what an author sees in View is always exactly what's live.
export function CreatorBookCard({ project, writerGuildName, onSetPublishStatus, onOpenPublishWizard, onOpen, onRead, salesByBook }) {
    const publishStatus = resolvePublishStatus(project);
    const isPublished = publishStatus !== 'none';
    // Real rating/review count once published — "\u2014" while loading or if there's nothing yet,
    // same as before Phase 2 existed.
    const [ratingStats, setRatingStats] = useState(null);
    useEffect(() => {
        if (!isPublished) return;
        let cancelled = false;
        fetchBookStats(project.id).then((stats) => { if (!cancelled) setRatingStats(stats); }).catch(() => {});
        return () => { cancelled = true; };
    }, [isPublished, project.id]);
    // Readers: real per-book view analytics (see src/lib/analytics.js's fetchBookViewSummary,
    // already used by CreatorAnalyticsPanel elsewhere on this same dashboard) — the count shown
    // is unique viewers, not raw view events, so a reader who reopens a book's detail card
    // several times only counts once. "\u2014" while loading; a genuinely-zero count still shows
    // as 0 once loaded, since "nobody's looked at this yet" is a real, meaningful answer for a
    // freshly-published book, not an absence of data the way a missing rating is.
    const [viewSummary, setViewSummary] = useState(null);
    useEffect(() => {
        if (!isPublished) return;
        let cancelled = false;
        fetchBookViewSummary(project.id).then((summary) => { if (!cancelled) setViewSummary(summary); }).catch(() => {});
        return () => { cancelled = true; };
    }, [isPublished, project.id]);
    // Sales/Earnings: real, uncapped per-book totals from fetchBookSalesSummary (src/lib/
    // payments.js), fetched once for every book on this dashboard by the parent (CreatorDashboard)
    // rather than once per card — see that function's own header for why it's a dedicated,
    // uncapped query instead of a reuse of fetchSalesLedger(). salesByBook is null while the
    // parent's fetch is still in flight (or failed) — "\u2014" in that case, same as Rating/Readers
    // while loading; once it resolves, a book simply missing from the map genuinely has zero
    // sales, which shows as a real 0/\u20a60 rather than a dash.
    const bookSales = salesByBook && salesByBook[project.id];
    return React.createElement("div", { className: "cd-book-card", style: {
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: 16,
        } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start', flexWrap: 'wrap' } },
            React.createElement(BookCover, { title: project.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author, cover: project.cover, size: 'sm' }),
            React.createElement("div", { style: { flex: '1 1 200px', minWidth: 0 } },
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15.5], fontWeight: 600, color: '#EFE7D2' } }, project.title || 'Untitled Novel'),
                    isSerialFormat(project) && React.createElement(SeriesTag, null)),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 2 } }, isSerialFormat(project) && project.chapterCount
                    ? `${project.chapterCount} ${project.chapterCount === 1 ? 'episode' : 'episodes'}`
                    : `${(project.wordCount || 0).toLocaleString()} words`),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 10, flexWrap: 'wrap' } },
                    React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                            padding: '3px 9px', borderRadius: RADIUS_SCALE[999],
                            background: project.completed ? 'rgba(143,203,143,0.12)' : 'rgba(122,122,130,0.14)',
                            color: project.completed ? '#8FCB8F' : '#A6A6AD',
                        } }, project.completed ? 'Completed' : 'In Progress'),
                    isPublished && React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                            padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                        } }, publishStatus === 'inkroot' ? 'Published \u00B7 Inkroot' : `Published \u00B7 ${writerGuildName || 'Guild'}`),
                    !isPublished && project.completed && React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                            padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(122,122,130,0.14)', color: '#A6A6AD',
                        } }, 'Unpublished'),
                    !isPublished && !project.completed && React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic' } }, "Mark as completed in Settings to publish"))),
            isPublished && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], flexWrap: 'wrap', marginLeft: 'auto' } },
                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "users", size: 13 }), label: "Readers", value: viewSummary ? String(viewSummary.uniqueViewers) : "\u2014" }),
                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "star", size: 13 }), label: "Rating", value: ratingStats && ratingStats.reviewCount > 0 ? `${ratingStats.avgRating.toFixed(1)} (${ratingStats.reviewCount})` : "\u2014" }),
                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "moneybag", size: 13 }), label: "Sales", value: salesByBook ? String(bookSales ? bookSales.sales : 0) : "\u2014" }),
                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "coin", size: 13 }), label: "Earnings", value: salesByBook ? formatNairaBalance(koboToNaira(bookSales ? bookSales.earningsKobo : 0)) : "\u2014" }))),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginTop: 14, paddingTop: 14, borderTop: '1px solid #2A2417' } },
            project.completed && React.createElement("button", { className: "cd-action-btn", onClick: () => onOpen(project.id) }, "Edit"),
            isPublished && React.createElement("button", { className: "cd-action-btn", onClick: () => onRead(project.id) }, "View"),
            project.completed && !isPublished && React.createElement("button", { className: "cd-action-btn", onClick: () => onOpenPublishWizard(project.id, 'book') }, "Publish"),
            isPublished && React.createElement("button", { className: "cd-action-btn", onClick: () => onOpenPublishWizard(project.id, 'book') }, "Manage Listing"),
            isPublished && publishStatus === 'guild' && React.createElement("button", { className: "cd-action-btn", onClick: () => onSetPublishStatus(project.id, 'inkroot') }, "Promote to Inkroot"),
            isPublished && React.createElement("button", { className: "cd-action-btn danger", onClick: () => onSetPublishStatus(project.id, 'none') }, "Unpublish"),
            !project.completed && React.createElement("button", { className: "cd-action-btn", onClick: () => onOpen(project.id) }, "Open")));
}


// A full-tab Coming Soon placeholder. Analytics, Earnings, Withdrawals, Ratings, and Readers all
// have real backends and real panels now (CreatorAnalyticsPanel, CreatorEarningsPanel,
// CreatorWithdrawalsPanel, CreatorRatingsPanel, CreatorReadersPanel) — this placeholder is only
// still used for the Templates and Add-ons tabs. Kept generic/reusable rather than deleted, since
// it's also what backs the reader-facing ComingSoonShelf entries in grand-library-screen.jsx.
export function CreatorComingSoonPanel({ icon, label, description }) {
    return React.createElement("div", { style: {
            textAlign: 'center', padding: '44px 20px', borderRadius: RADIUS_SCALE[16],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px dashed #3A3020',
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[30], marginBottom: 10, opacity: 0.7 } }, icon),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#C9BE8D', marginBottom: 6 } }, label, " \u2014 Coming Soon"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', maxWidth: 380, margin: '0 auto', lineHeight: 1.6 } }, description));
}


// Same visual shell as CreatorComingSoonPanel, minus the "\u2014 Coming Soon" suffix \u2014 for a tab
// that IS a real, implemented feature but simply has nothing to show yet (no published book to
// have ratings/analytics on). CreatorRatingsPanel/CreatorAnalyticsPanel below used to reuse
// CreatorComingSoonPanel directly for this, which meant "Ratings" and "Analytics" \u2014 both real,
// working panels \u2014 displayed "\u2014 Coming Soon" the moment a writer had nothing published yet,
// even though nothing about either feature was actually unbuilt. This is the honest version of
// that same empty state.
export function CreatorEmptyStatePanel({ icon, label, description }) {
    return React.createElement("div", { style: {
            textAlign: 'center', padding: '44px 20px', borderRadius: RADIUS_SCALE[16],
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px dashed #3A3020',
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[30], marginBottom: 10, opacity: 0.7 } }, icon),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#C9BE8D', marginBottom: 6 } }, label),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', maxWidth: 380, margin: '0 auto', lineHeight: 1.6 } }, description));
}


// The Creator Dashboard itself: header identity strip, five overview cards, and the eight-tab
// switch. Published Books and World Packs reuse the real project/pack data Author Studio already
// had (just restyled); the remaining six tabs are honest Coming Soon panels. This is what
// Author Studio's segmented switch now renders in 'studio' mode (see GrandLibraryScreen below) —
// Reader mode is untouched.
// Real aggregate ratings/reviews across every book this writer has published — backs the
// Ratings tab. Reviews are publicly readable (see schema_phase2.sql), so this works whether or
// not the person viewing it is currently signed in; there's simply nothing to show until at
// least one of their books has been published (which itself requires having been signed in at
// publish time) and read by someone else.
export function CreatorRatingsPanel({ projects }) {
    const publishedIds = React.useMemo(() => projects.filter((p) => resolvePublishStatus(p) !== 'none').map((p) => p.id), [projects]);
    const [state, setState] = useState({ loading: true, error: null, summary: [] });
    useEffect(() => {
        let cancelled = false;
        if (publishedIds.length === 0) {
            setState({ loading: false, error: null, summary: [] });
            return;
        }
        setState((s) => ({ ...s, loading: true }));
        fetchAuthorRatingsSummary(publishedIds)
            .then((summary) => { if (!cancelled) setState({ loading: false, error: null, summary }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, summary: [] }); });
        return () => { cancelled = true; };
    }, [publishedIds.join(',')]);
    const titleFor = (id) => (projects.find((p) => p.id === id) || {}).title || 'Untitled';
    if (publishedIds.length === 0) {
        return React.createElement(CreatorEmptyStatePanel, {
            icon: React.createElement(InkIcon, { name: "star", size: 28, style: { display: "inline-block" } }),
            label: "Ratings", description: "Publish a book first \u2014 once readers can find it, their ratings and reviews will show up here.",
        });
    }
    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading ratings\u2026");
    }
    if (state.error) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load ratings right now \u2014 check your connection and try again.");
    }
    if (state.summary.length === 0) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "No reviews yet \u2014 they'll appear here as readers rate your published work.");
    }
    return React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[16] } },
        state.summary.map((entry) => React.createElement("div", {
            key: entry.bookId, style: { padding: 16, borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417' },
        },
            React.createElement("div", { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 10 } },
                React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2' } }, titleFor(entry.bookId)),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#E8C468' } }, `\u2605 ${entry.avgRating.toFixed(1)} \u00b7 ${entry.reviews.length} review${entry.reviews.length === 1 ? '' : 's'}`)),
            React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                entry.reviews.slice(0, 5).map((r, i) => React.createElement("div", { key: r.id || i, style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', display: 'flex', alignItems: 'baseline', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                    React.createElement("span", { style: { color: '#E8C468' } }, '\u2605'.repeat(r.rating)), ' ',
                    React.createElement("span", { style: { color: '#7A7A82' } }, r.reviewer_name || 'A reader'),
                    // Anti-impersonation badge, piece 2 — see supabase schema.sql's `profiles.verified`
                    // column and lib/profile.js's fetchVerifiedIds. Title text spells out what the
                    // checkmark means since a bare icon alone is easy to misread as decorative.
                    r.reviewer_verified && React.createElement("span", { title: "Verified account", style: { color: '#6FAE8F' } }, '\u2713'),
                    r.body ? ` \u2014 ${r.body}` : '',
                    r.id && React.createElement(ReportButton, {
                        contentType: "review", contentId: r.id, label: "",
                        buttonStyle: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', fontSize: TYPE_SCALE[11], padding: '0 0 0 4px' },
                    })))))));
}


// The Creator Dashboard's Analytics tab — real reader activity per published book, backed by
// supabase/history/60_migration_book_view_analytics.sql. One book at a time (fetch_book_view_
// summary() is scoped to a single book id, author-checked server-side), so this is a book
// selector plus a summary panel rather than one big combined table — same shape choice
// CreatorRatingsPanel makes implicitly by rendering one card per book.
const ANALYTICS_SOURCE_LABELS = {
    featured: 'Featured', new_releases: 'New Releases', top_rated: 'Highest Rated',
    discover: 'Discover grid', cart: 'Cart', author_profile: "Author's Hall",
    guild_bookshelf: 'Guild Bookshelf', most_read: 'Most Read shelf', trending: 'Trending shelf', direct: 'Direct / other',
};

export function CreatorAnalyticsPanel({ projects }) {
    const publishedProjects = React.useMemo(() => projects.filter((p) => resolvePublishStatus(p) !== 'none'), [projects]);
    const [selectedId, setSelectedId] = useState(null);
    useEffect(() => {
        // Default to the first published book once the list is known, and re-pick if the
        // previously-selected one gets unpublished out from under this panel.
        if (publishedProjects.length === 0) { setSelectedId(null); return; }
        if (!publishedProjects.some((p) => p.id === selectedId)) setSelectedId(publishedProjects[0].id);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [publishedProjects.map((p) => p.id).join(',')]);

    const [state, setState] = useState({ loading: true, error: null, summary: null });
    useEffect(() => {
        if (!selectedId) { setState({ loading: false, error: null, summary: null }); return; }
        let cancelled = false;
        setState((s) => ({ ...s, loading: true, error: null }));
        fetchBookViewSummary(selectedId)
            .then((summary) => { if (!cancelled) setState({ loading: false, error: null, summary }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, summary: null }); });
        return () => { cancelled = true; };
    }, [selectedId]);

    if (publishedProjects.length === 0) {
        return React.createElement(CreatorEmptyStatePanel, {
            icon: React.createElement(InkIcon, { name: "chart", size: 28, style: { display: "inline-block" } }),
            label: "Analytics", description: "Publish a book first \u2014 once readers can find it, its view activity will show up here.",
        });
    }

    const titleFor = (id) => (publishedProjects.find((p) => p.id === id) || {}).title || 'Untitled';
    const summary = state.summary;
    const sourceEntries = summary ? Object.entries(summary.viewsBySource).sort((a, b) => b[1] - a[1]) : [];
    const maxSourceCount = sourceEntries.length ? sourceEntries[0][1] : 0;
    const maxTrendCount = summary && summary.dailyTrend.length ? Math.max(...summary.dailyTrend.map((d) => d.count)) : 0;

    return React.createElement("div", null,
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginBottom: 16, lineHeight: 1.6, maxWidth: 520 } },
            "Detail-card opens and full reads across the Grand Library, Author's Hall, and Guild Bookshelf. Anonymous (signed-out) views count toward totals but aren't included in the unique-viewer figure \u2014 there's no durable identity to de-duplicate them by."),
        publishedProjects.length > 1 && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', marginBottom: 18 } },
            publishedProjects.map((p) => React.createElement("button", {
                key: p.id, onClick: () => setSelectedId(p.id), style: {
                    background: selectedId === p.id ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'none',
                    border: '1px solid #3A3020', color: selectedId === p.id ? '#E8C468' : '#A6A6AD',
                    borderRadius: RADIUS_SCALE[999], padding: '6px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                },
            }, p.title || 'Untitled'))),
        state.loading
            ? React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading analytics\u2026")
            : state.error
                ? React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load analytics right now \u2014 check your connection and try again.")
                : !summary
                    ? React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "No view activity yet for this book.")
                    : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[16] } },
                        React.createElement("div", { style: { padding: 16, borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417' } },
                            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2', marginBottom: 12 } }, titleFor(selectedId)),
                            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[20], flexWrap: 'wrap' } },
                                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "unlock", size: 13 }), label: "Detail views", value: summary.totalDetailViews }),
                                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "book", size: 13 }), label: "Full reads", value: summary.totalReadStarts }),
                                React.createElement(CreatorMetric, { icon: React.createElement(InkIcon, { name: "users", size: 13 }), label: "Unique signed-in readers", value: summary.uniqueViewers }))),
                        sourceEntries.length > 0 && React.createElement("div", { style: { padding: 16, borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417' } },
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 } }, "Traffic sources"),
                            React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                                sourceEntries.map(([source, count]) => React.createElement("div", { key: source, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10] } },
                                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', width: 130, flexShrink: 0 } }, ANALYTICS_SOURCE_LABELS[source] || source),
                                    React.createElement("div", { style: { flex: 1, height: 8, borderRadius: RADIUS_SCALE[999], background: '#2A2417', overflow: 'hidden' } },
                                        React.createElement("div", { style: { width: `${maxSourceCount ? (count / maxSourceCount) * 100 : 0}%`, height: '100%', background: '#C89B3C' } })),
                                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#E8C468', width: 30, textAlign: 'right', flexShrink: 0 } }, count))))),
                        summary.dailyTrend.length > 0 && React.createElement("div", { style: { padding: 16, borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417' } },
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 12 } }, "Last 30 days"),
                            React.createElement("div", { style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 60 } },
                                summary.dailyTrend.map((d) => React.createElement("div", {
                                    key: d.date, title: `${d.date}: ${d.count}`, style: {
                                        flex: 1, minWidth: 2, height: `${maxTrendCount ? Math.max((d.count / maxTrendCount) * 100, 4) : 4}%`,
                                        background: '#C89B3C', borderRadius: '2px 2px 0 0',
                                    },
                                }))))));
}
