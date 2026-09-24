import React from 'react';
import { createRoot } from 'react-dom/client';
import { SyncProvider, useSync } from './shell/sync-context.jsx';
import InkrootApp from './App.jsx';
import { capturePendingReferralCodeFromUrl } from './lib/referrals.js';

// Older browsers and some embedded WebViews don't have structuredClone (it only shipped widely
// in 2022) — carried over from the original single-file app's own polyfill, since the app's
// data is all plain JSON and this fallback is safe.
if (typeof structuredClone !== 'function') {
  window.structuredClone = (obj) => JSON.parse(JSON.stringify(obj));
}

// As early as possible, before anything else runs — a ?ref= link followed by "Continue with
// Google" sends the browser away and back via a full page redirect, which would otherwise strip
// the query string before sync-context.jsx ever gets a chance to see it. This only ever writes
// to localStorage; the actual redemption call happens later, once there's a real signed-in
// session to redeem it against (see sync-context.jsx).
capturePendingReferralCodeFromUrl();

// Session/auth logic itself now lives in SyncProvider (see shell/sync-context.jsx) so any
// screen inside the app can reach it via useSync() — previously this file rendered a fixed,
// always-on-top "Sync" badge that showed on every single screen regardless of relevance. The
// actual account control now lives only on the Home dashboard (see AccountSyncControl in
// shell/account-sync-control.jsx). SyncGate below preserves the original startup behavior
// exactly: the app doesn't render at all until the initial session check resolves.
function SyncGate() {
  const sync = useSync();
  if (!sync.ready) return null;
  return React.createElement(InkrootApp, null);
}

// Production-readiness audit: nothing in the app caught a render-time exception, so any one
// component throwing (fix-tracker item 33 was exactly this — Publish from the Workshop) unmounted
// the entire React tree and left a blank dark screen with no way back. This is the smallest
// possible safety net, not a redesign: it changes nothing while everything renders normally, and
// on a crash shows a plain message with a reload button instead of nothing. Local data is
// untouched either way — everything is in IndexedDB (see lib/storage.js) and the outbox, so a
// reload picks up exactly where the writer left off. Error boundaries have to be class
// components; this one uses React.createElement like the rest of the repo.
class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error, info) {
    console.error('Inkroot: uncaught render error', error, info && info.componentStack);
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return React.createElement('div', {
      style: {
        minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 14, padding: 24, textAlign: 'center', background: '#17171B', color: '#EFE7D2',
        fontFamily: "'Inter', system-ui, sans-serif",
      },
    },
      React.createElement('div', { style: { fontSize: 18, fontWeight: 600 } }, 'Something went wrong.'),
      React.createElement('div', { style: { fontSize: 14, color: '#A6A6AD', maxWidth: 360, lineHeight: 1.5 } },
        'Your saved work is kept on this device. Reload to pick up where you left off.'),
      React.createElement('button', {
        onClick: () => window.location.reload(),
        style: {
          background: '#C89B3C', color: '#17171B', border: 'none', borderRadius: 8,
          padding: '10px 18px', fontSize: 14, fontWeight: 600, cursor: 'pointer',
        },
      }, 'Reload'));
  }
}

createRoot(document.getElementById('root')).render(
  React.createElement(AppErrorBoundary, null,
    React.createElement(SyncProvider, null, React.createElement(SyncGate, null)))
);

