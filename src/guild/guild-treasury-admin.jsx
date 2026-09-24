import React, { useEffect, useRef, useState } from 'react';
import {
    approveGuildTreasurySpend, cancelGuildTreasurySpendRequest, contributeToGuildTreasury,
    fetchGuildTreasuryApprovalThresholdNaira, fetchGuildTreasurySpendApprovals, fetchGuildTreasurySpendRequests,
    proposeGuildTreasurySpend, setGuildTreasuryRole, spendFromGuildTreasury,
} from '../lib/guild-treasury.js';
import { fetchPlayerGuild, fetchPlayerGuildMembers } from '../lib/player-guild.js';
import { currentUser } from '../lib/supabaseClient.js';
import { fetchAvailableBalanceNaira, formatNaira } from '../lib/payments.js';
import { fetchProfileNames } from '../lib/profile.js';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// ============================================================================================
// Guild Treasury — the role-gated half of the screen. Everything in GoTreasuryTabReal
// (guild-order.jsx) above this component is read-only for every member; everything below is an
// action, and every action is shown only to a role the backend actually lets perform it — see
// 44_migration_guild_treasury_roles_and_approvals.sql for the authority this mirrors:
//
//   - Contribute (move your own withdrawable earnings into this guild's purse) — any member.
//     contribute_to_guild_treasury() only checks membership, not role.
//   - Authorize / propose a guild-owned-funds spend, and approve a pending one — Leader,
//     Treasurer, or Officer only (is_guild_treasury_authorized()). A plain Member never sees
//     these controls, not even disabled ones — see GoTreasuryAdminSection below.
//   - Assign/revoke Treasurer or Officer — the Guild Leader only (set_guild_treasury_role()).
//
// None of this is the security boundary. Every one of these calls re-derives the caller's role
// and re-checks the real balance server-side before writing anything (see each function's own
// header comment in guild-treasury.js) — hiding a button here only avoids showing someone a
// control they'd be refused anyway, it does not itself stop anything.
//
// Deliberately kept separate from GoMemberEarningsPanel's own bucket: nothing here can ever
// touch a 'member'-bucket row (a member's own held-in-trust earnings) — contribute/spend/
// propose/approve all operate on the guild's own 'guild'-bucket funds exclusively, per the
// migration's own separation of the two buckets. A member's earnings stay exactly as private
// here as everywhere else in this app: nothing on this screen ever takes another member's id.
// ============================================================================================

function adminBtnStyle(primary, disabled) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', borderRadius: RADIUS_SCALE[8],
        cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.5 : 1,
        border: primary ? '1px solid rgba(232,196,104,0.5)' : '1px solid #2A2A30',
        background: primary ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'transparent',
        color: primary ? '#E8C468' : '#8A8680',
    };
}
const adminInputStyle = {
    width: '100%', boxSizing: 'border-box', background: '#100E0A', border: '1px solid #2A2A30', color: '#EFE7D2',
    borderRadius: RADIUS_SCALE[8], padding: '9px 11px', fontSize: TYPE_SCALE[13], marginTop: 4,
};
function AdminModal({ title, onClose, children }) {
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 65, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 400,
                background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16],
                padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, title),
                React.createElement("button", { onClick: onClose, style: { background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1 } }, "\u2715")),
            children));
}

// Moving part of the signed-in writer's own withdrawable balance into this guild's shared purse.
// Open to every member — see contribute_to_guild_treasury()'s own permission check.
function ContributeModal({ guildId, onClose, onDone }) {
    const [available, setAvailable] = useState(null);
    const [amount, setAmount] = useState('');
    const [note, setNote] = useState('');
    const [step, setStep] = useState('form'); // form | sending | error
    const [error, setError] = useState(null);
    const keyRef = useRef(null);

    useEffect(() => { fetchAvailableBalanceNaira().then(setAvailable).catch(() => setAvailable(0)); }, []);

    const amountValid = Number(amount) > 0 && available !== null && Number(amount) <= available;

    const handleSubmit = async () => {
        setStep('sending');
        setError(null);
        try {
            if (!keyRef.current) keyRef.current = uuid();
            await contributeToGuildTreasury(guildId, Number(amount), note.trim() || null, keyRef.current);
            onDone();
        } catch (e) {
            setError(e.message);
            setStep('form');
        }
    };

    return React.createElement(AdminModal, { title: "Contribute to the guild treasury", onClose },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12, lineHeight: 1.5 } },
            "Moves Naira out of your own withdrawable balance and into this guild's shared purse \u2014 it becomes guild-owned funds, not held-in-trust earnings you can take back."),
        React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } },
            available === null ? 'Amount' : `Amount (up to ${formatNaira(available)})`),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
            React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
            React.createElement("input", { type: "number", min: 1, value: amount, onChange: (e) => setAmount(e.target.value), style: { ...adminInputStyle, marginTop: 0 } })),
        React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 14, display: 'block' } }, "Note (optional)"),
        React.createElement("input", { value: note, onChange: (e) => setNote(e.target.value), placeholder: "What's this for?", style: adminInputStyle }),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
        React.createElement("button", {
            disabled: step === 'sending' || !amountValid, onClick: handleSubmit,
            style: { ...adminBtnStyle(true, step === 'sending' || !amountValid), width: '100%', marginTop: 16, padding: '10px 0' },
        }, step === 'sending' ? 'Contributing\u2026' : `Contribute ${amount ? formatNaira(Number(amount)) : ''}`));
}

// Authorizing a guild-owned-funds spend. One form, two possible backend calls depending on the
// amount vs the multi-approval threshold — see spend_from_guild_treasury()/
// propose_guild_treasury_spend()'s own header comments for exactly why: under the threshold
// executes immediately with this one authorization; at/above it only opens a request that still
// needs a second, distinct authorized approver before anything actually moves.
function SpendModal({ guildId, availableNaira, thresholdNaira, onClose, onDone }) {
    const [title, setTitle] = useState('');
    const [amount, setAmount] = useState('');
    const [step, setStep] = useState('form'); // form | sending | error
    const [error, setError] = useState(null);
    const keyRef = useRef(null);

    const amountNum = Number(amount);
    const amountValid = amountNum > 0 && amountNum <= availableNaira && title.trim().length > 0;
    const needsApproval = thresholdNaira != null && amountNum >= thresholdNaira;

    const handleSubmit = async () => {
        setStep('sending');
        setError(null);
        try {
            if (!keyRef.current) keyRef.current = uuid();
            let proposed = needsApproval;
            if (needsApproval) {
                await proposeGuildTreasurySpend(guildId, amountNum, title.trim(), keyRef.current);
            } else {
                try {
                    await spendFromGuildTreasury(guildId, amountNum, title.trim(), keyRef.current);
                } catch (spendErr) {
                    // Migration 112: a guild that has used up its rolling 24-hour direct-spend
                    // allowance can still spend under the threshold — through multi-approval.
                    // The server accepts an under-threshold proposal exactly when the direct
                    // route would have been refused for this reason, so retry as a proposal
                    // (same idempotency key; it's a different table) instead of dead-ending.
                    if (!/direct-spend limit/i.test(spendErr?.message || '')) throw spendErr;
                    await proposeGuildTreasurySpend(guildId, amountNum, title.trim(), keyRef.current);
                    proposed = true;
                }
            }
            onDone(proposed);
        } catch (e) {
            setError(e.message);
            setStep('form');
        }
    };

    return React.createElement(AdminModal, { title: "Authorize a spend", onClose },
        React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "What's it for"),
        React.createElement("input", { value: title, onChange: (e) => setTitle(e.target.value), placeholder: "e.g. Cover art commission", style: adminInputStyle }),
        React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 14, display: 'block' } }, `Amount (up to ${formatNaira(availableNaira)} available)`),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
            React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
            React.createElement("input", { type: "number", min: 1, value: amount, onChange: (e) => setAmount(e.target.value), style: { ...adminInputStyle, marginTop: 0 } })),
        needsApproval && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C9BE8D', marginTop: 10, fontStyle: 'italic' } },
            `${formatNaira(thresholdNaira)} or more requires a second Leader/Treasurer/Officer to approve before it executes.`),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
        React.createElement("button", {
            disabled: step === 'sending' || !amountValid, onClick: handleSubmit,
            style: { ...adminBtnStyle(true, step === 'sending' || !amountValid), width: '100%', marginTop: 16, padding: '10px 0' },
        }, step === 'sending' ? 'Sending\u2026' : needsApproval ? 'Propose spend' : `Authorize ${amount ? formatNaira(amountNum) : ''}`));
}

// Every proposed large spend this guild has on record — visible to any member (transparency, per
// guild_treasury_spend_requests' own select policy), but Approve/Cancel only ever render for
// someone the backend would actually let call them: is_guild_treasury_authorized() for Approve,
// "proposer or Leader" for Cancel. A plain Member sees the same list with no buttons at all.
function SpendRequestsPanel({ guildId, isAuthorized, isLeader, currentUserId, onChanged }) {
    const [requests, setRequests] = useState(undefined); // undefined = loading
    const [approvalsByRequest, setApprovalsByRequest] = useState({});
    const [names, setNames] = useState({});
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState(null);

    const load = () => {
        fetchGuildTreasurySpendRequests(guildId).then(async (rows) => {
            setRequests(rows);
            const pending = rows.filter((r) => r.status === 'pending');
            const [approvalsList, nameMap] = await Promise.all([
                Promise.all(pending.map((r) => fetchGuildTreasurySpendApprovals(r.id).catch(() => []))),
                fetchProfileNames(rows.map((r) => r.requested_by)).catch(() => ({})),
            ]);
            const byId = {};
            pending.forEach((r, i) => { byId[r.id] = approvalsList[i]; });
            setApprovalsByRequest(byId);
            setNames(nameMap);
        }).catch((e) => { setRequests([]); setError(e.message); });
    };
    useEffect(() => { load(); }, [guildId]);

    if (requests === undefined) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[11.5], padding: '10px 0' } }, "Loading spend requests\u2026");
    }
    const pendingRequests = requests.filter((r) => r.status === 'pending');
    const decidedRequests = requests.filter((r) => r.status !== 'pending').slice(0, 5);

    const doApprove = async (id) => {
        setBusyId(id); setError(null);
        try { await approveGuildTreasurySpend(id); load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusyId(null); }
    };
    const doCancel = async (id) => {
        setBusyId(id); setError(null);
        try { await cancelGuildTreasurySpendRequest(id); load(); onChanged(); } catch (e) { setError(e.message); } finally { setBusyId(null); }
    };

    const row = (r) => {
        const approvals = approvalsByRequest[r.id] || [];
        const alreadyApproved = approvals.some((a) => a.approver_id === currentUserId);
        const canCancel = r.status === 'pending' && (isLeader || r.requested_by === currentUserId);
        const canApprove = r.status === 'pending' && isAuthorized && !alreadyApproved;
        const statusColor = r.status === 'executed' ? '#8FCB8F' : r.status === 'cancelled' ? '#7A7A82' : '#C9BE8D';
        return React.createElement("div", { key: r.id, style: { padding: '11px 12px', borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2A30', marginBottom: 8 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', gap: SPACE_SCALE[10] } },
                React.createElement("div", null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[13], fontWeight: 600, color: '#EFE7D2' } }, r.title),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 2 } }, `Proposed by ${names[r.requested_by] || 'a guild officer'} \u00b7 ${new Date(r.created_at).toLocaleDateString()}`)),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], fontWeight: 700, color: '#E8C468', flexShrink: 0 } }, formatNaira(r.amountNaira))),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: statusColor, textTransform: 'capitalize' } },
                    r.status === 'pending' ? `${approvals.length} of ${r.required_approvals} approvals` : r.status),
                (canApprove || canCancel) && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6] } },
                    canApprove && React.createElement("button", { disabled: busyId === r.id, onClick: () => doApprove(r.id), style: adminBtnStyle(true, busyId === r.id) }, 'Approve'),
                    canCancel && React.createElement("button", { disabled: busyId === r.id, onClick: () => doCancel(r.id), style: adminBtnStyle(false, busyId === r.id) }, 'Cancel'))));
    };

    if (requests.length === 0) return null;

    return React.createElement("div", { style: { marginTop: 22 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Large spend requests'),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),
        pendingRequests.length === 0 && decidedRequests.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'Nothing proposed yet.')
            : React.createElement(React.Fragment, null, pendingRequests.map(row), decidedRequests.map(row)));
}

// Leader-only: grant or revoke Treasurer/Officer standing. set_guild_treasury_role() itself
// refuses anyone but the real player_guilds.owner_id and refuses to ever target the leader's own
// row — this panel mirrors both restrictions so nobody but the Leader even sees it, and the
// Leader's own row never shows role buttons.
function RoleManagementPanel({ guildId, ownerId }) {
    const [members, setMembers] = useState(undefined);
    const [busyId, setBusyId] = useState(null);
    const [error, setError] = useState(null);

    const load = () => { fetchPlayerGuildMembers(guildId).then(setMembers).catch((e) => setError(e.message)); };
    useEffect(() => { load(); }, [guildId]);

    if (members === undefined) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[11.5], padding: '10px 0' } }, "Loading roster\u2026");
    }

    const changeRole = async (memberId, role) => {
        setBusyId(memberId); setError(null);
        try { await setGuildTreasuryRole(guildId, memberId, role); load(); } catch (e) { setError(e.message); } finally { setBusyId(null); }
    };

    const roleLabel = { treasurer: 'Treasurer', officer: 'Officer', member: 'Member' };
    const others = members.filter((m) => m.user_id !== ownerId);

    return React.createElement("div", { style: { marginTop: 22 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Treasury roles'),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginBottom: 10, fontStyle: 'italic' } }, "Treasurers and Officers can authorize and approve guild spending, same as you \u2014 only you can grant or revoke that."),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),
        others.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No other members yet.')
            : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                others.map((m) => React.createElement("div", { key: m.user_id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px', borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2A30' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#D9D2BE', fontWeight: 600 } }, m.name),
                        m.role && m.role !== 'member'
                            ? React.createElement("span", { style: { display: 'inline-flex', fontSize: TYPE_SCALE[9], letterSpacing: '0.04em', padding: '2px 8px', borderRadius: 100, marginTop: 3, background: 'radial-gradient(circle at 30% 30%,#8F4A3A,#5E2E22)', color: '#F2DCC8' } }, roleLabel[m.role])
                            : React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 2 } }, 'Member')),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6] } },
                        ['treasurer', 'officer', 'member'].filter((r) => r !== m.role).map((r) => React.createElement("button", {
                            key: r, disabled: busyId === m.user_id, onClick: () => changeRole(m.user_id, r),
                            style: { ...adminBtnStyle(false, busyId === m.user_id), padding: '4px 9px', fontSize: TYPE_SCALE[10.5] },
                        }, `Make ${roleLabel[r]}`)))))));
}

// The single entry point GoTreasuryTabReal renders. Reads its own guild-owned-funds numbers
// (availableNaira) so the Spend/Contribute buttons and modals can show sane maxes, but never
// duplicates or re-derives the summary shown higher up on the screen — refreshSummary is called
// after any action that could change it so the parent's own fetch re-runs.
export function GoTreasuryAdminSection({ guildId, role, availableNaira, refreshSummary, isFounderView }) {
    const [modal, setModal] = useState(null); // null | 'contribute' | 'spend'
    const [threshold, setThreshold] = useState(null);
    const [userId, setUserId] = useState(null);
    const [ownerId, setOwnerId] = useState(null);
    const [notice, setNotice] = useState(null);

    useEffect(() => {
        fetchGuildTreasuryApprovalThresholdNaira().then(setThreshold).catch(() => {});
        currentUser().then((u) => setUserId(u ? u.id : null));
        fetchPlayerGuild(guildId).then((g) => setOwnerId(g ? g.owner_id : null)).catch(() => {});
    }, [guildId]);

    const isAuthorized = role === 'leader' || role === 'treasurer' || role === 'officer';
    const isLeader = role === 'leader';

    return React.createElement("div", { style: { marginTop: 26, paddingTop: 22, borderTop: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Treasury actions'),

        notice && React.createElement("div", { style: { color: '#8FCB8F', fontSize: TYPE_SCALE[11.5], marginBottom: 10, textAlign: 'center' } }, notice),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginBottom: 6 } },
            // Contribute — every member, regardless of role.
            React.createElement("button", { onClick: () => setModal('contribute'), style: adminBtnStyle(false) }, '+ Contribute to treasury'),
            // Authorize/propose a spend — Leader, Treasurer, Officer only. A plain Member never
            // sees this button at all, not even disabled.
            isAuthorized && React.createElement("button", { disabled: availableNaira <= 0, onClick: () => setModal('spend'), style: adminBtnStyle(true, availableNaira <= 0) }, 'Authorize a spend')),
        !isAuthorized && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', marginTop: 4 } }, "Only the Guild Leader, Treasurer, or an Officer can authorize spending the guild's funds."),

        // Every member can see proposed spends (transparency), but only an authorized role ever
        // sees an Approve button, and only the proposer or the Leader ever sees Cancel.
        React.createElement(SpendRequestsPanel, {
            guildId, isAuthorized, isLeader, currentUserId: userId,
            onChanged: () => { refreshSummary(); },
        }),

        // Assigning Treasurer/Officer — Guild Leader only, and only for a Player Guild: a Founder
        // Guild has nobody to delegate to (or from) — every Inkroot admin flagged
        // is_founder_guild_treasurer carries full Leader-equivalent authority (migration 112; it
        // used to be every is_platform_admin), not a per-member role row (see
        // set_guild_treasury_role()'s own guard in supabase/history/69_migration_founder_guild_
        // parity.sql, and player_guild_members not even existing for a Founder Guild's members).
        isLeader && !isFounderView && React.createElement(RoleManagementPanel, { guildId, ownerId }),

        modal === 'contribute' && React.createElement(ContributeModal, {
            guildId, onClose: () => setModal(null),
            onDone: () => { setModal(null); setNotice('Contribution recorded.'); refreshSummary(); },
        }),
        modal === 'spend' && React.createElement(SpendModal, {
            guildId, availableNaira, thresholdNaira: threshold, onClose: () => setModal(null),
            onDone: (needsApproval) => {
                setModal(null);
                setNotice(needsApproval ? 'Proposed \u2014 waiting on a second approval.' : 'Spend authorized.');
                refreshSummary();
            },
        }));
}
