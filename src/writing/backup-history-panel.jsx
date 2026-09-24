import React, { useState, useEffect } from 'react';
import { projectKey } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { formatBackupTime, readBackups } from './project-schema-and-backups.jsx';


// ---------- Backup History (Settings \u2192 Backups) ----------
// Lists the rotating autosave snapshots (see maybeSnapshotBackup) so a bad edit that already
// autosaved over the version you wanted can still be recovered, not just a browser crash.
export function BackupHistoryPanel({ projectId, onRestore, askConfirm }) {
    const [backups, setBackups] = useState(null); // null while loading
    useEffect(() => {
        let cancelled = false;
        readBackups(projectKey(projectId)).then((list) => {
            if (!cancelled)
                setBackups(list.slice().reverse());
        });
        return () => { cancelled = true; };
    }, [projectId]);
    if (backups === null) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Loading backup versions\u2026");
    }
    if (backups.length === 0) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "No backup versions yet \u2014 they build up automatically as you work, roughly one every couple of minutes of active editing.");
    }
    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } }, backups.map((b) => (React.createElement("div", { key: b.id, style: {
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10],
            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[8], padding: '8px 12px',
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#A6A6AD' } }, formatBackupTime(b.savedAt)),
        React.createElement("button", { onClick: () => askConfirm(`Restore the version from ${formatBackupTime(b.savedAt)}? This replaces everything currently in the project. Your current state is autosaved first, so nothing is lost \u2014 but note that backups don't store map/portrait images, so any images added since this backup was taken may show as placeholders after restoring.`, () => onRestore(b.data)), style: {
                background: 'none', border: '1px solid #3A3A42', color: '#D9D2BE', borderRadius: RADIUS_SCALE[6], padding: '5px 10px', fontSize: TYPE_SCALE[12], cursor: 'pointer', flexShrink: 0,
            } }, "Restore")))));
}
