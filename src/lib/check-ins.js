import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Daily check-ins — a real, server-verified daily action, distinct from the client-derived
// per-project "writing streak" in writing/project-workspace/tab-progress.jsx (that one comes from
// local word-count deltas; this one is a row in daily_checkins the server itself timestamped).
// See supabase/history/94_migration_official_badge_and_checkins.sql. There's no client insert
// policy on daily_checkins at all — checking in only ever happens through checkInToday() below,
// so the date always comes from the server clock, never something this client could backdate.

// Calls the check-in RPC (idempotent — a second call the same day is a no-op) and returns the
// resulting streak. Returns null when signed out or offline, same fallback contract as every
// other fetchX/postX in this codebase.
export async function checkInToday() {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.rpc('check_in_today');
    if (error) throw sanitizeError(error);
    const row = (data || [])[0];
    if (!row) return null;
    return { checkedInToday: !!row.checked_in_today, currentStreak: Number(row.current_streak) || 0 };
  } catch (e) {
    console.warn('Inkroot: checkInToday failed', e);
    return null;
  }
}

// Fetches the set of checked-in calendar dates for a given month (1-12), for rendering a
// calendar grid. Returns a Set<string> of 'YYYY-MM-DD' dates, or null when signed out/offline.
export async function fetchCheckInsForMonth(year, month) {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.rpc('fetch_checkins_for_month', { p_year: year, p_month: month });
    if (error) throw sanitizeError(error);
    return new Set((data || []).map((row) => row.checkin_date));
  } catch (e) {
    console.warn('Inkroot: fetchCheckInsForMonth failed', e);
    return null;
  }
}
