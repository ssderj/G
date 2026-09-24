import { supabase } from './supabaseClient.js';
import { fetchProfileNames, fetchPublicProfile } from './profile.js';
import { getDeviceSignalId } from '../shared-utils/device-signal.js';
import { sanitizeError } from './errors.js';

// ---------- Moderation queue backend ----------
// Powers src/moderation/moderation-queue.jsx. Everything here relies entirely on Postgres RLS
// (see schema.sql's `is_moderator` column and the "moderators read/update all reports" policies)
// to actually restrict access — a non-moderator calling any of these just gets an empty result
// or a permission error from Supabase, same as calling them signed out. There's no separate
// client-side gate to keep in sync with the database's.

// Whether `userId` is a moderator — gates whether the app shows a way to open the queue at all
// (see shell/ink-root.jsx). Purely a UI convenience: the real enforcement is server-side RLS, so
// this returning true/false wrong (e.g. a stale cache) can't itself grant or deny real access.
export async function fetchIsModerator(userId) {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('profiles')
    .select('is_moderator')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw sanitizeError(error);
  return !!(data && data.is_moderator);
}

// Whether `userId` is an Inkroot platform admin — a separate trust flag from is_moderator above
// (see 43_migration_inkroot_events_admin.sql for why they're kept apart: content moderation and
// authorizing real cash-prize payouts are different trust domains). Gates whether the app shows
// a way to open the Inkroot Events admin screen at all (see shell/ink-root.jsx) — same "purely a
// UI convenience, real enforcement is server-side" caveat as fetchIsModerator.
export async function fetchIsPlatformAdmin(userId) {
  if (!userId) return false;
  const { data, error } = await supabase
    .from('profiles')
    .select('is_platform_admin')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw sanitizeError(error);
  return !!(data && data.is_platform_admin);
}

// Batched sibling of fetchIsPlatformAdmin above, same shape/purpose as profile.js's
// fetchVerifiedIds — one round trip for a whole list of ids instead of one per id. Used by the
// Guild Notice Board (guild/notice-board.jsx) to tell which authors of a Founder Guild's
// 'announcement'-category Fireside posts are actually real Inkroot admins (the only real officer
// authority a Founder Guild has server-side — see is_guild_officer() in
// 69_migration_founder_guild_parity.sql) versus just a member who picked that category.
export async function fetchPlatformAdminIds(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  const { data, error } = await supabase
    .from('profiles')
    .select('id, is_platform_admin')
    .in('id', ids);
  if (error) throw sanitizeError(error);
  return new Set((data || []).filter((row) => row.is_platform_admin).map((row) => row.id));
}

// `status` filters to one queue tab ('open', 'reviewed', 'dismissed', 'actioned'); omit for
// every status. Attaches reporter_name and resolved_by_name the same way withReviewerNames does
// in lib/library.js — looked up live, never trusted from a stored copy.
export async function fetchReports(status) {
  let query = supabase.from('content_reports').select('*').order('created_at', { ascending: false });
  if (status) query = query.eq('status', status);
  const { data, error } = await query;
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const ids = [...new Set([...rows.map((r) => r.reporter_id), ...rows.map((r) => r.resolved_by).filter(Boolean)])];
  const names = await fetchProfileNames(ids);
  return rows.map((r) => ({
    id: r.id, reporterId: r.reporter_id, reporterName: names[r.reporter_id],
    contentType: r.content_type, contentId: r.content_id, guildId: r.guild_id,
    reason: r.reason, details: r.details, status: r.status,
    resolvedById: r.resolved_by, resolvedByName: r.resolved_by ? names[r.resolved_by] : null,
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).getTime() : null,
    createdAt: new Date(r.created_at).getTime(),
  }));
}

// Marks a report reviewed/dismissed/actioned (or back to open). resolved_by/resolved_at are
// stamped server-side by the stamp_report_resolution trigger — never sent from here — so who
// actioned a report can't be spoofed by the client.
export async function updateReportStatus(reportId, status) {
  const { error } = await supabase.from('content_reports').update({ status }).eq('id', reportId);
  if (error) throw sanitizeError(error);
}

// A short, moderator-facing preview of whatever a report points at — the text a moderator
// actually needs to judge the report, plus who posted it. Returns null (rather than throwing)
// for content that's already gone (e.g. the writer deleted the post/book since the report was
// filed) — the queue shows "content no longer available" in that case rather than blocking on it.
export async function fetchReportedContentPreview(report) {
  try {
    switch (report.contentType) {
      case 'published_book': {
        const { data } = await supabase.from('published_books').select('title, blurb, author_id, removed_by_moderator').eq('id', report.contentId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.author_id]);
        return { text: `${data.title}\n\n${data.blurb || ''}`.trim(), authorId: data.author_id, authorName: names[data.author_id], removed: !!data.removed_by_moderator };
      }
      case 'guild_published_book': {
        const { data } = await supabase.from('guild_published_books').select('title, blurb, author_id').eq('book_id', report.contentId).eq('guild_id', report.guildId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.author_id]);
        return { text: `${data.title}\n\n${data.blurb || ''}`.trim(), authorId: data.author_id, authorName: names[data.author_id] };
      }
      case 'fireside_post': {
        const { data } = await supabase.from('fireside_posts').select('body, author_id, removed_by_moderator').eq('id', report.contentId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.author_id]);
        return { text: data.body, authorId: data.author_id, authorName: names[data.author_id], removed: !!data.removed_by_moderator };
      }
      case 'guild_book_feedback': {
        const { data } = await supabase.from('guild_book_feedback').select('note, stars, author_id, removed_by_moderator').eq('id', report.contentId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.author_id]);
        return { text: `${data.stars}\u2605 \u2014 ${data.note || '(no written note)'}`, authorId: data.author_id, authorName: names[data.author_id], removed: !!data.removed_by_moderator };
      }
      case 'review': {
        const { data } = await supabase.from('reviews').select('body, reviewer_id, removed_by_moderator').eq('id', report.contentId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.reviewer_id]);
        return { text: data.body || '(no written review)', authorId: data.reviewer_id, authorName: names[data.reviewer_id], removed: !!data.removed_by_moderator };
      }
      case 'book_discussion_post': {
        const { data } = await supabase.from('book_discussion_posts').select('body, author_id, removed_by_moderator').eq('id', report.contentId).maybeSingle();
        if (!data) return null;
        const names = await fetchProfileNames([data.author_id]);
        return { text: data.body, authorId: data.author_id, authorName: names[data.author_id], removed: !!data.removed_by_moderator };
      }
      case 'account': {
        // The reported "content" IS the account itself — content_id holds their uuid directly
        // (see schema.sql's content_type comment), so there's no separate row to look up first.
        const profile = await fetchPublicProfile(report.contentId);
        if (!profile) return null;
        return { text: `Account: ${profile.name}${profile.verified ? ' (verified)' : ''}`, authorId: profile.id, authorName: profile.name };
      }
      default:
        return null;
    }
  } catch (e) {
    console.warn('Inkroot: fetchReportedContentPreview failed', e);
    return null;
  }
}

// Which table backs each removable content_type (see fetchReportedContentPreview above for the
// same mapping already used to fetch a preview) — every one of these tables uses `id` as both
// its primary key and content_reports.content_id, so no per-table id-column lookup is needed.
// 'guild_published_book' and 'account' are deliberately absent: neither was in scope for item 8
// (a Founder Guild's book listing and an account itself are different removal problems), so
// there's no removed_by_moderator column on either and this map is what keeps the "Remove
// content" button from ever showing for them.
const MODERATABLE_CONTENT_TABLES = {
  published_book: 'published_books',
  fireside_post: 'fireside_posts',
  guild_book_feedback: 'guild_book_feedback',
  review: 'reviews',
  book_discussion_post: 'book_discussion_posts',
};

// Hides (or restores) the content behind a report from everyone but its author and moderators —
// see 78_migration_moderator_content_removal.sql for the full reasoning on why this is a soft
// flag rather than a real DELETE. Enforced server-side by that migration's per-table
// "moderators remove ..." policy plus protect_content_from_moderator_edits, which is what stops
// this call from being able to touch anything on the row besides removed_by_moderator — a
// non-moderator's call here fails outright rather than silently no-opping.
export async function setContentRemoved(report, removed) {
  const table = MODERATABLE_CONTENT_TABLES[report.contentType];
  if (!table) throw new Error('This content type cannot be removed from here.');
  const { error } = await supabase.from(table).update({ removed_by_moderator: removed }).eq('id', report.contentId);
  if (error) throw sanitizeError(error);
}

// A moderator sets or clears a content ban (see schema.sql's `banned` column and its comment for
// exactly what this does and doesn't stop). Enforced server-side by the "moderators manage other
// accounts" RLS policy plus protect_admin_profile_columns — a non-moderator's call here fails
// (or silently no-ops the banned/ban_reason change) regardless of what this function sends.
export async function banAccount(userId, reason) {
  const { error } = await supabase.from('profiles').update({ banned: true, ban_reason: (reason || '').trim().slice(0, 500) || null }).eq('id', userId);
  if (error) throw sanitizeError(error);
}

export async function unbanAccount(userId) {
  const { error } = await supabase.from('profiles').update({ banned: false, ban_reason: null }).eq('id', userId);
  if (error) throw sanitizeError(error);
}

// A moderator grants or revokes the verified badge (schema.sql's `profiles.verified` — see that
// column's comment) — the in-app counterpart to the raw-SQL flip this used to require. Same
// enforcement path as banAccount/unbanAccount above; is_moderator itself is NOT grantable this
// way (or any way from the client) — see protect_admin_profile_columns' comment for why minting
// a moderator stays a service_role-only action.
export async function setVerified(userId, verified) {
  const { error } = await supabase.from('profiles').update({ verified }).eq('id', userId);
  if (error) throw sanitizeError(error);
}

// The real login ban — see schema.sql's admin_set_login_ban() comment for the full reasoning on
// how this actually blocks sign-in without needing a service-role key on the client or a
// separately-deployed server. A rejected call here (not a moderator, or targeting your own
// account) surfaces as a thrown error with the message the RPC raised.
export async function banAccountLogin(userId, reason) {
  const { error } = await supabase.rpc('admin_set_login_ban', { target_user_id: userId, should_ban: true, reason: (reason || '').trim().slice(0, 500) || null });
  if (error) throw sanitizeError(error);
}

export async function unbanAccountLogin(userId) {
  const { error } = await supabase.rpc('admin_set_login_ban', { target_user_id: userId, should_ban: false });
  if (error) throw sanitizeError(error);
}

// Whether `userId` is currently content-banned, login-banned, and/or verified, plus reasons —
// used by the moderation queue to show account status next to a reported account and to decide
// which actions to offer.
export async function fetchAccountStatus(userId) {
  if (!userId) return { banned: false, banReason: null, loginBanned: false, loginBanReason: null, verified: false };
  const { data, error } = await supabase.from('profiles').select('banned, ban_reason, login_banned, login_ban_reason, verified').eq('id', userId).maybeSingle();
  if (error) throw sanitizeError(error);
  return {
    banned: !!(data && data.banned), banReason: data ? data.ban_reason : null,
    loginBanned: !!(data && data.login_banned), loginBanReason: data ? data.login_ban_reason : null,
    verified: !!(data && data.verified),
  };
}

// Records that the CURRENT browser (see shared-utils/device-signal.js — a plain random id, not
// a fingerprint) has been used to sign in as `userId`. Called once per session from
// shell/ink-root.jsx whenever a sign-in is detected. Best-effort and silent on failure, same
// spirit as syncProfile — a signal that fails to record just means one less data point for a
// moderator later, never something that should interrupt the person signing in.
export async function recordDeviceSignal(userId) {
  const deviceId = getDeviceSignalId();
  if (!deviceId || !userId) return;
  try {
    await supabase.from('device_signals').upsert({ device_id: deviceId, user_id: userId, last_seen: new Date().toISOString() }, { onConflict: 'device_id,user_id' });
  } catch (e) {
    console.warn('Inkroot: recordDeviceSignal failed', e);
  }
}

// For a moderator reviewing a report: every OTHER account that has signed in on any of the same
// device ids as `userId` — see shared-utils/device-signal.js for exactly what this is (a soft
// correlation signal) and is not (a fingerprint, a block). Returns [] on any failure or for a
// non-moderator caller (RLS on device_signals only grants read to moderators), same
// fail-quiet-not-fail-loud posture as fetchPublishedAuthorNames.
export async function fetchDeviceCorrelation(userId) {
  if (!userId) return [];
  try {
    const { data: ownRows, error: ownErr } = await supabase.from('device_signals').select('device_id').eq('user_id', userId);
    if (ownErr) throw sanitizeError(ownErr);
    const deviceIds = [...new Set((ownRows || []).map((r) => r.device_id))];
    if (deviceIds.length === 0) return [];
    const { data: sharedRows, error: sharedErr } = await supabase.from('device_signals').select('user_id').in('device_id', deviceIds).neq('user_id', userId);
    if (sharedErr) throw sanitizeError(sharedErr);
    const otherIds = [...new Set((sharedRows || []).map((r) => r.user_id))];
    if (otherIds.length === 0) return [];
    const [names, statuses] = await Promise.all([
      fetchProfileNames(otherIds),
      Promise.all(otherIds.map((id) => fetchAccountStatus(id).then((s) => [id, s]))),
    ]);
    const statusById = Object.fromEntries(statuses);
    return otherIds.map((id) => ({ id, name: names[id], banned: statusById[id].banned, loginBanned: statusById[id].loginBanned }));
  } catch (e) {
    console.warn('Inkroot: fetchDeviceCorrelation failed', e);
    return [];
  }
}

// ---------- Manage Admins (see 77_migration_admin_role_revocation.sql) ----------
// Deliberately revoke-only: granting is_moderator/is_platform_admin still requires the same
// manual service_role/SQL step it always has (see protect_admin_profile_columns' own comment on
// why minting either role stays out of the app entirely). This screen only lets an existing
// platform admin take trust AWAY from an account, never hand it out — same "purely a UI
// convenience, real enforcement is server-side" caveat as fetchIsPlatformAdmin above.

// Every account that currently holds is_moderator and/or is_platform_admin — profiles' own
// "anyone can read profiles" policy already makes this readable by any signed-in caller, same as
// fetchIsPlatformAdmin; this just filters to the interesting rows instead of one id at a time.
export async function fetchPlatformRoleHolders() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, pen_name, display_name, is_moderator, is_platform_admin')
    .or('is_moderator.eq.true,is_platform_admin.eq.true')
    .order('display_name');
  if (error) throw sanitizeError(error);
  return (data || []).map((row) => ({
    id: row.id,
    name: row.pen_name || row.display_name || `Writer ${row.id.slice(0, 8)}`,
    isModerator: !!row.is_moderator,
    isPlatformAdmin: !!row.is_platform_admin,
  }));
}

// `role` is 'moderator' or 'platform_admin'. See admin_revoke_platform_role's own comment in
// schema.sql for the own-account guard and the audit-log insert this triggers.
export async function revokePlatformRole(userId, role, reason) {
  const { error } = await supabase.rpc('admin_revoke_platform_role', {
    target_user_id: userId, role, reason: (reason || '').trim().slice(0, 500) || null,
  });
  if (error) throw sanitizeError(error);
}

// The admin_role_revocations audit trail, newest first, with names resolved for both the target
// and the admin who acted — the "who removed whose access, and when" record item 7 was actually
// chasing.
export async function fetchRoleRevocationLog() {
  const { data, error } = await supabase
    .from('admin_role_revocations')
    .select('id, target_user_id, revoked_by, role, reason, created_at')
    .order('created_at', { ascending: false });
  if (error) throw sanitizeError(error);
  const rows = data || [];
  const names = await fetchProfileNames(rows.flatMap((r) => [r.target_user_id, r.revoked_by]));
  return rows.map((r) => ({
    id: r.id,
    role: r.role,
    reason: r.reason,
    createdAt: r.created_at,
    targetName: names[r.target_user_id] || 'Unknown',
    revokedByName: names[r.revoked_by] || 'Unknown',
  }));
}

