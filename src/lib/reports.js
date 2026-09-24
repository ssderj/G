import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// Mirrors content_reports' `reason` check constraint in supabase/schema.sql — keep in sync if
// that constraint's allowed values ever change.
//
// 'impersonation' and 'scam' (added alongside the verified-badge system — see
// shared-utils/identity-safety.js) exist because before this, someone posing as another author
// or pushing an off-platform payment scam could only be reported as vague "Other," which gives a
// moderator nothing to prioritize on. An explicit reason here means a report against an
// impersonator is instantly distinguishable from a copyright complaint in the review queue.
export const REPORT_REASONS = [
  { key: 'impersonation', label: 'Impersonating someone else' },
  { key: 'scam', label: 'Scam or fraud' },
  { key: 'copyright', label: 'Copyright infringement' },
  { key: 'harassment', label: 'Harassment or abuse' },
  { key: 'spam', label: 'Spam' },
  { key: 'illegal', label: 'Illegal content' },
  { key: 'other', label: 'Other' },
];

// Files a report against a piece of published/shared content. Requires a signed-in user —
// content_reports' own insert policy requires auth.uid() = reporter_id, so this throws a clear
// error up front rather than letting the request round-trip to Supabase just to be rejected by
// RLS. contentType must be one of content_reports' allowed values (see schema.sql); guildId is
// only meaningful for guild-scoped content types and should be omitted/null otherwise.
export async function submitReport({ contentType, contentId, guildId = null, reason, details = '' }) {
  const user = await currentUser();
  if (!user)
    throw new Error('Sign in to report content.');
  const { error } = await supabase.from('content_reports').insert({
    reporter_id: user.id,
    content_type: contentType,
    content_id: String(contentId),
    guild_id: guildId || null,
    reason,
    // Matches the trim-and-cap pattern used elsewhere for free-text user input (e.g.
    // GuildBookFeedbackModal's note field caps at 500) — 1000 here since a report may
    // legitimately need more room to explain than a book-feedback note does.
    details: (details || '').trim().slice(0, 1000) || null,
  });
  if (error)
    throw sanitizeError(error);
}
