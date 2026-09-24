import React, { useState } from 'react';
import { fetchMyReferralCode, fetchMyReferrals, fetchReferralRewardProgress } from '../lib/referrals.js';
import { fetchAvailableBalanceNaira, formatNaira, formatNairaBalance, koboToNaira } from '../lib/payments.js';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { IconCopy } from '../shared-ui/icons.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Referral Dashboard — the Creator Studio tab for src/lib/referrals.js's three fetchX functions,
// which existed already (see supabase/history/55-58_migration_referral_*.sql) but had no screen
// of their own until now. Read-only: nothing here writes anything — fetchReferralRewardProgress()
// itself is what actually grants an eligible reward server-side (see its own comment in
// referrals.js), so simply opening this tab is what makes a just-qualified referral pay out.
//
// Privacy: this screen shows a referrer ONLY what they themselves earned, never anything about
// the person they referred beyond the fact and date of signup and which reward kind(s) it went
// on to unlock. No referee name, email, purchase amount, sales total, or guild revenue figure is
// fetched or displayed here — referral_reward_progress() (the RPC fetchReferralRewardProgress
// calls) only ever returns the REFERRER's own reward amount per kind, never the underlying
// financial activity that triggered it, so there is nothing more granular available to leak even
// by mistake.
//
// "Available referral balance" below is deliberately NOT a separate figure from the Earnings tab
// — see supabase/history/56_migration_referral_rewards.sql's header: a referral reward is paid
// into the exact same author_balance_kobo() every other credit source feeds, on purpose, so
// there is only ever one wallet and one withdrawal flow (see CreatorWithdrawalsPanel). What's
// shown here is the referral-attributable SLICE of that one balance, estimated as the smaller of
// (a) lifetime referral earnings and (b) the account's current total balance — since nothing in
// this schema earmarks a withdrawal or an already-reversed grant back to a specific income
// source, an exact split isn't something the client can compute, and this screen says so rather
// than implying a precision it doesn't have.
//
// UI SCOPE, front-end only — nothing in src/lib/referrals.js or the SQL behind it changed:
// referral_reward_progress() still returns all three kinds (reader_purchase, writer_earnings,
// guild_activity), and a guild-attributable reward still lands in the same wallet balance if one
// was ever granted. This screen simply never surfaces the `guild_activity` slice of the rows it
// gets back — "referral rewards belong only to individual users" is a display decision, not a
// backend one. If a guild reward is ever granted, it's invisible here by omission, same as this
// screen already omits everything about the referred person beyond signup date.
const DISPLAY_KINDS = ['reader_purchase', 'writer_earnings'];
const REWARD_KIND_LABEL = { reader_purchase: 'Reader', writer_earnings: 'Writer' };


// One number-over-label tile in the summary grid — same "big serif number over a small uppercase
// label" shape CreatorEarningsPanel's balance card already uses (creator-dashboard.jsx), just
// compact enough to sit several across. minmax(140px,1fr) keeps it at 2-up on a phone-width
// screen rather than squeezing 4 tiles into one cramped row.
function ReferralStatTile({ label, value, caption, accent }) {
    return React.createElement("div", { style: {
            padding: '14px 12px', borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417',
            textAlign: 'center',
        } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: accent || '#EFE7D2' } }, value),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: 4 } }, label),
        caption && React.createElement("div", { style: { fontSize: TYPE_SCALE[9.5], color: '#5C5C64', marginTop: 3, lineHeight: 1.4 } }, caption));
}


// Small inline glyphs, same weight/style as shared-ui/icons.jsx — kept local since neither exists
// there yet and both are single-purpose to this card.
const IconWhatsApp = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "16", height: "16", fill: "currentColor", ...props },
    React.createElement("path", { d: "M12 2a10 10 0 00-8.6 15L2 22l5.2-1.4A10 10 0 1012 2zm0 18.2a8.1 8.1 0 01-4.3-1.2l-.3-.2-3.1.8.8-3-.2-.3A8.2 8.2 0 1112 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1-.2.2-.7.8-.8.9-.2.2-.3.2-.5.1-.2-.1-1-.4-2-1.2-.7-.7-1.2-1.5-1.4-1.7-.1-.2 0-.4.1-.5l.4-.4c.1-.1.2-.2.3-.4.1-.1 0-.3 0-.4-.1-.1-.6-1.4-.8-1.9-.2-.5-.4-.4-.6-.4h-.5c-.2 0-.4.1-.6.3-.2.2-.8.8-.8 1.9s.8 2.2.9 2.4c.1.2 1.6 2.5 4 3.5.6.2 1 .4 1.3.5.6.2 1 .1 1.4-.1.4-.2 1.3-.5 1.5-1 .2-.5.2-.9.1-1z" })));

const IconShareArrow = (props) => (React.createElement("svg", { viewBox: "0 0 24 24", width: "15", height: "15", fill: "none", stroke: "currentColor", strokeWidth: "2", strokeLinecap: "round", strokeLinejoin: "round", ...props },
    React.createElement("circle", { cx: "18", cy: "5", r: "2.6" }),
    React.createElement("circle", { cx: "6", cy: "12", r: "2.6" }),
    React.createElement("circle", { cx: "18", cy: "19", r: "2.6" }),
    React.createElement("path", { d: "M8.3 10.7l7.4-4.2M8.3 13.3l7.4 4.2" })));

const shareButtonStyle = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7,
    minHeight: 44, flex: '1 1 auto', border: '1px solid #2A2417', borderRadius: RADIUS_SCALE[10],
    background: '#1D1D22', color: '#D9D2BE', fontSize: TYPE_SCALE[12], fontWeight: 600, cursor: 'pointer',
    padding: '0 14px',
};

// The referral link itself — fetchMyReferralCode() turned into the exact `${origin}?ref=${code}`
// shape src/lib/referrals.js's own capturePendingReferralCodeFromUrl reads back out on the other
// end. Copy uses the same "write, flip a Copied flag for 1.5s, no error UI if unavailable"
// pattern as QuickStatsCard (shared-ui/ui-cards.jsx). WhatsApp opens wa.me with the link
// pre-filled into the message; native Share uses the Web Share API and is feature-detected the
// same defensive way — the button simply doesn't render where the API doesn't exist (most
// desktop browsers), rather than showing a button that would fail on tap.
function ReferralLinkCard({ code }) {
    const [copied, setCopied] = useState(false);
    const link = code ? `${window.location.origin}?ref=${code}` : null;
    const shareText = 'Come write or read with me on Inkroot \u2014 it\'s free to join.';
    const canNativeShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

    const handleCopy = () => {
        if (!link || !navigator.clipboard || !navigator.clipboard.writeText) return;
        navigator.clipboard.writeText(link).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
        }).catch(() => { });
    };
    const handleWhatsApp = () => {
        if (!link) return;
        window.open(`https://wa.me/?text=${encodeURIComponent(`${shareText} ${link}`)}`, '_blank', 'noopener');
    };
    const handleNativeShare = () => {
        if (!link || !canNativeShare) return;
        navigator.share({ title: 'Join me on Inkroot', text: shareText, url: link }).catch(() => { });
    };

    return React.createElement("div", { style: {
            padding: 16, marginBottom: 16, borderRadius: RADIUS_SCALE[14],
            background: 'linear-gradient(160deg, #2A2317, #17130E)', border: '1px solid #4A3D22',
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 8 } }, "Your referral link"),
        link
            ? React.createElement(React.Fragment, null,
                React.createElement("div", { style: {
                        fontSize: TYPE_SCALE[12.5], color: '#E8C468', fontFamily: 'monospace',
                        background: '#1D1D22', border: '1px solid #2A2417', borderRadius: RADIUS_SCALE[8], padding: '10px 12px',
                        overflowWrap: 'anywhere', marginBottom: 10,
                    } }, link),
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                    React.createElement("button", { onClick: handleCopy, style: {
                            ...shareButtonStyle,
                            background: copied ? 'rgba(143,203,143,0.18)' : 'linear-gradient(160deg, #E8C468, #C89B3C)',
                            color: copied ? '#8FCB8F' : '#17130E', border: 'none',
                        } },
                        React.createElement(IconCopy, { width: 15, height: 15 }), copied ? 'Copied!' : 'Copy link'),
                    React.createElement("button", { onClick: handleWhatsApp, style: shareButtonStyle },
                        React.createElement(IconWhatsApp, null), 'WhatsApp'),
                    canNativeShare && React.createElement("button", { onClick: handleNativeShare, style: shareButtonStyle },
                        React.createElement(IconShareArrow, null), 'Share')))
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64' } }, "\u2014"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 10, lineHeight: 1.5 } },
            "Share this with readers or writers. It's credited the moment someone signs in for the first time after clicking it."));
}


// The three-stage funnel every referral moves through. Note on honesty: this schema doesn't
// persist a separate "qualified but not yet paid" state — referral_reward_progress() (see
// referrals.js) checks eligibility and grants the reward in the same server call, so "Qualified"
// and "Reward earned" are always reached together, never one without the other. The middle step
// is still shown, rather than collapsed into a 2-step tracker, because it's real and meaningful
// context (this is the bar their referral actually had to clear) — it just isn't a state a
// referral can sit in for a while. `reached` is true once any tracked reward kind unlocks.
function ReferralProgressSteps({ reached, compact }) {
    const steps = ['Referred', 'Qualified', 'Reward earned'];
    const dot = compact ? 7 : 9;
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center' } },
        steps.map((label, i) => {
            const filled = i === 0 ? true : reached;
            return React.createElement(React.Fragment, { key: label },
                i > 0 && React.createElement("div", { style: {
                        width: compact ? 10 : 16, height: 2, background: filled ? '#E8C468' : '#2A2417', flex: '0 0 auto',
                    } }),
                React.createElement("div", { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flex: '0 0 auto' } },
                    React.createElement("div", { style: {
                            width: dot, height: dot, borderRadius: '50%',
                            background: filled ? '#E8C468' : 'transparent',
                            border: `1.5px solid ${filled ? '#E8C468' : '#3A3A40'}`,
                        } }),
                    !compact && React.createElement("span", { style: {
                            fontSize: TYPE_SCALE[8.5], color: filled ? '#C9BE8D' : '#5C5C64',
                            textTransform: 'uppercase', letterSpacing: '0.03em', whiteSpace: 'nowrap',
                        } }, label)));
        }));
}


// Reader Referral and Writer Referral — the only two referral types this screen shows. Each
// summarizes the one qualifying condition for that kind (structural, so safe to state plainly —
// see this file's earlier header note on why exact Naira floors and the fee-share percentage
// stay off the client) and the referrer's own funnel progress across every referral they've made,
// aggregated rather than per-referral (Referral History below covers the per-referral view).
function ReferralTypeCard({ title, blurb, kindKey, totalReferred, progress }) {
    const rows = progress.filter((p) => p.kind === kindKey);
    const unlocked = rows.filter((r) => r.unlocked);
    const earnedNaira = koboToNaira(unlocked.reduce((sum, r) => sum + (r.nairaRewardKobo || 0), 0));
    return React.createElement("div", { style: {
            padding: '16px 16px 14px', borderRadius: RADIUS_SCALE[12], background: '#1D1D22', border: '1px solid #2A2417',
        } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], fontWeight: 700, color: '#D9D2BE', marginBottom: 4 } }, title),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', lineHeight: 1.5, marginBottom: 12 } }, blurb),
        React.createElement("div", { style: { marginBottom: 12 } },
            React.createElement(ReferralProgressSteps, { reached: unlocked.length > 0 })),
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', paddingTop: 10, borderTop: '1px solid #2A2417' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } },
                totalReferred === 0 ? 'No referrals yet' : `${unlocked.length} of ${totalReferred} referred earned a reward`),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[14], fontWeight: 700, color: unlocked.length > 0 ? '#E8C468' : '#5C5C64' } },
                formatNairaBalance(earnedNaira))));
}


// One row in Referral History — a single referred account (identified only by signup date and
// current status, never a name), plus a per-referral progress tracker and whichever reward
// kind(s) it has unlocked so far. Guild-kind rows are filtered out at the call site (DISPLAY_
// KINDS) before this component ever sees them — see this file's header note.
// unlocked/reversed badges: unlocked shows the usual live gold "+amount" chip; reversed shows the
// same kind label but muted and struck through with "(reversed)" rather than disappearing —
// honest history (a reward WAS granted) without implying the money is still there. See
// 59_migration_referral_reward_progress_reflects_reversals.sql — reversed is false for anything
// that's still genuinely unlocked, so a reward is only ever shown in one of these two states.
function ReferralHistoryRow({ referral, rewards }) {
    const unlocked = rewards.filter((r) => r.unlocked);
    const reversed = rewards.filter((r) => r.reversed);
    return React.createElement("div", { style: {
            padding: '12px 14px', borderRadius: RADIUS_SCALE[10], background: '#1D1D22', border: '1px solid #2A2417',
        } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: SPACE_SCALE[8] } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D9D2BE' } },
                "Joined ", new Date(referral.created_at).toLocaleDateString()),
            React.createElement(ReferralProgressSteps, { reached: unlocked.length > 0, compact: true })),
        (unlocked.length > 0 || reversed.length > 0)
            ? React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', marginTop: 10 } },
                unlocked.map((r) => React.createElement("span", { key: r.kind, style: {
                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, color: '#E8C468',
                        background: 'rgba(232,196,104,0.1)', border: '1px solid rgba(232,196,104,0.25)',
                        borderRadius: RADIUS_SCALE[999], padding: '3px 10px',
                    } }, `${REWARD_KIND_LABEL[r.kind] || r.kind} \u00B7 +${formatNaira(koboToNaira(r.nairaRewardKobo))}`)),
                reversed.map((r) => React.createElement("span", { key: r.kind, style: {
                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, color: '#7A7A82',
                        background: 'rgba(122,122,130,0.08)', border: '1px solid rgba(122,122,130,0.2)',
                        borderRadius: RADIUS_SCALE[999], padding: '3px 10px', textDecoration: 'line-through',
                    } }, `${REWARD_KIND_LABEL[r.kind] || r.kind} \u00B7 ${formatNaira(koboToNaira(r.nairaRewardKobo))} (reversed)`)))
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 8, fontStyle: 'italic' } },
                "Still tracking for qualifying activity."));
}


function RewardsPolicyNote() {
    const [expanded, setExpanded] = useState(false);
    return React.createElement("div", { style: { marginBottom: 18 } },
        !expanded
            ? React.createElement("button", {
                onClick: () => setExpanded(true),
                style: { background: 'none', border: 'none', padding: 0, color: '#5C5C64', fontSize: TYPE_SCALE[10.5], cursor: 'pointer', textDecoration: 'underline' },
            }, "How rewards work")
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', lineHeight: 1.6 } },
                "A plain sign-up never pays a reward on its own \u2014 only real, Paystack-confirmed activity does. Each reward type can be earned once per referral. Your reward is always a small share of Inkroot's own platform fee on that activity, never money taken from your invitee's own earnings, and it's only paid out after a short waiting period once the activity is confirmed \u2014 enough time to rule out a refund or a dispute."));
}


export function ReferralDashboardPanel() {
    const [state, setState] = useState({ loading: true, error: null, code: null, referrals: [], progress: [], totalBalanceNaira: 0 });

    React.useEffect(() => {
        let cancelled = false;
        Promise.all([fetchMyReferralCode(), fetchMyReferrals(), fetchReferralRewardProgress(), fetchAvailableBalanceNaira()])
            .then(([code, referrals, progress, totalBalanceNaira]) => {
                if (cancelled) return;
                setState({ loading: false, error: null, code, referrals: referrals || [], progress: progress || [], totalBalanceNaira });
            })
            .catch((e) => { if (!cancelled) setState((s) => ({ ...s, loading: false, error: e })); });
        return () => { cancelled = true; };
    }, []);

    if (state.loading) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '30px 0', color: '#7A7A82', fontSize: TYPE_SCALE[12] } }, "Loading referrals\u2026");
    }
    if (state.error) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '20px 0', color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, "Couldn't load your referrals right now \u2014 check your connection and try again.");
    }

    // Front-end display filter only — see this file's header note. Everything below is derived
    // from this filtered set, so a guild-kind reward (if one was ever granted) never surfaces
    // anywhere on this screen, even though it's still part of the same underlying wallet balance.
    const progress = state.progress.filter((r) => DISPLAY_KINDS.includes(r.kind));
    const rewardsByReferee = new Map();
    for (const r of progress) {
        if (!rewardsByReferee.has(r.refereeId)) rewardsByReferee.set(r.refereeId, []);
        rewardsByReferee.get(r.refereeId).push(r);
    }
    const isSuccessful = (referral) => (rewardsByReferee.get(referral.referee_id) || []).some((r) => r.unlocked);

    const successfulReferrals = state.referrals.filter(isSuccessful).length;
    const pendingRewards = state.referrals.length - successfulReferrals;
    const unlockedRewards = progress.filter((r) => r.unlocked);
    const lifetimeReferralKobo = unlockedRewards.reduce((sum, r) => sum + (r.nairaRewardKobo || 0), 0);
    const lifetimeReferralNaira = koboToNaira(lifetimeReferralKobo);
    // See this file's header comment: an exact "referral-only" slice of the single wallet isn't
    // something the client can compute, so this is a conservative estimate, never larger than
    // either the lifetime total or the account's current total balance.
    const availableReferralNaira = Math.min(lifetimeReferralNaira, state.totalBalanceNaira);

    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: {
                fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', textAlign: 'center', marginBottom: 16, lineHeight: 1.6,
                padding: '0 6px',
            } },
            React.createElement("span", { style: { color: '#D9D2BE', fontWeight: 600 } }, "Sign-ups are free."),
            " You earn when your referrals create genuine value on Inkroot."),

        React.createElement(ReferralLinkCard, { code: state.code }),

        React.createElement("div", { style: {
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: SPACE_SCALE[10], marginBottom: 18,
            } },
            React.createElement(ReferralStatTile, { label: "Successful referrals", value: successfulReferrals, accent: '#8FCB8F' }),
            React.createElement(ReferralStatTile, { label: "Pending rewards", value: pendingRewards, accent: '#C9BE8D' }),
            React.createElement(ReferralStatTile, {
                label: "Available rewards", value: formatNairaBalance(availableReferralNaira), accent: '#E8C468',
                caption: "Part of your Earnings balance",
            }),
            React.createElement(ReferralStatTile, {
                label: "Lifetime earnings", value: formatNairaBalance(lifetimeReferralNaira),
                caption: "Net of any reversed rewards",
            })),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 700, color: '#D9D2BE', marginBottom: 10 } }, "Referral types"),
        React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[10], marginBottom: 10 } },
            React.createElement(ReferralTypeCard, {
                title: "Reader referral", kindKey: "reader_purchase", totalReferred: state.referrals.length, progress,
                blurb: "They make a real, successful purchase \u2014 a book or a tip \u2014 above a minimum amount.",
            }),
            React.createElement(ReferralTypeCard, {
                title: "Writer referral", kindKey: "writer_earnings", totalReferred: state.referrals.length, progress,
                blurb: "They publish a real book (30,000+ words) and their own book sales reach a minimum amount in real earnings.",
            })),
        React.createElement(RewardsPolicyNote, null),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 700, color: '#D9D2BE', marginBottom: 10 } }, "Referral history"),
        state.referrals.length === 0
            ? React.createElement(EmptyState, { text: "No referrals yet \u2014 share your link above and they'll show up here as soon as someone signs in through it." })
            : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[8] } },
                state.referrals.map((r) => React.createElement(ReferralHistoryRow, {
                    key: r.referee_id, referral: r, rewards: rewardsByReferee.get(r.referee_id) || [],
                }))));
}
