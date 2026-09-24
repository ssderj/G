import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';
import { koboToNaira } from './payments.js';

// A guild's real money — see supabase/history/33_migration_guild_treasury.sql. Every number here
// comes from a server-side function over guild_treasury_transactions; nothing in this file
// computes a balance locally or trusts one from anywhere but that RPC call. Works for both a
// Player Guild (pass its player_guilds.id) and a Founder Guild (pass its FOUNDER_GUILDS[].
// backendGuildId, not the text id) — see supabase/history/69_migration_founder_guild_parity.sql
// for how a Founder Guild's officer authority (Inkroot admin) plugs into the same is_guild_
// officer()/is_guild_member() checks every function below is gated by.

// { guildOwnedNaira, availableNaira, pendingNaira, memberEarningsNaira, memberEarningsMineNaira }
// or null when signed out, not a member, or offline — callers fall back to the simulated
// GoTreasuryTab preview in that case, same pattern as fetchGuildMemberStats/fetchPlayerGuild.
export async function fetchGuildTreasurySummary(guildId) {
  const user = await currentUser();
  if (!user || !guildId) return null;
  const { data, error } = await supabase.rpc('guild_treasury_summary', { p_guild_id: guildId }).single();
  if (error) throw sanitizeError(error);
  if (!data) return null;
  return {
    guildOwnedNaira: koboToNaira(data.guild_owned_kobo || 0),
    availableNaira: koboToNaira(data.available_kobo || 0),
    pendingNaira: koboToNaira(data.pending_kobo || 0),
    memberEarningsNaira: koboToNaira(data.member_earnings_kobo || 0),
    memberEarningsMineNaira: koboToNaira(data.member_earnings_mine_kobo || 0),
  };
}

// The transaction history: every guild-owned row (RLS-visible to any member), plus the caller's
// own member-earnings rows if any — RLS on guild_treasury_transactions filters this down to
// exactly what the caller may see, so this is a plain select, not a privileged one.
//
// anthology_id is set on a row when it came from an anthology sale being distributed per its
// revenue agreement (see 37_migration_guild_revenue_distribution.sql) — null for a plain
// contribution/spend. Lets a ledger UI link a credit back to the anthology that earned it.
export async function fetchGuildTreasuryLedger(guildId, limit = 30) {
  const { data, error } = await supabase.from('guild_treasury_transactions')
    .select('id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination, project_event_id, anthology_id, status, title, created_by, created_at')
    .eq('guild_id', guildId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({ ...row, amountNaira: koboToNaira(row.amount_kobo) }));
}

// { availableNaira, pendingNaira, lifetimeNaira } for the signed-in writer's own held earnings
// in this one guild, or null when signed out, not a member, or offline — same fallback contract
// as fetchGuildTreasurySummary. availableNaira is what withdrawGuildMemberEarnings will actually
// let them move right now (settled credits minus anything already released); lifetimeNaira never
// goes down, even after a withdrawal.
export async function fetchGuildMemberEarningsSummary(guildId) {
  const user = await currentUser();
  if (!user || !guildId) return null;
  const { data, error } = await supabase.rpc('guild_member_earnings_summary', { p_guild_id: guildId }).single();
  if (error) throw sanitizeError(error);
  if (!data) return null;
  return {
    availableNaira: koboToNaira(data.available_kobo || 0),
    pendingNaira: koboToNaira(data.pending_kobo || 0),
    lifetimeNaira: koboToNaira(data.lifetime_kobo || 0),
  };
}

// The signed-in writer's own member-earnings rows in this guild only — every credit they were
// ever paid into this guild's treasury (kind='anthology_share', etc.) and every release of that
// balance back to their own withdrawable balance (kind='release_to_member'). RLS already scopes
// guild_treasury_transactions' 'member' rows to member_id = auth.uid(), so this can never surface
// another member's earnings — the explicit filters here are just to keep this guild's own
// 'guild'-bucket rows (visible to every member) out of a screen that's meant to show one
// person's earnings only. Callers can split this one list into "earnings by project" (group the
// credit rows) and "withdrawal history" (kind='release_to_member') without a second round trip.
export async function fetchGuildMemberEarningsTransactions(guildId, limit = 200) {
  const user = await currentUser();
  if (!user || !guildId) return [];
  const { data, error } = await supabase.from('guild_treasury_transactions')
    .select('id, direction, kind, amount_kobo, currency, source, destination, project_event_id, anthology_id, status, title, created_at')
    .eq('guild_id', guildId).eq('bucket', 'member').eq('member_id', user.id)
    .order('created_at', { ascending: false }).limit(limit);
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({ ...row, amountNaira: koboToNaira(row.amount_kobo) }));
}

// Releases part of the signed-in writer's own verified, held-in-trust earnings in this guild
// into their own cross-guild withdrawable balance (author_balance_kobo) — see
// 41_migration_guild_member_earnings_withdrawal.sql for why this is a release into that balance
// rather than a direct bank payout. The actual payout to their bank account is then just an
// ordinary requestWithdrawal() call (payments.js) against that now-larger balance — the same
// Paystack pipeline every other withdrawal already uses. The server re-checks this member's own
// real balance in this guild before writing anything; amountNaira here is a request, not
// something the row trusts. idempotencyKey — see contributeToGuildTreasury above.
export async function withdrawGuildMemberEarnings(guildId, amountNaira, idempotencyKey) {
  const { data, error } = await supabase.rpc('withdraw_guild_member_earnings', {
    p_guild_id: guildId, p_amount_kobo: Math.round(amountNaira * 100), p_idempotency_key: idempotencyKey || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Moves part of the signed-in writer's own real, already-earned balance into the guild's purse.
// The server re-checks membership and the real balance itself (author_balance_kobo) before
// writing anything — amountNaira here is a request, not something the row trusts.
//
// idempotencyKey is optional but should be the same string across retries of one logical attempt
// (e.g. a caller retrying after a dropped connection) and a fresh one (see uuid() in
// shared-utils/storage-keys.jsx) for each genuinely new attempt — see
// 34_migration_guild_treasury_ledger_hardening.sql for what the server does with it. projectEventId
// tags this row to a specific Anthology or Guild Event once those features exist to pass one;
// omit it for a plain contribution.
export async function contributeToGuildTreasury(guildId, amountNaira, note, idempotencyKey, projectEventId) {
  const { data, error } = await supabase.rpc('contribute_to_guild_treasury', {
    p_guild_id: guildId, p_amount_kobo: Math.round(amountNaira * 100), p_note: note || null,
    p_idempotency_key: idempotencyKey || null, p_project_event_id: projectEventId || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Any guild leader (the real owner_id), treasurer, or officer can call this — checked
// server-side by is_guild_treasury_authorized(), never trusted from this device. Throws with a
// clear message ("Only the guild leader, treasurer, or an officer can authorize a treasury
// spend." / "That would exceed the guild's available treasury balance." / "Withdrawals of this
// size require multiple approvals — use propose_guild_treasury_spend instead.") for anyone else,
// an over-budget commission, or an amount at/above fetchGuildTreasuryApprovalThreshold(). See
// 44_migration_guild_treasury_roles_and_approvals.sql. idempotencyKey/projectEventId — see
// contributeToGuildTreasury above.
export async function spendFromGuildTreasury(guildId, amountNaira, title, idempotencyKey, projectEventId) {
  const { data, error } = await supabase.rpc('spend_from_guild_treasury', {
    p_guild_id: guildId, p_amount_kobo: Math.round(amountNaira * 100), p_title: title,
    p_idempotency_key: idempotencyKey || null, p_project_event_id: projectEventId || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// ============================================================================================
// Guild Treasury permissions — Guild Leader / Treasurer / Officers / Members. See
// 44_migration_guild_treasury_roles_and_approvals.sql. A member's own held-in-trust earnings
// (everything above this point in the file) are untouched by any of this: no function below can
// ever move a 'member'-bucket row for anyone but that row's own auth.uid().
// ============================================================================================

// 'leader' | 'treasurer' | 'officer' | 'member' | null (signed out, offline, or not a member of
// this guild at all). 'leader' means the real player_guilds.owner_id, not a stored role — see
// the migration for why leadership is never a row that could disagree with ownership.
export async function fetchGuildTreasuryRole(guildId) {
  const user = await currentUser();
  if (!user || !guildId) return null;
  const { data, error } = await supabase.rpc('guild_treasury_role', { p_guild_id: guildId });
  if (error) throw sanitizeError(error);
  return data || null;
}

// The Naira amount at/above which spendFromGuildTreasury refuses and proposeGuildTreasurySpend
// must be used instead. Not guild-specific today — see the migration's own note that this is a
// single global constant for now, easy to make per-guild later without touching any caller.
export async function fetchGuildTreasuryApprovalThresholdNaira() {
  const { data, error } = await supabase.rpc('guild_treasury_multi_approval_threshold_kobo');
  if (error) throw sanitizeError(error);
  return koboToNaira(data || 0);
}

// Only the guild leader may call this (checked server-side); throws for anyone else, for an
// invalid role, or for an attempt to change the leader's own row. role is 'treasurer', 'officer',
// or 'member' (demotes back to plain member).
export async function setGuildTreasuryRole(guildId, memberId, role) {
  const { data, error } = await supabase.rpc('set_guild_treasury_role', {
    p_guild_id: guildId, p_member_id: memberId, p_role: role,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Proposes a large (>= fetchGuildTreasuryApprovalThresholdNaira()) guild-owned-fund withdrawal.
// The caller's own authorization counts as the first of the request's required_approvals — a
// second, distinct authorized approver (approveGuildTreasurySpend below) is still needed before
// any real money moves. Throws for an unauthorized caller, an amount under the threshold (use
// spendFromGuildTreasury for those), or an amount that would exceed the guild's available
// balance once other pending proposals are accounted for.
export async function proposeGuildTreasurySpend(guildId, amountNaira, title, idempotencyKey) {
  const { data, error } = await supabase.rpc('propose_guild_treasury_spend', {
    p_guild_id: guildId, p_amount_kobo: Math.round(amountNaira * 100), p_title: title,
    p_idempotency_key: idempotencyKey || null,
  }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Records the signed-in authorized role's approval of a pending spend request. Once enough
// distinct approvals exist, the server executes the spend in the same call and the returned
// row's status flips to 'executed' (with transactionId set) — otherwise it comes back still
// 'pending' with one more approval recorded. Safe to call again for a request already approved
// by this same person (a no-op) or already executed (throws, since it's no longer pending).
export async function approveGuildTreasurySpend(requestId) {
  const { data, error } = await supabase.rpc('approve_guild_treasury_spend', { p_request_id: requestId }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Stands a pending spend request down before it collects enough approvals to execute — only the
// person who proposed it, or the guild leader, may call this.
export async function cancelGuildTreasurySpendRequest(requestId) {
  const { data, error } = await supabase.rpc('cancel_guild_treasury_spend_request', { p_request_id: requestId }).single();
  if (error) throw sanitizeError(error);
  return data;
}

// Every large-withdrawal proposal this guild has on record, newest first — RLS scopes this to
// guild members automatically, same as fetchGuildTreasuryLedger above.
export async function fetchGuildTreasurySpendRequests(guildId, limit = 30) {
  const { data, error } = await supabase.from('guild_treasury_spend_requests')
    .select('id, amount_kobo, title, requested_by, required_approvals, status, created_at, decided_at, transaction_id')
    .eq('guild_id', guildId).order('created_at', { ascending: false }).limit(limit);
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({ ...row, amountNaira: koboToNaira(row.amount_kobo) }));
}

// Who has already approved one specific request — used to show "N of required" and to disable
// the Approve button for someone who's already voted.
export async function fetchGuildTreasurySpendApprovals(requestId) {
  const { data, error } = await supabase.from('guild_treasury_spend_approvals')
    .select('approver_id, approved_at').eq('request_id', requestId);
  if (error) throw sanitizeError(error);
  return data || [];
}
