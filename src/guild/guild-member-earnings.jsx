import React, { useEffect, useMemo, useRef, useState } from 'react';
import { fetchGuildMemberEarningsSummary, fetchGuildMemberEarningsTransactions, withdrawGuildMemberEarnings } from '../lib/guild-treasury.js';
import { deleteBankAccount, fetchSavedBankAccounts, fetchWithdrawals, formatNaira, formatNairaBalance, koboToNaira, setDefaultBankAccount } from '../lib/payments.js';
import { AddBankAccountModal, WithdrawalStatusStepper, WithdrawModal, withdrawalStage } from '../library/creator-dashboard.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Deliberately not imported from guild-order.jsx (which renders this panel) — that would make
// the two files import each other. Same visual language as guild-order.jsx's own
// goBtnStyle/GoLocked, just a local, one-way copy.
function memberEarningsBtnStyle(primary) {
    return {
        fontSize: TYPE_SCALE[11.5], fontWeight: 600, padding: '7px 13px', borderRadius: RADIUS_SCALE[8], cursor: 'pointer',
        border: primary ? '1px solid rgba(232,196,104,0.5)' : '1px solid #2A2A30',
        background: primary ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'transparent',
        color: primary ? '#E8C468' : '#8A8680',
    };
}
function MemberEarningsLocked({ text }) {
    return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center', padding: '10px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6] } },
        React.createElement(InkIcon, { name: "lock", size: 11 }), text);
}

// Member Earnings — a writer's own slice of this one guild's real treasury (see
// 41_migration_guild_member_earnings_withdrawal.sql). Everything here is the writer's own money,
// nothing the guild owns: earnings credited by things like an Anthology sale's per-contributor
// share (bucket='member' in guild_treasury_transactions), held in this guild's treasury in trust
// until released back out.
//
// "Members should see only their own earnings" is enforced server-side, not just by this
// component's props: RLS on guild_treasury_transactions only ever returns 'member' rows where
// member_id = auth.uid(), and both RPCs this screen calls (guild_member_earnings_summary,
// withdraw_guild_member_earnings) derive every balance from auth.uid() alone — there is no
// guildId + memberId combination a client could pass to see or move someone else's earnings.
// This component never takes a memberId prop for that same reason: it can only ever be "my own
// earnings in this guild."
//
// Withdrawing here is a two-step handoff under one button (see WithdrawModal's beforeWithdraw
// hook in creator-dashboard.jsx): release the guild-held balance into the writer's own
// cross-guild withdrawable balance, then send that balance to their saved payout account via the
// exact same Paystack pipeline every other Inkroot withdrawal already uses.
export function GoMemberEarningsPanel({ guildId }) {
    const [state, setState] = useState({ loading: true, error: null, summary: null, transactions: [], withdrawals: [] });
    const [accounts, setAccounts] = useState([]);
    const [modal, setModal] = useState(null); // null | 'add' | 'withdraw'
    const [notice, setNotice] = useState(null);
    // One idempotency key per (attempt, amount) — same "retry-safe" reasoning as
    // GoTreasuryTabReal's contributeKeyRef/spendKeyRef: reusing the key on a plain retry of a
    // failed/dropped call lets the server (see 41_migration_guild_member_earnings_withdrawal.sql)
    // recognize it and return the original release instead of moving the kobo twice, but a
    // *different* amount is a genuinely new attempt and must get a fresh key. Tracked here
    // (rather than cleared on an input's onChange, as GoTreasuryTabReal does) because
    // WithdrawModal owns its own amount field internally — this just compares the amount it's
    // handed at call time against the amount the current key was minted for.
    const releaseKeyRef = useRef({ key: null, amountNaira: null });

    const load = () => {
        Promise.all([
            fetchGuildMemberEarningsSummary(guildId),
            fetchGuildMemberEarningsTransactions(guildId),
            fetchSavedBankAccounts(),
            // The real bank-transfer withdrawal rows (pending -> success/failed — see
            // withdrawalStage() in creator-dashboard.jsx), not this guild's own release-to-balance
            // ledger rows below: those are always instant, synchronous bookkeeping (see
            // withdrawGuildMemberEarnings's comment in guild-treasury.js) and can never actually
            // be pending/failed the way a real Paystack transfer can. This is what "Withdrawal
            // history" below actually shows, since it's the only list with a real payout status.
            // Cross-guild by nature (author_balance_kobo has no guild scope), same as
            // CreatorWithdrawalsPanel's own list.
            fetchWithdrawals(),
        ])
            .then(([summary, transactions, accts, withdrawals]) => {
                setState({ loading: false, error: null, summary, transactions, withdrawals });
                setAccounts(accts);
            })
            .catch((e) => setState((s) => ({ ...s, loading: false, error: e.message || 'Could not open your earnings.' })));
    };
    useEffect(() => { load(); }, [guildId]);

    const defaultAccount = accounts.find((a) => a.is_default) || accounts[0] || null;

    // Earnings by project — every credit this member was ever paid in this guild
    // (kind !== 'release_to_member'), grouped by whichever Anthology or Guild Event produced it.
    // Plain contributions never land here (those are 'guild'-bucket rows, not 'member' — this
    // screen only ever sees this member's own held earnings to begin with).
    const byProject = useMemo(() => {
        const groups = new Map();
        for (const t of state.transactions) {
            if (t.kind === 'release_to_member') continue;
            const key = t.anthology_id || t.project_event_id || 'guild';
            const label = t.title || 'Guild earnings';
            const existing = groups.get(key) || { key, label, totalNaira: 0 };
            existing.totalNaira += t.amountNaira;
            groups.set(key, existing);
        }
        return [...groups.values()].sort((a, b) => b.totalNaira - a.totalNaira);
    }, [state.transactions]);

    const handleDelete = async (id) => {
        try { await deleteBankAccount(id); load(); } catch (e) { setNotice({ type: 'error', text: e.message }); }
    };
    const handleSetDefault = async (id) => {
        try { await setDefaultBankAccount(id); load(); } catch (e) { setNotice({ type: 'error', text: e.message }); }
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '20px 10px' } }, "Opening your earnings\u2026");
    }
    if (state.error || !state.summary) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '20px 10px' } }, state.error || 'Could not open your earnings.');
    }

    const stat = (label, naira) => React.createElement("div", { key: label, style: { textAlign: 'center' } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[17], fontWeight: 600, color: '#E8C468' } }, formatNairaBalance(naira)),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 } }, label));

    const canWithdraw = state.summary.availableNaira >= 100;

    return React.createElement("div", { style: { marginTop: 8, paddingTop: 20, borderTop: '1px solid #2A2A30' } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Your drawer in the coffer'),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginBottom: 14, fontStyle: 'italic' } }, "Held in trust by this guild's treasury until you withdraw it \u2014 nobody but you can see or move this money."),

        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px,1fr))', gap: SPACE_SCALE[14], marginBottom: 16, padding: '16px 12px', background: 'linear-gradient(165deg,#1D1A14,#17140F)', border: '1px solid #332B1D', borderRadius: RADIUS_SCALE[12] } },
            stat('Available', state.summary.availableNaira),
            stat('Pending', state.summary.pendingNaira),
            stat('Lifetime', state.summary.lifetimeNaira)),

        notice && React.createElement("div", { style: { color: notice.type === 'error' ? '#D98A8A' : '#8FCB8F', fontSize: TYPE_SCALE[11.5], marginBottom: 10, textAlign: 'center' } }, notice.text),

        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 20, flexWrap: 'wrap' } },
            defaultAccount && canWithdraw && React.createElement("button", { onClick: () => setModal('withdraw'), style: memberEarningsBtnStyle(true) }, `Withdraw ${formatNaira(state.summary.availableNaira)}`),
            React.createElement("button", { onClick: () => setModal('add'), style: memberEarningsBtnStyle(false) }, defaultAccount ? '+ Add another payout account' : '+ Add a payout account')),
        !defaultAccount && React.createElement(MemberEarningsLocked, { text: 'Add a payout bank account before you can withdraw.' }),
        defaultAccount && !canWithdraw && React.createElement(MemberEarningsLocked, { text: 'Nothing verified and available to withdraw yet.' }),

        accounts.length > 0 && React.createElement("div", { style: { marginBottom: 22 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } }, 'Payout account'),
            React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                accounts.map((a) => React.createElement("div", {
                    key: a.id, style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 12px',
                        borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: a.is_default ? '1px solid #C89B3C' : '1px solid #2A2A30',
                    },
                },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE', fontWeight: 600 } }, a.account_name, a.is_default && React.createElement("span", { style: { color: '#C89B3C', fontSize: TYPE_SCALE[10], marginLeft: 6 } }, "\u2605 Default")),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 2 } }, `${a.bank_name} \u2014 ${a.account_number}`)),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6] } },
                        !a.is_default && React.createElement("button", { onClick: () => handleSetDefault(a.id), style: { ...memberEarningsBtnStyle(false), padding: '4px 8px', fontSize: TYPE_SCALE[10.5] } }, "Make default"),
                        React.createElement("button", { onClick: () => handleDelete(a.id), style: { ...memberEarningsBtnStyle(false), padding: '4px 8px', fontSize: TYPE_SCALE[10.5], color: '#D98A8A', border: '1px solid #3A2020' } }, "Delete"))))),

        React.createElement("div", { style: { marginBottom: 22 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Earnings by project'),
            byProject.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, "Nothing yet \u2014 once a project pays out to you through this guild, it'll show up here.")
                : byProject.map((p) => React.createElement("div", { key: p.key, style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12], color: '#8A8680', padding: '7px 0', borderBottom: '1px solid #2A2A30' } },
                    React.createElement("span", null, p.label), React.createElement("span", { style: { color: '#7FB2A0' } }, `+${formatNaira(p.totalNaira)}`)))),

        React.createElement("div", { style: { marginBottom: 22 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Transactions'),
            state.transactions.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No transactions yet.')
                : state.transactions.map((t) => React.createElement("div", { key: t.id, style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12], color: '#8A8680', padding: '7px 0', borderBottom: '1px solid #2A2A30' } },
                    React.createElement("span", null, (t.title || t.kind) + (t.status === 'pending' ? ' (pending)' : '')),
                    React.createElement("span", { style: { color: t.direction === 'credit' ? '#7FB2A0' : '#C89B3C' } }, `${t.direction === 'credit' ? '+' : '-'}${formatNaira(t.amountNaira)}`)))),

        React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, 'Withdrawal history'),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginBottom: 10, fontStyle: 'italic' } }, "Every withdrawal you've made to your bank account, from any guild or sale \u2014 the payout account is shared across Inkroot, not per-guild."),
            state.withdrawals.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, "You haven't withdrawn yet.")
                : state.withdrawals.map((w) => React.createElement("div", { key: w.id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', fontSize: TYPE_SCALE[12], color: '#8A8680', padding: '9px 0', borderBottom: '1px solid #2A2A30' } },
                    React.createElement("div", null,
                        React.createElement("span", null, new Date(w.created_at).toLocaleDateString()),
                        React.createElement(WithdrawalStatusStepper, { stage: withdrawalStage(w), failureReason: w.failure_reason })),
                    React.createElement("span", { style: { color: '#C89B3C', fontWeight: 600 } }, `-${formatNaira(koboToNaira(w.amount_kobo))}`)))),

        modal === 'add' && React.createElement(AddBankAccountModal, {
            onClose: () => setModal(null),
            onSaved: () => { setModal(null); setNotice({ type: 'success', text: 'Payout account saved.' }); load(); },
        }),
        modal === 'withdraw' && defaultAccount && React.createElement(WithdrawModal, {
            account: defaultAccount, availableNaira: state.summary.availableNaira, onClose: () => setModal(null),
            beforeWithdraw: async (amountNaira) => {
                if (releaseKeyRef.current.amountNaira !== amountNaira) {
                    releaseKeyRef.current = { key: uuid(), amountNaira };
                }
                await withdrawGuildMemberEarnings(guildId, amountNaira, releaseKeyRef.current.key);
            },
            onRequested: () => {
                releaseKeyRef.current = { key: null, amountNaira: null };
                setModal(null);
                setNotice({ type: 'success', text: 'Withdrawal requested \u2014 it should arrive shortly.' });
                load();
            },
        })));
}
