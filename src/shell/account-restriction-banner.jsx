import React, { useState, useEffect } from 'react';
import { useSync } from './sync-context.jsx';
import { fetchAccountStatus } from '../lib/moderation.js';
import { RADIUS_SCALE, TYPE_SCALE } from './nav-context.jsx';
import { InkIcon } from './ink-icon.jsx';

// Self-contained, same pattern as AccountSyncControl right next to it (reads its own session via
// useSync() rather than threading yet more props through HomeScreen). Shows a persistent notice
// — not permanently dismissible, since the restriction itself hasn't changed — when the
// signed-in account has been content-banned or login-banned, so a restricted person has SOME way
// to find out and why, instead of silently losing the ability to post with no explanation at
// all. This is what makes the moderation queue's ban tools accountable rather than invisible.
//
// Coverage is honestly partial for a login ban specifically: admin_set_login_ban (schema.sql)
// kills the banned account's session/refresh token immediately, so on their NEXT sign-in attempt
// they're simply blocked (see account-sync-control.jsx's ban-aware error handling for that
// case) — this banner can only ever be seen in the narrow window before that happens, if they
// were already signed in with a still-valid access token when the ban landed. It's still worth
// showing in that window rather than not, and it's the only one of the two ban types this
// component can miss — a content ban leaves someone fully signed in and using the app, so that
// case is always covered.
export function AccountRestrictionBanner() {
    const sync = useSync();
    const userId = sync && sync.session ? sync.session.user.id : null;
    const [status, setStatus] = useState(null);

    useEffect(() => {
        if (!userId) { setStatus(null); return; }
        let cancelled = false;
        fetchAccountStatus(userId).then((s) => { if (!cancelled) setStatus(s); }).catch(() => { if (!cancelled) setStatus(null); });
        return () => { cancelled = true; };
    }, [userId]);

    if (!status || (!status.banned && !status.loginBanned)) return null;

    return React.createElement("div", { style: {
            background: 'rgba(217,120,120,0.1)', border: '1px solid rgba(217,120,120,0.35)',
            borderRadius: RADIUS_SCALE[10], padding: '12px 16px', marginBottom: 16, color: '#E8B4B4',
            fontSize: TYPE_SCALE[12.5], lineHeight: 1.5,
        } },
        status.loginBanned
            ? React.createElement("div", null,
                React.createElement("strong", { style: { display: "inline-flex", alignItems: "center", gap: 6 } }, React.createElement(InkIcon, { name: "lock", size: 13 }), "Your account has been restricted from signing in."),
                status.loginBanReason ? ` Reason given: "${status.loginBanReason}."` : '',
                " If you believe this is a mistake, please reach out to appeal.")
            : React.createElement("div", null,
                React.createElement("strong", { style: { display: "inline-flex", alignItems: "center", gap: 6 } }, React.createElement(InkIcon, { name: "lock", size: 13 }), "Your account is currently restricted from publishing, posting, and reviewing."),
                status.banReason ? ` Reason given: "${status.banReason}."` : '',
                " You can still read and write privately. If you believe this is a mistake, please reach out to appeal."));
}
