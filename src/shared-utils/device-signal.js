// ---------- Anti-impersonation, piece 6 — soft ban-evasion signal ----------
// (Pieces 1-5: shared-utils/identity-safety.js's reserved/lookalike names, supabase
// schema.sql's `profiles.verified` badge, lib/reports.js's impersonation/scam report reasons,
// shared-ui/messaging-safety-banner.jsx, and real author accounts via lib/profile.js's
// fetchPublicProfile.)
//
// Why this is a SIGNAL and not a BAN, on purpose:
//
// There's no way to reliably "ban a device" for a web app, and it's worth being honest about why
// rather than pretend otherwise. A device id worth trusting would need to survive the user
// clearing site data, opening a private/incognito window, or switching browsers — nothing
// generated client-side (this one included) survives any of those, so it can never be a real
// block, only ever a hint. The alternatives that ARE hard to clear (canvas/audio/WebGL
// fingerprinting) bring real legal exposure (GDPR/CCPA consent requirements) and are exactly the
// kind of thing that gets an app flagged by app stores — not something to reach for quietly. The
// one genuinely robust version of "this device is banned" — Apple's App Attest, Google's Play
// Integrity — only works from inside a real native app shell with its own store/signing setup,
// which this web app doesn't have.
//
// So: this id is a plain random value with no invasive fingerprinting behind it at all, recorded
// against whichever account(s) sign in on this browser (see recordDeviceSignal in
// lib/moderation.js), surfaced to a moderator reviewing a report as "this account has also
// signed in on the same browser as: X (banned), Y" — see fetchDeviceCorrelation. A moderator
// still decides what that means; it never auto-blocks anything on its own. Google-OAuth/passkey-
// only signup (no anonymous email signup) already raises the cost of making many fresh accounts
// more than this signal does — this exists to catch the common case of someone who doesn't
// bother clearing storage, not to stop someone determined to evade it.

const DEVICE_ID_KEY = 'inkroot.deviceSignalId.v1';

// Lazily creates one on first call, then reuses it for the life of this browser's storage —
// cleared the same way any other localStorage value would be, which is exactly the point: this
// is meant to be exactly as easy to clear as everything else already living in localStorage, not
// harder.
export function getDeviceSignalId() {
    try {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if (!id) {
            id = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
            localStorage.setItem(DEVICE_ID_KEY, id);
        }
        return id;
    } catch (e) {
        return null; // localStorage unavailable (private mode, disabled storage, etc.) — signal just isn't recorded this session
    }
}
