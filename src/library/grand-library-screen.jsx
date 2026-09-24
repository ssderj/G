import React, { useEffect, useState } from 'react';
import { AUTHOR_FOLLOWS_KEY, authorKeyFor, readAuthorFollowMap, writeAuthorFollowMap } from './author-reputation.jsx';
import { AuthorsHallScreen } from './authors-hall-screen.jsx';
import { CreatorDashboard } from './creator-dashboard.jsx';
import { AddonLibraryCard, AuthorStudioBookCard, AuthorStudioPackCard, BookDetailModal, CartDrawer, ComingSoonShelf, DiscussionHallModal, FeaturedChronicleCard, GrandLibraryAtmosphere, LibraryBookcase, LibraryDiscoverCard, TemplateLibraryCard, WorldbuildingPackDetailModal, WorldbuildingPackLibraryCard } from './grand-library-cards.jsx';
import { GrandLibraryShelfRow, GrandLibraryShelfStyles, LIBRARY_CART_KEY, LIBRARY_SORTS, LibraryAuthorLink, LibrarySectionHeading, PublishingWizard, TipAuthorModal, readLibraryCart, readLibraryFavorites, readLibraryRatings, writeLibraryCart, writeLibraryFavorites, writeLibraryRatings } from './publishing.jsx';
import { fetchDiscoverBooks, fetchMostDiscussedBooks, fetchPublishedBookById, followAuthor, isFollowing as isFollowingRemote, unfollowAuthor } from '../lib/library.js';
import { fetchDiscoverPacks } from '../lib/worldbuilding-packs.js';
import { fetchDiscoverAddons } from '../lib/addon-marketplace.js';
import { fetchDiscoverTemplates } from '../lib/template-marketplace.js';
import { readAddons, writeAddons } from '../writing/addon-data.jsx';
import { readTemplates, writeTemplates } from '../writing/templates.jsx';
import { fetchMostRead, fetchTrending } from '../lib/book-rankings.js';
import { BOOK_VIEW_SOURCES, recordBookDetailView, recordBookReadStart } from '../lib/analytics.js';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { AlertDialog } from '../shared-ui/ui-primitives.jsx';
import { wordCount } from '../shared-utils/strip-html.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { InkRoot } from '../shell/ink-root.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE, useBodyScrollLock, useNav } from '../shell/nav-context.jsx';
import { packSummaryForIndex } from '../worldbuilding/book-cover.jsx';


export function GrandLibraryScreen({ projects, writerName, writerGuildName, writerProfile, writerRank, writerReputation, onOpen, onRead, onSetPublishStatus, onOpenPacks, onSetPackPublishStatus, onPublishBookWithDetails, onPublishPackWithDetails, onOpenAuthor, initialMode, inboxUnreadCount, onOpenInbox, initialBookId, onInitialBookIdConsumed }) {
    const [mode, setMode] = useState(initialMode || 'reader'); // 'reader' | 'studio'
    // The shared Publishing Wizard (see PublishingWizard), opened for whichever project/pack the
    // Publish or Manage listing button on an AuthorStudioBookCard / AuthorStudioPackCard was
    // clicked for. null | { projectId, type: 'book' | 'pack', packId }.
    const [publishWizard, setPublishWizard] = useState(null);
    const [search, setSearch] = useState('');
    const [genreFilter, setGenreFilter] = useState('all');
    const [sortKey, setSortKey] = useState('newest');
    const [favorites, setFavorites] = useState(() => readLibraryFavorites());
    const [ratings, setRatings] = useState(() => readLibraryRatings());
    const [selectedBookId, setSelectedBookId] = useState(null);
    // Which shelf/entry point the currently-open BookDetailModal was opened from — carried along
    // so "Read the full book" from inside the modal (onReadFull below) can tag its read_start
    // event with the same source its detail_view was already tagged with, rather than falling
    // back to the generic 'direct' bucket. See src/lib/analytics.js.
    const [selectedBookSource, setSelectedBookSource] = useState(BOOK_VIEW_SOURCES.DIRECT);
    const [selectedPackKey, setSelectedPackKey] = useState(null); // `${projectId}:${packId}`, or null
    // Follow Author (see AUTHOR_FOLLOWS_KEY) — same shared map AuthorsHallScreen's own Follow
    // button reads and writes, so a follow toggled from a Discover book card is instantly
    // reflected on that writer's Hall page too, and vice versa.
    const [followingMap, setFollowingMap] = useState(() => readAuthorFollowMap(AUTHOR_FOLLOWS_KEY));
    const isFollowingAuthor = (author) => !!followingMap[authorKeyFor(author)];
    // Fix-tracker item 31: follow/unfollow notice — shown only when a real remote sync (authorId
    // present) fails, since that's the only case where the write could have silently not reached
    // the `follows` table. { title, message } | null, same shape as ink-root.jsx's publishNotice.
    const [followNotice, setFollowNotice] = useState(null);
    // authorId is only ever known here for a book hydrated via fetchPublishedBookById (Trending/
    // Most Read/Highest Rated shelves, a directly-opened book, Book Detail) — this device's own
    // local catalog has no real author account behind it, so those stay local-only exactly like
    // before, flipping the map immediately with no server round trip. When a real authorId IS
    // available, followAuthor/unfollowAuthor now throw on a real database error instead of
    // silently resolving (see lib/library.js fix-tracker item 31), so the local map is only
    // flipped once the write has actually succeeded — never optimistically ahead of it — and a
    // failure (offline, RLS reject) surfaces via followNotice instead of only a console.warn,
    // leaving the toggle exactly where it was rather than drifting from the real database state.
    const toggleFollowAuthor = (author, authorId) => {
        const key = authorKeyFor(author);
        const wasFollowing = !!followingMap[key];
        const flipLocalMap = () => {
            setFollowingMap((prev) => {
                const next = { ...prev, [key]: !prev[key] };
                writeAuthorFollowMap(AUTHOR_FOLLOWS_KEY, next);
                return next;
            });
        };
        if (!authorId) {
            flipLocalMap();
            return;
        }
        (wasFollowing ? unfollowAuthor(authorId) : followAuthor(authorId))
            .then(() => flipLocalMap())
            .catch((e) => {
                setFollowNotice({
                    title: wasFollowing ? "Couldn't unfollow" : "Couldn't follow",
                    message: "Something unexpected went wrong reaching Inkroot. Please try again in a moment.",
                });
            });
    };
    // Cart — a real, on-device queue of books a reader means to buy (see LIBRARY_CART_KEY). Buy
    // adds to this queue rather than charging immediately, so a reader can gather several books
    // before paying — the actual charge happens when the Cart's own "Proceed to Checkout" hands
    // each priced item to the real Paystack flow (see checkoutBook in lib/payments.js).
    const [cart, setCart] = useState(() => readLibraryCart());
    const [cartOpen, setCartOpen] = useState(false);
    const addToCart = (book) => {
        setCart((prev) => {
            if (prev.some((it) => it.id === book.id))
                return prev;
            const next = [...prev, { id: book.id, title: book.title, author: book.author, price: book.price, cover: book.cover, subtitle: book.subtitle, seriesName: book.seriesName }];
            writeLibraryCart(next);
            return next;
        });
        // Reachable from the Buy button rendered *inside* BookDetailModal as well as from the
        // grid/shelf cards directly. openCart() already calls closeAnyOpenOverlay() itself as its
        // first step (needed either way: a no-op from the grid/shelf cards, closes Book Detail
        // first when Buy is pressed from inside the modal) — calling it again here was redundant,
        // and worse than harmless: selectedBookId doesn't update until the next render, so this
        // second call still saw it as truthy and popped the nav stack a second time, one level too
        // far (past Book into the Library *tab* entry itself, whose undo() flips Home's active tab
        // back to 'home' — unmounting this whole screen, cart-open state included, before the
        // drawer ever got to render). Same double-invocation bug already fixed for the reverse
        // direction, opening a Book from inside the Cart — see the FIX comment on cartDrawerModal
        // below. openCart() alone already closes whatever was open correctly; no separate call
        // needed.
        openCart();
    };
    const removeFromCart = (id) => {
        setCart((prev) => {
            const next = prev.filter((it) => it.id !== id);
            writeLibraryCart(next);
            return next;
        });
    };
    const [tipBook, setTipBook] = useState(null);
    const [discussBook, setDiscussBook] = useState(null);
    const nav = useNav();
    // Exactly one of Book/Pack/Cart/Tip/Discuss can be open at a time (see closeAnyOpenOverlay
    // below), so this is also "is any Grand Library overlay currently showing" — used to lock the
    // Library's own page scroll while one of them is up, so the shelves underneath can't still be
    // scrolled by wheel/touch/keyboard while a fixed-position overlay sits on top of them, and the
    // Library is exactly where it was scrolled to once the overlay closes.
    useBodyScrollLock(!!(selectedBookId || selectedPackKey || cartOpen || tipBook || discussBook));
    // closeAnyOpenOverlay() (defined below) is what enforces "at most one Grand Library overlay
    // open at a time" — every open* here needs to call it first, or its overlay can end up
    // stacked on top of whichever one was already open instead of replacing it (two overlapping
    // `position: fixed` layers, the bottom one still scrollable and its own Close button buried
    // underneath the top one). openBook/openPack/openCart used to skip this call — only
    // addToCart/openTip/openDiscuss made it — which is exactly how that stacking happened: e.g.
    // tapping the topbar Cart icon while a Book/Pack detail modal was still open pushed the Cart
    // on top rather than swapping it in.
    const openBook = (id, title, source) => {
        closeAnyOpenOverlay();
        nav.push({ label: title || 'Book', undo: () => setSelectedBookId(null) });
        setSelectedBookId(id);
        setSelectedBookSource(source || BOOK_VIEW_SOURCES.DIRECT);
        recordBookDetailView(id, source);
    };
    const closeBook = () => nav.pop();
    // A book opened from outside the Library's own local list — e.g. "View in the Grand Library"
    // on a just-published Guild Anthology (see home-screen.jsx's viewPublishedBook). Anthology
    // books live only in the real published_books table (destination: 'guild'), never among this
    // device's own `projects`, so `books` below can't resolve them — fetched once by id here
    // instead, via the same public published_books read every book detail already relies on, and
    // merged into selectedBook below rather than given a second detail view of its own.
    const [remoteInitialBook, setRemoteInitialBook] = useState(null);
    useEffect(() => {
        if (!initialBookId) return;
        let cancelled = false;
        setMode('reader');
        fetchPublishedBookById(initialBookId)
            .then((b) => { if (!cancelled && b) { setRemoteInitialBook(b); openBook(b.id, b.title, BOOK_VIEW_SOURCES.DIRECT); } })
            .catch((e) => console.warn('Inkroot: could not open that book', e))
            .finally(() => { if (onInitialBookIdConsumed) onInitialBookIdConsumed(); });
        return () => { cancelled = true; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [initialBookId]);
    // Worldbuilding Pack directory (migration 85, fix-tracker item 20) — the pack equivalent of
    // discoverBooks below: every publicly published pack across every author, not just this
    // device's own local `projects` (see migration 85's own header for why that was the actual
    // bug behind item 20 — a pack was never visible to anyone but the author who published it).
    // Same "one bounded fetch per Library visit, re-fetched whenever Discover comes back into
    // view" posture as discoverBooks just below.
    const [discoverPacks, setDiscoverPacks] = useState([]);
    useEffect(() => {
        let cancelled = false;
        fetchDiscoverPacks()
            .then((rows) => { if (!cancelled) setDiscoverPacks(rows); })
            .catch((e) => console.warn('Inkroot: fetchDiscoverPacks failed', e));
        return () => { cancelled = true; };
    }, [mode]);
    // Template/Add-on marketplaces, browsable here too now (audit finding #2, post-fix-tracker
    // session) — same fetchDiscoverTemplates/fetchDiscoverAddons items 21/22 already built for
    // the Writing tool's own panels. `myTemplates`/`myAddons` track this device's own local list
    // (readTemplates/readAddons) purely to know which cards already say "Added" — adding one
    // here writes into that same local list via writeTemplates/writeAddons, so it shows up in
    // TemplatesPanel/AddonStudioPanel too, and vice versa.
    const [discoverTemplates, setDiscoverTemplates] = useState([]);
    const [discoverAddons, setDiscoverAddons] = useState([]);
    const [myTemplates, setMyTemplates] = useState(() => readTemplates());
    const [myAddons, setMyAddons] = useState(() => readAddons());
    useEffect(() => {
        let cancelled = false;
        fetchDiscoverTemplates()
            .then((rows) => { if (!cancelled) setDiscoverTemplates(rows); })
            .catch((e) => console.warn('Inkroot: fetchDiscoverTemplates failed', e));
        fetchDiscoverAddons()
            .then((rows) => { if (!cancelled) setDiscoverAddons(rows); })
            .catch((e) => console.warn('Inkroot: fetchDiscoverAddons failed', e));
        return () => { cancelled = true; };
    }, [mode]);
    const handleAddTemplate = (item) => {
        const next = [...myTemplates, { id: item.id, type: item.type, name: item.name, marketplaceStatus: 'unpublished', publishedAt: null, ...item.payload }];
        setMyTemplates(next);
        writeTemplates(next);
    };
    const handleAddAddon = (item) => {
        const next = [...myAddons, {
            id: item.id, name: item.name, icon: item.icon, description: item.description,
            category: item.category, version: item.version, status: 'published',
            manifestVersion: item.manifestVersion, marketplaceStatus: 'unpublished', publishedAt: null,
            contains: item.contains,
        }];
        setMyAddons(next);
        writeAddons(next);
    };
    // Most Read shelf — real, verified reader-open activity (see fetchMostRead in
    // src/lib/book-rankings.js, backed by compute_most_read() / 39_migration_best_sellers_
    // most_read.sql), the same signal Living Universe's own Most Read section already shows.
    // fetchMostRead only returns id/title/author/genre/score (enough for a ranking list), not
    // the cover/subtitle/price a shelf card needs, so each ranked id is hydrated individually via
    // fetchPublishedBookById — the same public, no-auth-required read every book detail view
    // already relies on. A ranked book frequently belongs to another author and so won't be
    // among this device's own `books` (built from local `projects` above); keeping the hydrated
    // rows in their own map (rather than merging into `books`) lets `selectedBook` below resolve
    // one by id the same way it already does for remoteInitialBook, without the local list
    // pretending it has more books published than it actually does.
    const [mostReadBooks, setMostReadBooks] = useState([]);
    const [trendingBooks, setTrendingBooks] = useState([]);
    const [remoteShelfBooksById, setRemoteShelfBooksById] = useState({});
    useEffect(() => {
        let cancelled = false;
        fetchMostRead({ limit: 10 })
            .then((rows) => Promise.all(rows.map((r) => fetchPublishedBookById(r.bookId).catch(() => null))))
            .then((hydrated) => {
                if (cancelled) return;
                const found = hydrated.filter(Boolean);
                setMostReadBooks(found);
                setRemoteShelfBooksById((prev) => ({ ...prev, ...Object.fromEntries(found.map((b) => [b.id, b])) }));
            })
            .catch((e) => console.warn('Inkroot: fetchMostRead failed', e));
        return () => { cancelled = true; };
    }, []);
    // Trending shelf — same hydration approach as Most Read just above (fetchTrending only
    // returns id/title/author/genre/score; each ranked id is hydrated via fetchPublishedBookById
    // for the cover/subtitle/price a shelf card needs). See compute_trending / migration 64 for
    // why this is a deliberately lighter, faster-moving signal than Most Read's.
    useEffect(() => {
        let cancelled = false;
        fetchTrending({ limit: 10 })
            .then((rows) => Promise.all(rows.map((r) => fetchPublishedBookById(r.bookId).catch(() => null))))
            .then((hydrated) => {
                if (cancelled) return;
                const found = hydrated.filter(Boolean);
                setTrendingBooks(found);
                setRemoteShelfBooksById((prev) => ({ ...prev, ...Object.fromEntries(found.map((b) => [b.id, b])) }));
            })
            .catch((e) => console.warn('Inkroot: fetchTrending failed', e));
        return () => { cancelled = true; };
    }, []);
    // Grand Library Discover feed — every publicly published book across every author (see
    // fetchDiscoverBooks in src/lib/library.js), not just this device's own `projects`. This is
    // what Search, the Genre filter chips, and New Releases below all read from; a book this
    // device published locally still shows up here too, the same way it already shows up on
    // every other reader's device, because publishing already writes it to the same
    // published_books row fetchDiscoverBooks reads (see shell/ink-root.jsx's setPublishStatus).
    const [discoverBooks, setDiscoverBooks] = useState([]);
    const [discoverLoading, setDiscoverLoading] = useState(true);
    useEffect(() => {
        let cancelled = false;
        setDiscoverLoading(true);
        fetchDiscoverBooks()
            .then((rows) => { if (!cancelled) setDiscoverBooks(rows); })
            .catch((e) => console.warn('Inkroot: fetchDiscoverBooks failed', e))
            .finally(() => { if (!cancelled) setDiscoverLoading(false); });
        return () => { cancelled = true; };
        // Re-fetch whenever Discover comes back into view (e.g. right after publishing something
        // new from Creator Studio), same mode toggle the reader/studio tabs already flip.
    }, [mode]);
    // Book Discussion Halls shelf — same ranked-then-hydrate approach as Most Read/Trending just
    // above: fetchMostDiscussedBooks only returns id/post_count, each ranked id is hydrated via
    // fetchPublishedBookById for the cover/subtitle/price a shelf card needs. postCounts is kept
    // alongside (keyed by book id) since fetchPublishedBookById's own row has no count on it.
    const [discussedBooks, setDiscussedBooks] = useState([]);
    const [discussedPostCounts, setDiscussedPostCounts] = useState({});
    useEffect(() => {
        let cancelled = false;
        fetchMostDiscussedBooks({ limit: 8 })
            .then((rows) => Promise.all(rows.map((r) => fetchPublishedBookById(r.bookId).catch(() => null).then((book) => [book, r.postCount]))))
            .then((hydrated) => {
                if (cancelled) return;
                const found = hydrated.filter(([book]) => Boolean(book));
                setDiscussedBooks(found.map(([book]) => book));
                setDiscussedPostCounts(Object.fromEntries(found.map(([book, count]) => [book.id, count])));
                setRemoteShelfBooksById((prev) => ({ ...prev, ...Object.fromEntries(found.map(([book]) => [book.id, book])) }));
            })
            .catch((e) => console.warn('Inkroot: fetchMostDiscussedBooks failed', e));
        return () => { cancelled = true; };
    }, []);
    // Worldbuilding Pack detail, Cart, Tip Author, Discussion Hall, and the Publish Wizard used to
    // be plain useState toggles with no nav.push — they'd appear as an overlay on top of the
    // Library but never register on the Back/breadcrumb stack the way openBook/closeBook above
    // does. That left Back either doing nothing visible or popping an unrelated earlier screen
    // while the overlay stayed put, so the only way out was the Home breadcrumb's full stack
    // reset. Giving each one the same push-on-open / pop-on-close treatment as the book detail
    // above fixes that: Back and the breadcrumb trail now both know these are open, and closing
    // them (via nav.pop, whether that's the Back button, a breadcrumb click, or the modal's own
    // close button below) runs the matching undo and nothing else.
    const openPack = (key, title) => { closeAnyOpenOverlay(); nav.push({ label: title || 'Worldbuilding Pack', undo: () => setSelectedPackKey(null) }); setSelectedPackKey(key); };
    const closePack = () => nav.pop();
    const openCart = () => { closeAnyOpenOverlay(); nav.push({ label: 'Cart', undo: () => setCartOpen(false) }); setCartOpen(true); };
    const closeCart = () => nav.pop();
    const openTip = (book) => { closeAnyOpenOverlay(); nav.push({ label: 'Tip ' + (book.author || 'Author'), undo: () => setTipBook(null) }); setTipBook(book); };
    const closeTip = () => nav.pop();
    const openDiscuss = (book) => { closeAnyOpenOverlay(); nav.push({ label: 'Discussion', undo: () => setDiscussBook(null) }); setDiscussBook(book); };
    const closeDiscuss = () => nav.pop();
    const openPublishWizard = (projectId, type, packId) => { nav.push({ label: 'Publish', undo: () => setPublishWizard(null) }); setPublishWizard({ projectId, type, packId }); };
    const closePublishWizard = () => nav.pop();
    // At most one Grand Library overlay (Book, Pack, Cart, Tip, Discuss) should ever be mounted
    // at once — every one of them is a full-screen `position: fixed` layer, so two open together
    // render as two overlapping scroll containers: the one underneath still holds its own scroll
    // position and still catches stray clicks/taps around the edges of the one on top, and its
    // own Close/exit button ends up sitting underneath the newer overlay, unreachable. Every
    // open* above calls this first so that's never possible, whether the second overlay was
    // opened from a control inside the first one (Buy/Tip/Discuss/author-link — see
    // quickActionProps below) or from something still reachable underneath it (e.g. the topbar
    // Cart icon, or another shelf card) — either way, whichever overlay was already open gets
    // closed via its own nav.pop-backed close* (so the stack stays accurate) before the next one
    // opens.
    const closeAnyOpenOverlay = () => {
        if (selectedBookId)
            closeBook();
        else if (selectedPackKey)
            closePack();
        else if (cartOpen)
            closeCart();
        else if (tipBook)
            closeTip();
        else if (discussBook)
            closeDiscuss();
    };
    // Every clickable author name in the Grand Library routes through the Author's Hall (see
    // AuthorsHallScreen) via this same handler, passed down from InkRoot. Author's Hall is a
    // different top-level screen (InkRoot swaps GrandLibraryScreen out entirely for it), so any
    // Library overlay still open needs closing first — otherwise its nav entry is orphaned
    // underneath the Hall's instead of being cleanly popped.
    const openAuthorProfile = (author, authorId) => { closeAnyOpenOverlay(); if (onOpenAuthor) onOpenAuthor(author, authorId); };
    const toggleFavorite = (id) => {
        setFavorites((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            writeLibraryFavorites(next);
            return next;
        });
    };
    const handleSetRating = (id, rating) => {
        setRatings((prev) => {
            const next = { ...prev, [id]: { ...rating, ratedAt: Date.now() } };
            writeLibraryRatings(next);
            return next;
        });
    };
    // Discover's book list is now the global published-book catalog (see discoverBooks/
    // fetchDiscoverBooks above) rather than this device's own `projects` filtered to
    // publishStatus 'inkroot' — Search, the Genre chips, and New Releases below all read `books`
    // the same way they always did, they just now see every author's published work instead of
    // only whatever this device happens to have published locally.
    const books = discoverBooks;
    // Every published Worldbuilding Pack across every author (migration 85, fix-tracker item
    // 20) — real cross-author discovery now, same as `books` above switched to discoverBooks.
    // Used to be `projects.flatMap(...)`, this device's own local packs only; see
    // fetchDiscoverPacks's own comment for why that meant nobody but a pack's own author could
    // ever see it. A pack this device published locally still shows up here too, for the same
    // reason a locally-published book does: publishing already writes it to the same
    // published_packs row this reads from (see ink-root.jsx's setPackPublishStatus/
    // publishPackWithDetails).
    const publishedPacks = discoverPacks;
    const selectedPack = selectedPackKey ? publishedPacks.find((pk) => `${pk.projectId}:${pk.id}` === selectedPackKey) : null;
    const genresPresent = ['all', ...Array.from(new Set(books.map((b) => b.genre)))];
    const filtered = books.filter((b) => {
        if (genreFilter !== 'all' && b.genre !== genreFilter)
            return false;
        const q = search.trim().toLowerCase();
        if (q) {
            const haystack = [b.title, b.author, b.genre, b.guildName].filter(Boolean).join(' ').toLowerCase();
            if (!haystack.includes(q))
                return false;
        }
        return true;
    });
    const ratedBooks = books.filter((b) => ratings[b.id] && ratings[b.id].stars > 0)
        .sort((a, b) => ratings[b.id].stars - ratings[a.id].stars || b.updatedAt - a.updatedAt);
    const sorted = [...filtered];
    if (sortKey === 'favorites')
        sorted.sort((a, b) => (favorites.has(b.id) ? 1 : 0) - (favorites.has(a.id) ? 1 : 0) || b.updatedAt - a.updatedAt);
    else if (sortKey === 'rated')
        sorted.sort((a, b) => ((ratings[b.id] && ratings[b.id].stars) || 0) - ((ratings[a.id] && ratings[a.id].stars) || 0) || b.updatedAt - a.updatedAt);
    else
        sorted.sort((a, b) => b.updatedAt - a.updatedAt); // 'mostRead' has no real data yet — falls back to newest
    const newReleases = [...books].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
    const selectedBook = selectedBookId
        ? (books.find((b) => b.id === selectedBookId)
            || (remoteInitialBook && remoteInitialBook.id === selectedBookId ? remoteInitialBook : null)
            || remoteShelfBooksById[selectedBookId]
            || null)
        : null;
    // Correct this device's local follow map against the real `follows` row whenever a book with
    // a real authorId is opened — catches a follow made from a different device, without ever
    // downgrading an existing local "following" state on a failed/offline read.
    useEffect(() => {
        if (!selectedBook || !selectedBook.authorId) return;
        let cancelled = false;
        isFollowingRemote(selectedBook.authorId).then((remote) => {
            if (cancelled || !remote) return;
            const key = authorKeyFor(selectedBook.author);
            setFollowingMap((prev) => {
                if (prev[key]) return prev;
                const next = { ...prev, [key]: true };
                writeAuthorFollowMap(AUTHOR_FOLLOWS_KEY, next);
                return next;
            });
        }).catch(() => {});
        return () => { cancelled = true; };
    }, [selectedBook && selectedBook.id, selectedBook && selectedBook.authorId]);
    // Exactly one Featured Chronicle at a time (see FeaturedChronicleCard) — the reader's own
    // top-rated pick if they've rated anything, otherwise whatever's newest. Nothing renders at
    // all once there's nothing published yet.
    const featuredBook = ratedBooks[0] || newReleases[0] || null;
    // Featured Creators — every distinct author with at least one published book, most-published
    // first, each with a real Follow toggle (same AUTHOR_FOLLOWS_KEY as their own Hall page).
    const creatorTally = new Map();
    books.forEach((b) => {
        const key = authorKeyFor(b.author);
        if (!creatorTally.has(key))
            creatorTally.set(key, { name: b.author, count: 0 });
        creatorTally.get(key).count += 1;
    });
    const featuredCreators = Array.from(creatorTally.values()).sort((a, b) => b.count - a.count).slice(0, 8);
    const quickActionProps = (book) => ({
        following: isFollowingAuthor(book.author), inCart: cart.some((it) => it.id === book.id),
        onToggleFollow: toggleFollowAuthor, onBuy: addToCart, onTip: openTip, onDiscuss: openDiscuss,
    });
    const topBar = React.createElement("div", { className: "gl-topbar" },
        React.createElement("div", { className: "gl-topbar-search" },
            React.createElement(InkIcon, { name: "search", size: 15, color: "#7A7A82" }),
            React.createElement("input", { type: "text", value: search, onChange: (e) => setSearch(e.target.value), placeholder: "Search title, author, genre, or guild\u2026" })),
        React.createElement("div", { style: { flex: 1 } }),
        React.createElement("button", { className: "gl-topbar-icon", title: "Cart", onClick: openCart },
            React.createElement(InkIcon, { name: "cart", size: 17 }), cart.length > 0 && React.createElement("span", { className: "gl-topbar-badge" }, cart.length)),
        onOpenInbox && React.createElement("button", { className: "gl-topbar-icon", title: "Notifications & Inbox", onClick: onOpenInbox },
            React.createElement(InkIcon, { name: "bell", size: 17 }), inboxUnreadCount > 0 && React.createElement("span", { className: "gl-topbar-badge" }, inboxUnreadCount)));
    const featuredEl = featuredBook && React.createElement(FeaturedChronicleCard, Object.assign({
        book: featuredBook, myRating: ratings[featuredBook.id],
        onRead: () => { recordBookReadStart(featuredBook.id, BOOK_VIEW_SOURCES.FEATURED); onRead(featuredBook.id); },
        onViewDetails: () => openBook(featuredBook.id, featuredBook.title, BOOK_VIEW_SOURCES.FEATURED),
        onOpenAuthor: openAuthorProfile,
        onRate: () => openBook(featuredBook.id, featuredBook.title, BOOK_VIEW_SOURCES.FEATURED),
        onSample: () => openBook(featuredBook.id, featuredBook.title, BOOK_VIEW_SOURCES.FEATURED),
    }, quickActionProps(featuredBook)));
    const newReleasesShelf = React.createElement(GrandLibraryShelfRow, {
        icon: React.createElement(InkIcon, { name: "sparkle", size: 15 }), label: "New Releases", note: newReleases.length ? "Freshly published or updated chronicles" : null,
        books: newReleases, onSelectBook: (b) => openBook(b.id, b.title, BOOK_VIEW_SOURCES.NEW_RELEASES),
        emptyText: discoverLoading ? "Loading the Grand Library\u2019s latest releases\u2026" : "No books published yet.",
    });
    const trendingShelf = React.createElement(GrandLibraryShelfRow, {
        icon: React.createElement(InkIcon, { name: "flame", size: 15 }), label: "Trending",
        note: trendingBooks.length ? "What readers have been opening the last few days" : null,
        books: trendingBooks, onSelectBook: (b) => openBook(b.id, b.title, BOOK_VIEW_SOURCES.TRENDING),
        emptyText: "Nothing's trending yet \u2014 check back once a few readers have been opening the same books recently.",
    });
    const highestRatedShelf = React.createElement(GrandLibraryShelfRow, {
        icon: React.createElement(InkIcon, { name: "star", size: 15 }), label: "Highest Rated", note: ratedBooks.length ? "Based on your own ratings" : null,
        books: ratedBooks, onSelectBook: (b) => openBook(b.id, b.title, BOOK_VIEW_SOURCES.TOP_RATED),
        emptyText: "Rate a book below and it'll rise here \u2014 public ratings from every reader are coming soon.",
    });
    const worldbuildingPacksSection = React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "package", size: 15 }), label: "Worldbuilding Packs", note: publishedPacks.length ? "Lore, characters, and locations \u2014 shared on their own" : null }),
        publishedPacks.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, "No Worldbuilding Packs published yet.")
            : React.createElement("div", { className: "ink-grid-cards" },
                publishedPacks.map((pack) => React.createElement(WorldbuildingPackLibraryCard, { key: `${pack.projectId}:${pack.id}`, pack, onOpen: () => openPack(`${pack.projectId}:${pack.id}`, pack.title) }))));
    const mostReadShelf = React.createElement(GrandLibraryShelfRow, {
        icon: React.createElement(InkIcon, { name: "chart", size: 15 }), label: "Most Read",
        note: mostReadBooks.length ? "Verified reader-open activity across every author, recency-weighted" : null,
        books: mostReadBooks, onSelectBook: (b) => openBook(b.id, b.title, BOOK_VIEW_SOURCES.MOST_READ),
        emptyText: "No verified reading activity yet \u2014 check back once readers start opening published books.",
    });
    // Templates/Add-ons shelves, real now (audit finding #2) — same LibrarySectionHeading +
    // ink-grid-cards layout worldbuildingPacksSection above already uses, since these are the
    // same shape of thing: browse, then a single-click "Add" rather than a detail modal (see
    // TemplateLibraryCard/AddonLibraryCard's own comment for why neither needs one).
    const templatesShelf = React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "puzzle", size: 15 }), label: "Templates", note: discoverTemplates.length ? "Outline, beat-sheet, and series-bible templates from other writers" : null }),
        discoverTemplates.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, "No shared templates yet.")
            : React.createElement("div", { className: "ink-grid-cards" },
                discoverTemplates.map((t) => React.createElement(TemplateLibraryCard, {
                    key: t.id, template: t, added: myTemplates.some((m) => m.id === t.id), onAdd: () => handleAddTemplate(t),
                }))));
    const addonsShelf = React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "sparkle", size: 15 }), label: "Add-ons", note: discoverAddons.length ? "Covers, dividers, and other flourishes from other writers" : null }),
        discoverAddons.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, "No shared add-ons yet.")
            : React.createElement("div", { className: "ink-grid-cards" },
                discoverAddons.map((a) => React.createElement(AddonLibraryCard, {
                    key: a.id, addon: a, added: myAddons.some((m) => m.id === a.id), onAdd: () => handleAddAddon(a),
                }))));
    const editorsChoiceShelf = React.createElement(ComingSoonShelf, { icon: React.createElement(InkIcon, { name: "medal", size: 15 }), label: "Editor's Choice", description: "Hand-picked by Inkroot's editors \u2014 coming soon." });
    const guildAnthologiesShelf = React.createElement(ComingSoonShelf, { icon: React.createElement(InkIcon, { name: "castle", size: 15 }), label: "Guild Anthologies", description: "Curated shelves from Guilds across the Grand Library \u2014 coming soon." });
    const hallOfLegendsShelf = React.createElement(ComingSoonShelf, { icon: React.createElement(InkIcon, { name: "crown", size: 15 }), label: "Hall of Legends", description: "Chronicles recognized across the whole community \u2014 coming soon." });
    const featuredCreatorsSection = React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "users", size: 15 }), label: "Featured Creators", note: featuredCreators.length ? "Writers with something published in the Grand Library" : null }),
        featuredCreators.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, "No creators published yet.")
            : React.createElement("div", { className: "gl-shelf-scroll" },
                featuredCreators.map((c) => React.createElement("div", { key: c.name, className: "gl-shelf-item", style: { width: 108 } },
                    React.createElement("div", { onClick: () => openAuthorProfile(c.name), style: {
                            width: 64, height: 64, margin: '0 auto', borderRadius: '50%', cursor: 'pointer',
                            background: 'linear-gradient(160deg, #3C2A18, #241407)', border: '2px solid rgba(232,196,104,0.35)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], color: '#E8C468',
                        } }, (c.name || '?')[0].toUpperCase()),
                    React.createElement(LibraryAuthorLink, { author: c.name, onOpenAuthor: openAuthorProfile }),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 2 } }, `${c.count} work${c.count === 1 ? '' : 's'}`),
                    React.createElement("button", { onClick: () => toggleFollowAuthor(c.name), style: {
                            marginTop: 6, width: '100%', background: isFollowingAuthor(c.name) ? 'rgba(232,196,104,0.14)' : 'none',
                            border: '1px solid #3A3020', color: isFollowingAuthor(c.name) ? '#E8C468' : '#A6A6AD',
                            borderRadius: RADIUS_SCALE[999], padding: '4px 8px', fontSize: TYPE_SCALE[10.5], cursor: 'pointer', fontWeight: 600,
                        } }, isFollowingAuthor(c.name) ? "\u2713 Following" : "\u2795 Follow")))));
    const discussionHallsSection = React.createElement("div", { style: { marginBottom: 30 } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "chat", size: 15 }), label: "Book Discussion Halls", note: "Real, live conversations \u2014 shared with every reader" }),
        discussedBooks.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px' } }, "No discussions yet \u2014 open a book and start one.")
            : React.createElement("div", { className: "gl-shelf-scroll" },
                discussedBooks.map((book) => { const count = discussedPostCounts[book.id] || 0; return React.createElement("div", { key: book.id, className: "gl-shelf-item", style: { width: 150, textAlign: 'left', cursor: 'pointer' }, onClick: () => openDiscuss(book) },
                    React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[13], fontWeight: 600, color: '#EFE7D2' } }, book.title || 'Untitled Novel'),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 4 } }, `${count} post${count === 1 ? '' : 's'}`)); })));
    const browseSearchSection = React.createElement("div", { style: { marginTop: 8, paddingTop: 22, borderTop: '1px solid #2A2417' } },
        React.createElement(LibrarySectionHeading, { icon: React.createElement(InkIcon, { name: "search", size: 15 }), label: "Browse & Search" }),
        genresPresent.length > 1 && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', justifyContent: 'center', marginBottom: 10, marginTop: 8 } },
            genresPresent.map((g) => React.createElement("button", { key: g, onClick: () => setGenreFilter(g), style: {
                    background: genreFilter === g ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'none',
                    border: '1px solid #3A3020', color: genreFilter === g ? '#E8C468' : '#A6A6AD',
                    borderRadius: RADIUS_SCALE[999], padding: '5px 11px', fontSize: TYPE_SCALE[11], cursor: 'pointer',
                } }, g === 'all' ? 'All categories' : g))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' } }, "Free books can be read in full right away \u2014 a priced book unlocks in full once you buy it, sending money straight to its author"),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', justifyContent: 'center', marginBottom: 10 } },
            LIBRARY_SORTS.map((s) => React.createElement("button", { key: s.key, onClick: () => setSortKey(s.key), style: {
                    background: sortKey === s.key ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'none',
                    border: '1px solid #3A3020', color: sortKey === s.key ? '#E8C468' : '#A6A6AD',
                    borderRadius: RADIUS_SCALE[999], padding: '6px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                } }, s.label))),
        sortKey === 'mostRead' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', textAlign: 'center', marginBottom: 14, fontStyle: 'italic' } }, "no reading-count data tracked yet \u2014 showing newest first"),
        sortKey === 'rated' && ratedBooks.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', textAlign: 'center', marginBottom: 14, fontStyle: 'italic' } }, "no ratings yet \u2014 showing newest first"),
        sorted.length === 0
            ? React.createElement(EmptyState, { text: discoverLoading ? "Loading the Grand Library\u2019s published books\u2026" : (books.length === 0 ? "No books published yet \u2014 switch to Creator Studio to publish your first one." : "No books match that search.") })
            : React.createElement(LibraryBookcase, { items: sorted.map((book) => ({
                key: book.id,
                content: React.createElement(LibraryDiscoverCard, Object.assign({
                    book, isFavorite: favorites.has(book.id), onToggleFavorite: toggleFavorite,
                    onRead: (id) => { recordBookReadStart(id, BOOK_VIEW_SOURCES.DISCOVER); onRead(id); },
                    onPreview: () => openBook(book.id, book.title, BOOK_VIEW_SOURCES.DISCOVER), myRating: ratings[book.id], onOpenAuthor: openAuthorProfile,
                }, quickActionProps(book))),
            })) }));
    const selectedBookModal = selectedBook && React.createElement(BookDetailModal, Object.assign({
        book: selectedBook, isFavorite: favorites.has(selectedBook.id), onToggleFavorite: toggleFavorite,
        myRating: ratings[selectedBook.id], onSetRating: handleSetRating,
        onReadFull: (id) => { recordBookReadStart(id, selectedBookSource); nav.pop(); onRead(id); }, onClose: closeBook, onOpenAuthor: openAuthorProfile,
    }, quickActionProps(selectedBook)));
    const selectedPackModal = selectedPack && React.createElement(WorldbuildingPackDetailModal, { pack: selectedPack, onClose: closePack });
    const cartDrawerModal = cartOpen && React.createElement(CartDrawer, {
        items: cart, onClose: closeCart, onRemove: removeFromCart,
        // FIX — used to call closeCart() manually here before openBook(). openBook() already
        // calls closeAnyOpenOverlay() itself (see its definition above), but this closure's
        // `cartOpen` is still true at this point in the same tick (the setCartOpen(false) from
        // that manual closeCart() hasn't re-rendered yet), so closeAnyOpenOverlay() saw cartOpen
        // still true and called closeCart() a SECOND time — popping the nav stack one level too
        // far. That's what kept the overlap/stuck-close-button bug alive even after openBook
        // started enforcing "one overlay at a time": the nav stack drifted out of sync with what
        // was actually on screen every time a book was opened from inside the Cart, and later
        // Back/close presses acted on the wrong entry. openBook() alone already closes the Cart
        // correctly — no separate call needed.
        onOpenBook: (id) => { const b = books.find((bk) => bk.id === id); if (b) openBook(b.id, b.title, BOOK_VIEW_SOURCES.CART); },
    });
    const tipModal = tipBook && React.createElement(TipAuthorModal, { book: tipBook, onClose: closeTip, onOpenAuthor: openAuthorProfile });
    const discussModal = discussBook && React.createElement(DiscussionHallModal, { book: discussBook, onClose: closeDiscuss });
    const readerView = React.createElement(React.Fragment, null,
        React.createElement(GrandLibraryShelfStyles, null),
        topBar, featuredEl, newReleasesShelf, trendingShelf, highestRatedShelf, worldbuildingPacksSection,
        mostReadShelf, templatesShelf, addonsShelf, editorsChoiceShelf, guildAnthologiesShelf, hallOfLegendsShelf,
        featuredCreatorsSection, discussionHallsSection, browseSearchSection,
        selectedBookModal, selectedPackModal, cartDrawerModal, tipModal, discussModal);
    // Author Studio's 'studio' mode now renders the full Creator Dashboard (see CreatorDashboard
    // above) — same underlying project/pack data and Publishing Wizard wiring as before, just with
    // a proper identity header, overview cards, and an eight-tab layout in place of the single
    // scrolling list this used to be.
    const studioView = React.createElement(CreatorDashboard, {
        projects, writerProfile, writerRank, writerReputation, writerGuildName,
        onOpen, onRead, onSetPublishStatus, onOpenPacks, onSetPackPublishStatus,
        onOpenPublishWizard: openPublishWizard,
    });
    return React.createElement(GrandLibraryAtmosphere, null,
        React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2', textShadow: '0 0 18px rgba(232,196,104,0.25)' } }, "The Grand Library"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#B9AE8F', marginTop: 6, marginBottom: 34, fontStyle: 'italic' } }, "Publish, discover, and manage every chronicle, all in one hall")),
        React.createElement("div", { style: {
                position: 'sticky', top: 84, zIndex: 20,
                display: 'flex', gap: SPACE_SCALE[4], background: 'linear-gradient(160deg, #2A2115, #17130E)', border: '1px solid #4A3D22',
                borderRadius: RADIUS_SCALE[12], padding: 4, marginBottom: 28, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 6px 18px rgba(0,0,0,0.35)',
            } },
            React.createElement("button", { onClick: () => { closeAnyOpenOverlay(); setMode('reader'); }, style: {
                    flex: 1, border: 'none', cursor: 'pointer', borderRadius: RADIUS_SCALE[9], padding: '10px 12px',
                    fontSize: TYPE_SCALE[13], fontWeight: 600, letterSpacing: '0.03em',
                    background: mode === 'reader' ? 'linear-gradient(160deg, #3A2F1C, #241E12)' : 'transparent',
                    color: mode === 'reader' ? '#E8C468' : '#8A8272',
                    boxShadow: mode === 'reader' ? 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 14px rgba(232,196,104,0.32)' : 'none',
                    transition: 'background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease)',
                } }, "Discover"),
            React.createElement("button", { onClick: () => { closeAnyOpenOverlay(); setMode('studio'); }, style: {
                    flex: 1, border: 'none', cursor: 'pointer', borderRadius: RADIUS_SCALE[9], padding: '10px 12px',
                    fontSize: TYPE_SCALE[13], fontWeight: 600, letterSpacing: '0.03em',
                    background: mode === 'studio' ? 'linear-gradient(160deg, #3A2F1C, #241E12)' : 'transparent',
                    color: mode === 'studio' ? '#E8C468' : '#8A8272',
                    boxShadow: mode === 'studio' ? 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 14px rgba(232,196,104,0.32)' : 'none',
                    transition: 'background var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease), box-shadow var(--ink-dur) var(--ink-ease)',
                } }, "Creator Studio")),
        mode === 'reader' ? readerView : studioView,
        publishWizard && (() => {
            const wizProject = projects.find((p) => p.id === publishWizard.projectId);
            return wizProject && React.createElement(PublishingWizard, {
                project: wizProject, initialTarget: { type: publishWizard.type, packId: publishWizard.packId }, writerGuildName,
                onClose: closePublishWizard,
                onPublishBook: (destination, details) => onPublishBookWithDetails(publishWizard.projectId, destination, details),
                onPublishPack: (packId, destination, details) => onPublishPackWithDetails(publishWizard.projectId, packId, destination, details),
            });
        })(),
        followNotice && React.createElement(AlertDialog, { title: followNotice.title, message: followNotice.message, onClose: () => setFollowNotice(null) }));
}
