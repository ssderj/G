import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Client side of the flow described in supabase/schema.sql's "Account deletion" section: request
// starts a 30-day grace period (cancellable any time before it elapses); the actual purge runs
// server-side via pg_cron, not from here — this file only ever reads/writes account_deletions'
// row for the signed-in user, which its own RLS policy scopes to auth.uid() = user_id.

const GRACE_PERIOD_DAYS = 30;

// The Player Guild this account owns, if any (Founder Guilds have no owner_id, so they're never
// returned here) — used to warn a guild owner what happens to their guild before they request
// deletion. Purely a UX pre-check, same "immediate feedback, not the real enforcement" posture as
// publishing.jsx's client-side word-count check: the actual block is the account_deletions
// trigger added in 79_migration_account_deletion_guild_check.sql, not this query.
export async function fetchOwnedPlayerGuild() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await supabase.from('player_guilds').select('id, name').eq('owner_id', user.id).eq('is_founder_guild', false).maybeSingle();
  if (error) throw sanitizeError(error);
  return data;
}

// `acknowledgesGuildImpact` should be true only once the person has actually seen and confirmed
// the guild-specific warning (see account-sync-control.jsx) — sent as-is to
// acknowledges_owned_guild_impact, which the server-side trigger checks for real. Passing true
// unconditionally here would defeat the point of the check entirely, so this never defaults it
// on its own.
export async function requestAccountDeletion(acknowledgesGuildImpact = false) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to delete your account.');
  const scheduledPurgeAt = new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase.from('account_deletions').upsert({
    user_id: user.id,
    requested_at: new Date().toISOString(),
    scheduled_purge_at: scheduledPurgeAt,
    status: 'pending',
    acknowledges_owned_guild_impact: acknowledgesGuildImpact,
    updated_at: new Date().toISOString(),
  });
  if (error) {
    // The trigger's own raised message (see 79_migration_account_deletion_guild_check.sql) —
    // surfaced here as a distinct, catchable error code so the UI can show the guild-specific
    // warning instead of a generic failure message.
    if (/ACCOUNT_DELETION_BLOCKED_OWNS_PLAYER_GUILD/.test(error.message || '')) {
      const blocked = new Error('This account owns a Player Guild — confirm you understand what happens to it before deleting.');
      blocked.code = 'OWNS_PLAYER_GUILD';
      throw blocked;
    }
    throw sanitizeError(error);
  }
  return { scheduledPurgeAt };
}

// Only meaningful while status is still 'pending' — once pg_cron's purge has actually run
// (status 'completed'), the account is already anonymized/banned and there's nothing left to
// cancel; the RLS policy would still technically allow this call, but the purge is not
// reversible by this point.
export async function cancelAccountDeletion() {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to manage your account.');
  const { error } = await supabase.from('account_deletions').delete().eq('user_id', user.id);
  if (error)
    throw sanitizeError(error);
}

// Returns null if no deletion has ever been requested (the common case), or the current
// account_deletions row otherwise — including a 'completed' one, in the rare case this loads in
// the brief window before the app's own sign-out-on-ban handling (see sync-context.jsx) kicks in.
export async function fetchAccountDeletionStatus() {
  const user = await currentUser();
  if (!user)
    return null;
  const { data, error } = await supabase.from('account_deletions').select('*').eq('user_id', user.id).maybeSingle();
  if (error)
    throw sanitizeError(error);
  return data;
}
