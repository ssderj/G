import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Real backend for the Addon marketplace (migration 86, fix-tracker item 21) — same thin
// wrapper shape as lib/library.js and lib/worldbuilding-packs.js. Simpler than either: an addon
// is a standalone, device-global manifest already (no project scoping, no gated-content split,
// no purchase step — see migration 86's header for why), so this file is just
// publish/unpublish/browse.

export async function publishAddonRemote({ id, name, icon, description, category, version, manifestVersion, contains }) {
  const user = await currentUser();
  if (!user) return null; // not signed in — the addon stays local-only, same as a book/pack
  const { error } = await supabase.from('published_addons').upsert({
    id,
    author_id: user.id,
    name,
    icon: icon || '',
    description: description || '',
    category: category || '',
    version: version || '',
    manifest_version: manifestVersion || 1,
    contains: contains || {},
    updated_at: new Date().toISOString(),
  });
  if (error) throw sanitizeError(error);
  return true;
}

export async function unpublishAddonRemote(id) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('published_addons').delete().eq('id', id).eq('author_id', user.id);
  if (error) throw sanitizeError(error);
  return true;
}

// Every publicly published addon across every author — the addon equivalent of
// fetchDiscoverBooks/fetchDiscoverPacks.
export async function fetchDiscoverAddons({ limit } = {}) {
  const { data, error } = await supabase
    .from('published_addons')
    .select('id, author_id, name, icon, description, category, version, manifest_version, contains, published_at')
    .order('published_at', { ascending: false })
    .limit(limit || 2000);
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    icon: r.icon || '',
    description: r.description || '',
    category: r.category || 'Other',
    version: r.version || '',
    manifestVersion: r.manifest_version || 1,
    contains: r.contains || {},
    author: names[r.author_id] || 'Unnamed Writer',
    authorVerified: verifiedIds.has(r.author_id),
    authorId: r.author_id,
    publishedAt: new Date(r.published_at).getTime(),
  }));
}
