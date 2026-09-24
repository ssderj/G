import { supabase, currentUser } from './supabaseClient.js';
import { fetchProfileNames } from './profile.js';
import { sanitizeError } from './errors.js';

// The Guild Order's real Council (migration 82) — same thin client-wrapper shape as
// lib/guild-manuscript.js and lib/guild-world-bible.js. Proposals/votes follow the same
// document/contribution split chapters/passages use (see the migration's own header for why).

// guildType is 'founder' or 'player'; guildId is whichever real id that guild type actually has.
// Returns every proposal (open and closed) newest-first, each carrying its real opener's display
// name, a real yes/no/abstain tally from guild_order_votes, and this signed-in writer's own vote
// (if any) so the UI can show "you voted X" without a second round trip.
export async function fetchGuildProposals(guildType, guildId) {
  if (!guildId)
    return [];
  const [{ data: proposals, error: proposalsError }, user] = await Promise.all([
    supabase.from('guild_order_proposals').select('id, title, body, opened_by, status, created_at, closed_at')
      .eq('guild_type', guildType).eq('guild_id', guildId)
      .order('created_at', { ascending: false }),
    currentUser(),
  ]);
  if (proposalsError) throw sanitizeError(proposalsError);
  const rows = proposals || [];
  if (rows.length === 0)
    return [];

  const { data: votes, error: votesError } = await supabase
    .from('guild_order_votes')
    .select('proposal_id, voter_id, choice')
    .in('proposal_id', rows.map((r) => r.id));
  if (votesError) throw sanitizeError(votesError);

  const names = await fetchProfileNames(rows.map((r) => r.opened_by));
  const myId = user && user.id;
  return rows.map((p) => {
    const forThis = (votes || []).filter((v) => v.proposal_id === p.id);
    const tally = { yes: 0, no: 0, abstain: 0 };
    let myVote = null;
    for (const v of forThis) {
      tally[v.choice] = (tally[v.choice] || 0) + 1;
      if (myId && v.voter_id === myId) myVote = v.choice;
    }
    return { ...p, openedByName: names[p.opened_by] || 'A member', tally, total: forThis.length, myVote };
  });
}

// Opens a real proposal, attributed to whoever's actually signed in. Server-side, any real
// member can do this (see the migration's own comment on why the openVote rung isn't
// re-enforced here) — GO_PERMISSIONS.openVote still gates the client's own button.
export async function openGuildProposal(guildType, guildId, { title, body }) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to raise a proposal.');
  const trimmedTitle = (title || '').trim();
  if (!trimmedTitle)
    return null;
  const { error } = await supabase.from('guild_order_proposals').insert({
    guild_type: guildType, guild_id: guildId,
    title: trimmedTitle.slice(0, 200),
    body: (body || '').trim().slice(0, 2000),
    opened_by: user.id,
  });
  if (error) throw sanitizeError(error);
  return true;
}

// Closes a proposal — only the writer who opened it can do this (RLS-enforced), matching the
// migration's simplest-rule choice.
export async function closeGuildProposal(proposalId) {
  const { error } = await supabase.from('guild_order_proposals')
    .update({ status: 'closed', closed_at: new Date().toISOString() })
    .eq('id', proposalId);
  if (error) throw sanitizeError(error);
}

// Casts (or changes) this writer's own vote — an upsert on the (proposal_id, voter_id) unique
// constraint, so calling this again with a different choice just changes the existing row rather
// than erroring or creating a second one.
export async function castGuildVote(proposalId, choice) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to vote.');
  const { error } = await supabase.from('guild_order_votes')
    .upsert({ proposal_id: proposalId, voter_id: user.id, choice }, { onConflict: 'proposal_id,voter_id' });
  if (error) throw sanitizeError(error);
}

// Subscribes to live changes on this one guild's proposals AND the votes cast on them. Same
// client-side id-tracking trick subscribeGuildManuscriptRealtime already uses for passages
// (votes reference a proposal_id, not this guild directly, so there's no column here Postgres
// can filter the votes stream on server-side). Returns an unsubscribe function; onChange is
// called with no arguments, same convention as every other subscribeGuild*Realtime here.
export function subscribeGuildCouncilRealtime(guildType, guildId, onChange) {
  if (!guildId)
    return () => {};
  const proposalIds = new Set();

  supabase
    .from('guild_order_proposals')
    .select('id')
    .eq('guild_type', guildType).eq('guild_id', guildId)
    .then(({ data }) => {
      for (const row of data || []) proposalIds.add(row.id);
    });

  const channel = supabase
    .channel(`guild-order-council:${guildType}:${guildId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guild_order_proposals', filter: `guild_id=eq.${guildId}` }, (payload) => {
      if (payload.eventType === 'DELETE') {
        if (payload.old?.id) proposalIds.delete(payload.old.id);
      } else if (payload.new?.id) {
        proposalIds.add(payload.new.id);
      }
      onChange();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'guild_order_votes' }, (payload) => {
      const proposalId = payload.new?.proposal_id || payload.old?.proposal_id;
      if (proposalId && proposalIds.has(proposalId)) onChange();
    })
    .subscribe();
  return () => supabase.removeChannel(channel);
}
