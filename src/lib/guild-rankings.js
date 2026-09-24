import { supabase, isSupabaseConfigured, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Guilds on the Rise is computed entirely server-side (see
// supabase/history/40_migration_guilds_on_rise_scoring.sql's compute_guilds_on_rise()) from real,
// recent-window activity across a Player Guild's actual roster — never from guild size, and never
// from anything this client hands it. Same thin, honestly-failing wrapper shape as
// rising-stars.js and book-rankings.js: a failed call never blocks anything, it just means Living
// Universe falls back to its local Chronicle/Guild-Events simulation for this section.

// Fetches the current top Guilds on the Rise. windowDays/limit are optional previews of a
// different window/size — the WEIGHTS, FLOORS, and CAPS that actually decide the ranking always
// come from the moderator-tunable guilds_on_rise_config row server-side, never from here. Returns
// [] (never throws) so a signed-out reader or an offline device just sees Living Universe fall
// back to its local Founder-Guild-events section instead of an error.
export async function fetchGuildsOnRise({ windowDays, limit } = {}) {
  if (!isSupabaseConfigured) return [];
  try {
    const user = await currentUser();
    if (!user) return []; // compute_guilds_on_rise() is authenticated-only, same as every other real RPC in this app
    const { data, error } = await supabase.rpc('compute_guilds_on_rise', {
      p_window_days: windowDays || null,
      p_result_limit: limit || null,
    });
    if (error) throw sanitizeError(error);
    return (data || []).map((row) => ({
      guildId: row.guild_id,
      name: row.guild_name,
      motto: row.guild_motto || null,
      crestUrl: row.crest_url || null,
      memberCount: row.member_count || 0,
      newMembers: row.new_members || 0,
      readingActivity: row.reading_activity || 0,
      booksPublished: row.books_published || 0,
      questActivity: row.quest_activity || 0,
      anthologyActivity: row.anthology_activity || 0,
      reputationGrowth: Number(row.reputation_growth) || 0,
      score: Number(row.score) || 0,
    }));
  } catch {
    return [];
  }
}

// ---------- Public guild profile (see 51_migration_public_guild_events_directory.sql) ----------
// The minimal, safe-to-show-anyone read of a single Player Guild by id — for a card or link
// (Guilds on the Rise, Guild Events, Best/Most-Read) to land on a real guild page without the
// reader needing to already be a member. Same thin, honestly-failing wrapper shape as everything
// else in this file: returns null (never throws) on any failure or signed-out call, so a caller
// can fall back to "this guild couldn't be loaded" instead of erroring.
export async function fetchPublicGuildProfile(guildId) {
  if (!isSupabaseConfigured || !guildId) return null;
  try {
    const user = await currentUser();
    if (!user) return null; // get_public_guild_profile() is authenticated-only, same as every other real RPC in this app
    const { data, error } = await supabase.rpc('get_public_guild_profile', { p_guild_id: guildId }).maybeSingle();
    if (error) throw sanitizeError(error);
    if (!data) return null;
    return {
      guildId: data.id,
      name: data.name,
      motto: data.motto || null,
      crestUrl: data.crest_url || null,
      memberCount: data.member_count || 0,
      createdAt: data.created_at,
    };
  } catch {
    return null;
  }
}
