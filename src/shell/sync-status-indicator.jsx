import React, { useEffect, useState } from 'react';
import { getRejectedSyncKeys } from '../lib/syncEngine.js';
import { useSync } from './sync-context.jsx';

// ---------- Persistent sign-in status dot ----------
// Answers exactly one question: "am I online (signed in and syncing) right now?" That's
// different from the account CONTROL surface (AccountSyncControl, Home-only, lets you actually
// sign in/out/delete) — this is read-only status. Home-only on purpose (see below) — it used to
// mount once above NavigationProvider and float over every screen in the app, which meant it hung
// over project workspaces, the reader, the moderation queue, everywhere, rather than reading as
// part of the Home dashboard it's actually answering for. Rendered directly by HomeScreen now, so
// it only ever appears there.
//
// A plain color dot rather than a text pill: green while online and syncing, amber when the
// server refused something, muted grey when signed in but this device has no network connection,
// red the moment there's nothing to sync to (signed out — this device only). No label text sits
// next to it; the title tooltip carries the same detail for anyone who taps or hovers to ask.
//
// "Online" here used to mean only "there's a session" — a signed-in writer who lost wifi or
// switched on flight mode kept seeing green while nothing was actually syncing. The grey state
// tracks the browser's own connectivity flag (navigator.onLine + the window 'online'/'offline'
// events — the same 'online' event sync-context.jsx already uses to retry the outbox). Caveat,
// straight from how browsers define it: `false` reliably means no network at all, but `true` only
// means the device has *a* connection, not that Inkroot's server is reachable through it — so a
// captive portal or an outage on the server's side still reads as green here. That's deliberate
// scope: this indicator does not probe the server or track individual sync attempts.
//
// Deliberately not interactive (no onClick / navigation) — wiring this into Home's tab state
// would mean threading a callback down through InkrootApp/InkRoot just for this, and the title
// tooltip already tells anyone who's confused where to go. Revisit if that turns out not to be
// enough.
export function SyncStatusIndicator() {
    const sync = useSync();
    // Number of items the server refused to accept (see syncEngine.js's rejectedKeys). Without
    // this the dot stayed green for a signed-in writer whose manuscript could not actually be
    // backed up.
    const [rejected, setRejected] = useState(() => getRejectedSyncKeys().length);
    useEffect(() => {
        const handler = () => setRejected(getRejectedSyncKeys().length);
        window.addEventListener('inkroot:sync-rejected', handler);
        return () => window.removeEventListener('inkroot:sync-rejected', handler);
    }, []);
    // Browser connectivity flag — see the header comment for what `true` does and doesn't
    // guarantee. Read defensively (navigator can be absent outside a browser) and treated as
    // online unless the browser explicitly says otherwise.
    const [deviceOnline, setDeviceOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
    useEffect(() => {
        const goOnline = () => setDeviceOnline(true);
        const goOffline = () => setDeviceOnline(false);
        // Re-read once on mount in case connectivity changed between the initial render and this
        // effect running.
        setDeviceOnline(typeof navigator === 'undefined' || navigator.onLine !== false);
        window.addEventListener('online', goOnline);
        window.addEventListener('offline', goOffline);
        return () => {
            window.removeEventListener('online', goOnline);
            window.removeEventListener('offline', goOffline);
        };
    }, []);
    if (!sync || !sync.ready) return null;
    const { session } = sync;
    const online = !!session;
    // Signed in, but the device itself is offline. Takes precedence over `stuck`: while there's no
    // network, "couldn't be backed up" would blame the changes rather than the connection.
    // Signed out stays red regardless — "this device only" is the more basic fact.
    const unreachable = online && !deviceOnline;
    const stuck = online && !unreachable && rejected > 0;
    return React.createElement(
        'div',
        {
            title: unreachable
                ? `Signed in, but this device is offline \u2014 changes are saved here and will sync when you're back online${session.user.email ? ` (${session.user.email})` : ''}.`
                : stuck
                ? "Signed in, but some changes couldn't be backed up (an item may be too large). They're saved on this device. Manage this from Home."
                : online
                ? `Online \u2014 syncing${session.user.email ? ` (${session.user.email})` : ''}. Manage this from Home.`
                : "Offline \u2014 this device only. Sign in from Home to back up and sync across devices.",
            style: {
                position: 'fixed', top: 10, right: 10, zIndex: 40,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, borderRadius: '50%',
                background: 'rgba(23,19,14,0.88)', border: '1px solid #3A3020',
                pointerEvents: 'auto', userSelect: 'none', backdropFilter: 'blur(2px)',
            },
        },
        React.createElement('span', {
            style: {
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: unreachable ? '#9C9280' : stuck ? '#E0A030' : online ? '#5FBF6B' : '#D9534F',
                boxShadow: unreachable ? '0 0 5px rgba(156,146,128,0.6)' : stuck ? '0 0 5px rgba(224,160,48,0.75)' : online ? '0 0 5px rgba(95,191,107,0.75)' : '0 0 5px rgba(217,83,79,0.75)',
            },
        })
    );
}
