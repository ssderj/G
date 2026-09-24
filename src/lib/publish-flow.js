import { publishBookRemote, unpublishBookRemote, publishBookContentRemote, publishedBookExists } from './library.js';
import { publishBookToGuildRemote, unpublishBookFromGuildRemote } from './library-guild.js';
import { publishPackRemote, unpublishPackRemote, publishPackContentRemote, publishedPackExists } from './worldbuilding-packs.js';

// ---------- Publishing reliability (fix-tracker item 27) ----------
//
// THE BUG THIS FILE FIXES: every publish/unpublish call site (ink-root.jsx's setPublishStatus /
// publishBookWithDetails / setPackPublishStatus / publishPackWithDetails, and — worse —
// project-workspace.jsx's handleSetPublishStatus / handleWizardPublishBook /
// handleSetPackPublishStatus / handleWizardPublishPack, which never made a single remote call at
// all) wrote the local "Published" status FIRST, then fired the remote listing/content/guild-shelf
// pushes afterward as non-blocking, uncaught promises (`.catch(e => console.warn(...))`). Three
// separate ways that produced a broken book:
//   1. The writer's own screen showed "Published" the instant the local write landed — before
//      Supabase had done anything at all, let alone finished.
//   2. lib/library.js's own mutation functions returned the Supabase query builder directly,
//      which resolves (never rejects) to `{ data, error }` on a normal database error — so even
//      the `.catch()` that WAS there could never fire for an RLS denial or constraint violation,
//      only for a dropped connection. See the notes added directly above each mutation.
//   3. If the listing (published_books) succeeded but the content mirror
//      (published_book_content) failed, nothing rolled the listing back — a reader anywhere but
//      the author's own device would find the book in the Grand Library/Guild Bookshelf, tap it,
//      and hit an empty/broken manuscript forever, with no local sign anything was wrong.
//
// THE FIX: publishBookRemoteFlow / publishPackRemoteFlow below run the listing and content
// mutations in sequence and AWAIT each one. A local "Published" write only happens in the
// caller once this whole flow resolves. If the content step fails after the listing step
// succeeded, the listing is rolled back (deleted) before the error is thrown, so a listing with
// no content is never left standing. The guild-shelf mirror is intentionally a step outside
// that contract — see the comment on it below.
export class PublishFlowError extends Error {}

function friendlyMessage(e, fallback) {
  return (e && e.message) ? e.message : fallback;
}

// Publishes a book's remote listing + manuscript content as one unit. Resolves `{ remote: true }`
// once both steps have actually succeeded, or `{ remote: false }` when there's no signed-in
// account to push to at all (the pre-existing, intentional local-only-publish fallback — see
// PublishingWizard's own sign-in warning). Throws a PublishFlowError, with the listing rolled
// back, if the content step fails after the listing step lands.
export async function publishBookRemoteFlow({ id, listing, content, destination, guildId }) {
  let listingCreated = false;
  // Checked BEFORE the upsert below — afterwards the listing always exists and the answer is lost.
  // A re-publish of a book that's already live (and may already have paying readers) must never be
  // "rolled back" by deleting it: see publishedBookExists in library.js.
  const alreadyListed = await publishedBookExists(id);
  try {
    const result = await publishBookRemote(listing);
    if (result === null) return { remote: false }; // not signed in — nothing was written, nothing to roll back
    listingCreated = true;
  } catch (e) {
    throw new PublishFlowError(friendlyMessage(e, "Couldn't reach Inkroot to publish the listing — nothing was published."));
  }

  try {
    const contentResult = await publishBookContentRemote(id, content);
    if (contentResult === null) {
      // The user's session must have dropped between the two calls above (publishBookRemote
      // just succeeded, so they were signed in a moment ago) — treated exactly like a thrown
      // error below: roll back the now-orphaned listing rather than silently accepting "no
      // content was written" as success just because nothing threw.
      throw new Error("Signed out partway through publishing — please sign back in and try again.");
    }
  } catch (e) {
    // The listing above is now an orphan — a book anyone could find but no one but the author
    // could ever open. Roll it back before surfacing the error, so the failed attempt never
    // leaves a half-published book standing.
    if (!alreadyListed) {
      await unpublishBookRemote(id).catch((rollbackErr) => console.warn('Inkroot: rollback of orphaned book listing failed', rollbackErr));
      throw new PublishFlowError(friendlyMessage(e, "Couldn't publish the manuscript content, so the listing was rolled back — nothing was left half-published."));
    }
    // Re-publish of an already-live book: the previous listing and its manuscript are still intact
    // and still being read/owned by real people, so nothing is deleted. Only the new edit failed.
    throw new PublishFlowError(friendlyMessage(e, "Couldn't publish your latest manuscript changes — the previously published manuscript is still live. Try publishing again."));
  }

  // Guild Bookshelf mirror — kept as a best-effort, non-blocking step on purpose (unlike the two
  // above): a failure here leaves the book correctly listed and fully readable via
  // published_books/published_book_content (the two tables the app's own read paths actually
  // check — see checkBookReadAccess/openReaderBook), just not yet mirrored onto the shared guild
  // shelf row. That's a lesser, retryable inconsistency — the next publish/re-publish attempt
  // naturally retries it — not a half-published book, so it doesn't roll back the two steps
  // above or block success.
  if (destination === 'guild' && guildId) {
    try { await publishBookToGuildRemote(guildId, listing); }
    catch (e) { console.warn('Inkroot: guild shelf publish failed (book itself published fine)', e); }
  } else {
    try { await unpublishBookFromGuildRemote(id); }
    catch (e) { console.warn('Inkroot: guild shelf removal failed', e); }
  }

  return { remote: !!listingCreated };
}

// What to tell an author whose Unpublish came back `mode: 'hidden'` (see unpublishBookRemoteFlow).
// Shown by the two Unpublish call sites (ink-root.jsx's setPublishStatus and project-workspace.jsx's
// handleSetPublishStatus) after the local status has been updated, in the same AlertDialog they
// already use for publish errors.
export const SOLD_BOOK_UNPUBLISHED_NOTICE = {
  title: 'Taken off sale',
  message: "Readers have already bought this book, so Inkroot keeps it for them: they can still read it (and download it, if you allowed downloads). It no longer appears in the Grand Library, search or rankings, and nobody new can buy it. Publish it again any time to put it back on sale.",
};

// Removes a book's remote listing. Resolves `{ remote: true, mode }` once the listing is actually
// gone or hidden, or `{ remote: false }` when signed out (nothing to remove remotely — the
// local-only unpublish proceeds exactly as it always did). `mode` is 'deleted' (nobody had paid, so
// the row was removed), 'hidden' (paying readers exist, so the listing is kept off-sale for them —
// migration 118) or 'none' (no listing existed). Throws if the remote call fails, so the caller can
// leave the local status untouched rather than claiming "Unpublished" while the listing (and its
// manuscript) is still live and world-readable.
export async function unpublishBookRemoteFlow(id) {
  let mode;
  try {
    const result = await unpublishBookRemote(id);
    if (result === null) return { remote: false };
    mode = result.mode;
  } catch (e) {
    throw new PublishFlowError(friendlyMessage(e, "Couldn't reach Inkroot to remove the listing — it's still published, so nothing was changed here either."));
  }
  // Best-effort — see publishBookRemoteFlow's own comment on why the guild mirror doesn't gate
  // success/failure the way the listing+content pair does.
  await unpublishBookFromGuildRemote(id).catch((e) => console.warn('Inkroot: guild shelf removal failed', e));
  return { remote: true, mode };
}

// Pack equivalent of publishBookRemoteFlow — a pack only ever publishes to Inkroot (no guild
// destination exists for packs yet), so this is just the listing+content pair with the same
// rollback-on-content-failure contract.
export async function publishPackRemoteFlow({ id, listing, content }) {
  let listingCreated = false;
  // Checked BEFORE the upsert, same as publishBookRemoteFlow: a failed RE-publish of a pack that is
  // already live (and may already have owners) must not roll that listing back.
  const alreadyListed = await publishedPackExists(id);
  try {
    const result = await publishPackRemote(listing);
    if (result === null) return { remote: false };
    listingCreated = true;
  } catch (e) {
    throw new PublishFlowError(friendlyMessage(e, "Couldn't reach Inkroot to publish the pack listing — nothing was published."));
  }

  try {
    const contentResult = await publishPackContentRemote(id, content);
    if (contentResult === null) {
      throw new Error("Signed out partway through publishing — please sign back in and try again.");
    }
  } catch (e) {
    if (!alreadyListed) {
      await unpublishPackRemote(id).catch((rollbackErr) => console.warn('Inkroot: rollback of orphaned pack listing failed', rollbackErr));
      throw new PublishFlowError(friendlyMessage(e, "Couldn't publish the pack's contents, so the listing was rolled back — nothing was left half-published."));
    }
    // Re-publish of an already-live pack: the previous listing and contents are intact and may be
    // owned by real people, so nothing is removed. Only the new edit failed.
    throw new PublishFlowError(friendlyMessage(e, "Couldn't publish your latest pack changes — the previously published pack is still live. Try publishing again."));
  }

  return { remote: !!listingCreated };
}

// Pack twin of SOLD_BOOK_UNPUBLISHED_NOTICE — see unpublishPackRemoteFlow.
export const SOLD_PACK_UNPUBLISHED_NOTICE = {
  title: 'Taken off offer',
  message: "People have already bought or claimed this pack, so Inkroot keeps it for them: they can still download it. It no longer appears in the Grand Library and nobody new can get it. Publish it again any time to put it back on offer.",
};

// Resolves `{ remote: true, mode }` where mode is 'deleted' | 'hidden' | 'none' (see
// unpublishPackRemote), or `{ remote: false }` when signed out.
export async function unpublishPackRemoteFlow(id) {
  let mode;
  try {
    const result = await unpublishPackRemote(id);
    if (result === null) return { remote: false };
    mode = result.mode;
  } catch (e) {
    throw new PublishFlowError(friendlyMessage(e, "Couldn't reach Inkroot to remove the pack listing — it's still published, so nothing was changed here either."));
  }
  return { remote: true, mode };
}
