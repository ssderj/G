import React, { useState } from 'react';
import { useSync } from './sync-context.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from './nav-context.jsx';
import { PROFILE_KEY, GUILD_KEY, INBOX_KEY } from '../shared-utils/storage-keys.jsx';

// Turns a conflictBackups row's raw storage key (and its JSON value, where that helps) into
// something a writer actually recognizes, instead of showing them 'inkroot:project:3f9a2b1c'.
// Same fixed-key list storage-keys.jsx itself defines — projectKey(id) is the only one with a
// dynamic suffix, so that's the one pattern-matched rather than listed.
function describeConflictKey(key, value) {
    if (key === PROFILE_KEY) return 'your Writer Profile';
    if (key === GUILD_KEY) return 'your Guild membership';
    if (key === INBOX_KEY) return 'your Inbox';
    if (key && key.indexOf('inkroot:project:') === 0) {
        try {
            const parsed = JSON.parse(value);
            if (parsed && parsed.title) return `your project "${parsed.title}"`;
        } catch (e) { /* fall through to the generic label below */ }
        return 'one of your projects';
    }
    return 'a change';
}

// Item 10 (fix tracker) — the one piece syncEngine.js's own comment flagged as missing: a UI
// wired to the 'inkroot:sync-conflict' event it already dispatches. Same Home-only placement and
// visual language as AccountSyncControl right next to it (a pill button that opens a dropdown
// panel) — this is genuinely a sync-related control, so it belongs in the same spot, not a new
// surface elsewhere. Renders nothing at all when there's nothing to recover, so a writer who's
// never hit a conflict never sees this control exist.
export function ConflictRecoveryControl() {
    const sync = useSync();
    const [panelOpen, setPanelOpen] = useState(false);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState('');

    if (!sync || !sync.conflictBackups || sync.conflictBackups.length === 0)
        return null;
    const { conflictBackups, restoreConflict, dismissConflict } = sync;

    const handleRestore = (id) => {
        setBusyId(id); setError('');
        restoreConflict(id).catch((e) => setError(e && e.message ? e.message : 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };
    const handleDismiss = (id) => {
        setBusyId(id); setError('');
        dismissConflict(id).catch((e) => setError(e && e.message ? e.message : 'That didn\u2019t go through.')).finally(() => setBusyId(null));
    };

    return React.createElement("div", { style: { position: 'relative' } },
        React.createElement("button", {
            onClick: () => setPanelOpen((v) => !v),
            title: "Another device's edit overwrote something you changed here \u2014 the version you had is saved and can be restored.",
            style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                background: 'none', border: '1px solid #5A3A2A', color: '#D9A15A',
                borderRadius: RADIUS_SCALE[999], padding: '6px 12px', fontSize: TYPE_SCALE[11.5],
                cursor: 'pointer', fontFamily: 'inherit',
            },
        }, `\u26A0\uFE0F ${conflictBackups.length} change${conflictBackups.length === 1 ? '' : 's'} to review`),
        panelOpen && React.createElement("div", {
            style: {
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 30, width: 300,
                padding: 16, borderRadius: RADIUS_SCALE[12], border: '1px solid #3A3020',
                background: 'linear-gradient(160deg, #201A10, #17130E)', color: '#EFE7D2',
                fontSize: TYPE_SCALE[13], boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
                display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[12],
            },
        },
            React.createElement("p", { style: { margin: 0, color: '#B9AE8F', fontSize: TYPE_SCALE[12] } },
                "A newer version from another device overwrote what you had here, before it could sync. Nothing was lost \u2014 restore brings your version back on top; dismiss keeps the other device's version and discards yours."),
            conflictBackups.map((b) => React.createElement("div", {
                key: b.id, style: { borderTop: '1px solid #2A2417', paddingTop: 10 },
            },
                React.createElement("p", { style: { margin: '0 0 6px 0', fontSize: TYPE_SCALE[12.5] } },
                    `${describeConflictKey(b.key, b.value)} \u2014 ${new Date(b.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                    React.createElement("button", {
                        onClick: () => handleRestore(b.id), disabled: busyId === b.id,
                        style: {
                            background: 'none', border: '1px solid #5A3A2A', color: '#D9A15A',
                            borderRadius: RADIUS_SCALE[8], padding: '5px 10px', fontSize: TYPE_SCALE[12],
                            cursor: busyId === b.id ? 'default' : 'pointer',
                        },
                    }, busyId === b.id ? '\u2026' : 'Restore my version'),
                    React.createElement("button", {
                        onClick: () => handleDismiss(b.id), disabled: busyId === b.id,
                        style: {
                            background: 'none', border: '1px solid #3A3020', color: '#8A8272',
                            borderRadius: RADIUS_SCALE[8], padding: '5px 10px', fontSize: TYPE_SCALE[12],
                            cursor: busyId === b.id ? 'default' : 'pointer',
                        },
                    }, 'Dismiss')))),
            error && React.createElement("p", { style: { margin: 0, color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, error)));
}
