import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Real, server-verified progress for every NAIRA_ACHIEVEMENTS id except nairaWelcome (see the
// comment on NAIRA_ACHIEVEMENTS in ../writing/health-checks.jsx, and
// supabase/history/52_migration_naira_achievement_grants.sql /
// 53_migration_naira_writing_and_reading_signals.sql for the backend this calls into).
// naira_achievement_progress() is more than a plain read — it's also the moment an eligible
// achievement actually gets paid (there's no separate "claim" step in this UI), so this is called
// every time the Hall of Legends is opened, not cached.
//
// Returns a Map<achievement_id, { current, unlocked }>, or null when signed out or offline —
// same fallback contract as every other fetchX in this codebase (fetchGuildTreasurySummary,
// fetchPlayerGuild, etc.). Callers fall back to the existing locked-at-0 placeholder for nairaWelcome
// (the one id not present in the map) and for everything when this returns null.
export async function fetchNairaAchievementProgress() {
  const user = await currentUser();
  if (!user) return null;
  try {
    const { data, error } = await supabase.rpc('naira_achievement_progress');
    if (error) throw sanitizeError(error);
    const byId = new Map();
    (data || []).forEach((row) => {
      byId.set(row.achievement_id, { current: Number(row.current_count) || 0, unlocked: !!row.unlocked });
    });
    return byId;
  } catch (e) {
    console.warn('Inkroot: fetchNairaAchievementProgress failed', e);
    return null;
  }
}
