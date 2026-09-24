import { supabase, isSupabaseConfigured, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Rising Star is computed entirely server-side (see supabase/history/38_migration_rising_star_scoring.sql's
// compute_rising_stars()) from real, recent-window activity — never from a lifetime total, and
// never from anything this client hands it. Everything here is a thin, honestly-failing wrapper
// around that RPC, same non-blocking philosophy as the rest of Inkroot's sync layer
// (library.js, guild-progression-remote.js): a failed call never blocks or breaks the caller,
// it just means Living Universe falls back to its local Chronicle simulation for this section.

// Fetches the current top Rising Stars. windowDays/limit are optional previews of a different
// window/size — the WEIGHTS and FLOORS that actually decide the ranking always come from the
// moderator-tunable rising_star_config row server-side, never from here (see the migration's own
// comment on why compute_rising_stars() only accepts these two, and nothing that shapes the
// score itself). Returns [] (never throws) so a signed-out reader or an offline device just sees
// Living Universe fall back to its local Chronicle section instead of an error.
export async function fetchRisingStars({ windowDays, limit } = {}) {
  if (!isSupabaseConfigured) return [];
  try {
    const user = await currentUser();
    if (!user) return []; // compute_rising_stars() is authenticated-only, same as every other real RPC in this app
    const { data, error } = await supabase.rpc('compute_rising_stars', {
      p_window_days: windowDays || null,
      p_result_limit: limit || null,
    });
    if (error) throw sanitizeError(error);
    return (data || []).map((row) => ({
      authorId: row.author_id,
      name: row.pen_name || row.display_name || 'A writer',
      avatarUrl: row.avatar_url || null,
      recentUniqueReaders: row.recent_unique_readers || 0,
      readingGrowth: row.reading_growth || 0,
      followersGained: row.followers_gained || 0,
      bookEngagement: Number(row.book_engagement) || 0,
      recentPublishes: row.recent_publishes || 0,
      reputationGained: Number(row.reputation_gained) || 0,
      score: Number(row.score) || 0,
    }));
  } catch {
    return [];
  }
}

// Logs "this reader opened this book" toward Rising Star's real-reads signal. Fire-and-forget —
// called from onRead alongside the existing local reading-progress tracking, never blocking or
// failing the actual read. The server (log_book_read's on-conflict-do-nothing, scoped to one row
// per reader/book/UTC day) is what actually prevents this from being spammed into an inflated
// count; this function doesn't try to dedupe client-side, since that protection has to live
// where it can't be bypassed by a modified client.
export async function logBookRead(bookId) {
  if (!isSupabaseConfigured || !bookId) return;
  try {
    const user = await currentUser();
    if (!user) return;
    await supabase.rpc('log_book_read', { p_book_id: bookId });
  } catch {
    // Best-effort only — a reader's book still opens normally either way.
  }
}

// One heartbeat toward nairaReader/nairaLoyal's verified-reading-minutes signal (see
// supabase/history/53_migration_naira_writing_and_reading_signals.sql). Called from
// PublishedBookReader roughly once a minute, only while the tab is actually visible — see the
// hook there for the visibility gating; this function itself sends nothing but "I'm still here,"
// the server decides how much (if any) of that to actually credit. record_reading_heartbeat
// throttles against its own clock (not anything this call claims about elapsed time) and caps
// the daily total, so calling this more often than intended is harmless, not exploitable — same
// fire-and-forget, never-blocks-the-read philosophy as logBookRead above.
export async function recordReadingHeartbeat(bookId) {
  if (!isSupabaseConfigured || !bookId) return;
  try {
    const user = await currentUser();
    if (!user) return;
    await supabase.rpc('record_reading_heartbeat', { p_book_id: bookId });
  } catch {
    // Best-effort only — never interrupts reading.
  }
}
