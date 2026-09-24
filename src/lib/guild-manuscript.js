import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames } from './profile.js';
import { sanitizeError } from './errors.js';

// The Guild Order's real shared manuscript (migration 65) — see that migration's own header
// comment for the full rationale (why two tables, why guild_type/guild_id instead of a single
// key, why the permission model is lighter than GO_PERMISSIONS' full rung ladder). This file is
// the thin client wrapper around guild_order_chapters/guild_order_passages, same
// safe-regardless-of-sign-in-state philosophy as every other lib/*.js module — callers in
// guild-order.jsx don't need to check sign-in themselves before calling these; a signed-out
// writer just gets an insert rejected by RLS the same way any other write here would be.

// guildType is 'founder' or 'player' (matches guild_order_chapters.guild_type); guildId is
// whichever real id that guild type actually has — a Founder Guild's fixed key
// ('fantasy'/'romance'/...) or a Player Guild's real uuid. Returns chapters in display order,
// each carrying its own passages (already name-resolved) rather than making the caller stitch
// two separate lists back together.
export async function fetchGuildManuscript(guildType, guildId) {
  if (!guildId)
    return [];
  const { data: chapterRows, error } = await supabase
    .from('guild_order_chapters')
    .select('id, order_index, title, status, proposed_by, created_at, updated_at')
    .eq('guild_type', guildType).eq('guild_id', guildId)
    .order('order_index', { ascending: true }).order('created_at', { ascending: true });
  if (error) throw sanitizeError(error);
  const chapters = chapterRows || [];
  if (chapters.length === 0)
    return [];
  const chapterIds = chapters.map((c) => c.id);
  const { data: passageRows, error: passageError } = await supabase
    .from('guild_order_passages')
    .select('id, chapter_id, author_id, content, created_at')
    .in('chapter_id', chapterIds)
    .order('created_at', { ascending: true });
  if (passageError) throw sanitizeError(passageError);
  const passages = passageRows || [];
  const names = await fetchProfileNames([...chapters.map((c) => c.proposed_by), ...passages.map((p) => p.author_id)]);
  return chapters.map((c) => ({
    ...c,
    proposerName: names[c.proposed_by] || 'A writer',
    passages: passages
      .filter((p) => p.chapter_id === c.id)
      .map((p) => ({ ...p, authorName: names[p.author_id] || 'A writer' })),
  }));
}

// Proposes a new chapter — always starts 'draft' (guild_order_chapters' own insert policy
// enforces this too; matching it here client-side is just so a caller never sees a request it
// knows RLS will reject).
export async function proposeGuildChapter(guildType, guildId, title) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to propose a chapter.');
  const { error } = await supabase.from('guild_order_chapters').insert({
    guild_type: guildType, guild_id: guildId, title: (title || '').trim().slice(0, 200), proposed_by: user.id, status: 'draft',
  });
  if (error)
    throw sanitizeError(error);
}

// A real passage of prose, attributed to whoever's actually signed in — see the migration's own
// comment on why this is an append-only log rather than one shared editable field.
export async function addGuildPassage(chapterId, content) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to add a passage.');
  const trimmed = (content || '').trim();
  if (!trimmed)
    return null;
  const { error } = await supabase.from('guild_order_passages').insert({
    chapter_id: chapterId, author_id: user.id, content: trimmed.slice(0, 8000),
  });
  if (error)
    throw sanitizeError(error);
  return true;
}

// Advances (or reopens) a chapter's status. Any real member can call this for 'draft'/'in
// review' — approving is the one transition guild_order_chapters' own update policy actually
// gates server-side (see the migration), so a caller without real standing gets a genuine RLS
// rejection here, not just a hidden button.
export async function setGuildChapterStatus(chapterId, status) {
  const { error } = await supabase.from('guild_order_chapters').update({ status }).eq('id', chapterId);
  if (error)
    throw sanitizeError(error);
}

export async function deleteGuildChapter(chapterId) {
  const { error } = await supabase.from('guild_order_chapters').delete().eq('id', chapterId);
  if (error)
    throw sanitizeError(error);
}

// Subscribes to live inserts/updates on this one guild's chapters and passages. Returns an
// unsubscribe function. onChange is called with no arguments — same as
// subscribeFiresideRealtime (library-guild.js), callers just re-fetch via
// fetchGuildManuscript() rather than trying to patch individual rows into place themselves.
//
// guild_order_chapters has its own guild_id column, so Postgres can filter that stream
// server-side — filtered on guild_id alone (not guild_type too): a Founder Guild's id is one of
// the ten fixed lore keys and a Player Guild's is a real uuid, formats that can't collide in
// practice, so a single-column filter is enough, same reasoning fireside_posts' own
// guild_id-only filter relies on. guild_order_passages doesn't carry guild_id at all (see the
// migration), so — exactly like fireside_reactions before it — there's no server-side filter to
// scope that stream to just this guild; chapterIds tracks this guild's own known chapter ids
// client-side and gates the passages handler against it, so a passage on some OTHER guild's
// chapter (which RLS would still let this subscriber's channel see, since Realtime just filters
// by policy, not by our current UI) doesn't trigger a refetch here.
export function subscribeGuildManuscriptRealtime(guildType, guildId, onChange) {
  if (!guildId)
    return () => {};
  const chapterIds = new Set();

  // Seed with the guild's current chapter ids so a passage on an already-loaded chapter is
  // recognized immediately, rather than only after a guild_order_chapters event has populated
  // the set. A passage arriving before this resolves just gets missed once (falls back to
  // whatever the caller's own next fetchGuildManuscript() picks up), same tradeoff
  // subscribeFiresideRealtime makes.
  supabase
    .from('guild_order_chapters')
    .select('id')
    .eq('guild_type', guildType).eq('guild_id', guildId)
    .then(({ data }) => {
      for (const row of data || []) chapterIds.add(row.id);
    });

  const channel = supabase
    .channel(`guild-order-manuscript:${guildType}:${guildId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guild_order_chapters', filter: `guild_id=eq.${guildId}` }, (payload) => {
      // Keep chapterIds in sync with this guild's actual chapters as they're added/removed, so
      // the passages filter below stays accurate without a full re-query on every change.
      if (payload.eventType === 'DELETE') {
        if (payload.old?.id) chapterIds.delete(payload.old.id);
      } else if (payload.new?.id) {
        chapterIds.add(payload.new.id);
      }
      onChange();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guild_order_passages' }, (payload) => {
      const chapterId = payload.new?.chapter_id || payload.old?.chapter_id;
      if (chapterId && chapterIds.has(chapterId)) onChange();
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}
