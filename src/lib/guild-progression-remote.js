import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Fire-and-forget, same non-blocking philosophy as the rest of Inkroot's sync layer (syncEngine.js,
// library.js): a failed push here never blocks or fails the local Guild Hall render — it just
// means this device's numbers won't count toward the guild's shared total until the next
// successful push. No-ops quietly when signed out or when there's no guild to push to, so
// callers don't need to check auth/guild state first.
//
// `guildType` picks the table: 'player' -> guild_member_stats (player_guild_members-backed),
// 'founder' -> founder_guild_member_stats (founder_guild_members-backed, migration 88 — see
// that migration's own header for why this is a second table rather than widening the first).
// Both tables share the exact same non-key columns, so one function handles either.
export async function pushGuildMemberStats(guildId, { publishedCount, questsCompleted, questGuildXP, writingDayCount, firesidePostCount }, guildType = 'player') {
  const user = await currentUser();
  if (!user || !guildId) return null;
  const table = guildType === 'founder' ? 'founder_guild_member_stats' : 'guild_member_stats';
  const { error } = await supabase.from(table).upsert({
    guild_id: guildId,
    user_id: user.id,
    published_count: publishedCount || 0,
    quests_completed: questsCompleted || 0,
    quest_guild_xp: questGuildXP || 0,
    writing_day_count: writingDayCount || 0,
    fireside_post_count: firesidePostCount || 0,
    updated_at: new Date().toISOString(),
  });
  if (error) throw sanitizeError(error);
  return true;
}

// Returns every member's raw stats row for this guild — the material sumGuildMemberStats
// (guild-progression.jsx) reduces into totals. Which formula to apply to those totals lives in
// guild-progression.jsx, not here, so this stays a plain fetch. See pushGuildMemberStats above
// for what `guildType` selects.
export async function fetchGuildMemberStats(guildId, guildType = 'player') {
  if (!guildId) return [];
  const table = guildType === 'founder' ? 'founder_guild_member_stats' : 'guild_member_stats';
  const { data, error } = await supabase.from(table).select('*').eq('guild_id', guildId);
  if (error) throw sanitizeError(error);
  return data || [];
}
