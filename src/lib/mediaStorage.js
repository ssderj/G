import { supabase, currentUser, isSupabaseConfigured } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Two buckets, not one -- see schema_phase9.sql's header for why. 'media' is a public bucket
// (avatars/guild-crests/book-covers: meant to be publicly readable). 'media-private' is a
// genuinely non-public bucket holding only 'project-images' -- those belong to a project's own
// JSON in kv_store and are private by default everywhere else in this app. A public bucket's
// objects are servable through an unauthenticated public route regardless of any RLS policy, so
// putting private content in the public bucket behind only an RLS policy (an earlier version of
// this module did exactly that) never actually made it private -- it has to live in a bucket
// that has no public route at all.
const PUBLIC_BUCKET = 'media';
const PRIVATE_BUCKET = 'media-private';

// Folders whose objects live in PRIVATE_BUCKET rather than PUBLIC_BUCKET. 'project-images' holds
// in-manuscript images (character portraits, location photos, map backgrounds); avatars/
// guild-crests/book-covers are deliberately public (that's the whole point of an avatar or a
// book cover), so they're not in this set.
const PRIVATE_FOLDERS = new Set(['project-images']);

function bucketForFolder(folder) {
  return PRIVATE_FOLDERS.has(folder) ? PRIVATE_BUCKET : PUBLIC_BUCKET;
}

// How long a signed URL for a private-folder object stays valid before it needs re-signing.
// Generous on purpose -- a project can sit unopened for a long stretch between edits (see
// syncEngine.js's own offline-first philosophy), and there's no refresh-on-load wiring yet (see
// the note on getFreshProjectImageUrl below), so a short TTL would mean images going dark on a
// writer's own draft after a routine gap rather than only on genuine long-term inactivity.
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 180; // ~180 days

// Identifies an image's real type from its magic bytes, never from a data URL's own
// (client-supplied, unverified) `data:<mime>;base64,` header -- that header is just text the
// caller wrote, so trusting it would mean whatever content-type gets set on the uploaded object
// (and served back to every viewer of a public-bucket URL) is whatever the caller *claimed*, not
// what the bytes actually are. Returns null for anything that isn't one of the three formats this
// module ever produces (readLocalImageFile only ever compresses to jpeg/png/webp via canvas), so
// a data URL that doesn't start with a real image signature never reaches Storage at all -- see
// its caller in uploadImageDataUrl below, which treats null the same as any other upload failure
// and falls back to keeping the image inline, exactly as it already does for a Storage error.
function sniffImageMime(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'image/webp';
  }
  return null;
}

// Returns { blob, mime } with `mime` always the sniffed (real) type, or null if the bytes don't
// match any format this module accepts -- see sniffImageMime above for why the header is never
// trusted for this.
function dataUrlToBlob(dataUrl) {
  const [, base64] = dataUrl.split(',');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const mime = sniffImageMime(bytes);
  if (!mime) return null;
  return { blob: new Blob([bytes], { type: mime }), mime };
}

function extensionForMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

// Extracts the bucket + object path out of either URL shape this module hands back -- a public
// URL (`/storage/v1/object/public/<bucket>/<path>`) or a signed URL
// (`/storage/v1/object/sign/<bucket>/<path>?token=...`) -- checking both known buckets. Returns
// null for anything else (a local data URL, a pasted external URL, an empty string, ...).
function parseStorageUrl(url) {
  if (!url) return null;
  for (const bucket of [PUBLIC_BUCKET, PRIVATE_BUCKET]) {
    for (const kind of ['public', 'sign']) {
      const marker = `/storage/v1/object/${kind}/${bucket}/`;
      const idx = url.indexOf(marker);
      if (idx !== -1) return { bucket, path: url.slice(idx + marker.length).split('?')[0] };
    }
  }
  return null;
}

// Path-only convenience wrapper for callers (isUploadedMediaUrl, refreshProjectImageUrls) that
// only need to know whether a value is one of our own storage URLs, or need the path but not the
// bucket it currently happens to live in.
function pathFromStorageUrl(url) {
  return parseStorageUrl(url)?.path ?? null;
}

// Uploads an already-compressed image (a data URL from readLocalImageFile) to the signed-in
// writer's own folder in Supabase Storage (see schema_phase9.sql) and returns a URL for it --
// a public URL for a public folder (avatars/guild-crests/book-covers), or a signed URL for
// 'project-images', which has no public-read policy to serve a public URL from at all (see
// schema_phase9.sql). Returns null when signed out, offline, unconfigured, or the upload/signing
// fails for any reason -- every caller falls back to storing the data URL itself instead, same
// offline-first, never-block-on-a-failed-remote-step philosophy as the rest of the sync layer
// (syncEngine.js, library.js): local editing keeps working exactly as it always did either way.
export async function uploadImageDataUrl(dataUrl, folder) {
  if (!isSupabaseConfigured || !dataUrl) return null;
  const user = await currentUser();
  if (!user) return null;
  try {
    const decoded = dataUrlToBlob(dataUrl);
    if (!decoded) throw new Error('Unrecognized image data');
    const { blob, mime } = decoded;
    const ext = extensionForMime(mime);
    const path = `${folder}/${user.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const bucket = bucketForFolder(folder);
    const { error } = await supabase.storage.from(bucket).upload(path, blob, {
      contentType: mime,
      upsert: false,
    });
    if (error) throw sanitizeError(error);

    if (PRIVATE_FOLDERS.has(folder)) {
      const { data, error: signError } = await supabase.storage.from(bucket).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
      if (signError) throw sanitizeError(signError);
      return (data && data.signedUrl) || null;
    }
    const { data } = supabase.storage.from(bucket).getPublicUrl(path);
    return (data && data.publicUrl) || null;
  } catch (e) {
    console.warn('Inkroot: image upload to storage failed, falling back to inline image.', e);
    return null;
  }
}

// Re-signs a 'project-images' URL that's expired or about to -- the signed URL
// uploadImageDataUrl returned is only valid for SIGNED_URL_TTL_SECONDS, unlike every other
// folder's public URL, which never expires. Returns the original value unchanged for anything
// that isn't one of our own signed project-image URLs (a data URL, a public avatar/crest/cover
// URL, a pasted external URL, ...), so it's always safe to call on any stored image value.
//
// Called by refreshProjectImageUrls below, which is wired into ProjectWorkspace's own load
// effect (see project-workspace.jsx) -- the "natural next step" this module used to just flag
// and leave undone. Until a project is opened again after this was wired in, an image stays
// readable for the full 180-day TTL and then needs re-uploading (see
// 09_migration_scope_project_media_private.sql's note on existing data) -- degrading to a broken
// image rather than a security hole, since the alternative (a longer or unlimited TTL) would
// undermine the whole point of this folder being private.
//
// Always signs against PRIVATE_BUCKET regardless of which bucket the URL being refreshed
// actually names -- this is what lets a project still holding an old signed URL from before the
// 'media' / 'media-private' split (see schema_phase9.sql's header and
// 12_migration_split_private_media_bucket.sql) heal itself automatically: once
// scripts/move-project-images-to-private-bucket.mjs has copied that object over to
// PRIVATE_BUCKET at the same path, the next half-life refresh signs the *new* location and
// overwrites the stale URL via applyImageUrlPatches, with no per-project manual re-save needed.
export async function getFreshProjectImageUrl(url) {
  if (!isSupabaseConfigured || !url) return url;
  const path = pathFromStorageUrl(url);
  if (!path || !path.startsWith('project-images/')) return url;
  try {
    const { data, error } = await supabase.storage.from(PRIVATE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL_SECONDS);
    if (error) throw sanitizeError(error);
    return (data && data.signedUrl) || url;
  } catch (e) {
    console.warn('Inkroot: failed to refresh a project image URL.', e);
    return url;
  }
}

// Reads (never verifies -- there's no need, this only ever inspects a token this same project
// already holds) the `exp`/`iat` claims out of a Supabase Storage signed URL's own JWT, to decide
// whether it's actually worth spending a re-sign round trip on. Mirrors the "past the halfway
// point of its TTL" policy getFreshProjectImageUrl's own comment always intended -- refreshing
// every image on every project open would work but wastes a Storage call on images that don't
// need one yet. Fails open (treats an unreadable token as needing refresh) rather than silently
// skipping a refresh that turns out to have been needed -- an extra Storage call is harmless,
// a project image quietly going dark later is not.
function isPastHalfLife(signedUrl) {
  try {
    const token = new URL(signedUrl).searchParams.get('token');
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { iat, exp } = JSON.parse(atob(payload));
    if (!iat || !exp) return true;
    return Date.now() / 1000 >= iat + (exp - iat) / 2;
  } catch (e) {
    return true;
  }
}

// Walks a project's entire JSON tree (same generic, fixed-list-free shape as
// optimizeProjectImages in image-utils.jsx) looking for any embedded 'project-images' signed URL
// past the halfway point of its TTL, and re-signs it. Read-only -- returns the *paths* that need
// updating rather than a modified copy of the project, so the caller can apply them against
// whatever the current project state actually is by the time this resolves (see
// applyImageUrlPatches below and its use in project-workspace.jsx) instead of risking clobbering
// an edit the writer made while this was still in flight.
export async function refreshProjectImageUrls(project) {
  if (!isSupabaseConfigured) return [];
  const patches = [];
  async function walk(node, path) {
    if (!node || typeof node !== 'object') return;
    const keys = Array.isArray(node) ? node.map((_, i) => i) : Object.keys(node);
    for (const k of keys) {
      const v = node[k];
      const childPath = path.concat(k);
      if (typeof v === 'string') {
        const objPath = pathFromStorageUrl(v);
        if (objPath && objPath.startsWith('project-images/') && isPastHalfLife(v)) {
          const fresh = await getFreshProjectImageUrl(v);
          // oldValue records exactly what this patch was computed from, so applyImageUrlPatches
          // can confirm the field hasn't moved on (deleted or overwritten) before writing to it.
          if (fresh !== v) patches.push({ path: childPath, value: fresh, oldValue: v });
        }
      } else if (v && typeof v === 'object') {
        await walk(v, childPath);
      }
    }
  }
  await walk(project, []);
  return patches;
}

// Applies the path/value pairs refreshProjectImageUrls returned onto a (possibly since-edited)
// project, without touching anything else -- a plain, deep-clone-then-set patch rather than a
// wholesale replace, so it's safe to apply against whatever `project` state holds by the time the
// refresh call above resolves.
//
// Two things can have changed underneath a patch between when it was computed and when it's
// applied here, since this runs inside a setProject updater and `project` may be newer than the
// snapshot refreshProjectImageUrls walked:
//   1. The field's containing character/location/map may have been deleted, so walking `path`
//      into the current tree can bottom out on undefined/null before reaching the leaf.
//   2. The field may still exist but now hold a different image (the writer re-uploaded while
//      the refresh was in flight), in which case the patch's `value` is a freshly-signed copy of
//      a URL that's no longer current and must not overwrite it.
// Defensive traversal handles (1) by bailing out on that single patch instead of throwing.
// Compare-and-swap against `oldValue` handles (2) by only writing when the current value still
// matches what the patch was computed from.
export function applyImageUrlPatches(project, patches) {
  if (!patches || !patches.length) return project;
  const clone = structuredClone(project);
  for (const { path, value, oldValue } of patches) {
    let node = clone;
    let reachable = true;
    for (let i = 0; i < path.length - 1; i++) {
      if (node == null) { reachable = false; break; }
      node = node[path[i]];
    }
    if (!reachable || node == null) continue; // target's container is gone -- skip this patch
    const key = path[path.length - 1];
    if (node[key] !== oldValue) continue; // field moved on since the patch was computed -- skip
    node[key] = value;
  }
  return clone;
}

// Best-effort cleanup of a previously uploaded image, given its public or signed URL -- called
// whenever a caller replaces or clears an avatar/crest/cover/project image, so old objects don't
// just accumulate in a bucket forever. Never throws. A no-op for anything that isn't actually one
// of our own PUBLIC_BUCKET/PRIVATE_BUCKET URLs (a leftover local data URL from before this phase,
// an empty string, ...) -- there's nothing to remove in that case, not an error.
export async function deleteUploadedImage(url) {
  if (!isSupabaseConfigured || !url) return;
  const parsed = parseStorageUrl(url);
  if (!parsed) return;
  try {
    await supabase.storage.from(parsed.bucket).remove([parsed.path]);
  } catch (e) {
    console.warn('Inkroot: failed to remove old uploaded image.', e);
  }
}

// True for a URL this module produced (public or signed) -- vs. a local base64 data URL or a
// pasted external URL. Lets a caller decide whether an existing stored value is even worth
// passing to deleteUploadedImage/getFreshProjectImageUrl in the first place, without needing to
// duplicate the URL-shape check above.
export function isUploadedMediaUrl(url) {
  return pathFromStorageUrl(url) !== null;
}
