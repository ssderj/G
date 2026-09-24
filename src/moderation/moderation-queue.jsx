import React, { useState, useEffect, useCallback } from 'react';
import { fetchReports, fetchReportedContentPreview, updateReportStatus, banAccount, unbanAccount, banAccountLogin, unbanAccountLogin, setVerified, fetchAccountStatus, fetchDeviceCorrelation, setContentRemoved } from '../lib/moderation.js';
import { REPORT_REASONS } from '../lib/reports.js';
import { formatRelativeTime } from '../shared-utils/format-duration.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

const REASON_LABELS = REPORT_REASONS.reduce((acc, r) => { acc[r.key] = r.label; return acc; }, {});

const CONTENT_TYPE_LABELS = {
    published_book: 'Published book', guild_published_book: 'Guild book',
    fireside_post: 'Fireside post', guild_book_feedback: 'Guild feedback', review: 'Review', account: 'Account',
    book_discussion_post: 'Discussion post',
};

const STATUS_TABS = [
    { key: 'open', label: 'Open' },
    { key: 'reviewed', label: 'Reviewed' },
    { key: 'actioned', label: 'Actioned' },
    { key: 'dismissed', label: 'Dismissed' },
];

// Gated entirely by shell/ink-root.jsx only ever rendering this for a confirmed moderator (see
// isModerator there) — but real enforcement is Postgres RLS (schema.sql's "moderators read/update
// all reports" policies), not this component. A non-moderator who somehow reached this screen
// would just see empty lists and failed updates, not real data or real capability.
export function ModerationQueue({ onBack }) {
    const [tab, setTab] = useState('open');
    const [reports, setReports] = useState(null); // null while loading
    const [error, setError] = useState('');
    const [previews, setPreviews] = useState({}); // reportId -> preview | 'loading' | null (unavailable)
    const [accountStatuses, setAccountStatuses] = useState({}); // authorId -> { banned, banReason, loginBanned, loginBanReason, verified }
    const [deviceCorrelations, setDeviceCorrelations] = useState({}); // authorId -> [{ id, name, banned, loginBanned }]
    const [actioningId, setActioningId] = useState(null);
    const [workingAuthorId, setWorkingAuthorId] = useState(null); // any account-level action in flight for this author
    const [removingId, setRemovingId] = useState(null); // reportId whose content removal is in flight

    const load = useCallback(() => {
        setReports(null);
        setError('');
        fetchReports(tab)
            .then(setReports)
            .catch((e) => { setError(e && e.message ? e.message : 'Could not load reports.'); setReports([]); });
    }, [tab]);
    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        if (!reports) return;
        reports.forEach((r) => {
            if (previews[r.id] !== undefined) return;
            setPreviews((prev) => ({ ...prev, [r.id]: 'loading' }));
            fetchReportedContentPreview(r).then((p) => {
                setPreviews((prev) => ({ ...prev, [r.id]: p }));
                if (p && p.authorId && !accountStatuses[p.authorId]) {
                    fetchAccountStatus(p.authorId).then((s) => setAccountStatuses((prev) => ({ ...prev, [p.authorId]: s }))).catch(() => {});
                    fetchDeviceCorrelation(p.authorId).then((c) => setDeviceCorrelations((prev) => ({ ...prev, [p.authorId]: c })));
                }
            });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reports]);

    const handleAction = (reportId, status) => {
        setActioningId(reportId);
        updateReportStatus(reportId, status)
            .then(() => { setActioningId(null); load(); })
            .catch((e) => { setActioningId(null); setError(e && e.message ? e.message : 'Could not update that report.'); });
    };

    const handleBan = (authorId, reason) => {
        setWorkingAuthorId(authorId);
        banAccount(authorId, reason)
            .then(() => { setWorkingAuthorId(null); setAccountStatuses((prev) => ({ ...prev, [authorId]: { ...prev[authorId], banned: true, banReason: reason || null } })); })
            .catch((e) => { setWorkingAuthorId(null); setError(e && e.message ? e.message : 'Could not ban that account.'); });
    };
    const handleUnban = (authorId) => {
        setWorkingAuthorId(authorId);
        unbanAccount(authorId)
            .then(() => { setWorkingAuthorId(null); setAccountStatuses((prev) => ({ ...prev, [authorId]: { ...prev[authorId], banned: false, banReason: null } })); })
            .catch((e) => { setWorkingAuthorId(null); setError(e && e.message ? e.message : 'Could not unban that account.'); });
    };
    const handleLoginBan = (authorId, reason) => {
        setWorkingAuthorId(authorId);
        banAccountLogin(authorId, reason)
            .then(() => { setWorkingAuthorId(null); setAccountStatuses((prev) => ({ ...prev, [authorId]: { ...prev[authorId], loginBanned: true, loginBanReason: reason || null } })); })
            .catch((e) => { setWorkingAuthorId(null); setError(e && e.message ? e.message : 'Could not login-ban that account.'); });
    };
    const handleLoginUnban = (authorId) => {
        setWorkingAuthorId(authorId);
        unbanAccountLogin(authorId)
            .then(() => { setWorkingAuthorId(null); setAccountStatuses((prev) => ({ ...prev, [authorId]: { ...prev[authorId], loginBanned: false, loginBanReason: null } })); })
            .catch((e) => { setWorkingAuthorId(null); setError(e && e.message ? e.message : 'Could not restore login for that account.'); });
    };
    const handleVerify = (authorId, verified) => {
        setWorkingAuthorId(authorId);
        setVerified(authorId, verified)
            .then(() => { setWorkingAuthorId(null); setAccountStatuses((prev) => ({ ...prev, [authorId]: { ...prev[authorId], verified } })); })
            .catch((e) => { setWorkingAuthorId(null); setError(e && e.message ? e.message : `Could not ${verified ? 'verify' : 'unverify'} that account.`); });
    };

    // Hides (or restores) the reported content itself, independent of anything happening to the
    // account above — see lib/moderation.js's setContentRemoved. Updates this report's own
    // preview entry in place rather than reloading, same "optimistic local patch" shape as the
    // account-status handlers above.
    const handleSetRemoved = (report, removed) => {
        setRemovingId(report.id);
        setContentRemoved(report, removed)
            .then(() => {
                setRemovingId(null);
                setPreviews((prev) => (prev[report.id] ? { ...prev, [report.id]: { ...prev[report.id], removed } } : prev));
            })
            .catch((e) => { setRemovingId(null); setError(e && e.message ? e.message : 'Could not update this content.'); });
    };

    return React.createElement("div", { style: { minHeight: '100vh', background: '#17171B', padding: '20px 18px 60px' } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 18 } },
            onBack && React.createElement("button", { onClick: onBack, style: {
                    background: 'none', border: 'none', color: '#A6A6AD', fontSize: TYPE_SCALE[14], cursor: 'pointer', padding: '4px 6px 4px 0',
                } }, "\u2190"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[20], fontWeight: 600, color: '#EFE7D2' } }, "Moderation queue")),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginBottom: 18, flexWrap: 'wrap' } },
            STATUS_TABS.map((t) => React.createElement("button", { key: t.key, onClick: () => setTab(t.key), style: {
                    background: tab === t.key ? 'linear-gradient(160deg, #241F14, #17140F)' : 'none',
                    border: '1px solid ' + (tab === t.key ? '#4A3D22' : '#2A2A30'),
                    color: tab === t.key ? '#E8C468' : '#7A7A82',
                    borderRadius: RADIUS_SCALE[999], padding: '6px 14px', fontSize: TYPE_SCALE[12], cursor: 'pointer',
                } }, t.label))),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#D97878', marginBottom: 14 } }, error),
        reports === null
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64', textAlign: 'center', padding: '40px 0' } }, "Loading\u2026")
            : reports.length === 0
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64', textAlign: 'center', padding: '40px 0' } }, "Nothing here.")
                : React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[12] } },
                    reports.map((r) => React.createElement(ReportCard, {
                        key: r.id, report: r, preview: previews[r.id],
                        accountStatus: previews[r.id] && previews[r.id].authorId ? accountStatuses[previews[r.id].authorId] : null,
                        correlated: previews[r.id] && previews[r.id].authorId ? deviceCorrelations[previews[r.id].authorId] : null,
                        working: previews[r.id] && workingAuthorId === previews[r.id].authorId,
                        actioning: actioningId === r.id, onAction: (status) => handleAction(r.id, status),
                        onBan: (reason) => withAuthorId(previews[r.id], (id) => handleBan(id, reason)),
                        onUnban: () => withAuthorId(previews[r.id], handleUnban),
                        onLoginBan: (reason) => withAuthorId(previews[r.id], (id) => handleLoginBan(id, reason)),
                        onLoginUnban: () => withAuthorId(previews[r.id], handleLoginUnban),
                        onVerify: () => withAuthorId(previews[r.id], (id) => handleVerify(id, true)),
                        onUnverify: () => withAuthorId(previews[r.id], (id) => handleVerify(id, false)),
                        removing: removingId === r.id,
                        onSetRemoved: (removed) => handleSetRemoved(r, removed),
                    }))));
}

function withAuthorId(preview, fn) {
    if (preview && preview.authorId) fn(preview.authorId);
}

function ReportCard({ report, preview, accountStatus, correlated, working, actioning, onAction, onBan, onUnban, onLoginBan, onLoginUnban, onVerify, onUnverify, removing, onSetRemoved }) {
    const [banReasonInput, setBanReasonInput] = useState(null); // null = not open; string = input value
    const [loginBanReasonInput, setLoginBanReasonInput] = useState(null); // null = not open; string = input value
    return React.createElement("div", { style: {
            background: 'linear-gradient(160deg, #211C13, #17130E)', border: '1px solid #3A3020',
            borderRadius: RADIUS_SCALE[12], padding: 16,
        } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: SPACE_SCALE[10], marginBottom: 8 } },
            React.createElement("div", null,
                React.createElement("span", { style: {
                        display: 'inline-block', fontSize: TYPE_SCALE[10.5], fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
                        color: '#E8C468', background: 'rgba(200,155,60,0.12)', border: '1px solid rgba(200,155,60,0.3)',
                        borderRadius: RADIUS_SCALE[999], padding: '2px 9px', marginRight: 8,
                    } }, REASON_LABELS[report.reason] || report.reason),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } }, CONTENT_TYPE_LABELS[report.contentType] || report.contentType)),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', whiteSpace: 'nowrap' } }, formatRelativeTime(report.createdAt))),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#A6A6AD', marginBottom: 10 } },
            "Reported by ", React.createElement("span", { style: { color: '#C9BE8D' } }, report.reporterName || 'a reader')),
        React.createElement("div", { style: {
                background: 'rgba(0,0,0,0.25)', border: '1px solid #2A2417', borderRadius: RADIUS_SCALE[8],
                padding: '10px 12px', marginBottom: 10, fontSize: TYPE_SCALE[12], color: '#D8D0BE', whiteSpace: 'pre-wrap', lineHeight: 1.5,
            } },
            preview === 'loading'
                ? "Loading content\u2026"
                : preview === null || preview === undefined
                    ? "This content is no longer available (likely deleted)."
                    : React.createElement(React.Fragment, null,
                        preview.authorName && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 4 } }, "By ", preview.authorName),
                        preview.text || '(empty)')),
        // Removes (or restores) the reported content itself, independent of anything done to the
        // account below — see lib/moderation.js's setContentRemoved and
        // 78_migration_moderator_content_removal.sql. Only shown for content types that actually
        // carry a removed_by_moderator flag (preview.removed !== undefined) — an account report
        // or a Guild-hosted book listing has no such flag yet, so no button renders for those.
        preview && preview.removed !== undefined && React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap', marginBottom: 10 } },
            preview.removed
                ? React.createElement(React.Fragment, null,
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#D97878' } }, "Hidden from other readers."),
                    React.createElement("button", { onClick: () => onSetRemoved(false), disabled: removing, style: {
                            background: 'none', border: '1px solid #3A3020', color: removing ? '#5C5C64' : '#8FCB8F',
                            borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: removing ? 'default' : 'pointer',
                        } }, removing ? "Working\u2026" : "Restore"))
                : React.createElement("button", { onClick: () => onSetRemoved(true), disabled: removing, style: {
                        background: 'none', border: '1px solid #4A2A2A', color: removing ? '#5C5C64' : '#D97878',
                        borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: removing ? 'default' : 'pointer',
                    } }, removing ? "Working\u2026" : "Remove content")),
        report.details && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#B0A688', fontStyle: 'italic', marginBottom: 10 } },
            "Reporter's note: \u201C", report.details, "\u201D"),
        report.status !== 'open' && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginBottom: 10 } },
            "Marked ", report.status, report.resolvedByName ? ` by ${report.resolvedByName}` : '', report.resolvedAt ? ` \u00B7 ${formatRelativeTime(report.resolvedAt)}` : ''),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
            [
                { status: 'reviewed', label: 'Mark reviewed' },
                { status: 'actioned', label: 'Mark actioned' },
                { status: 'dismissed', label: 'Dismiss' },
                { status: 'open', label: 'Reopen' },
            ].filter((b) => b.status !== report.status).map((b) => React.createElement("button", {
                key: b.status, onClick: () => onAction(b.status), disabled: actioning, style: {
                    background: 'none', border: '1px solid #3A3020', color: actioning ? '#5C5C64' : '#C9BE8D',
                    borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: actioning ? 'default' : 'pointer',
                },
            }, b.label))),
        // Ban/unban and Verify/Unverify the account behind the reported content — see
        // lib/moderation.js's banAccount/unbanAccount/setVerified. Only shown once we know who
        // that account actually is (preview.authorId) — content that's already been deleted
        // (preview null) has nobody left to act on. A content ban only, not a login ban — see
        // schema.sql's `banned` column comment for exactly what this does and doesn't stop.
        preview && preview.authorId && React.createElement("div", { style: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #2A2417', display: 'flex', flexDirection: 'column', gap: 8 } },
            accountStatus && accountStatus.banned
                ? React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#D97878' } },
                        `${preview.authorName || 'This account'} is banned from posting/publishing.`,
                        accountStatus.banReason ? ` (${accountStatus.banReason})` : ''),
                    React.createElement("button", { onClick: onUnban, disabled: working, style: {
                            background: 'none', border: '1px solid #3A3020', color: working ? '#5C5C64' : '#8FCB8F',
                            borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                        } }, working ? "Working\u2026" : "Unban"))
                : banReasonInput === null
                    ? React.createElement("button", { onClick: () => setBanReasonInput(''), disabled: working, style: {
                            background: 'none', border: '1px solid #4A2A2A', color: working ? '#5C5C64' : '#D97878',
                            borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer', alignSelf: 'flex-start',
                        } }, "Ban ", preview.authorName || 'this account')
                    : React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
                        React.createElement("input", { value: banReasonInput, onChange: (e) => setBanReasonInput(e.target.value), placeholder: "Reason (shown to your team, not the user)", maxLength: 500, style: {
                                flex: 1, minWidth: 180, background: 'rgba(0,0,0,0.25)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[8],
                                color: '#EFE7D2', padding: '6px 10px', fontSize: TYPE_SCALE[11.5], fontFamily: 'inherit',
                            } }),
                        React.createElement("button", { onClick: () => { onBan(banReasonInput); setBanReasonInput(null); }, disabled: working, style: {
                                background: 'none', border: '1px solid #4A2A2A', color: working ? '#5C5C64' : '#D97878',
                                borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                            } }, working ? "Working\u2026" : "Confirm ban"),
                        React.createElement("button", { onClick: () => setBanReasonInput(null), style: {
                                background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                            } }, "Cancel")),
            // True login ban — see lib/moderation.js's banAccountLogin/unbanAccountLogin and
            // schema.sql's admin_set_login_ban() for what this actually does (blocks sign-in,
            // not just posting) versus the content-only ban above. Independent of it: an account
            // can be content-banned without a login ban, or vice versa.
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px dashed #2A2417' } },
                accountStatus && accountStatus.loginBanned
                    ? React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#D97878' } },
                            `${preview.authorName || 'This account'} is banned from signing in.`,
                            accountStatus.loginBanReason ? ` (${accountStatus.loginBanReason})` : ''),
                        React.createElement("button", { onClick: onLoginUnban, disabled: working, style: {
                                background: 'none', border: '1px solid #3A3020', color: working ? '#5C5C64' : '#8FCB8F',
                                borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                            } }, working ? "Working\u2026" : "Restore login"))
                    : loginBanReasonInput === null
                        ? React.createElement("button", { onClick: () => setLoginBanReasonInput(''), disabled: working, style: {
                                background: 'none', border: '1px solid #4A2A2A', color: working ? '#5C5C64' : '#D97878',
                                borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer', alignSelf: 'flex-start',
                            } }, "Login-ban ", preview.authorName || 'this account')
                        : React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', alignItems: 'center' } },
                            React.createElement("input", { value: loginBanReasonInput, onChange: (e) => setLoginBanReasonInput(e.target.value), placeholder: "Reason (shown to your team, not the user)", maxLength: 500, style: {
                                    flex: 1, minWidth: 180, background: 'rgba(0,0,0,0.25)', border: '1px solid #3A3020', borderRadius: RADIUS_SCALE[8],
                                    color: '#EFE7D2', padding: '6px 10px', fontSize: TYPE_SCALE[11.5], fontFamily: 'inherit',
                                } }),
                            React.createElement("button", { onClick: () => { onLoginBan(loginBanReasonInput); setLoginBanReasonInput(null); }, disabled: working, style: {
                                    background: 'none', border: '1px solid #4A2A2A', color: working ? '#5C5C64' : '#D97878',
                                    borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                                } }, working ? "Working\u2026" : "Confirm login ban"),
                            React.createElement("button", { onClick: () => setLoginBanReasonInput(null), style: {
                                    background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                                } }, "Cancel"))),
            // Verified badge grant/revoke — anti-impersonation piece 2, now moderator-grantable
            // in-app instead of requiring raw SQL. Independent of the ban controls above: an
            // account can be verified and still get banned (or unverified), and vice versa.
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap', paddingTop: 8, borderTop: '1px dashed #2A2417' } },
                accountStatus && accountStatus.verified
                    ? React.createElement(React.Fragment, null,
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#6FAE8F' } }, "\u2713 ", preview.authorName || 'This account', " is verified."),
                        React.createElement("button", { onClick: onUnverify, disabled: working, style: {
                                background: 'none', border: '1px solid #3A3020', color: working ? '#5C5C64' : '#C9BE8D',
                                borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                            } }, working ? "Working\u2026" : "Unverify"))
                    : React.createElement("button", { onClick: onVerify, disabled: working, style: {
                            background: 'none', border: '1px solid #3A4A2A', color: working ? '#5C5C64' : '#6FAE8F',
                            borderRadius: RADIUS_SCALE[999], padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: working ? 'default' : 'pointer',
                        } }, working ? "Working\u2026" : "\u2713 Verify ", preview.authorName || 'this account')),
            // Ban-evasion signal — see shared-utils/device-signal.js and lib/moderation.js's
            // fetchDeviceCorrelation for exactly what this is (a soft, easily-cleared browser
            // correlation) and isn't (a fingerprint, a block). Shown only when there's something
            // to flag, and phrased as a hint for a moderator's own judgment, never a verdict —
            // people legitimately share devices (family, library computers), so this alone is
            // never grounds for action on its own.
            correlated && correlated.length > 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: correlated.some((c) => c.banned || c.loginBanned) ? '#D97878' : '#7A7A82', paddingTop: 8, borderTop: '1px dashed #2A2417' } },
                "Same browser/device previously used to sign in as: ",
                correlated.map((c, i) => `${c.name || 'an account'}${c.banned || c.loginBanned ? ' (banned)' : ''}`).join(', '),
                ". Not proof of anything on its own \u2014 people share devices \u2014 but worth a look if this pattern keeps showing up.")));
}
