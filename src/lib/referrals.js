import { supabase, currentUser } from './supabaseClient.js';
import { sanitizeError } from './errors.js';

// See supabase/history/55_migration_referral_tracking.sql (tracking: codes, and recording who
// referred whom), supabase/history/56_migration_referral_rewards.sql (rewards: paying the
// referrer real Naira, but only once the referred account produces genuine economic activity —
// a qualifying purchase as a reader, real publish-and-earn activity as a writer, or a genuinely
// active guild — never a plain signup), and supabase/history/57_migration_referral_reward_
// platform_fee_funding.sql (funding: each reward is a small, fixed share of Inkroot's OWN
// platform fee on that qualifying activity, never a flat amount and never anything drawn from an
// author's or guild member's own agreed earnings). This module's own API (the RPCs it calls)
// hasn't changed since 56 — nairaRewardKobo simply reflects real fee revenue now instead of a
// fixed number.

const PENDING_REFERRAL_CODE_KEY = 'inkroot.pendingReferralCode.v1';

// Call once, as early as possible (see main.jsx), before Google's OAuth redirect can strip the
// URL. Stores whatever ?ref= code is present in localStorage — same "as easy to clear as
// everything else already living in localStorage" posture as shared-utils/device-signal.js — so
// it survives the full sign-out-and-back round trip an OAuth redirect requires. Never overwrites
// an already-stored code: the first link someone actually clicked wins, even if they later land
// on a different ?ref= link before finishing sign-in.
export function capturePendingReferralCodeFromUrl() {
    try {
        const params = new URLSearchParams(window.location.search);
        const code = params.get('ref');
        if (code && !localStorage.getItem(PENDING_REFERRAL_CODE_KEY)) {
            localStorage.setItem(PENDING_REFERRAL_CODE_KEY, code.trim().toLowerCase());
        }
    } catch (e) {
        // localStorage unavailable (private mode, disabled storage, etc.) — same defensive
        // shape as getDeviceSignalId(); a referral just isn't captured this session.
    }
}

// Call after every fresh sign-in (see sync-context.jsx's handleSession). Safe to call on every
// sign-in, not just the first ever: redeem_referral_code() is idempotent server-side, so a repeat
// call for an already-referred account is a no-op read, not an error. Clears the locally-cached
// code after a successful call either way (redeemed or already-was-referred) so this device
// stops re-attempting it on every future sign-in; leaves it in place on failure (e.g. offline, or
// the code turned out to be invalid) so a later retry is still possible.
export async function redeemPendingReferralCode() {
    let code;
    try {
        code = localStorage.getItem(PENDING_REFERRAL_CODE_KEY);
    } catch (e) {
        return null;
    }
    if (!code) return null;

    const user = await currentUser();
    if (!user) return null;

    try {
        const { data, error } = await supabase.rpc('redeem_referral_code', { p_code: code }).single();
        if (error) {
            // P0001 is one of redeem_referral_code's own deliberate rejections (no such code, or
            // the code is the caller's own) -- permanent, so retrying can never succeed. Left in
            // place it would also block capturePendingReferralCodeFromUrl (first link wins) from
            // ever storing a later, valid ?ref= link on this device. Network/other failures are
            // still kept for a later retry, exactly as before.
            if (error.code === 'P0001') {
                try { localStorage.removeItem(PENDING_REFERRAL_CODE_KEY); } catch (e) { /* ignore */ }
            }
            throw sanitizeError(error);
        }
        try { localStorage.removeItem(PENDING_REFERRAL_CODE_KEY); } catch (e) { /* ignore */ }
        return data;
    } catch (e) {
        console.warn('Inkroot: redeemPendingReferralCode failed', e);
        return null;
    }
}

// The signed-in user's own referral code, for building their shareable link
// (`${window.location.origin}?ref=${code}`). Returns null when signed out or offline — same
// fallback contract as every other fetchX in this codebase.
export async function fetchMyReferralCode() {
    const user = await currentUser();
    if (!user) return null;
    try {
        const { data, error } = await supabase.from('profiles').select('referral_code').eq('id', user.id).maybeSingle();
        if (error) throw sanitizeError(error);
        return (data && data.referral_code) || null;
    } catch (e) {
        console.warn('Inkroot: fetchMyReferralCode failed', e);
        return null;
    }
}

// Everyone the signed-in user has referred, most recent first — the raw rows (referee_id,
// status, created_at), not names; pair with fetchProfileNames() (lib/profile.js) the same way
// fetchPlayerGuildMembers() does if a caller needs display names next to each row.
export async function fetchMyReferrals() {
    const user = await currentUser();
    if (!user) return null;
    try {
        const { data, error } = await supabase
            .from('referrals')
            .select('referee_id, status, created_at')
            .eq('referrer_id', user.id)
            .order('created_at', { ascending: false });
        if (error) throw sanitizeError(error);
        return data || [];
    } catch (e) {
        console.warn('Inkroot: fetchMyReferrals failed', e);
        return null;
    }
}

// Real, server-verified reward progress across every referral the signed-in user has ever made
// (see 56_migration_referral_rewards.sql). referral_reward_progress() is more than a plain read —
// it's also the moment a qualifying (referral, kind) pair actually gets paid (there's no separate
// "claim" step, same non-claim shape as fetchNairaAchievementProgress), so this should be called
// whenever a "your referrals" screen is opened, not cached.
//
// Returns an array of { referralId, refereeId, kind, unlocked, nairaRewardKobo, reversed }, one
// row per (referral, reward kind) — up to three rows per referral, since a single referred
// account can independently trigger reader/writer/guild rewards over time. Returns null when
// signed out or offline — same fallback contract as every other fetchX in this codebase.
//
// `reversed` (see 59_migration_referral_reward_progress_reflects_reversals.sql) is true when a
// reward was granted and later clawed back — a refund or dispute landed on the qualifying
// activity after the fact. `unlocked` is false for a reversed reward (it means "you still have
// this," not "this was ever granted") — naira_reward_kobo stays populated either way, so a caller
// that wants to show a reversed reward as history (rather than hide it) still can.
export async function fetchReferralRewardProgress() {
    const user = await currentUser();
    if (!user) return null;
    try {
        const { data, error } = await supabase.rpc('referral_reward_progress');
        if (error) throw sanitizeError(error);
        return (data || []).map((row) => ({
            referralId: row.referral_id,
            refereeId: row.referee_id,
            kind: row.kind,
            unlocked: !!row.unlocked,
            reversed: !!row.reversed,
            nairaRewardKobo: row.naira_reward_kobo == null ? null : Number(row.naira_reward_kobo),
        }));
    } catch (e) {
        console.warn('Inkroot: fetchReferralRewardProgress failed', e);
        return null;
    }
}
