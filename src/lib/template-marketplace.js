import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames, fetchVerifiedIds } from './profile.js';
import { sanitizeError } from './errors.js';

// Real backend for the Template marketplace (migration 87, fix-tracker item 22) — same shape as
// lib/addon-marketplace.js: standalone, device-global items, no project scoping, no gated-
// content split, no purchase step (see migration 87's header). `payload` carries whichever
// type-specific fields templates.jsx's own emptyTemplate()/FIELD_SETS define for that type.

export async function publishTemplateRemote({ id, type, name, payload }) {
  const user = await currentUser();
  if (!user) return null; // not signed in — stays local-only, same as an addon/book/pack
  const { error } = await supabase.from('published_templates').upsert({
    id,
    author_id: user.id,
    type,
    name,
    payload: payload || {},
    updated_at: new Date().toISOString(),
  });
  if (error) throw sanitizeError(error);
  return true;
}

export async function unpublishTemplateRemote(id) {
  const user = await currentUser();
  if (!user) return null;
  const { error } = await supabase.from('published_templates').delete().eq('id', id).eq('author_id', user.id);
  if (error) throw sanitizeError(error);
  return true;
}

// Every publicly published template across every author — the template equivalent of
// fetchDiscoverAddons.
export async function fetchDiscoverTemplates({ limit } = {}) {
  const { data, error } = await supabase
    .from('published_templates')
    .select('id, author_id, type, name, payload, published_at')
    .order('published_at', { ascending: false })
    .limit(limit || 2000);
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const authorIds = rows.map((r) => r.author_id);
  const [names, verifiedIds] = await Promise.all([fetchProfileNames(authorIds), fetchVerifiedIds(authorIds)]);
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    payload: r.payload || {},
    author: names[r.author_id] || 'Unnamed Writer',
    authorVerified: verifiedIds.has(r.author_id),
    authorId: r.author_id,
    publishedAt: new Date(r.published_at).getTime(),
  }));
}
