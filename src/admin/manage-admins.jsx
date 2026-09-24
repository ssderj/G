import React, { useEffect, useState } from 'react';
import { fetchPlatformRoleHolders, fetchRoleRevocationLog, revokePlatformRole } from '../lib/moderation.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

const btnStyle = (primary) => ({
    background: primary ? '#2A2115' : 'none',
    border: '1px solid #3A3020',
    color: primary ? '#E8C468' : '#A6A6AD',
    borderRadius: RADIUS_SCALE[10],
    padding: '7px 14px',
    fontSize: TYPE_SCALE[12],
    cursor: 'pointer',
    fontWeight: primary ? 600 : 400,
});

const ROLE_LABEL = { moderator: 'Moderator', platform_admin: 'Platform admin' };

// One account holding is_moderator and/or is_platform_admin, with a revoke button per role it
// holds. Revoking is the only lever this row offers — see manage-admins' own header comment and
// admin_revoke_platform_role's comment in schema.sql for why granting stays a manual, out-of-app
// step.
function RoleHolderRow({ holder, onChanged }) {
    const [busy, setBusy] = useState(null); // which role is mid-revoke, or null
    const [error, setError] = useState(null);
    const [confirmingRole, setConfirmingRole] = useState(null);
    const [reason, setReason] = useState('');

    const handleRevoke = async (role) => {
        setBusy(role);
        setError(null);
        try {
            await revokePlatformRole(holder.id, role, reason.trim() || null);
            setConfirmingRole(null);
            setReason('');
            onChanged();
        } catch (e) {
            setError(e.message || `Could not revoke ${ROLE_LABEL[role].toLowerCase()} status.`);
        } finally {
            setBusy(null);
        }
    };

    const roles = [holder.isPlatformAdmin && 'platform_admin', holder.isModerator && 'moderator'].filter(Boolean);

    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 14, marginBottom: 10 } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], color: '#EFE7D2', fontWeight: 600, marginBottom: 6 } }, holder.name),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            roles.map((role) => React.createElement("div", { key: role, style: { display: 'flex', alignItems: 'center', gap: 8 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#B5B0A5', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[8], padding: '3px 8px' } }, ROLE_LABEL[role]),
                confirmingRole === role
                    ? null
                    : React.createElement("button", { onClick: () => setConfirmingRole(role), style: btnStyle(false) }, 'Revoke')))),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        confirmingRole && React.createElement("div", { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #2A2A30' } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginBottom: 8 } },
                `Revoke ${ROLE_LABEL[confirmingRole].toLowerCase()} status from ${holder.name}? This can't be undone from here \u2014 re-granting it requires a manual step outside the app.`),
            React.createElement("input", { value: reason, onChange: (e) => setReason(e.target.value),
                placeholder: "Reason for the audit log (optional)", style: {
                    width: '100%', background: '#141418', border: '1px solid #2A2A30', color: '#EFE7D2',
                    borderRadius: RADIUS_SCALE[8], padding: '7px 10px', fontSize: TYPE_SCALE[12], marginBottom: 8,
                } }),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                React.createElement("button", { disabled: busy === confirmingRole, onClick: () => handleRevoke(confirmingRole),
                    style: { ...btnStyle(true), opacity: busy === confirmingRole ? 0.5 : 1 } }, busy === confirmingRole ? '\u2026' : 'Confirm revoke'),
                React.createElement("button", { onClick: () => { setConfirmingRole(null); setReason(''); }, style: btnStyle(false) }, 'Cancel'))));
}

function RevocationLog({ entries, loading }) {
    return React.createElement("div", { style: { marginTop: 24, paddingTop: 20, borderTop: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Revocation log'),
        loading
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "Loading\u2026")
            : entries.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, 'No roles have been revoked yet.')
                : entries.map((e) => React.createElement("div", { key: e.id, style: { fontSize: TYPE_SCALE[11.5], color: '#B5B0A5', marginBottom: 8 } },
                    `${e.revokedByName} revoked ${ROLE_LABEL[e.role].toLowerCase()} from ${e.targetName} \u2014 ${new Date(e.createdAt).toLocaleString()}`,
                    e.reason && React.createElement("div", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[10.5] } }, e.reason))));
}

// Only ever rendered for a confirmed platform admin (see shell/ink-root.jsx's isPlatformAdmin) —
// same "real enforcement is server-side" posture as ModerationQueue and the other admin screens.
// Deliberately revoke-only: there is no way to grant is_moderator/is_platform_admin from here or
// anywhere else in the app — see 77_migration_admin_role_revocation.sql for why that stays a
// manual service_role/SQL step.
export function ManageAdmins({ onBack }) {
    const [holders, setHolders] = useState([]);
    const [log, setLog] = useState([]);
    const [loading, setLoading] = useState(true);
    const [logLoading, setLogLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = () => {
        setLoading(true);
        setLogLoading(true);
        fetchPlatformRoleHolders()
            .then((rows) => { setHolders(rows); setLoading(false); })
            .catch((e) => { setError(e.message || 'Could not load admins and moderators.'); setLoading(false); });
        fetchRoleRevocationLog()
            .then((rows) => { setLog(rows); setLogLoading(false); })
            .catch(() => setLogLoading(false));
    };
    useEffect(() => { load(); }, []);

    return React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', color: '#EFE7D2', padding: '20px 16px 60px', maxWidth: 640, margin: '0 auto' } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 20 } },
            React.createElement("button", { onClick: onBack, style: { background: 'none', border: 'none', color: '#8A8680', fontSize: TYPE_SCALE[13], cursor: 'pointer' } }, "\u2190 Back"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#E8C468' } }, 'Manage Admins')),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 16, fontStyle: 'italic' } },
            "Every account currently holding moderator or platform admin status. You can revoke either here \u2014 granting them still requires a manual step outside the app."),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),

        loading
            ? React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '16px 0' } }, "Loading\u2026")
            : holders.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '16px 0' } }, 'No admins or moderators found.')
                : holders.map((h) => React.createElement(RoleHolderRow, { key: h.id, holder: h, onChanged: load })),

        React.createElement(RevocationLog, { entries: log, loading: logLoading }));
}
