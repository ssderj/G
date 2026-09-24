import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { onAuthChange, getSession, signOut, signInWithGoogle, signInWithPasskey, registerPasskey } from '../lib/auth.js';
import { switchSyncUser, clearSyncUser, fullResync, listConflictBackups, restoreConflictBackup, dismissConflictBackup } from '../lib/syncEngine.js';
import { storage } from '../lib/storage.js';
import { GUILD_KEY } from '../shared-utils/storage-keys.jsx';
import { syncFounderGuildMembership } from '../lib/library-guild.js';
import { redeemPendingReferralCode } from '../lib/referrals.js';

// Account sync used to be a floating "Sync · off" badge rendered by main.jsx on top of the whole
// app, outside its component tree entirely — which meant it showed up fixed in the corner of
// every single screen (Home, the Grand Library, a project workspace, the Guild Hall...) whether
// or not sync had anything to do with what was on screen. Moving the session/auth logic into a
// context here lets exactly one place — the Home dashboard, via AccountSyncControl in
// account-sync-control.jsx — render the actual control, while everything else can ignore it
// entirely. The session logic itself (onAuthChange wiring, the online-retry effect, sign-out,
// Google OAuth, passkeys) is unchanged from what main.jsx used to own directly.
export const SyncContext = createContext(null);

export function useSync() {
    return useContext(SyncContext);
}

export function SyncProvider({ children }) {
    const [session, setSession] = useState(null);
    const [ready, setReady] = useState(false);
    const [oauthError, setOauthError] = useState('');
    const [justSignedIn, setJustSignedIn] = useState(false);

    // FIX — shared bookkeeping between the explicit getSession() hydration and the
    // onAuthStateChange listener below (see the second useEffect for why both now exist). Both
    // can observe the very first real session of this page load, so this lives in refs rather
    // than a `let` local to just one of the two — that's what keeps "have we already marked the
    // app ready" / "have we already synced this user" consistent no matter which of the two
    // notices it first, instead of the two stepping on each other or double-firing switchSyncUser.
    const readyRef = useRef(false);
    const hadSessionRef = useRef(false);
    const syncedUserIdRef = useRef(null);

    useEffect(() => {
        // Google OAuth is a redirect flow (see lib/auth.js's signInWithGoogle) — a rejection
        // (e.g. this account is login-banned) happens server-side, AFTER the redirect away and
        // back, so unlike passkey sign-in (see account-sync-control.jsx's handlePasskeySignIn)
        // it can't be caught as a thrown error at the signInWithGoogle() call site — that call
        // just starts the redirect and returns immediately. Supabase instead reports a rejection
        // by appending error/error_description to the redirect URL itself, so that's read here,
        // once, on load. The substring check below is a best effort, same caveat as the passkey
        // path: Supabase's exact error_description wording for a banned account isn't something
        // verifiable from this environment — check it against your own project if this matters.
        const params = new URLSearchParams(window.location.hash ? window.location.hash.slice(1) : window.location.search);
        const err = params.get('error_description') || params.get('error');
        if (err) {
            // URLSearchParams.get() has already percent-decoded this (and turned '+' into a space).
            // Decoding it a second time threw a URIError -- uncaught inside this effect, so it
            // blanked the whole app -- for any description containing a literal '%'.
            const decoded = err;
            // decoded here is a raw error_description straight from Supabase's own OAuth
            // redirect — used only to classify against the "banned" pattern below, never
            // displayed directly (see account-sync-control.jsx's handlePasskeySignIn for the
            // equivalent passkey-flow check and why the same rule applies there).
            setOauthError(/banned/i.test(decoded)
                ? "This account has been restricted from signing in. If you believe this is a mistake, please reach out to appeal."
                : "Something went wrong signing in with Google. Please try again.");
            // Scrubs the error out of the visible URL so reloading the page doesn't keep
            // re-showing it, and it doesn't linger visibly in the address bar.
            window.history.replaceState(null, '', window.location.pathname);
        } else if (params.get('code') || params.get('access_token')) {
            // FIX — a SUCCESSFUL Google return leaves `?code=...&state=...` (PKCE flow) or
            // `#access_token=...` (implicit flow) sitting in the address bar. supabase-js reads
            // and exchanges it automatically on load (see lib/auth.js) but never removes it from
            // the URL itself — only the error branch above ever did that. A PKCE auth code is
            // single-use and only valid for a few minutes (Supabase rejects a second exchange of
            // the same code), so leaving it in the URL meant refreshing the page right after
            // signing in resubmitted that already-used code, the second exchange silently
            // produced no session, and the app looked signed-out again — this is "logged in
            // works, but doesn't survive a refresh". Stripping it immediately, the same way the
            // error branch already did, fixes that: by the time this effect runs, the Supabase
            // client (constructed at module load, before React even mounts) has already read
            // whatever it needed from the URL — same timing the pre-existing error-cleanup line
            // above already relied on — so clearing it here doesn't race the exchange itself.
            window.history.replaceState(null, '', window.location.pathname);
        }
    }, []);

    useEffect(() => {
        // Single handler fed by two sources below — the explicit getSession() call and the
        // onAuthStateChange listener — so "did we already mark ready", "did we already show the
        // just-signed-in confirmation", and "did we already sync this user's data" all stay
        // correct regardless of which source notices a given session change first.
        const handleSession = (s) => {
            setSession(s);
            if (!readyRef.current) {
                readyRef.current = true;
                hadSessionRef.current = !!s;
                setReady(true);
            } else if (s && !hadSessionRef.current) {
                // A genuine sign-in completing DURING this page load — Google's redirect-back
                // landing, or a passkey prompt resolving — as opposed to already being signed in
                // when the app first booted (that's the branch above, which stays silent; nobody
                // needs a "you're signed in" toast every time they just open the app). This is
                // the fix for the actual confusion: Google OAuth redirects the whole page away
                // and back with zero visual continuity, so without an explicit confirmation here,
                // landing back on Home gives no sign whatsoever that anything happened — see
                // account-sync-control.jsx, which auto-opens the panel and shows this.
                hadSessionRef.current = true;
                setJustSignedIn(true);
            } else if (!s) {
                hadSessionRef.current = false;
            }
            if (s) {
                if (syncedUserIdRef.current === s.user.id) return; // already synced this user this load
                syncedUserIdRef.current = s.user.id;
                // also clears any other account's leftover local data first
                switchSyncUser(s.user.id).then(async () => {
                    // Backfill: covers the common case of joining a Founder Guild while signed
                    // out, then signing in later — ink-root.jsx's own load-time backfill only
                    // catches a membership that's already local *when the app boots*, not one
                    // that becomes attributable to an account only once sign-in happens after.
                    // Reads GUILD_KEY post-resync (switchSyncUser already awaited pulling this
                    // account's own remote data), so this reflects the signed-in account's own
                    // guild membership, not a different account's leftover local state.
                    try {
                        const res = await storage.get(GUILD_KEY);
                        const guildProfile = res && JSON.parse(res.value);
                        if (guildProfile && guildProfile.guildType === 'founder' && guildProfile.founderGuildId) {
                            await syncFounderGuildMembership(guildProfile.founderGuildId);
                        }
                    } catch (e) {
                        console.warn('Inkroot: founder guild membership backfill failed', e);
                    }

                    // Fire-and-forget, same non-blocking philosophy as the backfill above.
                    // redeemPendingReferralCode() itself no-ops when there's no locally-cached
                    // code, and is safe to attempt on every sign-in (idempotent server-side) —
                    // see src/lib/referrals.js.
                    redeemPendingReferralCode();
                });
            } else {
                syncedUserIdRef.current = null;
                clearSyncUser();
            }
        };

        let cancelled = false;
        // FIX — explicit getSession() call, IN ADDITION to the onAuthStateChange listener below
        // (previously the only source, see its own comment for what it still covers). The
        // original design relied solely on onAuthStateChange's first callback to already reflect
        // a session freshly restored from the Google OAuth redirect. getSession() and that first
        // callback are supposed to resolve to the same thing, but they're not guaranteed to be
        // consistent the moment this component mounts: getSession() always waits for the client's
        // pending initialize()/URL-code-exchange to finish before resolving, while the listener's
        // very first callback can fire from whatever session state the client already had
        // *before* that exchange completes — i.e. null. That's exactly "Google OAuth is now
        // working... but Inkroot does not recognize me as logged in": the redirect and exchange
        // both succeeded, but the app had already latched `ready = true` / signed-out off an
        // initial callback that ran a beat too early. Calling getSession() directly here always
        // waits for the real outcome, so it catches that exact case without removing the listener
        // itself, which is still what's needed for sign-out, a later sign-in, passkeys, and
        // cross-tab session changes.
        getSession().then((s) => {
            if (cancelled) return;
            handleSession(s);
        });

        const unsubscribe = onAuthChange((s) => {
            if (cancelled) return;
            handleSession(s);
        });

        return () => { cancelled = true; unsubscribe(); };
    }, []);

    // Retry sync whenever the device comes back online — the outbox already holds anything
    // written while offline, this just stops it from waiting for the next local edit to flush.
    useEffect(() => {
        const handler = () => { if (session) fullResync(); };
        window.addEventListener('online', handler);
        return () => window.removeEventListener('online', handler);
    }, [session]);

    // Item 10 (fix tracker) — the recovery UI for syncEngine.js's own conflict-backup safety net.
    // backupLosingLocalEdit (syncEngine.js) already saves a losing local edit to IndexedDB's
    // conflictBackups store and fires 'inkroot:sync-conflict' whenever "remote wins" would
    // otherwise discard it silently; nothing was listening for that event until now. Loaded once
    // on mount (not just on the event) because a conflict can have been backed up during a
    // previous session/background sync, before anything was mounted to hear about it — the
    // writer should still see it the next time they open the app, not only if one happens to
    // occur while they're already looking at the screen.
    const [conflictBackups, setConflictBackups] = useState([]);
    const refreshConflictBackups = () => listConflictBackups().then(setConflictBackups).catch((e) => console.warn('Inkroot: listConflictBackups failed', e));
    useEffect(() => {
        refreshConflictBackups();
        const handler = () => refreshConflictBackups();
        window.addEventListener('inkroot:sync-conflict', handler);
        return () => window.removeEventListener('inkroot:sync-conflict', handler);
    }, []);
    const restoreConflict = (id) => restoreConflictBackup(id).then((ok) => { if (ok) refreshConflictBackups(); return ok; });
    const dismissConflict = (id) => dismissConflictBackup(id).then(refreshConflictBackups);

    const value = {
        session, ready, signOut, signInWithGoogle, signInWithPasskey, registerPasskey, oauthError, justSignedIn, clearJustSignedIn: () => setJustSignedIn(false),
        conflictBackups, restoreConflict, dismissConflict,
    };
    return React.createElement(SyncContext.Provider, { value }, children);
}
