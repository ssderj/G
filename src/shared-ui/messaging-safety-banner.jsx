import React, { useState } from 'react';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ---------- Anti-impersonation, piece 4 of 4 ----------
// (Pieces 1-3: shared-utils/identity-safety.js's reserved/lookalike names, supabase
// schema.sql's `profiles.verified` badge, and lib/reports.js's impersonation/scam report
// reasons.)
//
// A verified badge and a report button both help AFTER someone has already been fooled — this
// banner is the one piece meant to stop the scam from landing in the first place, regardless of
// who's impersonating whom or whether they've been caught yet. It works because the actual harm
// in an impersonation scam isn't the fake name — it's the moment a reader is asked to pay,
// click, or hand over something outside the app. Naming that moment explicitly, right where
// people read messages from other real accounts (Fireside, Guild Bookshelf feedback), inoculates
// against it independent of any name/account-level detection ever catching up.
//
// Dismissible per device (not per-guild, not server-synced) — same "small local flag, not worth
// a sync round trip" pattern as LIBRARY_FAVORITES_KEY etc. in library/publishing.jsx. Reappears
// if localStorage is cleared or on a new device; that's an acceptable tradeoff for a notice whose
// entire purpose is to be seen, not to track acknowledgment.
const DISMISSED_KEY = 'inkroot.safetyBannerDismissed.v1';

function readDismissed() {
    try {
        return localStorage.getItem(DISMISSED_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function writeDismissed() {
    try {
        localStorage.setItem(DISMISSED_KEY, '1');
    } catch (e) { /* best-effort — a failed write just means it reappears next visit */ }
}

// `context` customizes the wording slightly for where it's shown (e.g. "Fireside" vs "Guild
// Bookshelf") without needing a separate component per surface.
export function MessagingSafetyBanner({ context = 'this space' }) {
    const [dismissed, setDismissed] = useState(readDismissed);
    if (dismissed) return null;
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'flex-start', gap: SPACE_SCALE[8], padding: '10px 14px', marginBottom: 14,
            borderRadius: RADIUS_SCALE[10], background: 'rgba(200,155,60,0.08)', border: '1px solid rgba(200,155,60,0.28)',
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[13], lineHeight: 1, marginTop: 1 } }, "\u26A0\uFE0F"),
        React.createElement("div", { style: { flex: 1, fontSize: TYPE_SCALE[11], color: '#C9BE8D', lineHeight: 1.5 } },
            `Inkroot never asks you to pay outside the app. Be cautious of anyone in ${context} asking to be paid via gift cards, crypto, wire transfer, or an outside link — even a verified account.`,
            " Use the \u2691 report button on anything that looks like a scam."),
        React.createElement("button", { onClick: () => { writeDismissed(); setDismissed(true); }, title: "Dismiss", style: {
                background: 'none', border: 'none', color: '#8A7355', fontSize: TYPE_SCALE[14], cursor: 'pointer', padding: 0, lineHeight: 1, flexShrink: 0,
            } }, "\u2715"));
}
