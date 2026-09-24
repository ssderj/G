import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Real backend for Worldbuilding Packs (migration 85, fix-tracker item 20) — same thin
// client-wrapper shape as lib/library.js's book functions, split across discovery
// (published_packs — the directory a pack never had before this) and gated content
// (published_pack_content — full entry contents, unlocked by purchase; see that migration's own
// header for why this is gated where published_book_content deliberately isn't).

// ---------- Discovery / listing ----------

// Pushes (or updates) a pack's public listing. `id` is the same "<projectId>:<packKey>"
// composite string the Grand Library already uses locally as its pack key, so a remote row's id
// lines up with what the UI computes without a second id scheme. Called alongside
// publishPackContentRemote on every publish/re-publish, same pairing setPublishStatus already
// uses for a book's publishBookRemote/publishBookContentRemote.
// See the matching note above publishBookRemote in lib/library.js — Supabase's query builder
// resolves rather than rejects on a database-level error, so every mutation below now checks
// `error` and throws explicitly instead of letting a failed write look like a success to a
// `.catch()` upstream.
export async function publishPackRemote({ id, projectId, packKey, title, subtitle, description, genre, tags, coverImageUrl, price, categories, totalEntries, publishedAt }) {
  const user = await currentUser();
  if (!user) return null; // not signed in — stays a local-only publish, same as a book
  const { error } = await supabase.from('published_packs').upsert({
    id,
    author_id: user.id,
    project_id: projectId,
    pack_key: packKey,
    title,
    subtitle: subtitle || '',
    description: description || '',
    genre: genre || '',
    tags: tags || [],
    cover_image_url: coverImageUrl || '',
    price: price || 0,
    categories: categories || [],
    total_entries: totalEntries || 0,
    published_at: new Date(publishedAt || Date.now()).toISOString(),
    updated_at: new Date().toISOString(),
    // (Re)publishing always puts the pack back on offer — an earlier unpublish of a pack that had
    // owners only hid it (migration 118), and this upsert is what relists it.
    unlisted: false,
  });
  if (error) throw sanitizeError(error);
  return true;
}

// Whether this author already has a listing for pack `id` (live or unlisted). Pack twin of
// publishedBookExists in library.js: publish-flow.js uses it so a failed RE-publish never rolls back
// (i.e. takes down) a pack that was already live. Fails toward "exists" on any error or when signed
// out, because the safe outcome of a wrong guess is leaving a listing in place.
export async function publishedPackExists(id) {
  const user = await currentUser();
  if (!user) return true;
  const { data, error } = await supabase.from('published_packs').select('id').eq('id', id).eq('author_id', user.id).maybeSingle();
  if (error) return true;
  return !!data;
}

// Goes through unpublish_pack() (migration 118) rather than a plain DELETE: a pack nobody has bought
// or claimed is deleted; one that has owners is kept and hidden so they can still download it (a
// real DELETE cascaded away published_pack_content, the only copy buyers could fetch). Resolves
// `{ mode }` with 'deleted' | 'hidden' | 'none', or null when signed out; throws on a real failure.
export async function unpublishPackRemote(id) {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase.rpc('unpublish_pack', { p_pack_id: id });
  if (error) throw sanitizeError(error);
  return { mode: data || 'none' };
}

// Every publicly published Worldbuilding Pack across every author — the pack equivalent of
// fetchDiscoverBooks. Replaces grand-library-screen.jsx's old `projects.flatMap(...)`, which
// only ever showed this device's own local packs (see migration 85's header for the full
// finding). `id` is returned as the pack's own local key (pack_key), not the composite storage
// row id, so `${pack.projectId}:${pack.id}` keeps composing the same way for a remote-sourced
// pack as it already does for a local one.
export async function fetchDiscoverPacks({ limit } = {}) {
  const { data, error } = await supabase
    .from('published_packs')
    .select('id, author_id, project_id, pack_key, title, subtitle, description, genre, tags, cover_image_url, price, categories, total_entries, published_at')
    .eq('unlisted', false) // an author's own hidden (sold-then-unpublished) pack is readable by them but isn't Discover content
    .order('published_at', { ascending: false })
    .limit(limit || 2000);
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({
    id: r.pack_key,
    projectId: r.project_id,
    title: r.title,
    subtitle: r.subtitle || '',
    description: r.description || '',
    genre: r.genre || 'Unspecified',
    tags: r.tags || [],
    coverImageUrl: r.cover_image_url || '',
    price: typeof r.price === 'number' ? r.price : 0,
    categories: r.categories || [],
    totalEntries: r.total_entries || 0,
    author: names[r.author_id] || 'Unnamed Writer',
    authorVerified: verifiedIds.has(r.author_id),
    authorId: r.author_id,
    publishedAt: new Date(r.published_at).getTime(),
    updatedAt: new Date(r.published_at).getTime(),
    projectTitle: '', // no remote project-title lookup exists — the pack's own title/description stand alone, same as a book's do
  }));
}

// A single published_packs row by its composite storage id ("<projectId>:<packKey>") — used to
// resolve one specific known pack regardless of how it was reached, same role
// fetchPublishedBookById plays for a book.
export async function fetchPublishedPackById(id) {
  if (!id) return null;
  const { data, error } = await supabase
    .from('published_packs')
    .select('id, author_id, project_id, pack_key, title, subtitle, description, genre, tags, cover_image_url, price, categories, total_entries, published_at')
    .eq('id', id)
    .maybeSingle();
  if (error) throw sanitizeError(error);
  if (!data) return null;
  const [names, verifiedIds] = await Promise.all([fetchProfileNames([data.author_id]), fetchVerifiedIds([data.author_id])]);
  return {
    id: data.pack_key,
    projectId: data.project_id,
    title: data.title,
    subtitle: data.subtitle || '',
    description: data.description || '',
    genre: data.genre || 'Unspecified',
    tags: data.tags || [],
    coverImageUrl: data.cover_image_url || '',
    price: typeof data.price === 'number' ? data.price : 0,
    categories: data.categories || [],
    totalEntries: data.total_entries || 0,
    author: names[data.author_id] || 'Unnamed Writer',
    authorVerified: verifiedIds.has(data.author_id),
    authorId: data.author_id,
    publishedAt: new Date(data.published_at).getTime(),
  };
}

// ---------- Gated content (purchase required) ----------

// Mirrors a pack's full selected entries (every field, not just the name/snippet `categories`
// already carries) into published_pack_content. Called alongside publishPackRemote on every
// publish/re-publish — see ink-root.jsx's buildPublishedPackContent for how the payload is
// assembled from the owning project's own characters/locations/timeline/glossary/world arrays.
export async function publishPackContentRemote(id, content) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('published_pack_content').upsert({
    pack_id: id,
    content,
  });
  if (error) throw sanitizeError(error);
  return true;
}

// Whether the current reader may download a pack's full contents. Unlike checkBookReadAccess —
// where a price of 0 short-circuits straight to "allowed", since reading a book is free by
// product design — a pack's full content is always gated behind its own purchases row, price 0
// included: paystack-init-pack-purchase writes a `success` row for a free pack too (see that
// function and migration 85's header), so "free" and "owned" resolve to the same purchases
// check here rather than a separate price<=0 shortcut. Fails closed on any lookup error, same
// reasoning as checkBookReadAccess — never a silent bypass.
export async function checkPackDownloadAccess(packId) {
  try {
    const { data: pack, error: packError } = await supabase
      .from('published_packs')
      .select('price, author_id')
      .eq('id', packId)
      .maybeSingle();
    if (packError) throw sanitizeError(packError);
    if (!pack) return { allowed: false, price: null };
    const user = await currentUser();
    if (user && user.id === pack.author_id) return { allowed: true, price: pack.price || 0 };
    if (!user) return { allowed: false, price: pack.price || 0 }; // can't have purchased anything signed out
    const { data: purchase, error: purchaseError } = await supabase
      .from('purchases')
      .select('id')
      .eq('pack_id', packId)
      .eq('buyer_id', user.id)
      .eq('status', 'success')
      .limit(1)
      .maybeSingle();
    if (purchaseError) throw sanitizeError(purchaseError);
    return { allowed: !!purchase, price: pack.price || 0 };
  } catch (e) {
    console.warn('Inkroot: checkPackDownloadAccess failed', e);
    return { allowed: false, price: null };
  }
}

// The read side of the content mirror above — returns null on any failure, missing row, or an
// RLS denial (an un-purchased pack simply comes back empty rather than throwing), same "treat
// unavailable and errored the same way" posture fetchPublishedBookContent already takes.
export async function fetchPublishedPackContent(packId) {
  try {
    const { data, error } = await supabase
      .from('published_pack_content')
      .select('content')
      .eq('pack_id', packId)
      .maybeSingle();
    if (error) throw sanitizeError(error);
    return data ? data.content : null;
  } catch (e) {
    console.warn('Inkroot: fetchPublishedPackContent failed', e);
    return null;
  }
}
