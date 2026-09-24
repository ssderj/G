import React from 'react';
import { IdentityPlaque } from '../guild/guild-hall.jsx';
import { reputationTitleFor } from './author-reputation.jsx';
import { ArchiveDivider } from '../shared-ui/ui-cards.jsx';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// The Writer Identity Card: the premium centerpiece at the top of the Author's Hall — meant to
// read like a carved identity plate kept in a respected medieval author's personal chamber, not a
// form. Holds every piece of who-this-writer-is (avatar, name, pen name, motto) plus the two
// lifetime measures (Rank, Reputation) as a row of engraved plaques beneath it. Used to also
// carry Level and Lifetime XP plaques — removed along with Writer Level; Rank is now driven
// directly by Reputation (reputationTitleFor) rather than a separate level-derived ladder, so
// there's one standing here, not two redundant ones.
export function WriterIdentityCard({ profile, fileInputRef, handleAvatarFile, avatarError, onSaveProfile, onRemoveAvatar, joinDateLabel, reputation, nameError, nameWarning, profileSyncNotice, verified, officialBadge, isModerator, onOpenModerationQueue, isPlatformAdmin, onOpenInkrootEventsAdmin, onOpenManualWithdrawalsAdmin, onOpenManageAdmins, onOpenGuildEventJudging }) {
    const repTitle = reputationTitleFor(reputation);
    return React.createElement("div", {
        style: {
            textAlign: 'center', padding: '34px 26px 24px', borderRadius: RADIUS_SCALE[16], marginBottom: 30,
            background: 'radial-gradient(ellipse at 50% 0%, rgba(200,155,60,0.14), transparent 65%), linear-gradient(160deg, #211C13, #17130E)',
            border: '1px solid #4A3D22', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 30px rgba(0,0,0,0.35)',
        },
    },
        React.createElement("div", { onClick: () => fileInputRef.current && fileInputRef.current.click(), style: {
                width: 108, height: 108, borderRadius: '50%', margin: '0 auto 16px', cursor: 'pointer', position: 'relative',
                background: profile.avatar ? `center/cover url(${profile.avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                border: '3px solid #C89B3C', boxShadow: '0 0 0 3px #100E0A, 0 0 28px rgba(200,155,60,0.32), 0 4px 16px rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            } },
            !profile.avatar && React.createElement(InkIcon, { name: "users", size: 34, color: "#8A8272" }),
            React.createElement("span", { style: {
                    position: 'absolute', bottom: -2, right: -2, width: 30, height: 30, borderRadius: '50%',
                    background: '#C89B3C', border: '2px solid #17140F', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[13],
                } }, "\u270E"),
            // Only offered once there's an actual photo to remove — reverting to the default
            // avatar shouldn't require picking a replacement image first.
            profile.avatar && React.createElement("span", {
                onClick: (e) => { e.stopPropagation(); onRemoveAvatar && onRemoveAvatar(); },
                title: "Remove photo",
                style: {
                    position: 'absolute', bottom: -2, left: -2, width: 26, height: 26, borderRadius: '50%',
                    background: '#17140F', border: '2px solid #5C2A2A', color: '#D98A8A',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                },
            }, "\u2715")),
        React.createElement("input", { ref: fileInputRef, type: "file", accept: "image/*", onChange: handleAvatarFile, style: { display: 'none' } }),
        avatarError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97757', marginBottom: 10 } }, avatarError),
        // Anti-impersonation badge, piece 2 — see supabase schema.sql's `profiles.verified` and
        // shared-utils/identity-safety.js for piece 1 (reserved/lookalike names). No in-app way
        // to earn this yet (see the migration's comment); it just reflects whatever a deployment
        // operator has manually set for this account.
        verified && React.createElement("div", { title: "Verified account", style: {
                display: 'inline-flex', alignItems: 'center', gap: 5, margin: '0 auto 8px', padding: '3px 10px',
                borderRadius: RADIUS_SCALE[12], background: 'rgba(111,174,143,0.14)', border: '1px solid rgba(111,174,143,0.4)',
                color: '#6FAE8F', fontSize: TYPE_SCALE[11],
            } }, "\u2713 Verified"),
        // The Inkroot Official Badge — a separate, fully automated signal from `verified` above
        // (that one's a moderator-curated identity checkmark; this one's criteria-based, see
        // lib/official-badge.js). Shown only once earned — officialBadge is null while loading or
        // signed out, and { earned: false } while criteria are still outstanding, so both those
        // cases render nothing here rather than a half-earned badge.
        officialBadge && officialBadge.earned && React.createElement("div", { title: "Inkroot Official Badge \u2014 eligible for Naira rewards", style: {
                display: 'inline-flex', alignItems: 'center', gap: 5, margin: '0 auto 8px', padding: '3px 10px',
                borderRadius: RADIUS_SCALE[12], background: 'rgba(95,191,110,0.14)', border: '1px solid rgba(95,191,110,0.4)',
                color: '#5FBF6E', fontSize: TYPE_SCALE[11],
            } }, React.createElement(InkIcon, { name: "shield", size: 11 }), "Official"),
        React.createElement("input", { value: profile.name, onChange: (e) => onSaveProfile({ name: e.target.value }), placeholder: "Your name", maxLength: 80, style: {
                display: 'block', margin: '0 auto', textAlign: 'center', background: 'none', border: 'none', outline: 'none',
                fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontWeight: 600, color: '#EFE7D2', width: '100%', maxWidth: 280,
            } }),
        React.createElement("input", { value: profile.penName, onChange: (e) => onSaveProfile({ penName: e.target.value }), placeholder: "Pen name (optional)", maxLength: 80, style: {
                display: 'block', margin: '4px auto 0', textAlign: 'center', background: 'none', border: 'none', outline: 'none',
                fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[14], color: '#A6A6AD', width: '100%', maxWidth: 280,
            } }),
        // Anti-impersonation feedback — see shell/ink-root.jsx's saveProfile and
        // shared-utils/identity-safety.js. nameError means the last keystroke was rejected
        // outright (a reserved Inkroot/staff-style name); nameWarning means the name saved fine
        // but closely resembles a real published author, so it's flagged rather than blocked.
        nameError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97757', marginTop: 8, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 } }, nameError),
        !nameError && nameWarning && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C9A24B', marginTop: 8, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 } }, "\u26A0\uFE0F " + nameWarning),
        // Reliability gap fix (fix-tracker item 27/31's bug class, applied to profile sync) —
        // shell/ink-root.jsx's saveProfile sets this when syncProfile actually fails to reach
        // `profiles` (offline, RLS denial, etc.), so the writer isn't left thinking a name/
        // avatar/motto change is visible to everyone when it's only saved on this device.
        profileSyncNotice && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97757', marginTop: 8, maxWidth: 320, marginLeft: 'auto', marginRight: 'auto', lineHeight: 1.5 } }, "\u26A0\uFE0F " + profileSyncNotice),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[6], marginTop: 10, maxWidth: 340, marginLeft: 'auto', marginRight: 'auto' } },
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201C"),
            React.createElement("input", { value: profile.motto || '', onChange: (e) => onSaveProfile({ motto: e.target.value }), placeholder: "A motto or words to write by\u2026", maxLength: 140, style: {
                    flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', textAlign: 'center',
                    fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[12.5], color: '#C9BE8D',
                } }),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#4A4A52' } }, "\u201D")),
        React.createElement(ArchiveDivider, { maxWidth: 300, margin: '22px auto 18px', fontSize: TYPE_SCALE[11], color: '#4A3D22', opacity: 1 }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'stretch' } },
            React.createElement(IdentityPlaque, { icon: repTitle.icon, label: "Rank", value: repTitle.name, valueColor: repTitle.color }),
            React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            React.createElement(IdentityPlaque, { icon: "\u2726", label: "Reputation", value: reputation.toLocaleString(), valueColor: repTitle.color })),
        joinDateLabel && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 20 } }, "Writing since ", joinDateLabel),
        // Unlike the trust-and-safety/admin entry points below, this one is never gated on a
        // role flag: any verified author can be auto-seated on a blind judge panel (see
        // assign_guild_event_judges() — eligibility is verified/not-banned/guild-unaffiliated,
        // not a special permission), so there's no boolean here to check before showing it. A
        // reader with no seats just lands on an empty "Your judging seats" list.
        onOpenGuildEventJudging && React.createElement("button", { onClick: onOpenGuildEventJudging, style: {
                display: 'block', margin: '16px auto 0', background: 'none', border: '1px solid #3A3020', color: '#C9BE8D',
                borderRadius: RADIUS_SCALE[999], padding: '6px 16px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
            } }, "\u2696\uFE0F Judging queue"),
        // Trust-and-safety entry point — only ever rendered for a confirmed moderator (see
        // shell/ink-root.jsx's isModerator). Real access is still enforced server-side by RLS
        // regardless of whether this button is visible.
        isModerator && onOpenModerationQueue && React.createElement("button", { onClick: onOpenModerationQueue, style: {
                display: 'block', margin: '16px auto 0', background: 'none', border: '1px solid #3A3020', color: '#C9BE8D',
                borderRadius: RADIUS_SCALE[999], padding: '6px 16px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
            } }, "\u2691 Moderation queue"),
        // Same "only ever rendered for a confirmed [flag]" posture as the Moderation queue button
        // above, gated on the separate is_platform_admin trust flag instead of is_moderator — see
        // 43_migration_inkroot_events_admin.sql for why the two are kept apart. Real access is
        // still enforced server-side (is_inkroot_admin()) regardless of whether this is visible.
        isPlatformAdmin && onOpenInkrootEventsAdmin && React.createElement("button", { onClick: onOpenInkrootEventsAdmin, style: {
                display: 'block', margin: '10px auto 0', background: 'none', border: '1px solid #3A3020', color: '#C9BE8D',
                borderRadius: RADIUS_SCALE[999], padding: '6px 16px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
            } }, "\u2691 Inkroot Events admin"),
        // Same gating as the Inkroot Events admin button above — see
        // 62_migration_manual_withdrawals.sql for why a manual withdrawal queue exists at all.
        isPlatformAdmin && onOpenManualWithdrawalsAdmin && React.createElement("button", { onClick: onOpenManualWithdrawalsAdmin, style: {
                display: 'block', margin: '10px auto 0', background: 'none', border: '1px solid #3A3020', color: '#C9BE8D',
                borderRadius: RADIUS_SCALE[999], padding: '6px 16px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
            } }, "\u2691 Manual Withdrawals admin"),
        // Same gating as the two buttons above — see 77_migration_admin_role_revocation.sql.
        // Revoke-only: this screen never lets a platform admin grant is_moderator or
        // is_platform_admin, only take either away and log it.
        isPlatformAdmin && onOpenManageAdmins && React.createElement("button", { onClick: onOpenManageAdmins, style: {
                display: 'block', margin: '10px auto 0', background: 'none', border: '1px solid #3A3020', color: '#C9BE8D',
                borderRadius: RADIUS_SCALE[999], padding: '6px 16px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
            } }, "\u2691 Manage Admins"));
}


// "Follow Author" — shown only on someone else's Author's Hall, never your own. The label and
// styling flip to reflect this device's current follow state; the Reputation point behind
// Genuine reader follows now comes from the real server-side follower count (see followerCount /
// fetchFollowerCount in AuthorsHallScreen), not this device's own follow history, so it updates
// for every reader who follows this author, not just this one.
export function FollowAuthorButton({ following, onToggle }) {
    return React.createElement("button", {
        onClick: onToggle,
        style: {
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SPACE_SCALE[7],
            margin: '14px auto 0', background: following ? 'rgba(200,155,60,0.10)' : '#C89B3C',
            border: following ? '1px solid #4A3D22' : '1px solid #C89B3C',
            color: following ? '#C89B3C' : '#17130E',
            borderRadius: RADIUS_SCALE[10], padding: '9px 22px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
            cursor: 'pointer', fontFamily: 'inherit', transition: 'all var(--ink-dur) var(--ink-ease)',
        },
    }, following ? "\u2713 Following" : "+ Follow Author");
}


// Read-only counterpart to WriterIdentityCard, shown on another author's Author's Hall — same
// carved-plate visual language, but nothing here is editable and there's no avatar upload, since
// none of that is this viewer's to change. `reputation` is this author's own public Reputation
// total (see computeAuthorReputation) — never this device's own writer's number, and never a raw
// follower count.
export function PublicIdentityCard({ authorName, authorId, avatar, verified, reputation, following, onToggleFollow }) {
    const repTitle = reputationTitleFor(reputation);
    return React.createElement("div", {
        style: {
            textAlign: 'center', padding: '34px 26px 24px', borderRadius: RADIUS_SCALE[16], marginBottom: 30,
            background: 'radial-gradient(ellipse at 50% 0%, rgba(200,155,60,0.14), transparent 65%), linear-gradient(160deg, #211C13, #17130E)',
            border: '1px solid #4A3D22', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 10px 30px rgba(0,0,0,0.35)',
        },
    },
        React.createElement("div", { style: {
                width: 108, height: 108, borderRadius: '50%', margin: '0 auto 16px', position: 'relative',
                background: avatar ? `center/cover url(${avatar})` : 'radial-gradient(circle at 34% 28%, #2A2620, #17140F 72%)',
                border: '3px solid #C89B3C', boxShadow: '0 0 0 3px #100E0A, 0 0 28px rgba(200,155,60,0.32), 0 4px 16px rgba(0,0,0,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
            } }, !avatar && React.createElement(InkIcon, { name: "users", size: 34, color: "#8A8272" })),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 } },
            React.createElement("div", { style: {
                    fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontWeight: 600, color: '#EFE7D2',
                } }, authorName || 'Unnamed Writer'),
            // Anti-impersonation badge, piece 2 — see supabase schema.sql's `profiles.verified`.
            // Only ever true here when this Hall was opened from a real account id (see
            // authors-hall-screen.jsx's remoteProfile) — never derived from the name alone.
            verified && React.createElement("span", { title: "Verified account", style: { color: '#6FAE8F', fontSize: TYPE_SCALE[16] } }, '\u2713')),
        onToggleFollow && React.createElement(FollowAuthorButton, { following, onToggle: onToggleFollow }),
        // Anti-impersonation piece 5.5 — reporting the ACCOUNT directly, not just something it
        // posted. Only shown when this Hall was opened from a real account id (same guard as the
        // verified badge above) — the local-only Grand Library's name-only "authors" have no
        // real account behind them to report (see authors-hall-screen.jsx's authorId comment).
        // This is what lets a suspicious name/avatar get flagged before that account has posted
        // anything else reportable.
        authorId && React.createElement("div", { style: { marginTop: 10 } },
            React.createElement(ReportButton, { contentType: "account", contentId: authorId, label: "Report this account" })),
        React.createElement(ArchiveDivider, { maxWidth: 300, margin: '22px auto 18px', fontSize: TYPE_SCALE[11], color: '#4A3D22', opacity: 1 }),
        React.createElement("div", { style: { display: 'flex', alignItems: 'stretch' } },
            React.createElement(IdentityPlaque, { icon: repTitle.icon, label: "Rank", value: repTitle.name, valueColor: repTitle.color }),
            React.createElement("div", { style: { width: 1, background: '#2E2818', margin: '2px 0' } }),
            React.createElement(IdentityPlaque, { icon: "\u2726", label: "Reputation", value: reputation.toLocaleString(), valueColor: repTitle.color })));
}
