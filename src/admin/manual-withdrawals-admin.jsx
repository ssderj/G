import React, { useEffect, useState } from 'react';
import { adminFetchPendingManualWithdrawals, adminSettleManualWithdrawal, formatNaira, koboToNaira } from '../lib/payments.js';
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

// One pending manual withdrawal request, with the two settlement actions
// (admin_settle_manual_withdrawal's only two valid outcomes: success or failed). Deliberately no
// third "processing" state — unlike a Paystack transfer, there's nothing async to wait on here:
// the admin sends the money by hand first, then records that it happened.
function PendingWithdrawalRow({ request, onChanged }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const [showReject, setShowReject] = useState(false);
    const [note, setNote] = useState('');

    const handleMarkPaid = async () => {
        setBusy(true);
        setError(null);
        try {
            await adminSettleManualWithdrawal(request.id, 'success', note.trim() || null);
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not mark this as paid.');
        } finally {
            setBusy(false);
        }
    };
    const handleReject = async () => {
        if (!note.trim()) { setError('Give a reason so the writer knows what to fix.'); return; }
        setBusy(true);
        setError(null);
        try {
            await adminSettleManualWithdrawal(request.id, 'failed', note.trim());
            onChanged();
        } catch (e) {
            setError(e.message || 'Could not reject this request.');
        } finally {
            setBusy(false);
        }
    };

    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[11], padding: 14, marginBottom: 10 } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' } },
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], color: '#EFE7D2', fontWeight: 600 } }, request.writer_name),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[16], fontWeight: 700, color: '#E8C468' } }, formatNaira(koboToNaira(request.amount_kobo)))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#B5B0A5', marginTop: 6 } }, request.account_name),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } }, `${request.bank_name} \u2014 ${request.account_number}`),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', marginTop: 4 } }, `Requested ${new Date(request.created_at).toLocaleString()}`),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11], marginTop: 8 } }, error),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 12, flexWrap: 'wrap' } },
            React.createElement("button", { disabled: busy, onClick: handleMarkPaid, style: { ...btnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Mark as paid'),
            React.createElement("button", { onClick: () => setShowReject((v) => !v), style: btnStyle(false) }, showReject ? 'Cancel' : 'Reject')),

        React.createElement("input", { value: note, onChange: (e) => setNote(e.target.value),
            placeholder: showReject ? "Reason for rejection" : "Note for your own records (optional)", style: {
                width: '100%', marginTop: 10, background: '#141418', border: '1px solid #2A2A30', color: '#EFE7D2',
                borderRadius: RADIUS_SCALE[8], padding: '7px 10px', fontSize: TYPE_SCALE[12],
            } }),
        showReject && React.createElement("button", { disabled: busy, onClick: handleReject, style: { ...btnStyle(false), marginTop: 8, opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Confirm rejection'));
}

// Only ever rendered for a confirmed platform admin (see shell/ink-root.jsx's isPlatformAdmin) —
// same "real enforcement is server-side" posture as ModerationQueue and InkrootEventsAdmin. Every
// write here (admin_settle_manual_withdrawal) re-checks is_inkroot_admin() itself regardless of
// what got this screen open in the first place. See 62_migration_manual_withdrawals.sql.
export function ManualWithdrawalsAdmin({ onBack }) {
    const [requests, setRequests] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = () => {
        adminFetchPendingManualWithdrawals()
            .then((rows) => { setRequests(rows); setLoading(false); })
            .catch((e) => { setError(e.message || 'Could not open the withdrawal queue.'); setLoading(false); });
    };
    useEffect(() => { load(); }, []);

    return React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', color: '#EFE7D2', padding: '20px 16px 60px', maxWidth: 640, margin: '0 auto' } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 20 } },
            React.createElement("button", { onClick: onBack, style: { background: 'none', border: 'none', color: '#8A8680', fontSize: TYPE_SCALE[13], cursor: 'pointer' } }, "\u2190 Back"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[18], fontWeight: 600, color: '#E8C468' } }, 'Manual Withdrawals')),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginBottom: 16, fontStyle: 'italic' } },
            "Send the money yourself, then mark it paid \u2014 or reject with a reason if something's wrong (e.g. the account details don't check out). Rejecting returns the amount to the writer's available balance immediately."),

        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginBottom: 10 } }, error),

        loading
            ? React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '16px 0' } }, "Opening the queue\u2026")
            : requests.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '16px 0' } }, 'Nothing waiting right now.')
                : requests.map((r) => React.createElement(PendingWithdrawalRow, { key: r.id, request: r, onChanged: load })));
}
