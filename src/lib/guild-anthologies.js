import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// A Player Guild's collaborative book — see supabase/history/35_migration_guild_anthologies.sql.
// Deliberately thin: creating an anthology and submitting/reviewing a contribution are plain
// table calls under RLS (same weight as published_books/guild_book_feedback already get
// elsewhere), not RPCs — only the two actions that touch more than their own row (closing
// submissions, publishing) go through a server function. Player Guilds only, same scope cut as
// guild-treasury.js.

export async function fetchGuildAnthologies(guildId) {
  const { data, error } = await supabase.from('guild_anthologies')
    .select('id, guild_id, title, description, cover, price, submission_deadline, status, published_book_id, created_by, created_at, published_at')
    .eq('guild_id', guildId).order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  return data || [];
}

export async function fetchGuildAnthology(anthologyId) {
  const { data, error } = await supabase.from('guild_anthologies').select('*').eq('id', anthologyId).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Plain insert under RLS (see migration: only the guild's real owner may create one). Price is
// only the PROPOSED price here — once published, the live price lives on published_books.price.
export async function createGuildAnthology(guildId, { title, description, cover, price, submissionDeadline }) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to create an anthology.');
  const { data, error } = await supabase.from('guild_anthologies').insert({
    guild_id: guildId, title, description: description || null, cover: cover || null,
    price: price || 0, submission_deadline: submissionDeadline || null, created_by: user.id,
  }).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// Only title/description/cover/price/submission_deadline are actually writable this way (see
// guard_guild_anthology_mutation) — status and published_book_id silently hold their existing
// value if included, and any edit at all is rejected once the anthology is published.
export async function updateGuildAnthology(anthologyId, patch) {
  const { data, error } = await supabase.from('guild_anthologies').update(patch).eq('id', anthologyId).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// ---------- Submissions ----------

export async function fetchAnthologySubmissions(anthologyId) {
  const { data, error } = await supabase.from('guild_anthology_submissions')
    .select('*').eq('anthology_id', anthologyId).order('submitted_at', { ascending: true });
  if (error) throw sanitizeError(error);
  return data || [];
}

// projectId is the writer's own local project id (same pattern as publishing a book to the
// Guild Bookshelf) — title/blurb/wordCount are display metadata for review, same as before.
// `content` (release blocker fix — see 91_migration_anthology_submission_content.sql) is the
// contributor's own actual manuscript — {chapters: [{id,title,text}]}, built by the caller from
// this device's own local project (guild-anthology.jsx's loadProjectManuscriptContent) — the
// only place that text exists, since it's never synced to a second, non-author-owned table.
// Optional so a caller mid-migration (or an old cached bundle) doesn't hard-fail, but
// publish_guild_anthology() on the server refuses to publish any approved submission that never
// got one.
export async function submitToAnthology(anthologyId, { projectId, title, blurb, wordCount, content }) {
  const user = await currentUser();
  if (!user) throw new Error('Sign in to submit to this anthology.');
  const { data, error } = await supabase.from('guild_anthology_submissions').insert({
    anthology_id: anthologyId, contributor_id: user.id, project_id: projectId,
    title, blurb: blurb || null, word_count: wordCount || 0, content: content || null,
  }).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// A contributor may only touch these fields, and only before their submission is reviewed —
// see guard_anthology_submission_update for what's actually enforced server-side. `content`
// added alongside the other three (same release-blocker fix as submitToAnthology above) so
// saving an edit also refreshes the attached manuscript from the contributor's current project,
// rather than leaving an earlier submission's text stale once they've kept writing.
export async function updateOwnSubmission(submissionId, { title, blurb, projectId, wordCount, content }) {
  const patch = {};
  if (title !== undefined) patch.title = title;
  if (blurb !== undefined) patch.blurb = blurb;
  if (projectId !== undefined) patch.project_id = projectId;
  if (wordCount !== undefined) patch.word_count = wordCount;
  if (content !== undefined) patch.content = content;
  const { data, error } = await supabase.from('guild_anthology_submissions').update(patch).eq('id', submissionId).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

export async function withdrawSubmission(submissionId) {
  const { data, error } = await supabase.from('guild_anthology_submissions')
    .update({ review_status: 'withdrawn' }).eq('id', submissionId).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// Guild-owner-only server-side (see guard_anthology_submission_update); reviewNote is optional.
export async function reviewSubmission(submissionId, approve, reviewNote) {
  const { data, error } = await supabase.from('guild_anthology_submissions')
    .update({ review_status: approve ? 'approved' : 'rejected', review_note: reviewNote || null })
    .eq('id', submissionId).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// The approved-contributor list — derived from submissions, not a stored roster (see migration).
export async function fetchAnthologyContributors(anthologyId) {
  const { data, error } = await supabase.rpc('guild_anthology_contributors', { p_anthology_id: anthologyId });
  if (error) throw sanitizeError(error);
  return data || [];
}

// ---------- Revenue agreements (see supabase/history/36_migration_guild_anthology_revenue_agreements.sql) ----------

export async function fetchRevenueAgreement(anthologyId) {
  const { data, error } = await supabase.from('guild_anthology_revenue_agreements')
    .select('*').eq('anthology_id', anthologyId).maybeSingle();
  if (error) throw sanitizeError(error);
  return data;
}

export async function fetchRevenueShares(agreementId) {
  const { data, error } = await supabase.from('guild_anthology_revenue_shares')
    .select('*').eq('agreement_id', agreementId).order('share_bps', { ascending: false });
  if (error) throw sanitizeError(error);
  return data || [];
}

// splitType: 'equal' | 'contribution' | 'custom'. customShares (only for 'custom'):
// [{ contributor_id, share_bps }, ...] covering exactly the anthology's approved contributors,
// summing to exactly 10000. Owner-only server-side; always resets every contributor's approval,
// even on a no-op re-propose — see the migration's header for why that's the whole point.
export async function proposeRevenueAgreement(anthologyId, splitType, customShares) {
  const { data, error } = await supabase.rpc('propose_anthology_revenue_agreement', {
    p_anthology_id: anthologyId, p_split_type: splitType, p_custom_shares: customShares || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// A contributor may only ever touch their OWN row's approved_at (see
// guard_anthology_revenue_share_update) — passing someone else's shareId simply won't match any
// row the update policy grants access to.
export async function setRevenueShareApproval(shareId, approved) {
  const { data, error } = await supabase.from('guild_anthology_revenue_shares')
    .update({ approved_at: approved ? new Date().toISOString() : null }).eq('id', shareId).select().single();
  if (error) throw sanitizeError(error);
  return data;
}

// ---------- Lifecycle (owner-only, server-checked) ----------

export async function closeAnthologySubmissions(anthologyId) {
  const { data, error } = await supabase.rpc('close_guild_anthology_submissions', { p_anthology_id: anthologyId }).single();
  if (error) throw sanitizeError(error);
  return data;
}

export async function reopenAnthologySubmissions(anthologyId) {
  const { data, error } = await supabase.rpc('reopen_guild_anthology_submissions', { p_anthology_id: anthologyId }).single();
  if (error) throw sanitizeError(error);
  return data;
}

export async function cancelAnthology(anthologyId) {
  const { data, error } = await supabase.rpc('cancel_guild_anthology', { p_anthology_id: anthologyId }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Creates the real published_books row and returns it. Throws with the same clear messages the
// RPC raises ("Close submissions and finish reviewing before publishing.", "At least one
// approved submission is required before publishing.", etc.) for the caller to surface as-is.
export async function publishAnthology(anthologyId) {
  const { data, error } = await supabase.rpc('publish_guild_anthology', { p_anthology_id: anthologyId }).single();
  if (error) throw sanitizeError(error);
  return data;
}
