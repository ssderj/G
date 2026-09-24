import React, { useState, useEffect } from 'react';
import { useSync } from './sync-context.jsx';
import { cancelAccountDeletion, fetchAccountDeletionStatus, fetchOwnedPlayerGuild, requestAccountDeletion } from '../lib/account-deletion.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from './nav-context.jsx';
import { sanitizeError } from '../lib/errors.js';

// The one place account sync is actually relevant: the Home dashboard, where a returning writer
// would look for it. Sign-in is optional the same way it always was — this only ever offers to
// carry writing to another device, never gates anything.
export function AccountSyncControl() {
    const sync = useSync();
    const [panelOpen, setPanelOpen] = useState(false);
    const [authError, setAuthError] = useState('');
    const [authNotice, setAuthNotice] = useState('');
    const [deletionStatus, setDeletionStatus] = useState(null);
    const [confirmingDelete, setConfirmingDelete] = useState(false);
    const [deletionBusy, setDeletionBusy] = useState(false);
    const [deletionError, setDeletionError] = useState('');
    // The Player Guild this account owns, if any — fetched only once the person actually starts
    // confirming deletion (not just from opening the panel), so a guild-owning account sees the
    // guild-specific warning before they can complete the request. null = none owned; undefined =
    // not checked yet for this confirmation attempt. See lib/account-deletion.js's
    // fetchOwnedPlayerGuild.
    const [ownedGuild, setOwnedGuild] = useState(undefined);

    if (!sync)
        return null;
    const { session, signOut, signInWithGoogle, signInWithPasskey, registerPasskey, oauthError, justSignedIn, clearJustSignedIn } = sync;

    // A rejected Google sign-in (see sync-context.jsx's oauthError effect) lands after a full
    // page redirect back to this exact screen, with the panel collapsed by default — without
    // this, a banned user would land back here to a plain "Sync this device" button with no
    // visible explanation at all until they happened to open the panel themselves.
    useEffect(() => {
        if (oauthError) setPanelOpen(true);
    }, [oauthError]);

    // The actual fix for "I didn't know whether I was signed in" — Google's redirect-back (and,
    // to a lesser extent, a passkey prompt resolving) has zero visual continuity with clicking
    // "Continue with Google" moments earlier: the whole page navigated away and came back, the
    // panel that was open is closed again by default, and there was never any loading state to
    // watch during the redirect itself. Auto-opening here and showing the confirmation below (see
    // the session ? branch's "Signed in as ..." line, and justSignedIn's use there) closes that
    // gap — see sync-context.jsx's justSignedIn for what actually triggers it (a genuine new
    // sign-in completing THIS page load, not merely already being signed in when the app opened).
    useEffect(() => {
        if (justSignedIn) setPanelOpen(true);
    }, [justSignedIn]);

    // Nothing about the account changes during the 30-day grace period itself — no immediate
    // sign-in block, no hidden content — only a scheduled countdown the person can still cancel.
    // Refetch whenever the panel opens (rather than caching indefinitely) so a deletion requested
    // or cancelled on another device shows up here too.
    useEffect(() => {
        if (panelOpen && session) {
            fetchAccountDeletionStatus().then(setDeletionStatus).catch((e) => console.warn('Inkroot: deletion status fetch failed', e));
        }
    }, [panelOpen, session]);

    // Same "fetch when the relevant UI actually opens" shape as the effect above, scoped to
    // confirmingDelete instead of panelOpen so this query only ever runs for someone actually
    // about to delete their account, not every time the sync panel opens.
    useEffect(() => {
        if (confirmingDelete) {
            fetchOwnedPlayerGuild().then(setOwnedGuild).catch((e) => { console.warn('Inkroot: owned-guild check failed', e); setOwnedGuild(null); });
        } else {
            setOwnedGuild(undefined);
        }
    }, [confirmingDelete]);

    const handleRequestDeletion = async () => {
        setDeletionBusy(true);
        setDeletionError('');
        try {
            const { scheduledPurgeAt } = await requestAccountDeletion(!!ownedGuild);
            setDeletionStatus({ status: 'pending', scheduled_purge_at: scheduledPurgeAt });
            setConfirmingDelete(false);
        } catch (e) {
            setDeletionError(e && e.message ? e.message : 'Something went wrong — please try again.');
        } finally {
            setDeletionBusy(false);
        }
    };

    const handleCancelDeletion = async () => {
        setDeletionBusy(true);
        setDeletionError('');
        try {
            await cancelAccountDeletion();
            setDeletionStatus(null);
        } catch (e) {
            setDeletionError(e && e.message ? e.message : 'Something went wrong — please try again.');
        } finally {
            setDeletionBusy(false);
        }
    };

    // Redirects away immediately on success, so there's nothing to close/reset here — only the
    // pre-redirect failure case (e.g. Google not enabled in the Supabase dashboard yet) surfaces
    // back to this panel.
    const handleGoogleSignIn = async () => {
        setAuthError(''); setAuthNotice('');
        // signInWithGoogle() (lib/auth.js) now checks its own preconditions (secure context,
        // localStorage availability) and always resolves with { error } rather than throwing, so
        // this no longer needs its own try/catch on top.
        const { error } = await signInWithGoogle();
        if (error) setAuthError(error.message);
    };

    const handlePasskeySignIn = async () => {
        setAuthError(''); setAuthNotice('');
        const { error } = await signInWithPasskey();
        if (error) {
            // Best-effort ban-aware messaging — see sync-context.jsx's oauthError effect for the
            // equivalent Google-OAuth-flow case (that one can't be caught here directly) and its
            // comment on why this substring check is a best effort rather than a guaranteed
            // match: Supabase doesn't return a distinct, documented error code for "banned" on a
            // fresh sign-in attempt (only on refreshing an already-existing session) — verify the
            // exact wording against your own project if this matters to you. error.message here
            // is a raw AuthError from supabase-js (see lib/auth.js's signInWithPasskey — this is
            // the one place its result is deliberately left unsanitized so this classification
            // can still see the real text) — it's only ever used to classify which of these two
            // hand-written strings to show, never displayed itself.
            setAuthError(/banned/i.test(error.message || '')
                ? "This account has been restricted from signing in. If you believe this is a mistake, please reach out to appeal."
                : "Something went wrong signing in with your passkey. Please try again.");
        }
        else setPanelOpen(false);
    };

    // Only reachable while signed in (see the session ? branch below) — registering a passkey
    // requires an existing session (see src/lib/auth.js), so this is offered as a follow-up
    // after signing in with Google, not as its own sign-in option.
    const handleAddPasskey = async () => {
        setAuthError(''); setAuthNotice('');
        const { error } = await registerPasskey();
        // error here is a raw AuthError from supabase-js (see lib/auth.js's registerPasskey,
        // deliberately left unwrapped so account-sync-control's sibling ban-detection above can
        // still classify the equivalent sign-in error) — there's no comparable classification
        // needed for adding a passkey, so this is the one place that actually needs to sanitize
        // it before display.
        if (error) setAuthError(sanitizeError(error).message);
        else setAuthNotice('Passkey added — you can use it to sign in next time.');
    };

    return React.createElement("div", { style: { position: 'relative' } },
        React.createElement("button", {
            onClick: () => setPanelOpen((v) => { const next = !v; if (!next) clearJustSignedIn(); return next; }),
            style: {
                display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6],
                background: 'none', border: '1px solid #2A2A30', color: session ? '#E8C468' : '#8A8272',
                borderRadius: RADIUS_SCALE[999], padding: '6px 12px', fontSize: TYPE_SCALE[11.5],
                cursor: 'pointer', fontFamily: 'inherit',
            },
        }, session ? `\u2601\uFE0F Synced \u00b7 ${session.user.email}` : "\u2601\uFE0F Sync this device"),
        panelOpen && React.createElement("div", {
            style: {
                position: 'absolute', top: 'calc(100% + 8px)', right: 0, zIndex: 30, width: 270,
                padding: 16, borderRadius: RADIUS_SCALE[12], border: '1px solid #3A3020',
                background: 'linear-gradient(160deg, #201A10, #17130E)', color: '#EFE7D2',
                fontSize: TYPE_SCALE[13], boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            },
        },
            session
                ? React.createElement(React.Fragment, null,
                    justSignedIn && React.createElement("p", { style: { marginTop: 0, color: '#9FBF8A', fontWeight: 600 } }, "\u2705 Signed in successfully."),
                    React.createElement("p", { style: { marginTop: 0, color: '#B9AE8F' } }, `Signed in as ${session.user.email}`),
                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap' } },
                        React.createElement("button", {
                            onClick: handleAddPasskey, style: {
                                background: 'none', border: '1px solid #3A3020', color: '#EFE7D2',
                                borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                            },
                        }, "Add a passkey"),
                        React.createElement("button", {
                            onClick: signOut, style: {
                                background: 'none', border: '1px solid #3A3020', color: '#EFE7D2',
                                borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                            },
                        }, "Sign out")),
                    authNotice && React.createElement("p", { style: { color: '#9FBF8A', fontSize: TYPE_SCALE[12] } }, authNotice),
                    authError && React.createElement("p", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, authError),
                    React.createElement("div", { style: { marginTop: 14, paddingTop: 12, borderTop: '1px solid #2A2417' } },
                        deletionStatus && deletionStatus.status === 'pending'
                            ? React.createElement(React.Fragment, null,
                                React.createElement("p", { style: { color: '#D9A15A', fontSize: TYPE_SCALE[11.5], marginTop: 0 } },
                                    `Account deletion scheduled for ${new Date(deletionStatus.scheduled_purge_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })}. Nothing changes until then — you can still cancel.`),
                                React.createElement("button", { onClick: handleCancelDeletion, disabled: deletionBusy, style: {
                                        background: 'none', border: '1px solid #3A3020', color: '#EFE7D2',
                                        borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], cursor: deletionBusy ? 'default' : 'pointer',
                                    } }, deletionBusy ? "Cancelling\u2026" : "Cancel deletion"))
                            : confirmingDelete
                                ? React.createElement(React.Fragment, null,
                                    React.createElement("p", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[11.5], marginTop: 0 } },
                                        "Your account will be scheduled for permanent deletion in 30 days. You can cancel any time before then. Your published books, reviews, and guild posts stay visible to others but are no longer linked to your name."),
                                    // Shown only for an account that owns a Player Guild (see
                                    // lib/account-deletion.js's fetchOwnedPlayerGuild) — there's
                                    // no ownership-transfer feature to offer instead, so this is
                                    // the explicit "I understand" this deletion needs before it's
                                    // allowed to proceed (see 79_migration_account_deletion_
                                    // guild_check.sql's server-side enforcement of the same rule).
                                    ownedGuild && React.createElement("p", { style: { color: '#D9A15A', fontSize: TYPE_SCALE[11.5] } },
                                        `You own the Player Guild "${ownedGuild.name}". Deleting your account permanently bans it from signing in, so nobody will ever be able to manage that guild's treasury, events, or membership again — its members keep the guild, but it's permanently without an owner. There's no way to transfer ownership first.`),
                                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                                        React.createElement("button", { onClick: handleRequestDeletion, disabled: deletionBusy || ownedGuild === undefined, style: {
                                                background: 'none', border: '1px solid #5A2A2A', color: '#D98A8A',
                                                borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], cursor: deletionBusy ? 'default' : 'pointer',
                                            } }, deletionBusy ? "Scheduling\u2026" : "Yes, delete my account"),
                                        React.createElement("button", { onClick: () => setConfirmingDelete(false), disabled: deletionBusy, style: {
                                                background: 'none', border: '1px solid #3A3020', color: '#EFE7D2',
                                                borderRadius: RADIUS_SCALE[8], padding: '6px 12px', fontSize: TYPE_SCALE[12.5], cursor: deletionBusy ? 'default' : 'pointer',
                                            } }, "Never mind")))
                                : React.createElement("button", { onClick: () => setConfirmingDelete(true), style: {
                                        background: 'none', border: 'none', color: '#7A4A3A', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', padding: 0, textDecoration: 'underline',
                                    } }, "Delete my account"),
                        deletionError && React.createElement("p", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, deletionError)))
                : React.createElement(React.Fragment, null,
                    React.createElement("p", { style: { color: '#8A8272', marginTop: 0, fontStyle: 'italic' } },
                        "Optional — the app works fully offline without this. Sign in only to carry this device's writing to your other devices."),
                    React.createElement("button", {
                        onClick: handlePasskeySignIn,
                        style: {
                            width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', gap: SPACE_SCALE[8], padding: '6px 10px', borderRadius: RADIUS_SCALE[6],
                            border: '1px solid #3A3020', background: 'none', color: '#EFE7D2', cursor: 'pointer',
                            fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit', marginBottom: 8,
                        },
                    }, "Sign in with passkey"),
                    React.createElement("div", {
                        style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], margin: '10px 0', color: '#5C5C64' },
                    },
                        React.createElement("div", { style: { flex: 1, height: 1, background: '#3A3020' } }),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11] } }, "or"),
                        React.createElement("div", { style: { flex: 1, height: 1, background: '#3A3020' } })),
                    React.createElement("button", {
                        onClick: handleGoogleSignIn,
                        style: {
                            width: '100%', boxSizing: 'border-box', display: 'flex', alignItems: 'center',
                            justifyContent: 'center', gap: SPACE_SCALE[8], padding: '6px 10px', borderRadius: RADIUS_SCALE[6],
                            border: '1px solid #3A3020', background: '#fff', color: '#1f1f1f', cursor: 'pointer',
                            fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit',
                        },
                    }, "Continue with Google"),
                    authError && React.createElement("p", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, authError),
                    // Google's rejection (see sync-context.jsx's oauthError effect) lands after a
                    // full page redirect, so this can outlive the panel being freshly opened —
                    // shown independently of authError, which only ever comes from a same-session
                    // passkey attempt.
                    oauthError && React.createElement("p", { style: { color: '#D98A8A', fontSize: TYPE_SCALE[12] } }, oauthError))));
}
