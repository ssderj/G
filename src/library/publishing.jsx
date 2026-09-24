import React, { useState, useEffect } from 'react';
import { Field, TagInput } from '../shared-ui/form-fields.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { ImagePicker } from '../shared-ui/ui-primitives.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { BookCover, PACK_CATEGORY_KEYS, WORLD_BIBLE_CATEGORIES, worldBibleEntries } from '../worldbuilding/book-cover.jsx';
import { useSync } from '../shell/sync-context.jsx';
import { checkoutBook, formatNaira } from '../lib/payments.js';


// ---------- The Guild Library ----------
// Books "published by guild members" — for now, the writer's own completed projects, since
// this view has no live per-guild roster to draw on. Cover, title, author, and word count all
// come straight from the project's own data (via the existing BookCover component); reading time
// is a real estimate from word count. Rating and Reviews have no backing system here, so they
// read honestly as not yet tracked — and since nothing is sold, Price is always "Free."
// "Favorite" is a real, working per-reader bookmark (not a placeholder), which is what makes the
// Guild Favorites sort meaningful.
export const LIBRARY_FAVORITES_KEY = 'inkroot:library:favorites';


export function readLibraryFavorites() {
    try {
        return new Set(JSON.parse(localStorage.getItem(LIBRARY_FAVORITES_KEY) || '[]'));
    }
    catch (e) {
        return new Set();
    }
}


export function writeLibraryFavorites(set) {
    try {
        localStorage.setItem(LIBRARY_FAVORITES_KEY, JSON.stringify([...set]));
    }
    catch (e) { }
}


export function estimateReadingTime(words) {
    const minutes = Math.max(1, Math.round(words / 220));
    if (minutes < 60)
        return `${minutes} min read`;
    const hours = Math.floor(minutes / 60);
    const rem = minutes % 60;
    return rem ? `${hours}h ${rem}m read` : `${hours}h read`;
}


export const LIBRARY_SORTS = [
    { key: 'newest', label: 'Newest' },
    { key: 'rated', label: 'Highest Rated' },
    { key: 'mostRead', label: 'Most Read' },
    { key: 'favorites', label: 'My Library' },
];


export function LibraryBookCard({ book, isFavorite, onToggleFavorite, onRead, onOpenAuthor }) {
    return React.createElement("div", { style: {
            display: 'flex', gap: SPACE_SCALE[14], background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
            borderRadius: RADIUS_SCALE[14], padding: 16, textAlign: 'left',
        } },
        React.createElement(BookCover, { title: book.title, subtitle: book.subtitle, seriesName: book.seriesName, author: book.author, cover: book.cover, size: 'sm' }),
        React.createElement("div", { style: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8] } },
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], flexWrap: 'wrap' } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, book.title || 'Untitled Novel'),
                        isSerialFormat(book) && React.createElement(SeriesTag, null)),
                    React.createElement(LibraryAuthorLink, { author: book.author, onOpenAuthor })),
                React.createElement("button", { onClick: () => onToggleFavorite(book.id), title: "Guild favorite", style: {
                        background: 'none', border: 'none', cursor: 'pointer', fontSize: TYPE_SCALE[16], color: isFavorite ? '#E8C468' : '#4A4A52', flexShrink: 0,
                    } }, isFavorite ? "\u2605" : "\u2606")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' } },
                React.createElement("span", null, book.genre),
                isSerialFormat(book) && book.chapterCount
                    ? React.createElement("span", null, `${book.chapterCount} episode${book.chapterCount === 1 ? '' : 's'}`)
                    : React.createElement("span", null, `${book.wordCount.toLocaleString()} words`),
                React.createElement("span", null, estimateReadingTime(book.wordCount))),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 'auto', paddingTop: 12 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#8FCB8F', fontWeight: 600 } }, "Free"),
                React.createElement("button", { onClick: () => onRead(book.id), style: {
                        background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                        borderRadius: RADIUS_SCALE[8], padding: '7px 16px', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer', marginLeft: 'auto',
                    } }, "Read"))));
}


// ---------- The Grand Library ----------
// Publishing, book discovery, and the author marketplace, unified into one screen instead of
// three separate pages. Reader mode is where every published book can be found and read in full.
// Author Studio is where a writer manages their own books: flip a project between Draft and
// Published, and — for the same book, in the same place — set the marketplace listing (genre,
// blurb, asking price) that Reader mode displays. Pricing here is real: Inkroot's Paystack
// integration (see lib/payments.js, checkoutBook, and the paystack-* Edge Functions) actually
// charges a reader and pays the author out in Naira for anything above ₦0 — a listed price is a
// real, chargeable amount, not a placeholder waiting on a future payment processor.
export const LIBRARY_GENRES = ['Fantasy', 'Romance', 'Sci-Fi', 'Mystery', 'Historical', 'Horror', 'Poetry', 'General Fiction'];


// ---------- Book Premiere format ----------
// A published book's storyFormat is 'book' (a traditional full-length manuscript, told in
// Chapters) or 'series' (a shorter, serialized story released and read in Episodes). Both are
// the same underlying manuscript — chapters array and all — so this is purely a label plus a
// reader-facing episode list (see PublishedBookReader); nothing about how the project stores its
// content changes. Duplicated here (rather than imported from project-schema-and-backups.jsx)
// to avoid a circular import — that module already imports ProjectWorkspace, which imports this
// one, so these small pure helpers just live in both places instead of looping back.
export function isSerialFormat(book) {
    return !!book && book.storyFormat === 'series';
}


export function bookFormatTerm(book, plural) {
    return isSerialFormat(book) ? (plural ? 'Episodes' : 'Episode') : (plural ? 'Chapters' : 'Chapter');
}


// The small "Series" pill shown wherever a serialized book's card or page needs to signal, at a
// glance, that it's read in Episodes rather than Chapters — the Guild Library card, Grand
// Library discovery cards, the Featured Chronicle, Author Studio, and the book detail page all
// use this same one so it always looks identical.
export function SeriesTag({ style }) {
    return React.createElement("span", { style: Object.assign({
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[9], fontWeight: 700,
            letterSpacing: '0.03em', textTransform: 'uppercase', color: '#8FCB8F', background: 'rgba(143,203,143,0.14)',
            border: '1px solid rgba(143,203,143,0.33)', borderRadius: RADIUS_SCALE[999], padding: '2px 8px', whiteSpace: 'nowrap',
        }, style || {}) }, "\u25B6 Series");
}


export function formatLibraryPrice(price) {
    return (!price || price <= 0) ? 'Free' : formatNaira(price);
}


// ---------- Book card badges ----------
// A tiny corner badge for a book card: New, Best Seller, Editor's Choice, or Award Winner.
// Only "New" is backed by real data today (a book published or updated in the last 14 days).
// The other three read from optional fields on the book record itself (isBestSeller,
// isEditorsChoice, isAwardWinner) so a card lights up the moment something upstream sets one of
// them — same honesty policy as the rest of the Grand Library (see formatLibraryPrice above and
// the "Editor's Choice — coming soon" shelf): nothing is invented here, the badge just stays
// silent until there's a real signal to show.
export const LIBRARY_BADGE_STYLES = {
    awardWinner: { label: 'Award Winner', icon: React.createElement(InkIcon, { name: 'trophy', size: 10 }), color: '#E8C468', background: 'rgba(232,196,104,0.14)' },
    editorsChoice: { label: "Editor's Choice", icon: React.createElement(InkIcon, { name: 'medal', size: 10 }), color: '#C89B3C', background: 'rgba(200,155,60,0.14)' },
    bestSeller: { label: 'Best Seller', icon: React.createElement(InkIcon, { name: 'flame', size: 10 }), color: '#E8935B', background: 'rgba(232,147,91,0.14)' },
    new: { label: 'New', icon: "\u2726", color: '#8FCB8F', background: 'rgba(143,203,143,0.14)' },
};


export function getLibraryBadge(book) {
    if (book.isAwardWinner)
        return LIBRARY_BADGE_STYLES.awardWinner;
    if (book.isEditorsChoice)
        return LIBRARY_BADGE_STYLES.editorsChoice;
    if (book.isBestSeller)
        return LIBRARY_BADGE_STYLES.bestSeller;
    const ageDays = book.updatedAt ? (Date.now() - book.updatedAt) / 86400000 : Infinity;
    if (ageDays <= 14)
        return LIBRARY_BADGE_STYLES.new;
    return null;
}


export function LibraryCardBadge({ badge }) {
    if (!badge)
        return null;
    return React.createElement("span", { title: badge.label, style: {
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[3], fontSize: TYPE_SCALE[9], fontWeight: 700,
            letterSpacing: '0.03em', textTransform: 'uppercase', color: badge.color,
            background: badge.background, border: `1px solid ${badge.color}33`,
            borderRadius: RADIUS_SCALE[999], padding: '2px 7px', whiteSpace: 'nowrap', flexShrink: 0,
        } }, badge.icon, " ", badge.label);
}


// A book's personal star rating (see the "Personal ratings (local-only)" section) rendered small,
// for use right in the card grid rather than only inside BookDetailModal. Five empty stars with
// "Not yet rated" is the honest default — there's no public/aggregate rating data to fall back on.
export function LibraryCardRating({ myRating }) {
    const stars = (myRating && myRating.stars) || 0;
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[5] } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], letterSpacing: 1, color: stars > 0 ? '#E8C468' : '#3A3A42' } }, "\u2605".repeat(stars) + "\u2606".repeat(5 - stars)),
        React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64' } }, stars > 0 ? `${stars}/5` : 'Not yet rated'));
}


// An author name rendered as a clickable control. Every clickable author surface in the app —
// book cards, the Grand Library, Guild bookshelves and feedback threads, book detail pages — goes
// through this one component, so tapping a name, avatar, or rank anywhere always lands on the same
// Author's Hall (see AuthorsHallScreen) for that author.
// `verified` and `authorId` are both optional, and both anti-impersonation piece 2/5 (see
// supabase schema.sql's `profiles.verified` and lib/profile.js's fetchPublicProfile). Only pass
// either from a caller that resolved `author` against a real account id (e.g.
// guild-book-feedback-modal.jsx's remote book listing); the local-only Grand Library has no real
// account behind its author strings at all (see grand-library-screen.jsx), so it always omits
// both rather than risk showing a badge, or opening a Hall, that isn't backed by anything real.
export function LibraryAuthorLink({ author, onOpenAuthor, verified, authorId }) {
    return React.createElement("span", { onClick: onOpenAuthor ? (e) => { e.stopPropagation(); onOpenAuthor(author, authorId); } : undefined,
            role: onOpenAuthor ? 'button' : undefined, tabIndex: onOpenAuthor ? 0 : undefined,
            className: onOpenAuthor ? "gl-author-link" : undefined,
            style: {
                fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 2,
                cursor: onOpenAuthor ? 'pointer' : 'default',
            } }, author, verified && React.createElement("span", { title: "Verified account", style: { color: '#6FAE8F', marginLeft: 4 } }, '\u2713'));
}


// ---------- Publish destinations ----------
// A completed project's publish state: 'none' (not published anywhere), 'inkroot' (in the Grand
// Library, open to every reader), or 'guild' (private to the writer's current Guild only — for
// feedback, competitions, beta reading, and guild events). This lives on the project itself
// (see setPublishStatus in InkRoot), not a duplicate copy, so promoting a Guild publication to
// Inkroot is just flipping this one field — nothing is re-uploaded.
// Backward-compat: older saves predate this field entirely and only ever had `completed` doing
// double duty as "published to the Grand Library" — so a missing publishStatus on a completed
// project reads as 'inkroot' rather than 'none', preserving what was already visible there.
export function resolvePublishStatus(project) {
    return project.publishStatus || (project.completed ? 'inkroot' : 'none');
}


// ---------- Publishing Wizard: the one shared publishing workflow ----------
// Opened from a project's own Settings tab (see ProjectWorkspace's Publish button), from Author
// Studio's Publish button (see AuthorStudioBookCard), and from a Worldbuilding Pack's own Publish
// button, whether that's inside the project (WorldbuildingPackCard) or from Author Studio
// (AuthorStudioPackCard) — always this same four-step flow: choose what to publish, choose a
// destination, fill in the listing, preview it. Confirming Step 4 always sets the very same
// fields (publishStatus/publishedAt, title, description, genre, tags, price, and — for a pack —
// its cover) on the same underlying book or pack record, whichever door it came through. That
// record is what's already mirrored onto the index (see useMetaReport and packSummaryForIndex),
// which is what makes it show up in the Grand Library and stay manageable from Author Studio
// either way — there was never a second publishing system to keep in sync.
//
// A completed project can still be an empty or near-empty manuscript — "completed" is a writer's
// own manual toggle in Settings, not a length check. MIN_PUBLISH_WORDS is this UI's half of the
// real floor: the one that actually blocks a listing from ever being created lives server-side,
// in published_books' and guild_published_books' own insert/update policies (see
// min_publish_word_count() in supabase/schema.sql) — this constant only has to match
// it closely enough to give a writer the same answer here, before they reach Step 4, instead of
// only finding out from a server error after filling in the whole listing.
export const MIN_PUBLISH_WORDS = 5000;
export function PublishingWizard({ project, initialTarget, writerGuildName, onClose, onPublishBook, onPublishPack }) {
    // publishBookRemote/publishBookToGuildRemote (see ink-root.jsx's setPublishStatus and
    // lib/library.js) silently no-op when signed out, rather than throwing — by original design,
    // so local-only publishing keeps working exactly as it did before accounts existed. The
    // trade-off: nothing in that path ever told the writer their "Publish" click only updated
    // this device and never reached anyone else. That's the actual bug worth fixing here — not
    // the fallback itself, which is a reasonable default, but the silence around it. Warning at
    // this step (not blocking) keeps that same local-first spirit while closing the surprise.
    const sync = useSync();
    const isSignedIn = !!(sync && sync.session);
    const packs = project.worldbuildingPacks || [];
    const [step, setStep] = useState(1);
    // Publishing reliability (fix-tracker item 27): onPublishBook/onPublishPack now resolve only
    // once the remote listing+content pair has actually succeeded (see lib/publish-flow.js's
    // publishBookRemoteFlow/publishPackRemoteFlow) and reject with a real, readable message on
    // failure — so this step is awaited, with the same idle/publishing/error shape
    // TipAuthorModal already uses elsewhere in this file, rather than firing the call and
    // closing the wizard immediately regardless of outcome. On error the wizard stays open on
    // this same confirm step so the writer can just retry, no re-filling steps 1\u20133.
    const [publishState, setPublishState] = useState('idle'); // idle | publishing | error
    const [publishError, setPublishError] = useState(null);
    const [targetType, setTargetType] = useState((initialTarget && initialTarget.type) || 'book');
    const [packId, setPackId] = useState((initialTarget && initialTarget.packId) || (packs[0] && packs[0].id) || null);
    const [destination, setDestination] = useState(null);
    const [details, setDetails] = useState(null); // seeded by the effect below once a target is known
    // Book Premiere format ('book' | 'series') — only meaningful for targetType === 'book'.
    // Seeded from the project's own current format so reopening the wizard (e.g. "Manage
    // listing") shows what's already set rather than resetting to Full Book every time.
    const [storyFormat, setStoryFormat] = useState(project.storyFormat === 'series' ? 'series' : 'book');
    const bookReady = !!project.completed;
    // Same reduce ink-root.jsx's setPublishStatus/publishBookWithDetails use to compute the real
    // word count pushed to published_books — kept in sync with that so this screen's answer
    // never disagrees with what the server is about to check.
    // BUGFIX: when this Wizard is opened from Author Studio / the Workshop (grand-library-
    // screen.jsx's openPublishWizard), `project` is the lightweight project *index* entry
    // (see useMetaReport in project-schema-and-backups.jsx) — it deliberately never carries the
    // real `chapters` array, only pre-computed summary fields (wordCount, chapterCount), so the
    // Grand Library/Author Studio never has to load a project's full manuscript just to list it.
    // Opened from a project's own Settings/Publishing Hub (project-workspace.jsx), `project` IS
    // the full loaded project and `chapters` is real. `Array.isArray` tells the two apart:
    // recompute from real chapters when they're present (unchanged from before), otherwise trust
    // the index's own already-accurate mirrors instead of treating a missing array as "0 words in
    // 0 chapters" — which used to both wrongly block a genuinely-ready book behind the word floor
    // and crash outright further down (project.chapters.length on an undefined array), blanking
    // the whole app with no error boundary anywhere to catch it.
    const chaptersLoaded = Array.isArray(project.chapters);
    const bookWordCount = chaptersLoaded ? project.chapters.reduce((s, c) => s + wordCount(c.text), 0) : (project.wordCount || 0);
    const bookChapterCount = chaptersLoaded ? project.chapters.length : (project.chapterCount || 0);
    const bookMeetsWordFloor = bookWordCount >= MIN_PUBLISH_WORDS;
    const canContinueStep1AsBook = bookReady && bookMeetsWordFloor;
    const targetPack = targetType === 'pack' ? packs.find((p) => p.id === packId) : null;
    // Re-seed the details form from whichever target is currently chosen — including on the very
    // first render — so Step 3 always starts from that target's own current listing rather than
    // carrying over whatever the last-chosen target happened to have.
    useEffect(() => {
        const source = targetType === 'book' ? project : targetPack;
        if (!source) {
            setDetails(null);
            return;
        }
        setDetails({
            title: source.title || '',
            description: (targetType === 'book' ? source.blurb : source.description) || '',
            genre: source.genre || 'Unspecified',
            tags: source.tags || [],
            coverImageUrl: targetType === 'pack' ? (source.coverImageUrl || '') : '',
            priceMode: (typeof source.price === 'number' && source.price > 0) ? 'paid' : 'free',
            price: typeof source.price === 'number' ? source.price : 0,
            downloadable: targetType === 'book' ? !!source.downloadable : false,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [targetType, packId]);
    const setDetail = (patch) => setDetails((d) => d && ({ ...d, ...patch }));
    const guildAvailableForTarget = targetType === 'book' && !!writerGuildName;
    const canContinueStep1 = targetType === 'book' ? canContinueStep1AsBook : !!targetPack;
    const canContinueStep2 = destination === 'inkroot' || (destination === 'guild' && guildAvailableForTarget);
    const priceValid = !details || details.priceMode === 'free' || (parseFloat(details.price) > 0);
    const canContinueStep3 = !!details && details.title.trim() !== '' && priceValid;
    const handleConfirm = async () => {
        const finalDetails = {
            title: details.title.trim() || (targetType === 'book' ? 'Untitled Novel' : 'Untitled Pack'),
            description: details.description.slice(0, targetType === 'book' ? 400 : 500),
            genre: details.genre,
            tags: details.tags,
            coverImageUrl: details.coverImageUrl,
            priceMode: details.priceMode,
            price: details.priceMode === 'paid' ? (parseFloat(details.price) || 0) : 0,
        };
        if (targetType === 'book') {
            finalDetails.storyFormat = storyFormat;
            finalDetails.downloadable = !!details.downloadable;
        }
        setPublishState('publishing');
        setPublishError(null);
        try {
            if (targetType === 'book')
                await onPublishBook(destination, finalDetails);
            else
                await onPublishPack(packId, destination, finalDetails);
            onClose();
        }
        catch (e) {
            setPublishState('error');
            setPublishError(e.message || "Something went wrong reaching Inkroot — nothing was published.");
        }
    };
    const blocked = (step === 1 && !canContinueStep1) || (step === 2 && !canContinueStep2) || (step === 3 && !canContinueStep3);
    const renderStep1 = () => React.createElement("div", null,
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 16, lineHeight: 1.5 } }, "Choose what you're publishing from ", project.title || 'this project', "."),
        React.createElement("button", {
            onClick: () => canContinueStep1AsBook && setTargetType('book'), disabled: !canContinueStep1AsBook, style: {
                display: 'block', width: '100%', textAlign: 'left', marginBottom: 10, borderRadius: RADIUS_SCALE[10], padding: '14px 16px',
                cursor: canContinueStep1AsBook ? 'pointer' : 'not-allowed', opacity: canContinueStep1AsBook ? 1 : 0.55,
                background: targetType === 'book' ? 'linear-gradient(160deg, #2C2415, #1D170E)' : 'linear-gradient(160deg, #211C13, #17130E)',
                border: targetType === 'book' ? '1px solid #C89B3C' : '1px solid #3A3020',
            },
        },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#E8C468', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "book", size: 15 }), "Book Premiere"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 4, lineHeight: 1.5 } }, !bookReady
                ? 'Mark this project as completed, in Settings, before publishing the book.'
                : !bookMeetsWordFloor
                    ? `This manuscript is ${bookWordCount.toLocaleString()} words \u2014 publishing needs at least ${MIN_PUBLISH_WORDS.toLocaleString()}.`
                    : `Debut ${project.title || 'this manuscript'} to readers \u2014 as a full book or a serialized story.`)),
        targetType === 'book' && bookReady && React.createElement("div", { style: { marginBottom: 10, borderRadius: RADIUS_SCALE[10], padding: '12px 14px 14px', background: 'rgba(122,122,130,0.06)', border: '1px solid #2E2A1E' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } }, "Format"),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } }, [
                ['book', 'Full Book', 'Told in Chapters'],
                ['series', 'Serialized Story', 'Told in Episodes'],
            ].map(([key, label, sub]) => React.createElement("button", { key, onClick: () => setStoryFormat(key), style: {
                    flex: 1, textAlign: 'left', borderRadius: RADIUS_SCALE[8], padding: '9px 11px', cursor: 'pointer',
                    background: storyFormat === key ? 'rgba(232,196,104,0.14)' : 'transparent',
                    border: storyFormat === key ? '1px solid #C89B3C' : '1px solid #2A2A30',
                } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12], fontWeight: 600, color: storyFormat === key ? '#E8C468' : '#D9D2BE' } }, label),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#7A7A82', marginTop: 1 } }, sub)))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } }, `This project currently has ${bookChapterCount} ${(storyFormat === 'series' ? (bookChapterCount === 1 ? 'episode' : 'episodes') : (bookChapterCount === 1 ? 'chapter' : 'chapters'))}. Readers will see them exactly as your manuscript has them, in order.`)),
        packs.length > 0
            ? React.createElement("button", { onClick: () => setTargetType('pack'), style: {
                    display: 'block', width: '100%', textAlign: 'left', borderRadius: RADIUS_SCALE[10], padding: '14px 16px', cursor: 'pointer',
                    background: targetType === 'pack' ? 'linear-gradient(160deg, #2C2415, #1D170E)' : 'linear-gradient(160deg, #211C13, #17130E)',
                    border: targetType === 'pack' ? '1px solid #C89B3C' : '1px solid #3A3020',
                } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#E8C468', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "package", size: 15 }), "Worldbuilding Pack"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 4, lineHeight: 1.5 } }, "Publish a selection of characters, locations, and lore on its own."))
            : React.createElement("div", { style: { borderRadius: RADIUS_SCALE[10], padding: '14px 16px', background: 'rgba(122,122,130,0.06)', border: '1px dashed #3A3020' } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#8A8272', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "package", size: 15 }), "Worldbuilding Pack"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4, lineHeight: 1.5, fontStyle: 'italic' } }, "Create one first from this project's Publishing \u2192 Worldbuilding Packs tab.")),
        targetType === 'pack' && packs.length > 1 && React.createElement("div", { style: { marginTop: 14 } },
            React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Which pack?"),
            React.createElement("select", { value: packId || '', onChange: (e) => setPackId(e.target.value), style: {
                    width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[13], marginTop: 4,
                } }, packs.map((p) => React.createElement("option", { key: p.id, value: p.id }, p.title || 'Untitled Pack')))));
    const renderStep2 = () => React.createElement("div", null,
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 16, lineHeight: 1.5 } }, "Choose where this goes \u2014 a Guild publication can be promoted to Inkroot later with one click."),
        React.createElement("button", { onClick: () => setDestination('inkroot'), style: {
                display: 'block', width: '100%', textAlign: 'left', marginBottom: 10, borderRadius: RADIUS_SCALE[10], padding: '14px 16px', cursor: 'pointer',
                background: destination === 'inkroot' ? 'linear-gradient(160deg, #2C2415, #1D170E)' : 'linear-gradient(160deg, #241F14, #17140F)',
                border: destination === 'inkroot' ? '1px solid #C89B3C' : '1px solid #4A3D22',
            } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#E8C468', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "book", size: 15 }), "Publish to Inkroot"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 4, lineHeight: 1.5 } }, "Publishes it to the Grand Library, open to every reader.")),
        guildAvailableForTarget
            ? React.createElement("button", { onClick: () => setDestination('guild'), style: {
                    display: 'block', width: '100%', textAlign: 'left', borderRadius: RADIUS_SCALE[10], padding: '14px 16px', cursor: 'pointer',
                    background: destination === 'guild' ? 'linear-gradient(160deg, #2C2415, #1D170E)' : 'linear-gradient(160deg, #241F14, #17140F)',
                    border: destination === 'guild' ? '1px solid #C89B3C' : '1px solid #4A3D22',
                } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#E8C468', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "castle", size: 15 }), `Publish to ${writerGuildName}`),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 4, lineHeight: 1.5 } }, "Publish privately inside your Guild for feedback, competitions, beta reading, and guild events."))
            : React.createElement("div", { style: { background: 'rgba(122,122,130,0.06)', border: '1px dashed #3A3020', borderRadius: RADIUS_SCALE[10], padding: '14px 16px' } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#8A8272', display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: "castle", size: 15 }), "Publish to Guild"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4, lineHeight: 1.5, fontStyle: 'italic' } }, targetType === 'pack'
                    ? "Worldbuilding Packs currently publish to Inkroot only."
                    : "Join or found a Guild first to publish privately for feedback, competitions, beta reading, and guild events.")));
    const renderStep3 = () => {
        if (!details)
            return null;
        return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[14] } },
            React.createElement(Field, { label: targetType === 'book' ? "Book title" : "Pack title", value: details.title, onChange: (v) => setDetail({ title: v }), large: true, maxLength: 200 }),
            React.createElement(Field, { label: "Description", value: details.description, onChange: (v) => setDetail({ description: v }), textarea: true, placeholder: "What's this about, and why would a reader want it\u2026" }),
            React.createElement("div", null,
                React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Category"),
                React.createElement("select", { value: details.genre, onChange: (e) => setDetail({ genre: e.target.value }), style: {
                        width: '100%', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[13], marginTop: 4,
                    } }, ['Unspecified', ...LIBRARY_GENRES].map((g) => React.createElement("option", { key: g, value: g }, g)))),
            React.createElement(TagInput, { tags: details.tags, onChange: (tags) => setDetail({ tags }), placeholder: "e.g. political intrigue, dragons\u2026" }),
            targetType === 'pack'
                ? React.createElement("div", null,
                    React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Cover image (optional)"),
                    React.createElement("div", { style: { marginTop: 6 } }, React.createElement(ImagePicker, { value: details.coverImageUrl, onChange: (v) => setDetail({ coverImageUrl: v }), placeholder: "Upload a cover", maxDim: 900, quality: 0.85 })))
                : React.createElement("div", null,
                    React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Cover"),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[12], marginTop: 8 } },
                        React.createElement(BookCover, { title: project.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author, cover: project.cover, size: 'sm' }),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', lineHeight: 1.5 } }, "This is the cover from this project's Settings. Change the style, accent, or upload your own from there."))),
            React.createElement("div", null,
                React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Price"),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 6 } }, ['free', 'paid'].map((mode) => React.createElement("button", { key: mode, onClick: () => setDetail({ priceMode: mode }), style: {
                        flex: 1, borderRadius: RADIUS_SCALE[8], padding: '8px 0', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                        background: details.priceMode === mode ? '#C89B3C22' : 'transparent',
                        border: details.priceMode === mode ? '1px solid #C89B3C' : '1px solid #2A2A30',
                        color: details.priceMode === mode ? '#C89B3C' : '#A6A6AD',
                    } }, mode === 'free' ? 'Free' : 'Paid'))),
                details.priceMode === 'paid' && React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 10 } },
                    React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
                    React.createElement("input", { type: "number", min: 0, step: "1", value: details.price, onChange: (e) => setDetail({ price: e.target.value }), style: {
                            width: 90, background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[13],
                        } })),
                details.priceMode === 'paid' && !priceValid && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#D98A8A', marginTop: 6 } }, "Enter a price above \u20a60, or switch to Free."),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } }, targetType === 'book' && destination === 'inkroot'
                    ? "Readers pay this in Naira through Inkroot's checkout once the book is published."
                    : "Shown to readers in Naira \u2014 Guild-only listings and Worldbuilding Packs aren't purchasable yet, only books published to the Grand Library are.")),
            targetType === 'book' && React.createElement("div", null,
                React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Downloads"),
                React.createElement("button", {
                    onClick: () => !project.publishStatus && setDetail({ downloadable: !details.downloadable }),
                    disabled: !!project.publishStatus,
                    style: {
                        display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginTop: 6, borderRadius: RADIUS_SCALE[8],
                        padding: '8px 12px', width: '100%', textAlign: 'left', cursor: project.publishStatus ? 'default' : 'pointer',
                        background: details.downloadable ? '#C89B3C22' : 'transparent',
                        border: details.downloadable ? '1px solid #C89B3C' : '1px solid #2A2A30',
                        opacity: project.publishStatus ? 0.6 : 1,
                    },
                },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: details.downloadable ? '#C89B3C' : '#A6A6AD' } },
                        details.downloadable ? "Readers can download a PDF/EPUB copy" : "Reading in Inkroot only \u2014 no download")),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } }, project.publishStatus
                    ? "This is locked once a book is live. To change it, unpublish this book and publish it again \u2014 unless readers have already bought it, in which case it stays as it was first published."
                    : "Anyone who can already read this book (free readers, or a buyer) will also be able to save a PDF/EPUB copy. This can't be changed after publishing without unpublishing and republishing, and once readers have bought the book it stays as first published.")));
    };
    const renderStep4 = () => {
        if (!details)
            return null;
        const destLabel = destination === 'guild' ? `Guild \u00B7 ${writerGuildName}` : 'Inkroot \u00B7 Grand Library';
        return React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 16, lineHeight: 1.5 } }, "This is how it will look once published. You can still go back and change anything."),
            !isSignedIn && React.createElement("div", { style: {
                    display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[12], color: '#E8C468',
                    background: 'rgba(232,196,104,0.08)', border: '1px solid rgba(232,196,104,0.35)', borderRadius: RADIUS_SCALE[10],
                    padding: '10px 12px', marginBottom: 14, lineHeight: 1.5,
                } },
                React.createElement("span", { style: { flexShrink: 0 } }, "\u26A0\uFE0F"),
                React.createElement("span", null, "You're not signed in, so this will only save the \u201Cpublished\u201D status on this device \u2014 nobody else will actually see it in the Grand Library", destination === 'guild' ? " or your Guild" : "", " until you sign in from Home and publish again.")),
            publishState === 'error' && React.createElement("div", { style: {
                    display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[12], color: '#D98A8A',
                    background: 'rgba(217,138,138,0.08)', border: '1px solid rgba(217,138,138,0.35)', borderRadius: RADIUS_SCALE[10],
                    padding: '10px 12px', marginBottom: 14, lineHeight: 1.5,
                } },
                React.createElement("span", { style: { flexShrink: 0 } }, "\u26A0\uFE0F"),
                React.createElement("span", null, publishError)),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], padding: 16, borderRadius: RADIUS_SCALE[12], background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020' } },
                targetType === 'book'
                    ? React.createElement(BookCover, { title: details.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author, cover: project.cover, size: 'sm' })
                    : React.createElement("div", { style: {
                            width: 64, height: 64, borderRadius: RADIUS_SCALE[10], flexShrink: 0, overflow: 'hidden',
                            background: details.coverImageUrl ? `center/cover url(${details.coverImageUrl})` : 'radial-gradient(circle at 34% 30%, #2A2115, #17130E 75%)',
                            border: '1px solid #4A3D22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[24],
                        } }, !details.coverImageUrl && React.createElement(InkIcon, { name: "package", size: 26, color: "#5C5245" })),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, details.title),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 3 } }, details.genre),
                    targetType === 'book' && storyFormat === 'series' && React.createElement("span", { style: {
                            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[9.5], fontWeight: 700,
                            letterSpacing: '0.03em', textTransform: 'uppercase', color: '#8FCB8F', background: 'rgba(143,203,143,0.14)',
                            border: '1px solid rgba(143,203,143,0.33)', borderRadius: RADIUS_SCALE[999], padding: '2px 8px', marginTop: 6,
                        } }, `\u25B6 Series \u00B7 ${bookChapterCount} Episode${bookChapterCount === 1 ? '' : 's'}`),
                    details.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#A6A6AD', marginTop: 8, lineHeight: 1.5, fontStyle: 'italic' } }, details.description),
                    details.tags.length > 0 && React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[4], marginTop: 8 } },
                        details.tags.map((t, i) => React.createElement("span", { key: i, style: { fontSize: TYPE_SCALE[10.5], color: '#D9D2BE', background: '#232328', borderRadius: RADIUS_SCALE[10], padding: '2px 8px' } }, t))),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 10 } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 700, color: details.priceMode === 'paid' ? '#E8C468' : '#8FCB8F' } }, details.priceMode === 'paid' ? formatLibraryPrice(parseFloat(details.price) || 0) : 'Free'),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } }, destLabel)))));
    };
    return React.createElement("div", { onClick: () => { if (publishState !== 'publishing') onClose(); }, className: "pub-wizard-backdrop", style: {
            position: 'fixed', inset: 0, zIndex: 80, background: 'rgba(10,9,7,0.78)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 16px', overflowY: 'auto',
        } },
        React.createElement("style", null, "\n            @keyframes pubWizardBackdropIn { from { opacity: 0; } to { opacity: 1; } }\n            @keyframes pubWizardPanelIn { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }\n            @keyframes pubWizardStepIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }\n            .pub-wizard-backdrop { animation: pubWizardBackdropIn 220ms ease; }\n            .pub-wizard-panel { animation: pubWizardPanelIn 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }\n            .pub-wizard-step { animation: pubWizardStepIn 200ms ease; }\n        "),
        React.createElement("div", { onClick: (e) => e.stopPropagation(), className: "pub-wizard-panel", style: {
                width: '100%', maxWidth: 560, background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22',
                borderRadius: RADIUS_SCALE[16], padding: 24, boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2' } }, "Publish"),
                React.createElement("button", { disabled: publishState === 'publishing', onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18],
                        cursor: publishState === 'publishing' ? 'default' : 'pointer', padding: 0, lineHeight: 1, opacity: publishState === 'publishing' ? 0.5 : 1,
                    } }, "\u2715")),
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], margin: '14px 0 20px' } },
                [1, 2, 3, 4].map((n) => React.createElement(React.Fragment, { key: n },
                    React.createElement("div", { style: {
                            width: 24, height: 24, borderRadius: '50%', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: TYPE_SCALE[11], fontWeight: 700, background: n <= step ? '#C89B3C' : '#2A2A30', color: n <= step ? '#17171B' : '#7A7A82',
                        } }, n),
                    n < 4 && React.createElement("div", { style: { flex: 1, height: 2, background: n < step ? '#C89B3C' : '#2A2A30' } })))),
            React.createElement("div", { key: step, className: "pub-wizard-step" },
                step === 1 && renderStep1(),
                step === 2 && renderStep2(),
                step === 3 && renderStep3(),
                step === 4 && renderStep4()),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', marginTop: 20 } },
                step > 1
                    ? React.createElement("button", { disabled: publishState === 'publishing', onClick: () => setStep((s) => s - 1), style: {
                            background: 'none', border: '1px solid #2A2A30', color: '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13],
                            cursor: publishState === 'publishing' ? 'default' : 'pointer', opacity: publishState === 'publishing' ? 0.6 : 1,
                        } }, "Back")
                    : React.createElement("span", null),
                step < 4
                    ? React.createElement("button", { disabled: blocked, onClick: () => setStep((s) => s + 1), style: {
                            background: blocked ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22',
                            color: blocked ? '#5C5C64' : '#E8C468', borderRadius: RADIUS_SCALE[8], padding: '9px 18px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                            cursor: blocked ? 'not-allowed' : 'pointer',
                        } }, "Continue")
                    : React.createElement("button", { disabled: publishState === 'publishing', onClick: handleConfirm, style: {
                            background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22',
                            color: '#E8C468', borderRadius: RADIUS_SCALE[8], padding: '9px 18px', fontSize: TYPE_SCALE[13], fontWeight: 700,
                            cursor: publishState === 'publishing' ? 'default' : 'pointer', opacity: publishState === 'publishing' ? 0.7 : 1,
                        } }, publishState === 'publishing'
                        ? 'Publishing\u2026'
                        : (destination === 'guild' ? React.createElement(React.Fragment, null, React.createElement(InkIcon, { name: "castle", size: 13, style: { display: "inline-block", verticalAlign: "-2px", marginRight: 6 } }), `Publish to ${writerGuildName || 'Guild'}`) : React.createElement(React.Fragment, null, React.createElement(InkIcon, { name: "book", size: 13, style: { display: "inline-block", verticalAlign: "-2px", marginRight: 6 } }), "Publish to Inkroot"))))));
}


// ---------- Worldbuilding Packs: builder + management ----------
export function emptyPackSelection() {
    const sel = {};
    PACK_CATEGORY_KEYS.forEach((k) => { sel[k] = []; });
    return sel;
}


// One collapsible category section inside the pack builder: a select-all row plus a checkbox
// per entry already living in this project's World Bible for that category. Categories with
// nothing in them yet are skipped entirely by the caller rather than shown empty.
export function PackCategoryPicker({ meta, entries, selectedIds, onToggleAll, onToggleOne }) {
    const [open, setOpen] = useState(false);
    const allSelected = entries.length > 0 && entries.every((e) => selectedIds.includes(e.id));
    return React.createElement("div", { style: { border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], marginBottom: 8, overflow: 'hidden' } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '10px 12px', background: '#1B1912', cursor: 'pointer' }, onClick: () => setOpen((o) => !o) },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, meta.icon),
            React.createElement("span", { style: { flex: 1, fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: '#EFE7D2' } }, meta.label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11.5], color: selectedIds.length > 0 ? '#C89B3C' : '#5C5C64' } }, `${selectedIds.length} of ${entries.length} selected`),
            React.createElement("button", { onClick: (e) => { e.stopPropagation(); onToggleAll(entries.map((en) => en.id), allSelected); }, style: {
                    background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[6], padding: '3px 8px', fontSize: TYPE_SCALE[10.5], cursor: 'pointer',
                } }, allSelected ? 'Clear' : 'Select all'),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform var(--ink-dur) var(--ink-ease)' } }, "\u25BE")),
        open && React.createElement("div", { style: { padding: '6px 12px 10px', display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[2], maxHeight: 220, overflowY: 'auto' } },
            entries.map((entry) => React.createElement("label", { key: entry.id, style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[9], padding: '5px 4px', cursor: 'pointer' } },
                React.createElement("input", { type: "checkbox", checked: selectedIds.includes(entry.id), onChange: () => onToggleOne(entry.id) }),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.name),
                entry.snippet && React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', flexShrink: 0, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, entry.snippet)))));
}


// Create or edit a Worldbuilding Pack: a title/blurb/cover/price listing, plus a picker for
// exactly which of this project's own characters, locations, lore, timeline events, and glossary
// terms to include. Nothing here duplicates that data — see PACK_CATEGORY_KEYS.
export function WorldbuildingPackBuilderModal({ project, pack, onSave, onClose }) {
    const [title, setTitle] = useState(pack ? pack.title : '');
    const [subtitle, setSubtitle] = useState(pack ? pack.subtitle : '');
    const [description, setDescription] = useState(pack ? pack.description : '');
    const [coverImageUrl, setCoverImageUrl] = useState(pack ? pack.coverImageUrl : '');
    const [price, setPrice] = useState(pack && typeof pack.price === 'number' ? String(pack.price) : '0');
    const [selection, setSelection] = useState(() => {
        const base = emptyPackSelection();
        if (pack && pack.selection)
            PACK_CATEGORY_KEYS.forEach((k) => { base[k] = Array.isArray(pack.selection[k]) ? [...pack.selection[k]] : []; });
        return base;
    });
    const toggleOne = (key, id) => setSelection((prev) => ({ ...prev, [key]: prev[key].includes(id) ? prev[key].filter((x) => x !== id) : [...prev[key], id] }));
    const toggleAll = (key, ids, currentlyAllSelected) => setSelection((prev) => ({ ...prev, [key]: currentlyAllSelected ? [] : ids }));
    const totalSelected = PACK_CATEGORY_KEYS.reduce((s, k) => s + selection[k].length, 0);
    const handleSave = () => {
        const n = parseFloat(price);
        const now = Date.now();
        onSave({
            id: pack ? pack.id : uuid(),
            title: title.trim() || 'Untitled Pack',
            subtitle: subtitle.trim(),
            description: description.slice(0, 500),
            coverImageUrl,
            price: (isNaN(n) || n < 0) ? 0 : n,
            genre: pack ? (pack.genre || 'Unspecified') : 'Unspecified',
            tags: pack ? (pack.tags || []) : [],
            selection,
            publishStatus: pack ? pack.publishStatus : 'none',
            publishedAt: pack ? pack.publishedAt : null,
            createdAt: pack ? pack.createdAt : now,
            updatedAt: now,
        });
    };
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(10,9,7,0.78)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '24px 16px', overflowY: 'auto',
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 640, background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22',
                borderRadius: RADIUS_SCALE[16], padding: 24, boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#EFE7D2' } }, pack ? 'Edit Worldbuilding Pack' : 'New Worldbuilding Pack'),
                React.createElement("button", { onClick: onClose, style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1 } }, "\u2715")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 18, lineHeight: 1.5 } }, "Choose what to include from ", project.title || 'this project', ". You can change the selection any time \u2014 it always reflects your current World Bible."),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[14], marginBottom: 18 } },
                React.createElement(Field, { label: "Pack title", value: title, onChange: setTitle, placeholder: "e.g. The Salt Throne \u2014 World Compendium", large: true, maxLength: 200 }),
                React.createElement(Field, { label: "Tagline (optional)", value: subtitle, onChange: setSubtitle, placeholder: "A short line under the title", maxLength: 200 }),
                React.createElement(Field, { label: "Description", value: description, onChange: setDescription, textarea: true, placeholder: "What's inside, and why a reader or fellow writer would want it\u2026" }),
                React.createElement("div", null,
                    React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Cover image (optional)"),
                    React.createElement("div", { style: { marginTop: 6 } },
                        React.createElement(ImagePicker, { value: coverImageUrl, onChange: setCoverImageUrl, placeholder: "Upload a cover", maxDim: 900, quality: 0.85 }))),
                React.createElement("div", null,
                    React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Asking price"),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 4 } },
                        React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
                        React.createElement("input", { type: "number", min: 0, step: "1", value: price, onChange: (e) => setPrice(e.target.value), style: {
                                width: 90, background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[13],
                            } })),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 6, fontStyle: 'italic' } }, "Worldbuilding Packs aren't purchasable yet \u2014 this is just how the price will show. Leave it at 0 for Free."))),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } }, `What's included \u2014 ${totalSelected} ${totalSelected === 1 ? 'entry' : 'entries'} selected`),
            React.createElement("div", { style: { maxHeight: 320, overflowY: 'auto', paddingRight: 2, marginBottom: 18 } },
                PACK_CATEGORY_KEYS.map((key) => {
                    const entries = worldBibleEntries(project, key);
                    if (entries.length === 0)
                        return null;
                    const meta = WORLD_BIBLE_CATEGORIES.find((c) => c.key === key) || { icon: React.createElement(InkIcon, { name: 'scroll', size: 13 }), label: key };
                    const allIds = entries.map((e) => e.id);
                    const allSelected = allIds.every((id) => selection[key].includes(id));
                    return React.createElement(PackCategoryPicker, {
                        key, meta, entries, selectedIds: selection[key],
                        onToggleAll: (ids, currentlyAll) => toggleAll(key, ids, currentlyAll || allSelected),
                        onToggleOne: (id) => toggleOne(key, id),
                    });
                }),
                PACK_CATEGORY_KEYS.every((key) => worldBibleEntries(project, key).length === 0) && React.createElement(EmptyState, { text: "Nothing in this project's World Bible yet \u2014 add some characters, locations, or lore first." })),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[10], justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onClose, style: { background: 'none', border: '1px solid #2A2A30', color: '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], cursor: 'pointer' } }, "Cancel"),
                React.createElement("button", { onClick: handleSave, disabled: totalSelected === 0, style: {
                        background: totalSelected === 0 ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22',
                        color: totalSelected === 0 ? '#5C5C64' : '#E8C468', borderRadius: RADIUS_SCALE[8], padding: '9px 18px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                        cursor: totalSelected === 0 ? 'not-allowed' : 'pointer',
                    } }, pack ? 'Save changes' : 'Create pack'))));
}


// One Worldbuilding Pack in a project's own Packs tab — its listing, what it contains at a
// glance, and Edit / Publish / Unpublish / Delete. Publishing here only offers Inkroot (not a
// Guild) since this view doesn't have the writer's guild context — see WorldbuildingPackDetailModal
// and the Grand Library's Author Studio for the cross-project view.
export function WorldbuildingPackCard({ project, pack, onEdit, onDelete, onSetPublishStatus, onOpenPublishWizard }) {
    const categories = PACK_CATEGORY_KEYS.map((key) => ({
        key, meta: WORLD_BIBLE_CATEGORIES.find((c) => c.key === key), count: (pack.selection[key] || []).length,
    })).filter((c) => c.count > 0);
    const total = categories.reduce((s, c) => s + c.count, 0);
    const published = pack.publishStatus && pack.publishStatus !== 'none';
    return React.createElement("div", { style: { background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[14], padding: 16 } },
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[14], alignItems: 'flex-start' } },
            React.createElement("div", { style: {
                    width: 52, height: 52, borderRadius: RADIUS_SCALE[10], flexShrink: 0, overflow: 'hidden', position: 'relative',
                    background: pack.coverImageUrl ? `center/cover url(${pack.coverImageUrl})` : 'radial-gradient(circle at 34% 30%, #2A2115, #17130E 75%)',
                    border: '1px solid #4A3D22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[20],
                } }, !pack.coverImageUrl && React.createElement(InkIcon, { name: "package", size: 22, color: "#5C5245" })),
            React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], fontWeight: 600, color: '#EFE7D2' } }, pack.title || 'Untitled Pack'),
                pack.subtitle && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginTop: 2, fontStyle: 'italic' } }, pack.subtitle),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, `${total} entr${total === 1 ? 'y' : 'ies'} across ${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`),
                categories.length > 0 && React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[6], marginTop: 8 } },
                    categories.map((c) => React.createElement("span", { key: c.key, style: {
                            fontSize: TYPE_SCALE[10.5], color: '#A6A6AD', background: 'rgba(122,122,130,0.10)', border: '1px solid #2E2A1E',
                            borderRadius: RADIUS_SCALE[999], padding: '2px 9px',
                        } }, c.meta ? c.meta.icon : '', " ", c.meta ? c.meta.label : c.key, " \u00B7 ", c.count))),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginTop: 12, flexWrap: 'wrap' } },
                    published
                        ? React.createElement("span", { style: {
                                fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                                padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                            } }, "Published \u00B7 Inkroot")
                        : React.createElement("button", { onClick: () => onOpenPublishWizard(pack.id), disabled: total === 0, style: {
                                background: 'none', border: '1px solid #3A3020', color: total === 0 ? '#5C5C64' : '#C89B3C', borderRadius: RADIUS_SCALE[8],
                                padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: total === 0 ? 'not-allowed' : 'pointer', fontWeight: 600,
                            } }, "Publish"),
                    published && React.createElement("button", { onClick: () => onOpenPublishWizard(pack.id), style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                        } }, "Manage listing"),
                    published && React.createElement("button", { onClick: () => onSetPublishStatus(pack.id, 'none'), style: {
                            background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0,
                        } }, "Unpublish"),
                    React.createElement("button", { onClick: onEdit, style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0 } }, "Edit"),
                    React.createElement("button", { onClick: onDelete, style: { background: 'none', border: 'none', color: '#8A5A5A', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0, marginLeft: 'auto' } }, "Delete")))));
}


// ---------- Personal ratings (local-only) ----------
// A reader's own star rating + private note for a book, kept on this device — used for things
// scoped to just this reader (the Featured Chronicle pick, a book card's own star display).
// Deliberately kept separate from "public reviews", which are a different, genuinely shared
// feature: a real reviews table other readers' opinions actually land in (see submitReview/
// fetchBookStats in lib/library.js and the review form + review list inside BookDetailModal in
// grand-library-cards.jsx) — not a stand-in for a review system that doesn't exist yet.
export const LIBRARY_RATINGS_KEY = 'inkroot:library:ratings';


export function readLibraryRatings() {
    try {
        return JSON.parse(localStorage.getItem(LIBRARY_RATINGS_KEY) || '{}');
    }
    catch (e) {
        return {};
    }
}


export function writeLibraryRatings(map) {
    try {
        localStorage.setItem(LIBRARY_RATINGS_KEY, JSON.stringify(map));
    }
    catch (e) { }
}


// REMOVED — LIBRARY_DISCUSSIONS_KEY / readLibraryDiscussions() / writeLibraryDiscussions(), the
// device-local Book Discussion Hall storage. The Discussion Hall is real now (migration 67,
// book_discussion_posts) — see fetchBookDiscussion/postBookDiscussion/
// subscribeBookDiscussionRealtime in lib/library.js and DiscussionHallModal in
// grand-library-cards.jsx.


// ---------- Cart (local queue in front of a real checkout) ----------
// "Buy" adds a book to this device's own Cart so a reader can collect several books before
// paying for them together — the queue itself is device-local and persists across sessions, but
// "Proceed to Checkout" (CartDrawer.handleCheckout in grand-library-cards.jsx) hands each priced
// item to the real Paystack flow one at a time (see checkoutBook in lib/payments.js), and a book
// only leaves the cart once its purchase has actually settled. Nothing about a completed
// purchase is invented — see item 2 of the production audit for the full chain down to the
// server-verified paystack-webhook and the published_book_content RLS it gates.
export const LIBRARY_CART_KEY = 'inkroot:library:cart';


export function readLibraryCart() {
    try {
        return JSON.parse(localStorage.getItem(LIBRARY_CART_KEY) || '[]');
    }
    catch (e) {
        return [];
    }
}


export function writeLibraryCart(list) {
    try {
        localStorage.setItem(LIBRARY_CART_KEY, JSON.stringify(list));
    }
    catch (e) { }
}


// A small heading used above every Grand Library section (shelf rows and Coming Soon panels
// alike), so New Releases, Most Read, Editor's Choice etc. all read as one family of sections.
export function LibrarySectionHeading({ icon, label, note }) {
    return React.createElement("div", { style: { marginBottom: 10 } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[15] } }, icon),
            React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, label)),
        note && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 3, fontStyle: 'italic' } }, note));
}


// Shared CSS for every horizontal bookshelf row in the Grand Library (New Releases, Highest
// Rated, etc.) — a slim walnut ledge the covers sit on, echoing HomeScreen's own shelf (see its
// .shelf-* styles) but namespaced "gl-shelf-" and fully self-contained, since this screen can be
// open while Home's <style> tag isn't mounted at all.
export function GrandLibraryShelfStyles() {
    return React.createElement("style", null, `
      /* Book covers on every shelf carousel render at BookCover's 'sm' size (94 wide, 2:3 aspect
         -> 141 tall). These numbers are baked into the shelf math below (overlap depth, plank
         position, contact-shadow placement) so the plank's top edge sits a little way up inside
         the bottom of each cover rather than floating beneath it. */
      .gl-shelf-stage { position: relative; margin: 4px 0 22px 0; }
      .gl-shelf-ambient {
        position: absolute; left: 6px; right: 6px; top: 6px; height: 132px; z-index: 0;
        pointer-events: none; filter: blur(20px);
        background: radial-gradient(ellipse at center, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0) 70%);
      }
      /* The plank itself: warm wood-grain gradient, a lit top lip catching the chandelier glow,
         and its own soft drop shadow onto whatever sits below it so it reads as a physical ledge
         rather than a flat stripe of color. Static and absolutely positioned relative to the
         stage (not inside the scrolling row), so it never repaints while books scroll past it. */
      .gl-shelf-wood {
        position: absolute; left: 2px; right: 2px; top: 129px; height: 19px; border-radius: 2px 2px 4px 4px; z-index: 1;
        background:
          linear-gradient(90deg, rgba(0,0,0,0.16) 0%, rgba(0,0,0,0) 10%, rgba(0,0,0,0) 90%, rgba(0,0,0,0.16) 100%),
          /* Wandering grain streaks (irregular widths, not a repeating tile) layered under the
             existing plank-seam pattern, so the wood reads as an actual cut board rather than a
             flat brown fill. */
          repeating-linear-gradient(90deg,
            rgba(0,0,0,0.08) 0px, rgba(0,0,0,0.08) 1px, transparent 1px, transparent 6px,
            rgba(0,0,0,0.05) 6px, rgba(0,0,0,0.05) 7px, transparent 7px, transparent 15px,
            rgba(0,0,0,0.06) 15px, rgba(0,0,0,0.06) 16px, transparent 16px, transparent 27px),
          repeating-linear-gradient(90deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 7px, rgba(0,0,0,0.05) 9px),
          linear-gradient(180deg, #5C3F26 0%, #4A3220 28%, #35210F 62%, #241407 100%);
        box-shadow:
          0 10px 16px -6px rgba(0,0,0,0.55),
          0 2px 0 rgba(0,0,0,0.3),
          inset 0 1px 0 rgba(232,196,104,0.35),
          inset 0 -6px 8px -6px rgba(0,0,0,0.6);
      }
      /* A faint warm highlight along the very front edge, as if catching light from the
         chandelier hanging above the Grand Library. */
      .gl-shelf-wood::before {
        content: ''; position: absolute; left: 4%; right: 4%; top: 0; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(232,196,104,0.5) 50%, transparent);
      }
      .gl-shelf-scroll {
        position: relative; z-index: 2; display: flex; align-items: flex-start; gap: 8px;
        overflow-x: auto; overflow-y: hidden; scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch; scrollbar-width: none; padding: 0 4px 4px 4px;
        transform: translateZ(0);
      }
      .gl-shelf-scroll::-webkit-scrollbar { display: none; }
      .gl-shelf-item { cursor: pointer; flex-shrink: 0; scroll-snap-align: start; text-align: center;
        transition: transform var(--ink-dur) var(--ink-ease); }
      .gl-shelf-item:hover { transform: translateY(-3px); }
      .gl-shelf-item-cover { position: relative; }
      /* Contact shadow where each book actually meets the shelf (sits just above the cover's own
         bottom edge, roughly where the plank's top lip crosses behind it) plus a wider, softer
         cast shadow spilling onto the wood in front of it — together they sell the book as
         resting ON the shelf rather than merely overlapping a stripe of color. Both live on a
         single pseudo-element per book (no extra DOM nodes), so scroll performance is unaffected. */
      .gl-shelf-item-cover::after {
        content: ''; position: absolute; left: 50%; bottom: 6px; transform: translateX(-50%);
        width: 88%; height: 22px; pointer-events: none; filter: blur(3px);
        /* Same tight-core-plus-soft-halo contact shadow as Home's own shelf (.shelf-item-cover),
           so a book reads as touching the wood here rather than casting one even blur. */
        background:
          radial-gradient(ellipse at center, rgba(0,0,0,0.6) 0%, rgba(0,0,0,0) 38%),
          radial-gradient(ellipse at center, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0) 78%);
      }
      .gl-shelf-item-label {
        font-size: 10.5px; color: #A6A6AD; margin-top: 16px; max-width: 86px; line-height: 1.3;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .gl-author-link { text-decoration: none; transition: color var(--ink-dur) var(--ink-ease); }
      .gl-author-link:hover, .gl-author-link:focus-visible { color: #E8C468; text-decoration: underline; }
      /* ---------- Discover top bar: search, Cart, Notifications/Inbox ---------- */
      .gl-topbar {
        position: sticky; top: 0; z-index: 25; display: flex; align-items: center; gap: 10px;
        padding: 10px 4px; margin: -4px -4px 18px -4px; flex-wrap: wrap;
        background: rgba(23,20,14,0.92); backdrop-filter: blur(8px);
        border-bottom: 1px solid rgba(232,196,104,0.14);
      }
      .gl-topbar-search { position: relative; flex: 1 1 200px; min-width: 140px; max-width: 480px; }
      .gl-topbar-search input {
        width: 100%; background: rgba(122,122,130,0.08); border: 1px solid rgba(122,122,130,0.22);
        border-radius: 9px; padding: 9px 12px 9px 30px; color: #EFE7D2; font-size: 12.5px; outline: none;
        transition: border-color var(--ink-dur) var(--ink-ease);
      }
      .gl-topbar-search input:focus { border-color: rgba(232,196,104,0.5); }
      .gl-topbar-search span { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; color: #5C5C64; pointer-events: none; }
      .gl-topbar-icon {
        position: relative; width: 36px; height: 36px; border-radius: 9px; border: 1px solid rgba(122,122,130,0.22);
        background: rgba(122,122,130,0.08); color: #EFE7D2; font-size: 15px; cursor: pointer; flex-shrink: 0;
        display: flex; align-items: center; justify-content: center; transition: all var(--ink-dur) var(--ink-ease);
      }
      .gl-topbar-icon:hover { background: rgba(232,196,104,0.12); border-color: rgba(232,196,104,0.4); }
      .gl-topbar-badge {
        position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; border-radius: 999px;
        background: #C89B3C; color: #17130E; font-size: 9.5px; font-weight: 700; display: flex; align-items: center;
        justify-content: center; padding: 0 4px; border: 2px solid #17171B;
      }
      /* ---------- Quick action row: Buy / Tip / Follow / Rate / Discuss / Sample ---------- */
      .gl-quick-actions { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
      .gl-qa-icon {
        flex: 0 0 auto; width: 26px; height: 26px; border-radius: 7px; border: 1px solid #3A3020;
        background: rgba(122,122,130,0.06); color: #EFE7D2; font-size: 12px; cursor: pointer;
        display: flex; align-items: center; justify-content: center; transition: all var(--ink-dur) var(--ink-ease); padding: 0;
      }
      .gl-qa-icon:hover { border-color: #C89B3C; background: rgba(232,196,104,0.12); }
      .gl-qa-icon.on { background: rgba(232,196,104,0.16); border-color: #C89B3C; color: #E8C468; }
      .gl-qa-buy {
        flex: 1 1 auto; min-width: 88px; height: 26px; border-radius: 7px; border: none;
        background: linear-gradient(160deg, #E8C468, #C89B3C); color: #17130E; font-size: 11.5px; font-weight: 700; cursor: pointer;
      }
      .gl-qa-buy:hover { filter: brightness(1.06); }
      /* ---------- Browse & Search bookcase (see LibraryBookcase) ----------
         A real carved wooden case standing in for what used to be a flat grid of book cards.
         .gl-bookcase is the case itself: dark walnut posts down each side (the ::before/::after
         stiles below) framing a stack of recessed compartments, one per book. Kept deliberately
         narrow/single-column for now — this is the physical foundation (depth, shadow, wood),
         not the finished multi-book-per-shelf layout. No transitions/animations added here. */
      .gl-bookcase {
        position: relative; margin: 4px 0 8px; padding: 14px 13px 2px;
        border-radius: 8px 8px 5px 5px;
        background: linear-gradient(180deg, #2E2314 0%, #221A0F 40%, #1B140C 100%);
        border: 1px solid #4A3D22;
        box-shadow:
          inset 0 1px 0 rgba(232,196,104,0.14), inset 0 0 0 1px rgba(0,0,0,0.35),
          0 14px 34px rgba(0,0,0,0.42), 0 2px 0 rgba(0,0,0,0.5);
      }
      /* Left/right case posts (stiles) — give the case visible thickness/edges rather than a
         flat rectangle, like the solid wood frame of a real bookcase. */
      .gl-bookcase::before, .gl-bookcase::after {
        content: ''; position: absolute; top: 0; bottom: 0; width: 9px; z-index: 2;
        background: linear-gradient(90deg, #5C3F26, #2E1E10);
      }
      .gl-bookcase::before { left: 0; border-radius: 6px 0 0 4px; box-shadow: inset -2px 0 4px rgba(0,0,0,0.55), inset 2px 0 2px rgba(255,255,255,0.06); }
      .gl-bookcase::after { right: 0; border-radius: 0 6px 4px 0; box-shadow: inset 2px 0 4px rgba(0,0,0,0.55), inset -2px 0 2px rgba(255,255,255,0.06); }
      /* One recessed niche per book. The back panel (below) is a separate absolutely-positioned
         layer behind the content so its inset shadows read as real depth into the case, not a
         border drawn around the book's own info. */
      .gl-bookcase-compartment { position: relative; margin: 0 7px; }
      .gl-bookcase-compartment-back {
        position: absolute; inset: 0 0 14px 0; border-radius: 3px; z-index: 0; pointer-events: none;
        background:
          /* A little warm light spilling in from the front/top of the niche (same chandelier
             source every other warm highlight in the case answers to), falling off well before
             it reaches the back panel — so the compartment reads as lit at the mouth and
             genuinely receding into shadow behind the book, not just a flat dark fill. */
          radial-gradient(ellipse at 50% 0%, rgba(232,196,104,0.05) 0%, transparent 45%),
          radial-gradient(ellipse at 50% 0%, rgba(0,0,0,0.4) 0%, rgba(0,0,0,0) 65%),
          repeating-linear-gradient(90deg, rgba(0,0,0,0.05) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0) 30px, rgba(0,0,0,0.05) 32px),
          linear-gradient(180deg, #1E1710 0%, #17110A 55%, #100C07 100%);
        box-shadow:
          inset 0 10px 16px -8px rgba(0,0,0,0.75),
          inset 8px 0 14px -10px rgba(0,0,0,0.6),
          inset -8px 0 14px -10px rgba(0,0,0,0.6);
      }
      .gl-bookcase-compartment-content { position: relative; z-index: 1; padding: 18px 13px 20px; }
      /* The shelf plank each compartment's book actually rests on — same wood-grain language as
         .gl-shelf-wood above, so every shelf in the Grand Library (curated rows and this case
         alike) reads as the same physical material. Doubles as the divider between compartments. */
      .gl-bookcase-ledge {
        position: relative; height: 14px; margin: 0 2px; z-index: 1;
        border-radius: 1px 1px 3px 3px;
        background:
          repeating-linear-gradient(90deg,
            rgba(0,0,0,0.08) 0px, rgba(0,0,0,0.08) 1px, transparent 1px, transparent 6px,
            rgba(0,0,0,0.05) 6px, rgba(0,0,0,0.05) 7px, transparent 7px, transparent 15px),
          linear-gradient(180deg, #5C3F26 0%, #4A3220 28%, #35210F 62%, #241407 100%);
        box-shadow: 0 8px 14px -6px rgba(0,0,0,0.55), inset 0 1px 0 rgba(232,196,104,0.32), inset 0 -4px 6px -4px rgba(0,0,0,0.6);
      }
      .gl-bookcase-ledge::before {
        content: ''; position: absolute; left: 4%; right: 4%; top: 0; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(232,196,104,0.4) 50%, transparent);
      }
      .gl-bookcase-compartment:last-child .gl-bookcase-ledge { margin-bottom: 6px; }
    `);
}


// A real, working shelf of books (used for New Releases, and for Highest Rated once at least one
// book carries a personal rating) — a horizontal scroll of covers resting on a wooden ledge.
// Clicking a cover opens BookDetailModal rather than jumping straight into reading, so a browsing
// reader can see the blurb/price/sample before committing to anything.
export function GrandLibraryShelfRow({ icon, label, note, books, onSelectBook, emptyText }) {
    return React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon, label, note }),
        books.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, emptyText)
            : React.createElement("div", { className: "gl-shelf-stage" },
                React.createElement("div", { className: "gl-shelf-ambient" }),
                React.createElement("div", { className: "gl-shelf-wood" }),
                React.createElement("div", { className: "gl-shelf-scroll" },
                    books.map((book) => React.createElement("div", { key: book.id, className: "gl-shelf-item", onClick: () => onSelectBook(book) },
                        React.createElement("div", { className: "gl-shelf-item-cover" },
                            React.createElement(BookCover, { title: book.title, subtitle: book.subtitle, seriesName: book.seriesName, author: book.author, cover: book.cover, size: 'sm' })),
                        React.createElement("div", { className: "gl-shelf-item-label" }, book.title || 'Untitled Novel'))))));
}


// ---------- Book card quick actions: Buy, Tip Author, Follow Author, Rate, Book Discussion
// Hall, Read Sample ----------
// Shown on every full book card (LibraryDiscoverCard, FeaturedChronicleCard) and repeated as its
// own row inside BookDetailModal (the book page) — one shared control so the six actions always
// look and behave identically wherever a book shows up. Shelf-row spines (GrandLibraryShelfRow)
// stay minimal on purpose, echoing a real shelf of book spines rather than a row of product
// cards; clicking one opens the same book page, where the full action set lives. Buy queues the
// book in the on-device Cart, whose own Buy button performs a real Paystack charge
// (checkoutBook — see Phase 12/PAYMENTS.md), and Tip Author does the same, immediately (also
// checkoutBook, kind: 'tip' — see TipAuthorModal). Follow/Rate/Discuss are real, working,
// on-device features.
export function LibraryQuickActions({ book, following, inCart, onToggleFollow, onBuy, onTip, onRate, onDiscuss, onSample }) {
    return React.createElement("div", { className: "gl-quick-actions" },
        React.createElement("button", { className: "gl-qa-icon", title: "Tip Author", onClick: (e) => { e.stopPropagation(); onTip(book); } }, React.createElement(InkIcon, { name: "coin", size: 13 })),
        React.createElement("button", {
            className: `gl-qa-icon${following ? ' on' : ''}`, title: following ? 'Following' : 'Follow Author',
            onClick: (e) => { e.stopPropagation(); onToggleFollow(book.author, book.authorId); },
        }, following ? "\u2713" : "\u2795"),
        React.createElement("button", { className: "gl-qa-icon", title: "Rate", onClick: (e) => { e.stopPropagation(); onRate(book); } }, React.createElement(InkIcon, { name: "star", size: 13 })),
        React.createElement("button", { className: "gl-qa-icon", title: "Book Discussion Hall", onClick: (e) => { e.stopPropagation(); onDiscuss(book); } }, React.createElement(InkIcon, { name: "chat", size: 13 })),
        React.createElement("button", { className: "gl-qa-icon", title: "Read Sample", onClick: (e) => { e.stopPropagation(); onSample(book); } }, React.createElement(InkIcon, { name: "book", size: 13 })),
        React.createElement("button", { className: "gl-qa-buy", onClick: (e) => { e.stopPropagation(); onBuy(book); } },
            inCart ? "\u2713 In Cart" : `Buy ${formatLibraryPrice(book.price)}`));
}


// "Tip Author" — a real Naira payment straight to the writer (via Paystack, see
// src/lib/payments.js's checkoutBook and the paystack-init-purchase Edge Function). Following
// the author is still offered below as a real, working alternative — not a fallback for tipping
// not working, just a second genuine way to support them.
const TIP_PRESETS_NAIRA = [200, 500, 1000, 2000];

export function TipAuthorModal({ book, onClose, onOpenAuthor }) {
    const [amount, setAmount] = useState(500);
    const [state, setState] = useState('idle'); // idle | paying | success | error | pending
    const [error, setError] = useState(null);

    const handleTip = async () => {
        setState('paying');
        setError(null);
        try {
            const outcome = await checkoutBook({ bookId: book.id, kind: 'tip', amountNaira: amount });
            setState(outcome === 'success' ? 'success' : outcome === 'pending' ? 'pending' : 'error');
            if (outcome === 'failed') setError("Payment didn't go through \u2014 you weren't charged.");
        } catch (e) {
            setState('error');
            setError(e.message);
        }
    };

    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 380, textAlign: 'center',
                background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16],
                padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end' } },
                React.createElement("button", { onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            React.createElement("div", { style: { marginBottom: 8 } }, React.createElement(InkIcon, { name: "coin", size: 26, color: "#E8C468" })),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#EFE7D2' } }, `Tip ${book.author || 'this writer'}`),
            state === 'success' && React.createElement("div", { style: { marginTop: 16, color: '#8FCB8F', fontSize: TYPE_SCALE[13], fontWeight: 600 } }, `\u2713 ${formatNaira(amount)} sent \u2014 thank you!`),
            state === 'pending' && React.createElement("div", { style: { marginTop: 16, color: '#E8C468', fontSize: TYPE_SCALE[12.5] } }, "Payment confirmed \u2014 finishing up on Inkroot's side. This can take a minute; no need to pay again."),
            (state === 'idle' || state === 'paying' || state === 'error') && React.createElement(React.Fragment, null,
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center', marginTop: 16, flexWrap: 'wrap' } },
                    TIP_PRESETS_NAIRA.map((n) => React.createElement("button", { key: n, onClick: () => setAmount(n), style: {
                            borderRadius: RADIUS_SCALE[8], padding: '7px 14px', fontSize: TYPE_SCALE[12.5], fontWeight: 600, cursor: 'pointer',
                            background: amount === n ? '#C89B3C22' : 'transparent',
                            border: amount === n ? '1px solid #C89B3C' : '1px solid #3A3020',
                            color: amount === n ? '#C89B3C' : '#A6A6AD',
                        } }, formatNaira(n)))),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], justifyContent: 'center', marginTop: 12 } },
                    React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
                    React.createElement("input", { type: "number", min: 100, step: "50", value: amount, onChange: (e) => setAmount(Number(e.target.value)), style: {
                            width: 100, background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[8], padding: '8px 10px', fontSize: TYPE_SCALE[13], textAlign: 'center',
                        } })),
                error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
                React.createElement("button", { disabled: state === 'paying' || !amount || amount < 100, onClick: handleTip, style: {
                        marginTop: 16, width: '100%', border: 'none', borderRadius: RADIUS_SCALE[10], padding: '10px 0',
                        background: 'linear-gradient(160deg, #E8C468, #C89B3C)', color: '#17130E', fontSize: TYPE_SCALE[13], fontWeight: 700,
                        cursor: state === 'paying' ? 'default' : 'pointer', opacity: state === 'paying' ? 0.7 : 1,
                    } }, state === 'paying' ? 'Processing\u2026' : `Tip ${formatNaira(amount)}`)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 16, lineHeight: 1.6 } }, "You can also support them for free:"),
            React.createElement("button", { onClick: () => { onOpenAuthor && onOpenAuthor(book.author); }, style: {
                    marginTop: 10, background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                    padding: '8px 16px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer', fontWeight: 600,
                } }, "\u2795 Follow them instead")));
}
