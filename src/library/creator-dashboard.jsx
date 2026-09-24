import React, { useState, useEffect } from 'react';
import { fetchFollowers } from '../lib/library.js';
import { AuthorStudioPackCard, CreatorAnalyticsPanel, CreatorBookCard, CreatorDashboardStyles, CreatorRatingsPanel } from './grand-library-cards.jsx';
import { CreatorInsightsSection, CreatorWorkshopHeader, CreatorWorkshopScene, CreatorWorkshopStyles, CreatorWorkshopSurface, WORKSHOP_STATIONS } from './creator-workshop.jsx';
import { resolvePublishStatus } from './publishing.jsx';
import { ReferralDashboardPanel } from './referral-dashboard.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { useSync } from '../shell/sync-context.jsx';
import {
    ACTIVE_WITHDRAWAL_METHOD, deleteBankAccount, fetchAvailableBalanceNaira, fetchBanks, fetchBookSalesSummary, fetchSalesLedger, fetchSavedBankAccounts,
    fetchWithdrawals, formatNaira, formatNairaBalance, koboToNaira, requestManualWithdrawal, requestWithdrawal, resolveBankAccount, saveBankAccount, setDefaultBankAccount,
} from '../lib/payments.js';
// Templates and Add-ons are per-device lists (readTemplates/readAddons), not per-project, so
// they're read here the same direct way grand-library-screen.jsx's Author Studio Marketplace
// tab already reads them — see CreatorTemplatesPanel/CreatorAddonsPanel below, which replace
// what used to be a "Coming Soon" placeholder on both these tabs even though the real Template
// and Addon Marketplaces (fix-tracker items 21-22) have existed for a while, just without an
// entry point here. MarketplaceToggle is the exact same share/unshare action a project's own
// Publishing Hub → Templates/Add-ons tab already uses (imported, not duplicated), so sharing
// from here and sharing from there hit the same published_templates/published_addons row.
import { readTemplates, writeTemplates, TEMPLATE_TYPES, MarketplaceToggle as TemplateMarketplaceToggle } from '../writing/templates.jsx';
import { readAddons, writeAddons } from '../writing/addon-data.jsx';
import { MarketplaceToggle as AddonMarketplaceToggle } from '../writing/addon-studio.jsx';


// Shared modal chrome for the two payment dialogs below (Add Bank Account, Withdraw) — same
// centered-card-over-scrim shape as TipAuthorModal in publishing.jsx, just not exported from
// there since these two are Creator Dashboard-only.
function PaymentModal({ title, onClose, children }) {
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
                React.createElement("button", { onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            children));
}


const inputStyle = {
    width: '100%', boxSizing: 'border-box', background: '#1D1D22', border: '1px solid #2A2A30', color: '#EFE7D2',
    borderRadius: RADIUS_SCALE[8], padding: '9px 11px', fontSize: TYPE_SCALE[13], marginTop: 4,
};
const primaryButtonStyle = (disabled) => ({
    width: '100%', border: 'none', borderRadius: RADIUS_SCALE[10], padding: '10px 0', marginTop: 14,
    background: 'linear-gradient(160deg, #E8C468, #C89B3C)', color: '#17130E', fontSize: TYPE_SCALE[13], fontWeight: 700,
    cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.6 : 1,
});


// Adding a saved bank account: pick a bank, enter the 10-digit NUBAN, resolve+confirm whose
// account it actually is (via Paystack — see resolveBankAccount), then save it. Nothing is
// stored until the account name comes back and the person confirms it's right — see
// paystack-save-bank-account, which re-resolves server-side rather than trusting this step's
// result, so this confirm step is purely so a mistyped account number gets caught by the person
// before anything is saved, not a security boundary.
export function AddBankAccountModal({ onClose, onSaved }) {
    const [banks, setBanks] = useState([]);
    const [banksError, setBanksError] = useState(null);
    const [bankCode, setBankCode] = useState('');
    const [accountNumber, setAccountNumber] = useState('');
    const [resolvedName, setResolvedName] = useState(null);
    const [step, setStep] = useState('form'); // form | resolving | confirm | saving | error
    const [error, setError] = useState(null);

    useEffect(() => {
        fetchBanks().then(setBanks).catch((e) => setBanksError(e.message));
    }, []);

    const handleResolve = async () => {
        setStep('resolving');
        setError(null);
        try {
            const name = await resolveBankAccount({ accountNumber, bankCode });
            setResolvedName(name);
            setStep('confirm');
        } catch (e) {
            setError(e.message);
            setStep('form');
        }
    };

    const handleConfirm = async () => {
        setStep('saving');
        setError(null);
        try {
            const account = await saveBankAccount({ accountNumber, bankCode });
            onSaved(account);
        } catch (e) {
            setError(e.message);
            setStep('confirm');
        }
    };

    return React.createElement(PaymentModal, { title: "Add a bank account", onClose },
        step !== 'confirm' && React.createElement(React.Fragment, null,
            React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Bank"),
            banksError
                ? React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12], marginTop: 4 } }, banksError)
                : React.createElement("select", { value: bankCode, onChange: (e) => setBankCode(e.target.value), style: inputStyle },
                    React.createElement("option", { value: "" }, banks.length ? "Choose your bank\u2026" : "Loading banks\u2026"),
                    banks.map((b) => React.createElement("option", { key: b.code, value: b.code }, b.name))),
            React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 14, display: 'block' } }, "Account number"),
            React.createElement("input", { value: accountNumber, onChange: (e) => setAccountNumber(e.target.value.replace(/\D/g, '').slice(0, 10)), placeholder: "10-digit account number", style: inputStyle }),
            error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
            React.createElement("button", {
                disabled: step === 'resolving' || !bankCode || accountNumber.length !== 10, onClick: handleResolve,
                style: primaryButtonStyle(step === 'resolving' || !bankCode || accountNumber.length !== 10),
            }, step === 'resolving' ? 'Looking up account\u2026' : 'Continue')),
        step === 'confirm' && React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82' } }, "This account belongs to:"),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#E8C468', marginTop: 6 } }, resolvedName),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 4 } }, `${accountNumber} \u2014 ${(banks.find((b) => b.code === bankCode) || {}).name}`),
            error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 16 } },
                React.createElement("button", { onClick: () => setStep('form'), style: {
                        flex: 1, background: 'none', border: '1px solid #3A3020', color: '#A6A6AD', borderRadius: RADIUS_SCALE[10], padding: '10px 0', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                    } }, "Not me \u2014 go back"),
                React.createElement("button", { disabled: step === 'saving', onClick: handleConfirm, style: { ...primaryButtonStyle(step === 'saving'), flex: 1, marginTop: 0 } },
                    step === 'saving' ? 'Saving\u2026' : 'Save this account'))));
}


// Withdrawals never carry an Inkroot platform fee of their own — the platform's cut (see
// PLATFORM_FEE_BPS) is already taken out of a sale/tip before it ever reaches author_balance_kobo
// (or, for guild earnings, before it's released into that same balance), so what a writer sees as
// "available" here is already net. This constant is what the confirm step below shows as "Fees" —
// kept as one named 0 rather than a hardcoded literal in the JSX so it reads as a deliberate fact
// about how withdrawals work, not an oversight. If a real withdrawal-time fee is ever introduced
// server-side, this is the one place a UI-side estimate would need to change to match it.
const WITHDRAWAL_FEE_NAIRA = 0;

// A withdrawal's lifecycle as reported by the withdrawals row: pending -> success/failed (see
// supabase/functions/paystack-webhook and the `withdrawals` table's own status check). Nothing
// server-side has a distinct "processing" status of its own — but by the time paystack-withdraw
// returns, it has already handed the transfer to Paystack and stamped the row with
// paystack_transfer_code (see that function), so a still-'pending' row that already has a
// transfer code is honestly "sent, awaiting confirmation" rather than merely "requested". This
// is a read-only presentational distinction — see fetchWithdrawals()'s own note — never something
// this file writes back or gates an action on.
export function withdrawalStage(w) {
    if (w.status === 'success') return 'completed';
    if (w.status === 'failed') return 'failed';
    return w.paystack_transfer_code ? 'processing' : 'pending';
}

const STAGE_STEPS = [
    { key: 'pending', label: 'Pending' },
    { key: 'processing', label: 'Processing' },
    { key: 'completed', label: 'Completed' },
];
const STAGE_ORDER = { pending: 0, processing: 1, completed: 2, failed: 2 };

// A small horizontal Pending -> Processing -> Completed (or Failed, replacing the last step)
// tracker for one withdrawal. Purely a display of the status/paystack_transfer_code this
// withdrawal row already carries — see withdrawalStage() above for exactly how those two fields
// map onto a stage.
export function WithdrawalStatusStepper({ stage, failureReason }) {
    const steps = stage === 'failed'
        ? [STAGE_STEPS[0], STAGE_STEPS[1], { key: 'failed', label: 'Failed' }]
        : STAGE_STEPS;
    const activeIndex = STAGE_ORDER[stage];
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', marginTop: 6 } },
        steps.map((step, i) => {
            const isFailedStep = step.key === 'failed';
            const reached = i <= activeIndex;
            const color = isFailedStep && reached ? '#D98A8A' : reached ? '#8FCB8F' : '#3A3A40';
            const textColor = isFailedStep && reached ? '#D98A8A' : reached ? '#D9D2BE' : '#5C5C64';
            return React.createElement(React.Fragment, { key: step.key },
                i > 0 && React.createElement("div", { style: { width: 14, height: 1, background: i <= activeIndex ? color : '#2A2A30', flexShrink: 0 } }),
                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }, title: isFailedStep && failureReason ? failureReason : undefined },
                    React.createElement("span", { style: { width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 } }),
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: textColor, textTransform: 'uppercase', letterSpacing: '0.03em' } }, step.label)));
        }));
}

// Requesting a withdrawal against the saved default bank account. Two steps under one modal:
// 'form' (choose the amount) then 'confirm' (review destination, fees, and the final amount
// before anything is sent) — a mis-tapped amount or the wrong saved account gets caught here
// rather than after money is already moving. The amount itself is only ever validated for real
// against author_balance_kobo() server-side (see paystack-withdraw) — the max/placeholder here
// is a convenience, not the actual enforcement.
//
// beforeWithdraw is an optional async hook run immediately before the withdrawal request itself
// — e.g. Guild Member Earnings (guild-member-earnings.jsx) uses it to release held guild
// earnings into this same withdrawable balance first, so "release, then withdraw" reads as one
// action to the person even though it's two server calls. Defaults to a no-op so every other
// caller of this modal is unaffected. A rejected beforeWithdraw stops here — requestWithdrawal
// never runs — and its error is shown the same way a failed withdrawal request would be.
export function WithdrawModal({ account, availableNaira, onClose, onRequested, beforeWithdraw }) {
    const [amount, setAmount] = useState(availableNaira);
    const [step, setStep] = useState('form'); // form | confirm | requesting | error
    const [error, setError] = useState(null);

    const amountValid = amount && amount >= 100 && amount <= availableNaira;
    const finalAmount = amountValid ? amount - WITHDRAWAL_FEE_NAIRA : 0;

    const handleWithdraw = async () => {
        setStep('requesting');
        setError(null);
        try {
            if (beforeWithdraw) await beforeWithdraw(amount);
            const withdrawal = ACTIVE_WITHDRAWAL_METHOD === 'manual'
                ? await requestManualWithdrawal({ bankAccountId: account.id, amountNaira: amount })
                : await requestWithdrawal({ bankAccountId: account.id, amountNaira: amount });
            onRequested(withdrawal);
        } catch (e) {
            setError(e.message);
            setStep('confirm');
        }
    };

    if (step === 'confirm' || step === 'requesting') {
        return React.createElement(PaymentModal, { title: "Confirm withdrawal", onClose },
            row('Amount', formatNaira(amount)),
            row('Destination account', React.createElement(React.Fragment, null,
                React.createElement("div", { style: { fontWeight: 600, color: '#EFE7D2' } }, account.account_name),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 2 } }, `${account.bank_name} \u2014 ${account.account_number}`))),
            row('Fees', WITHDRAWAL_FEE_NAIRA > 0 ? formatNaira(WITHDRAWAL_FEE_NAIRA) : 'No fee'),
            React.createElement("div", { style: { borderTop: '1px solid #3A3020', margin: '10px 0' } }),
            row('You\u2019ll receive', React.createElement("span", { style: { fontSize: TYPE_SCALE[16], fontWeight: 700, color: '#E8C468' } }, formatNaira(finalAmount))),
            ACTIVE_WITHDRAWAL_METHOD === 'manual' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10, fontStyle: 'italic' } },
                "Withdrawals are reviewed and sent by hand right now, usually within a day or two \u2014 not instant."),
            error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 12 } }, error),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 16 } },
                React.createElement("button", { disabled: step === 'requesting', onClick: () => setStep('form'), style: {
                        flex: 1, background: 'none', border: '1px solid #3A3020', color: '#A6A6AD', borderRadius: RADIUS_SCALE[10], padding: '10px 0', fontSize: TYPE_SCALE[13], cursor: step === 'requesting' ? 'default' : 'pointer', opacity: step === 'requesting' ? 0.6 : 1,
                    } }, "Back"),
                React.createElement("button", { disabled: step === 'requesting', onClick: handleWithdraw, style: { ...primaryButtonStyle(step === 'requesting'), flex: 1, marginTop: 0 } },
                    step === 'requesting' ? 'Sending\u2026' : `Confirm \u2014 ${formatNaira(amount)}`)));
    }

    return React.createElement(PaymentModal, { title: "Withdraw earnings", onClose },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82' } }, "Sending to:"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], fontWeight: 600, color: '#EFE7D2', marginTop: 2 } }, account.account_name),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, `${account.bank_name} \u2014 ${account.account_number}`),
        React.createElement("label", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginTop: 16, display: 'block' } }, `Amount (up to ${formatNaira(availableNaira)})`),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
            React.createElement("span", { style: { color: '#7A7A82', fontSize: TYPE_SCALE[13] } }, "\u20a6"),
            React.createElement("input", { type: "number", min: 100, max: availableNaira, value: amount, onChange: (e) => setAmount(Number(e.target.value)), style: { ...inputStyle, marginTop: 0 } })),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 8 } }, WITHDRAWAL_FEE_NAIRA > 0 ? `A ${formatNaira(WITHDRAWAL_FEE_NAIRA)} fee applies \u2014 you'll confirm the final amount next.` : 'No withdrawal fee \u2014 the full amount you enter is what arrives.'),
        error && React.createElement("div", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 10 } }, error),
        React.createElement("button", {
            disabled: !amountValid, onClick: () => setStep('confirm'),
            style: primaryButtonStyle(!amountValid),
        }, 'Review withdrawal'));
}

// Small label/value row shared by the confirm step above.
function row(label, value) {
    return React.createElement("div", { key: label, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[10], padding: '6px 0', fontSize: TYPE_SCALE[12.5] } },
        React.createElement("span", { style: { color: '#7A7A82' } }, label),
        React.createElement("span", { style: { color: '#D9D2BE', textAlign: 'right' } }, value));
}


// Earnings — a real ledger of book sales and tips (see purchases table / fetchSalesLedger),
// each row already split into what the reader paid vs what this author was actually credited
// (Inkroot's platform fee is the difference — see PLATFORM_FEE_BPS in the paystack functions).
export function CreatorEarningsPanel() {
    const [state, setState] = useState({ loading: true, error: null, balance: 0, ledger: [] });
    useEffect(() => {
        let cancelled = false;
        Promise.all([fetchAvailableBalanceNaira(), fetchSalesLedger()])
            .then(([balance, ledger]) => { if (!cancelled) setState({ loading: false, error: null, balance, ledger }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, balance: 0, ledger: [] }); });
        return () => { cancelled = true; };
    }, []);
    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading earnings\u2026");
    }
    if (state.error) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '20px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load earnings right now \u2014 check your connection and try again.");
    }
    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: {
                textAlign: 'center', padding: '20px 0', marginBottom: 18, borderRadius: RADIUS_SCALE[14],
                background: 'linear-gradient(160deg, #2A2317, #17130E)', border: '1px solid #4A3D22',
            } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Available balance"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontWeight: 600, color: '#E8C468', marginTop: 4 } }, formatNairaBalance(state.balance))),
        state.ledger.length === 0
            ? React.createElement(EmptyState, { text: "No sales or tips yet \u2014 once a reader buys a book or tips you, it'll show up here." })
            : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                state.ledger.map((row) => React.createElement("div", {
                    key: row.id, style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px',
                        borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2417',
                    },
                },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#D9D2BE', fontWeight: 600, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } }, React.createElement(InkIcon, { name: row.kind === 'tip' ? 'coin' : 'cart', size: 12 }), row.kind === 'tip' ? 'Tip' : 'Book sale'),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 2 } }, new Date(row.created_at).toLocaleString())),
                    React.createElement("div", { style: { textAlign: 'right' } },
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: row.status === 'success' ? '#8FCB8F' : row.status === 'failed' ? '#D98A8A' : '#C9BE8D' } }, formatNaira(koboToNaira(row.author_amount_kobo))),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[10], color: '#5C5C64', textTransform: 'capitalize' } }, row.status))))));
}


// Withdrawals — manage saved bank accounts (one lives here at a time as "default", see
// bank_accounts.is_default) and cash out the available balance to it. Saving an account once and
// reusing it is the whole point (see set_default_bank_account / deleteBankAccount) — this screen
// never asks for account details again after the first save, only to add a different one or
// withdraw.
export function CreatorWithdrawalsPanel() {
    const [state, setState] = useState({ loading: true, error: null, balance: 0, accounts: [], withdrawals: [] });
    const [modal, setModal] = useState(null); // null | 'add' | 'withdraw'
    const [notice, setNotice] = useState(null);

    const reload = () => {
        Promise.all([fetchAvailableBalanceNaira(), fetchSavedBankAccounts(), fetchWithdrawals()])
            .then(([balance, accounts, withdrawals]) => setState({ loading: false, error: null, balance, accounts, withdrawals }))
            .catch((e) => setState((s) => ({ ...s, loading: false, error: e })));
    };
    useEffect(reload, []);

    const defaultAccount = state.accounts.find((a) => a.is_default) || state.accounts[0] || null;

    const handleDelete = async (id) => {
        try {
            await deleteBankAccount(id);
            reload();
        } catch (e) { setNotice({ type: 'error', text: e.message }); }
    };
    const handleSetDefault = async (id) => {
        try {
            await setDefaultBankAccount(id);
            reload();
        } catch (e) { setNotice({ type: 'error', text: e.message }); }
    };

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading\u2026");
    }
    if (state.error) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '20px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load withdrawals right now \u2014 check your connection and try again.");
    }

    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: {
                textAlign: 'center', padding: '20px 0', marginBottom: 18, borderRadius: RADIUS_SCALE[14],
                background: 'linear-gradient(160deg, #2A2317, #17130E)', border: '1px solid #4A3D22',
            } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em' } }, "Available balance"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontWeight: 600, color: '#E8C468', marginTop: 4 } }, formatNairaBalance(state.balance)),
            defaultAccount && state.balance >= 100 && React.createElement("button", { onClick: () => setModal('withdraw'), style: {
                    marginTop: 12, border: 'none', borderRadius: RADIUS_SCALE[10], padding: '9px 20px',
                    background: 'linear-gradient(160deg, #E8C468, #C89B3C)', color: '#17130E', fontSize: TYPE_SCALE[12.5], fontWeight: 700, cursor: 'pointer',
                } }, "Withdraw")),

        notice && React.createElement("div", { style: { color: notice.type === 'error' ? '#D98A8A' : '#8FCB8F', fontSize: TYPE_SCALE[12], marginBottom: 12, textAlign: 'center' } }, notice.text),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } }, "Saved bank accounts"),
        state.accounts.length === 0
            ? React.createElement(EmptyState, { text: "No saved bank account yet \u2014 add one to withdraw your earnings." })
            : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8], marginBottom: 8 } },
                state.accounts.map((a) => React.createElement("div", {
                    key: a.id, style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px',
                        borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: a.is_default ? '1px solid #C89B3C' : '1px solid #2A2417',
                    },
                },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#D9D2BE', fontWeight: 600 } }, a.account_name, a.is_default && React.createElement("span", { style: { color: '#C89B3C', fontSize: TYPE_SCALE[10], marginLeft: 6 } }, "\u2605 Default")),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', marginTop: 2 } }, `${a.bank_name} \u2014 ${a.account_number}`)),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                        !a.is_default && React.createElement("button", { onClick: () => handleSetDefault(a.id), style: {
                                background: 'none', border: '1px solid #3A3020', color: '#A6A6AD', borderRadius: RADIUS_SCALE[8], padding: '5px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer',
                            } }, "Make default"),
                        React.createElement("button", { onClick: () => handleDelete(a.id), style: {
                                background: 'none', border: '1px solid #3A2020', color: '#D98A8A', borderRadius: RADIUS_SCALE[8], padding: '5px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer',
                            } }, "Delete"))))),
        React.createElement("button", { onClick: () => setModal('add'), style: {
                background: 'none', border: '1px dashed #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[10],
                padding: '9px 0', width: '100%', fontSize: TYPE_SCALE[12.5], cursor: 'pointer', fontWeight: 600, marginTop: 4,
            } }, "+ Add a bank account"),

        state.withdrawals.length > 0 && React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', margin: '20px 0 8px' } }, "Withdrawal history"),
            React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                state.withdrawals.map((w) => React.createElement("div", {
                    key: w.id, style: {
                        display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 14px',
                        borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2417', fontSize: TYPE_SCALE[12],
                    },
                },
                    React.createElement("div", null,
                        React.createElement("div", { style: { color: '#D9D2BE' } }, new Date(w.created_at).toLocaleDateString()),
                        React.createElement(WithdrawalStatusStepper, { stage: withdrawalStage(w), failureReason: w.failure_reason })),
                    React.createElement("span", { style: { fontWeight: 600, color: '#E8C468' } }, formatNaira(koboToNaira(w.amount_kobo))))))),

        modal === 'add' && React.createElement(AddBankAccountModal, {
            onClose: () => setModal(null),
            onSaved: () => { setModal(null); setNotice({ type: 'success', text: 'Bank account saved.' }); reload(); },
        }),
        modal === 'withdraw' && defaultAccount && React.createElement(WithdrawModal, {
            account: defaultAccount, availableNaira: state.balance, onClose: () => setModal(null),
            onRequested: () => { setModal(null); setNotice({ type: 'success', text: ACTIVE_WITHDRAWAL_METHOD === 'manual' ? 'Withdrawal requested \u2014 it will be reviewed and sent within a day or two.' : 'Withdrawal requested \u2014 it should arrive shortly.' }); reload(); },
        }));
}


// Real followers — the honest slice of "who's reading your work" this phase can deliver (see
// the comment in library.js's fetchFollowers). Page-view/traffic-source tracking isn't part of
// this phase; the description below says so rather than implying it's covered.
export function CreatorReadersPanel() {
    const [state, setState] = useState({ loading: true, error: null, followers: [] });
    useEffect(() => {
        let cancelled = false;
        fetchFollowers()
            .then((followers) => { if (!cancelled) setState({ loading: false, error: null, followers }); })
            .catch((e) => { if (!cancelled) setState({ loading: false, error: e, followers: [] }); });
        return () => { cancelled = true; };
    }, []);
    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading followers\u2026");
    }
    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' } },
            "Real followers \u2014 traffic sources and page-view analytics aren't tracked yet"),
        state.error && React.createElement("div", { style: { textAlign: 'center', padding: '20px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load followers right now \u2014 check your connection and try again."),
        !state.error && state.followers.length === 0 && React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "No followers yet \u2014 once other readers follow you, they'll show up here."),
        !state.error && state.followers.length > 0 && React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
            state.followers.map((f) => React.createElement("div", {
                key: f.follower_id, style: {
                    display: 'flex', justifyContent: 'space-between', padding: '10px 14px',
                    borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2417',
                    fontSize: TYPE_SCALE[12], color: '#D9D2BE',
                },
            }, `Reader ${f.follower_id.slice(0, 8)}`, React.createElement("span", { style: { color: '#5C5C64' } }, new Date(f.created_at).toLocaleDateString())))));
}


// A single row for one shared-or-shareable item (template or addon) on the summary tabs below —
// icon/name/type on the left, marketplace status + the real Share/Unshare toggle on the right.
// Deliberately read-only beyond that toggle: creating, editing, and installing a template or
// addon still happens in a project's own Publishing Hub (templates.jsx/addon-studio.jsx), which
// is the only place with the project context (`update`) those actions need — this row exists so
// a writer can see what they've already made and share it without opening a project first.
function CreatorShareableRow({ icon, name, meta, toggle }) {
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], padding: '10px 12px',
            background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10],
        } },
        React.createElement("span", { style: { fontSize: 18, flexShrink: 0 } }, icon),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#EFE7D2', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, name),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, meta)),
        toggle);
}


// Read-only summary of this device's local templates (see readTemplates in templates.jsx),
// with the same real Share-to-Marketplace toggle the Publishing Hub's own Templates tab uses —
// this is what used to be a flat "Coming Soon" panel on this tab, even though the Template
// Marketplace itself (fix-tracker item 22) has been live for a while.
function CreatorTemplatesPanel() {
    const sync = useSync();
    const signedIn = !!(sync && sync.session && sync.session.user);
    const [templates, setTemplates] = useState(() => readTemplates());
    const onChange = (next) => { setTemplates(next); writeTemplates(next); };
    const updateTemplate = (id, patch) => onChange(templates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
    const typeLabel = (type) => (TEMPLATE_TYPES.find((t) => t.key === type) || {}).label || type;
    if (templates.length === 0) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px', textAlign: 'center' } },
            "No templates yet \u2014 open a project's Publishing \u2192 Templates tab to create one.");
    }
    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
        templates.map((t) => React.createElement(CreatorShareableRow, {
            key: t.id, icon: React.createElement(InkIcon, { name: 'scroll', size: 16 }), name: t.name || 'Untitled template', meta: typeLabel(t.type),
            toggle: React.createElement(TemplateMarketplaceToggle, { template: t, signedIn, onUpdateTemplate: (patch) => updateTemplate(t.id, patch) }),
        })));
}


// Same idea as CreatorTemplatesPanel above, for this device's local addons (readAddons in
// addon-data.jsx) — replaces the other half of what used to be a shared "Coming Soon" panel,
// even though the Addon Marketplace itself (fix-tracker item 21) has been live for a while.
function CreatorAddonsPanel() {
    const sync = useSync();
    const signedIn = !!(sync && sync.session && sync.session.user);
    const [addons, setAddons] = useState(() => readAddons());
    const onChange = (next) => { setAddons(next); writeAddons(next); };
    const updateAddon = (id, patch) => onChange(addons.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    if (addons.length === 0) {
        return React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px', textAlign: 'center' } },
            "No addons yet \u2014 open a project's Publishing \u2192 Add-ons tab to create one.");
    }
    return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
        addons.map((a) => React.createElement(CreatorShareableRow, {
            key: a.id, icon: a.icon || React.createElement(InkIcon, { name: 'puzzle', size: 16 }), name: a.name || 'Untitled addon', meta: `v${a.version || '0.1.0'} \u00B7 ${a.category || 'Other'}`,
            toggle: React.createElement(AddonMarketplaceToggle, { addon: a, signedIn, onUpdateAddon: (patch) => updateAddon(a.id, patch) }),
        })));
}


// The six tabs represented as hands-on furniture stations inside the workshop scene (see
// creator-workshop.jsx). The remaining four -- analytics/ratings/readers/referrals -- are
// exactly the same tabs and the exact same panels as before, just relocated into the compact
// Creator Insights nook below instead of standing shoulder-to-shoulder with these six.
const WORKSHOP_PRIMARY_TAB_KEYS = WORKSHOP_STATIONS.map((s) => s.key);


export function CreatorDashboard({ projects, writerProfile, writerRank, writerReputation, writerGuildName, onOpen, onRead, onSetPublishStatus, onOpenPacks, onSetPackPublishStatus, onOpenPublishWizard }) {
    const [tab, setTab] = useState('books');
    const [insightsOpen, setInsightsOpen] = useState(false);
    const projectsWithPacks = projects.filter((p) => (p.worldbuildingPacks || []).length > 0);
    const publishedBooksCount = projects.filter((p) => resolvePublishStatus(p) !== 'none').length;
    const publishedPacksCount = projects.reduce((sum, p) => sum + (p.worldbuildingPacks || []).filter((pk) => pk.publishStatus && pk.publishStatus !== 'none').length, 0);
    const publishedWorksCount = publishedBooksCount + publishedPacksCount;
    const isPrimaryTab = WORKSHOP_PRIMARY_TAB_KEYS.includes(tab);
    const activeStation = WORKSHOP_STATIONS.find((s) => s.key === tab);
    // Real per-book Sales/Earnings for every CreatorBookCard below — fetched ONCE here for the
    // whole Published Books tab (see fetchBookSalesSummary's own header for why this is a
    // dedicated, uncapped, author-scoped query rather than N per-card calls or a reuse of
    // fetchSalesLedger's capped recent-activity ledger). null means "not loaded yet, or the
    // fetch failed" — every card correctly keeps showing "\u2014" for both fields in that case,
    // rather than a false zero, until this resolves. Re-fetches whenever the published-book count
    // changes (a fresh publish/unpublish), not on every keystroke elsewhere in the dashboard.
    const [salesByBook, setSalesByBook] = useState(null);
    useEffect(() => {
        if (publishedBooksCount === 0) { setSalesByBook({}); return; }
        let cancelled = false;
        fetchBookSalesSummary().then((summary) => { if (!cancelled) setSalesByBook(summary); }).catch(() => {});
        return () => { cancelled = true; };
    }, [publishedBooksCount]);
    let body = null;
    if (projects.length === 0) {
        body = React.createElement(EmptyState, { text: "No projects yet \u2014 start one from Home, then come back here to publish it." });
    }
    else if (tab === 'books') {
        body = React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' } }, "Publish a project and set its marketplace listing \u2014 both live here, together"),
            React.createElement("div", { className: "ink-grid-cards" },
                [...projects].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).map((p) => React.createElement(CreatorBookCard, {
                    key: p.id, project: p, writerGuildName, onSetPublishStatus, onOpenPublishWizard, onOpen, onRead, salesByBook,
                }))));
    }
    else if (tab === 'packs') {
        body = projectsWithPacks.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', fontStyle: 'italic', padding: '6px 2px', textAlign: 'center' } }, "No packs yet \u2014 open a project's Publishing \u2192 Worldbuilding Packs tab to create one.")
            : React.createElement("div", { className: "ink-grid-cards" },
                projectsWithPacks.flatMap((p) => (p.worldbuildingPacks || []).map((pack) => React.createElement(AuthorStudioPackCard, {
                    key: `${p.id}:${pack.id}`, projectId: p.id, projectTitle: p.title, pack, onOpen: onOpenPacks, onUnpublish: onSetPackPublishStatus, onOpenPublishWizard,
                }))));
    }
    else if (tab === 'templates') {
        body = React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' } }, "Share a template with other writers, or unshare one \u2014 both live here, together"),
            React.createElement(CreatorTemplatesPanel, null));
    }
    else if (tab === 'addons') {
        body = React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', marginBottom: 16, fontStyle: 'italic' } }, "Share an addon with other writers, or unshare one \u2014 both live here, together"),
            React.createElement(CreatorAddonsPanel, null));
    }
    else if (tab === 'analytics') {
        body = React.createElement(CreatorAnalyticsPanel, { projects });
    }
    else if (tab === 'earnings') {
        body = React.createElement(CreatorEarningsPanel, null);
    }
    else if (tab === 'withdrawals') {
        body = React.createElement(CreatorWithdrawalsPanel, null);
    }
    else if (tab === 'ratings') {
        body = React.createElement(CreatorRatingsPanel, { projects });
    }
    else if (tab === 'readers') {
        body = React.createElement(CreatorReadersPanel, null);
    }
    else if (tab === 'referrals') {
        body = React.createElement(ReferralDashboardPanel, null);
    }
    // Selecting an Insights tab (Analytics/Ratings/Readers/Referrals) auto-opens the nook so the
    // panel that was just requested is actually visible, rather than requiring a second click.
    const handleSelect = (key) => {
        setTab(key);
        if (!WORKSHOP_PRIMARY_TAB_KEYS.includes(key))
            setInsightsOpen(true);
    };

    return React.createElement("div", { className: "ink-page-in" },
        React.createElement(CreatorDashboardStyles, null),
        React.createElement(CreatorWorkshopStyles, null),
        React.createElement(CreatorWorkshopHeader, { profile: writerProfile, rank: writerRank, reputation: writerReputation }),
        React.createElement(CreatorWorkshopScene, {
            activeTab: tab, onSelect: handleSelect, publishedBooksCount, publishedPacksCount,
        }),
        isPrimaryTab && React.createElement(CreatorWorkshopSurface, { station: activeStation }, body),
        React.createElement(CreatorInsightsSection, {
            activeTab: tab, onSelect: handleSelect, open: insightsOpen, onToggleOpen: () => setInsightsOpen((o) => !o),
            publishedWorksCount, panel: !isPrimaryTab ? body : null,
        }));
}
