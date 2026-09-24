import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// The Inkroot Official Badge — a fully automated, criteria-based gate (distinct from
// profiles.verified, the moderator-curated identity checkmark). Its sole purpose is to stop
// Naira achievement farming: grant_naira_achievement() refuses to pay out until this is earned
// (see supabase/history/94_migration_official_badge_and_checkins.sql), so this fetch is purely
// informational — showing the writer what they still need, not something this client could
// falsify its way past.
//
// Recomputed live on every call, not cached — the account-age criterion is time-based, so a
// stored flag would need a cron job to ever flip on its own. Same "not cached, called each time
// the relevant screen opens" choice fetchNairaAchievementProgress already made.
//
// Returns { hasBook, inGuild, paidEvent, weekOld, earned }, or null when signed out or offline —
// same fallback contract as every other fetchX here.
export async function fetchOfficialBadgeStatus() {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.rpc('inkroot_official_badge_status');
    if (error) throw sanitizeError(error);
    const row = (data || [])[0];
    if (!row) return null;
    return {
      hasBook: !!row.has_book,
      inGuild: !!row.in_guild,
      paidEvent: !!row.paid_event,
      weekOld: !!row.week_old,
      earned: !!row.earned,
    };
  } catch (e) {
    console.warn('Inkroot: fetchOfficialBadgeStatus failed', e);
    return null;
  }
}
