import React, { useEffect, useState } from 'react';
import { formatNaira } from '../lib/payments.js';
import {
    cancelAnthology, closeAnthologySubmissions, createGuildAnthology, fetchAnthologyContributors,
    fetchAnthologySubmissions, fetchGuildAnthologies, fetchRevenueAgreement, fetchRevenueShares,
    proposeRevenueAgreement, publishAnthology, reopenAnthologySubmissions, reviewSubmission,
    setRevenueShareApproval, submitToAnthology, updateGuildAnthology, updateOwnSubmission, withdrawSubmission,
} from '../lib/guild-anthologies.js';
import { currentUser } from '../lib/supabaseClient.js';
import { storage } from '../lib/storage.js';
import { InkIcon } from '../shell/ink-icon.jsx';
import { projectKey } from '../shared-utils/storage-keys.jsx';
import { BookCover } from '../worldbuilding/book-cover.jsx';
import { ProgressBar } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
// Everything below is REUSED from guild-order.jsx, not reinvented: the same anthology backend
// calls (imported above), the same button/input styling, the same real shared Manuscript tab and
// World Bible tab the rest of the Guild Order already uses, the same book-cover picker, and (for
// the simulated workspace further down) the same word-count-split preview content whoever can't
// get a real anthology yet (signed out, offline, or a Founder Guild — see guild-order.jsx's own
// HONESTY NOTE) has always seen. This file only redesigns the page layout — landing list, empty
// state, start flow, and a tabbed workspace — around all of that, for BOTH the real and the
// simulated case now (see GuildAnthologyScreen's own comment below for why both live here).
import {
    GW_ANTHOLOGY_STYLES, GoAnthologyOverviewSimulated, GoAnthologyPermissionsNote,
    GoCoverPicker, GoManuscriptTab, GoWorldBibleTab, goBtnStyle, goInputStyle,
} from './guild-order.jsx';


// ---------- Guild Anthology — landing page + workspace ----------
// Public entry point, replacing the old single "Anthology" tab body in guild-order.jsx's switch.
// remoteGuildId is a real player_guilds.id for both guild types now — a Player Guild's own real
// row, or a Founder Guild's fixed backendGuildId (see FOUNDER_GUILDS in guild-hall.jsx and
// supabase/history/69_migration_founder_guild_parity.sql) — set by home-screen.jsx's
// guildOrderBackendId. Only a signed-out or offline session has no real anthology backend to
// open, in which case this falls back to GuildAnthologyWorkshopSimulated: the SAME landing-page/
// workspace shell below, carrying the guild's one deterministic, always-open preview anthology
// (built from goBuildAnthologySeed + this device's own local state — see that component's own
// header) rather than a second, differently-dressed screen. Only the data source differs; the
// layout a member sees is consistent whichever guild type they're in.
export function GuildAnthologyScreen(props) {
    if (!props.remoteGuildId) {
        return React.createElement(GuildAnthologyWorkshopSimulated, props);
    }
    return React.createElement(GuildAnthologyWorkshop, props);
}


// Reads a contributor's own manuscript straight from this device's local storage — the exact
// same kv_store lookup ink-root.jsx's setPublishStatus already does for a solo book, using the
// same storage/projectKey singletons rather than any new prop threading, since both are already
// importable from anywhere in the app. This is the only place an anthology submission's actual
// prose comes from (see 91_migration_anthology_submission_content.sql): the `projects` list
// this file already receives is only the index — id/title/wordCount/cover — never chapter text.
// Mirrors buildPublishedBookContent's own chapter trim (id/title/text only, never an author's
// project-only fields like notes or backups). Never throws — a project that can't be found or
// parsed locally (wrong device, corrupted entry) comes back as null, same fail-honest shape as
// every other lib/*.js wrapper in this app; the caller still submits/saves the rest of the form,
// just without content attached, and publish_guild_anthology() is what actually catches that
// before the anthology goes live.
async function loadProjectManuscriptContent(projectId) {
    try {
        const res = await storage.get(projectKey(projectId));
        if (!res) return null;
        const proj = JSON.parse(res.value);
        return { chapters: (proj.chapters || []).map((c) => ({ id: c.id, title: c.title, text: c.text })) };
    } catch (e) {
        console.warn('Inkroot: could not read local project for anthology submission', e);
        return null;
    }
}


const GA_STYLES = `
    .ga-card{position:relative;text-align:left;width:100%;box-sizing:border-box;display:flex;gap:14px;align-items:flex-start;background:linear-gradient(175deg,#232025,#1C1A1E);border:1px solid #2E2A28;border-radius:${RADIUS_SCALE[12]}px;padding:16px;cursor:pointer;box-shadow:0 6px 14px rgba(0,0,0,0.3);}
    .ga-card:hover{border-color:rgba(200,155,60,0.4);}
    .ga-grid{display:grid;grid-template-columns:1fr;gap:14px;}
    @media (min-width: 620px) { .ga-grid{grid-template-columns:1fr 1fr;} }
    .ga-empty{border-radius:${RADIUS_SCALE[16]}px;border:1px solid rgba(200,155,60,0.28);background:linear-gradient(160deg,#241E14,#1A160D 70%);padding:32px 22px;text-align:center;}
    .ga-tabs{display:flex;gap:${SPACE_SCALE[6]}px;justify-content:center;flex-wrap:wrap;margin-bottom:20px;}
    .ga-tab{font-size:${TYPE_SCALE[11.5]}px;font-weight:600;padding:7px 14px;border-radius:${RADIUS_SCALE[100]}px;cursor:pointer;border:1px solid #2A2A30;background:transparent;color:#8A8680;}
    .ga-tab.active{border-color:rgba(232,196,104,0.5);background:linear-gradient(160deg,#241F14,#1A160D);color:#E8C468;}
    .ga-sim-badge{font-size:${TYPE_SCALE[9.5]}px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#8A8680;border:1px solid #3A3A42;border-radius:${RADIUS_SCALE[5]}px;padding:3px 8px;white-space:nowrap;}
`;



// Exported so the compact Guild Homepage preview (guild-anthology-preview.jsx) can render the
// exact same status color and lifecycle progress a card gets in here, instead of a second,
// slightly-different copy of either.
export function statusColorFor(status) {
    return { open: '#8FCB8F', reviewing: '#C89B3C', published: '#7FB2C9', cancelled: '#5C5C64' }[status] || '#5C5C64';
}


// Where in its lifecycle an anthology sits, as a simple 3-stage progress bar (Open \u2192
// Reviewing \u2192 Published) \u2014 the one dimension of "progress" every anthology shares,
// regardless of price or submission count.
export function stageProgress(status) {
    const idx = { open: 1, reviewing: 2, published: 3, cancelled: 0 }[status] || 0;
    return { value: idx, max: 3 };
}


function AnthologyCard({ anthology: a, contributorCount, onOpen }) {
    const progress = stageProgress(a.status);
    return React.createElement("button", { className: "ga-card", onClick: onOpen },
        React.createElement(BookCover, { title: a.title, author: '', cover: a.cover, size: 'sm' }),
        React.createElement("div", { style: { flex: 1, minWidth: 0 } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] } },
                React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], color: '#EFE7D2', fontWeight: 600 } }, a.title),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, textTransform: 'uppercase', color: statusColorFor(a.status), border: `1px solid ${statusColorFor(a.status)}55`, borderRadius: RADIUS_SCALE[5], padding: '3px 8px', whiteSpace: 'nowrap' } }, a.status)),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', margin: '8px 0 6px' } },
                `${formatNaira(a.price)}${a.submission_deadline ? ` \u00B7 closes ${new Date(a.submission_deadline).toLocaleDateString()}` : ''}`),
            React.createElement(ProgressBar, { value: progress.value, max: progress.max, color: a.status === 'cancelled' ? '#5C5C64' : '#C89B3C' }),
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
                React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82' } }, `${contributorCount != null ? contributorCount : '\u2026'} contributor${contributorCount === 1 ? '' : 's'}`),
                React.createElement("span", { style: { fontSize: TYPE_SCALE[11], fontWeight: 600, color: '#C89B3C' } }, "Open \u2192"))));
}


// seedProjects/initialSeedProjectId: the optional "bring one of your existing projects in"
// path, sitting alongside the plain blank-anthology path this form has always had. Picking a
// project here only pre-fills title/cover (still editable) and remembers seedProjectId; the
// actual "bring it in" step is the parent's handleCreate calling the existing submitToAnthology
// once the anthology itself exists (see GuildAnthologyWorkshop below) \u2014 nothing new on the
// backend, just the two existing calls (createGuildAnthology, submitToAnthology) composed here
// instead of requiring a separate trip through "Publish an existing project" afterward.
function AnthologyCreateForm({ onCreate, onCancel, seedProjects, initialSeedProjectId }) {
    const seedable = (seedProjects || []).filter((p) => (p.wordCount || 0) > 0);
    const [form, setForm] = useState(() => {
        const seed = initialSeedProjectId && seedable.find((p) => p.id === initialSeedProjectId);
        return {
            title: (seed && seed.title) || '', description: '', price: '', deadline: '',
            cover: (seed && seed.cover) || null, seedProjectId: (seed && seed.id) || null,
        };
    });
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);
    const pickSeed = (project) => {
        setForm((f) => ({
            ...f, seedProjectId: project ? project.id : null,
            title: project && !f.title ? project.title : f.title,
            cover: project && !f.cover ? project.cover : f.cover,
        }));
    };
    const submit = async () => {
        if (!form.title.trim()) return;
        setBusy(true); setError(null);
        try {
            await onCreate({
                title: form.title.trim(), description: form.description.trim() || null,
                price: form.price ? Number(form.price) : 0,
                submissionDeadline: form.deadline ? new Date(form.deadline).toISOString() : null,
                cover: form.cover, seedProjectId: form.seedProjectId,
            });
        } catch (e) {
            setError(e.message || 'Could not create that anthology.');
        } finally {
            setBusy(false);
        }
    };
    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 18, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[15], color: '#EFE7D2', marginBottom: 4 } }, "Start an Anthology"),
        seedable.length > 0 && React.createElement("div", null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 5 } }, "Bring in one of your projects (optional)"),
            React.createElement("select", {
                value: form.seedProjectId || '',
                onChange: (e) => pickSeed(seedable.find((p) => p.id === e.target.value) || null),
                style: goInputStyle,
            },
                React.createElement("option", { value: "" }, "\u2014 Start blank \u2014"),
                seedable.map((p) => React.createElement("option", { key: p.id, value: p.id }, `${p.title} (${(p.wordCount || 0).toLocaleString()} words)`))),
            form.seedProjectId && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', marginTop: 4, fontStyle: 'italic' } },
                "This project will be submitted as the anthology's first entry once it's created.")),
        React.createElement(GoCoverPicker, { title: form.title, cover: form.cover, onChange: (cover) => setForm({ ...form, cover }) }),
        React.createElement("input", { value: form.title, onChange: (e) => setForm({ ...form, title: e.target.value }), placeholder: 'Anthology title', style: goInputStyle }),
        React.createElement("textarea", { value: form.description, onChange: (e) => setForm({ ...form, description: e.target.value }), placeholder: "A short description\u2026", rows: 3, style: goInputStyle }),
        React.createElement("input", { value: form.price, onChange: (e) => setForm({ ...form, price: e.target.value }), placeholder: "Price in \u20a6", type: "number", min: "0", style: goInputStyle }),
        React.createElement("input", { value: form.deadline, onChange: (e) => setForm({ ...form, deadline: e.target.value }), type: "date", style: goInputStyle }),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63' } }, error),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("button", { disabled: busy, onClick: submit, style: { ...goBtnStyle(true), opacity: busy ? 0.5 : 1 } }, busy ? '\u2026' : 'Create anthology'),
            React.createElement("button", { disabled: busy, onClick: onCancel, style: goBtnStyle(false) }, "Cancel")));
}


// The "publish one of your existing projects" path \u2014 same submitToAnthology call the
// workspace's own "Submit your work" picker uses, just reachable straight from the landing page
// as the second way to create Guild work, alongside starting a brand-new anthology.
function QuickSubmitPanel({ openAnthologies, projects, onSubmitted, onCancel }) {
    const [anthologyId, setAnthologyId] = useState(openAnthologies.length === 1 ? openAnthologies[0].id : null);
    const [existingSubs, setExistingSubs] = useState([]);
    const [loadingSubs, setLoadingSubs] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        if (!anthologyId) { setExistingSubs([]); return; }
        setLoadingSubs(true);
        fetchAnthologySubmissions(anthologyId).then(setExistingSubs).catch(() => setExistingSubs([])).finally(() => setLoadingSubs(false));
    }, [anthologyId]);

    const chosen = openAnthologies.find((a) => a.id === anthologyId) || null;
    const eligible = (projects || []).filter((p) => (p.wordCount || 0) > 0
        && !existingSubs.some((s) => s.project_id === p.id && s.review_status !== 'withdrawn'));

    const submit = async (p) => {
        setBusy(true); setError(null);
        try {
            const content = await loadProjectManuscriptContent(p.id);
            await submitToAnthology(anthologyId, { projectId: p.id, title: p.title, wordCount: p.wordCount || 0, content });
            onSubmitted(anthologyId);
        } catch (e) {
            setError(e.message || 'Could not submit that project.');
        } finally {
            setBusy(false);
        }
    };

    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 18, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[15], color: '#EFE7D2' } }, "Publish an existing project"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8680', lineHeight: 1.5 } }, "Send one of your own projects in as a submission to an anthology that's currently open."),
        !chosen && React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
            openAnthologies.map((a) => React.createElement("button", { key: a.id, onClick: () => setAnthologyId(a.id), style: { ...goBtnStyle(false), textAlign: 'left' } }, a.title))),
        chosen && React.createElement(React.Fragment, null,
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82' } }, `Submitting to: ${chosen.title}`),
            loadingSubs && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64' } }, "Checking your eligible projects\u2026"),
            !loadingSubs && eligible.length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } }, "No eligible manuscripts to submit yet."),
            !loadingSubs && eligible.map((p) => React.createElement("button", {
                key: p.id, disabled: busy, style: { ...goBtnStyle(false), textAlign: 'left', opacity: busy ? 0.5 : 1 }, onClick: () => submit(p),
            }, `${p.title} (${(p.wordCount || 0).toLocaleString()} words)`))),
        error && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63' } }, error),
        React.createElement("button", { onClick: onCancel, style: goBtnStyle(false) }, "Cancel"));
}


function AnthologyEmptyState({ isOwner, onStart }) {
    return React.createElement("div", { className: "ga-empty" },
        React.createElement("div", { style: { marginBottom: 10, display: "flex", justifyContent: "center" } }, React.createElement(InkIcon, { name: "scroll", size: 24, color: "#8A8272" })),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[18], color: '#EFE7D2', marginBottom: 10 } }, "No Guild Anthologies Yet"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8680', lineHeight: 1.6, maxWidth: 420, margin: '0 auto 18px' } },
            "A Guild Anthology is a themed collection the whole guild builds together: members submit their own manuscripts, the guild reviews entries and agrees on a revenue split, and the finished book is published to the guild's own Bookshelf under the guild's name. While it's open, every anthology also opens onto the guild's shared Manuscript and World Bible, so the guild can write and build lore together, too."),
        isOwner
            ? React.createElement("button", { onClick: onStart, style: goBtnStyle(true) }, "+ Start an Anthology")
            : React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', fontStyle: 'italic' } }, "Only the guild owner can start a new anthology."));
}


// ---------- The anthology workspace \u2014 opened once a member picks (or just created) one ----------
// Overview holds everything the old single-page Anthology tab already did (submissions, the
// existing-project picker, lifecycle actions, revenue agreement) \u2014 moved here unchanged in
// substance. Manuscript and World Bible are the exact same GoManuscriptTab / GoWorldBibleTab the
// rest of the Guild Order already uses: this workspace doesn't get its own copy of either, since
// Inkroot's real shared manuscript and its World Bible are guild-wide, not reinvented per
// anthology \u2014 opening them from here just puts the guild's one shared writing desk and lore
// shelf a click away from whichever anthology brought you in.
function AnthologyWorkspace({ selected, remoteGuildId, isOwner, projects, playerName, onViewPublishedBook, onBack, onChanged, guild, guildType, guildId, playerRung, state, patchState }) {
    const [wtab, setWtab] = useState('overview');
    const WORKSPACE_TABS = [
        { key: 'overview', label: 'Overview' },
        { key: 'manuscript', label: 'Manuscript' },
        { key: 'worldbible', label: 'World Bible' },
    ];
    return React.createElement("div", null,
        React.createElement("style", null, GW_ANTHOLOGY_STYLES + GA_STYLES),
        React.createElement("button", { onClick: onBack, style: { ...goBtnStyle(false), marginBottom: 16 } }, "\u2190 All anthologies"),
        React.createElement("div", { className: "gw-desk-plate" },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'center', marginBottom: 14 } },
                React.createElement(BookCover, { title: selected.title, author: '', cover: selected.cover, size: 'sm' })),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[16], color: '#EFE7D2', marginBottom: 4 } }, selected.title),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: statusColorFor(selected.status), border: `1px solid ${statusColorFor(selected.status)}55`, borderRadius: RADIUS_SCALE[100], padding: '3px 10px' } }, selected.status)),
        React.createElement("div", { className: "ga-tabs" },
            WORKSPACE_TABS.map((t) => React.createElement("button", { key: t.key, className: `ga-tab${wtab === t.key ? ' active' : ''}`, onClick: () => setWtab(t.key) }, t.label))),
        wtab === 'overview' && React.createElement(AnthologyOverviewTab, { selected, remoteGuildId, isOwner, projects, playerName, onViewPublishedBook, onChanged }),
        wtab === 'manuscript' && React.createElement(GoManuscriptTab, { guild, guildType, guildId, playerRung }),
        wtab === 'worldbible' && React.createElement(GoWorldBibleTab, { guild, guildType, guildId, playerRung, playerName }));
}


// The submissions/review/revenue-share content that used to be the entire "selected" branch of
// the old Anthology tab \u2014 same calls, same guards, moved here as the workspace's Overview tab.
function AnthologyOverviewTab({ selected, remoteGuildId, isOwner, projects, playerName, onViewPublishedBook, onChanged }) {
    const [submissions, setSubmissions] = useState([]);
    const [detailError, setDetailError] = useState(null);
    const [showPicker, setShowPicker] = useState(false);
    const [actionError, setActionError] = useState(null);
    const [actionBusy, setActionBusy] = useState(false);
    const [myUserId, setMyUserId] = useState(null);
    const [agreement, setAgreement] = useState(null);
    const [shares, setShares] = useState([]);
    const [showCustomBuilder, setShowCustomBuilder] = useState(false);
    const [customDraft, setCustomDraft] = useState({});
    const [editForm, setEditForm] = useState(null);
    const [editBusy, setEditBusy] = useState(false);
    const [editSubmission, setEditSubmission] = useState(null);
    const [editSubmissionBusy, setEditSubmissionBusy] = useState(false);
    const [editSubmissionError, setEditSubmissionError] = useState(null);

    useEffect(() => { currentUser().then((u) => setMyUserId(u && u.id)).catch(() => {}); }, []);

    const loadSubmissions = () => fetchAnthologySubmissions(selected.id).then(setSubmissions).catch((e) => setDetailError(e.message || 'Could not load submissions.'));
    const loadRevenue = () => fetchRevenueAgreement(selected.id).then((ag) => {
        setAgreement(ag);
        if (ag) fetchRevenueShares(ag.id).then(setShares).catch((e) => setDetailError(e.message || 'Could not load the revenue agreement.'));
        else setShares([]);
    }).catch((e) => setDetailError(e.message || 'Could not load the revenue agreement.'));
    useEffect(() => { setDetailError(null); loadSubmissions(); loadRevenue(); }, [selected.id]);

    const refreshBoth = () => { loadSubmissions(); loadRevenue(); if (onChanged) onChanged(); };

    const openEdit = () => setEditForm({
        title: selected.title || '', description: selected.description || '', price: selected.price != null ? String(selected.price) : '',
        deadline: selected.submission_deadline ? selected.submission_deadline.slice(0, 10) : '', cover: selected.cover || null,
    });
    const handleSaveEdit = () => {
        if (!editForm.title.trim()) return;
        setEditBusy(true); setActionError(null);
        updateGuildAnthology(selected.id, {
            title: editForm.title.trim(), description: editForm.description.trim() || null,
            price: editForm.price ? Number(editForm.price) : 0,
            submission_deadline: editForm.deadline ? new Date(editForm.deadline).toISOString() : null,
            cover: editForm.cover,
        }).then(() => { setEditForm(null); if (onChanged) onChanged(); })
            .catch((e) => setActionError(e.message || 'Could not save those changes.'))
            .finally(() => setEditBusy(false));
    };

    const runAction = async (fn) => {
        setActionBusy(true); setActionError(null);
        try { await fn(); refreshBoth(); }
        catch (e) { setActionError(e.message || 'That action failed.'); }
        finally { setActionBusy(false); }
    };

    const openSubmissionEdit = (s) => { setEditSubmissionError(null); setEditSubmission({ id: s.id, projectId: s.project_id, title: s.title || '', blurb: s.blurb || '', wordCount: String(s.word_count || 0) }); };
    // Re-reads the contributor's own project from local storage on every save (not just the
    // title/blurb/wordCount form fields) so a writer who's kept revising their manuscript while
    // it sits pending has their submission's attached content stay current — see
    // loadProjectManuscriptContent's own header and 91_migration_anthology_submission_content.sql.
    const handleSaveSubmissionEdit = async () => {
        if (!editSubmission || !editSubmission.title.trim()) return;
        setEditSubmissionBusy(true); setEditSubmissionError(null);
        try {
            // Only overwrites the attached content when this device actually has the project
            // locally — a failed read (e.g. saving this edit from a different device than the
            // one the manuscript lives on) leaves whatever was already attached alone, rather
            // than wiping a previously-good submission's content back to null.
            const content = await loadProjectManuscriptContent(editSubmission.projectId);
            const patch = {
                title: editSubmission.title.trim(), blurb: editSubmission.blurb.trim() || null,
                wordCount: Number(editSubmission.wordCount) || 0,
            };
            if (content) patch.content = content;
            await updateOwnSubmission(editSubmission.id, patch);
            setEditSubmission(null);
            loadSubmissions();
        } catch (e) {
            setEditSubmissionError(e.message || 'Could not save those changes.');
        } finally {
            setEditSubmissionBusy(false);
        }
    };

    const eligible = (projects || []).filter((p) => (p.wordCount || 0) > 0
        && !submissions.some((s) => s.project_id === p.id && s.review_status !== 'withdrawn'));
    const approved = submissions.filter((s) => s.review_status === 'approved');
    const totalWords = approved.reduce((s, x) => s + (x.word_count || 0), 0) || 1;
    const submissionByContributor = {};
    approved.forEach((s) => { submissionByContributor[s.contributor_id] = s; });
    const allApproved = shares.length > 0 && shares.every((s) => !!s.approved_at);
    const agreementReady = !!agreement && allApproved;
    const openCustomBuilder = () => {
        const draft = {};
        approved.forEach((s) => { draft[s.contributor_id] = ''; });
        setCustomDraft(draft);
        setShowCustomBuilder(true);
    };
    const customTotalPct = Object.values(customDraft).reduce((s, v) => s + (parseFloat(v) || 0), 0);
    const submitCustom = () => runAction(async () => {
        const customShares = Object.entries(customDraft).map(([contributor_id, pct]) => ({ contributor_id, share_bps: Math.round((parseFloat(pct) || 0) * 100) }));
        await proposeRevenueAgreement(selected.id, 'custom', customShares);
        setShowCustomBuilder(false);
    });

    return React.createElement("div", null,
        React.createElement("div", { style: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: SPACE_SCALE[20], marginBottom: 8, fontSize: TYPE_SCALE[11.5], color: '#7A7A82', flexWrap: 'wrap' } },
            React.createElement("span", null, `Price: ${formatNaira(selected.price)}`),
            selected.submission_deadline && React.createElement("span", null, `Closes: ${new Date(selected.submission_deadline).toLocaleDateString()}`),
            selected.published_book_id && (onViewPublishedBook
                ? React.createElement("button", { onClick: () => onViewPublishedBook(selected.published_book_id), style: { background: 'none', border: 'none', color: '#7FB2C9', fontSize: TYPE_SCALE[11.5], textDecoration: 'underline', cursor: 'pointer', padding: 0 } }, "View on the Guild Bookshelf")
                : React.createElement("span", { style: { color: '#7FB2C9' } }, "Live on the Guild Bookshelf"))),
        selected.description && React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#8A8680', margin: '10px 0 4px', lineHeight: 1.55, textAlign: 'center' } }, selected.description),
        isOwner && selected.status !== 'published' && !editForm && React.createElement("div", { style: { textAlign: 'center', margin: '14px 0' } },
            React.createElement("button", { onClick: openEdit, style: { ...goBtnStyle(false), fontSize: TYPE_SCALE[11] } }, "Edit listing")),

        editForm && React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10] } },
            React.createElement(GoCoverPicker, { title: editForm.title, cover: editForm.cover, onChange: (cover) => setEditForm({ ...editForm, cover }) }),
            React.createElement("input", { value: editForm.title, onChange: (e) => setEditForm({ ...editForm, title: e.target.value }), placeholder: 'Anthology title', style: goInputStyle }),
            React.createElement("textarea", { value: editForm.description, onChange: (e) => setEditForm({ ...editForm, description: e.target.value }), placeholder: "A short description\u2026", rows: 3, style: goInputStyle }),
            React.createElement("input", { value: editForm.price, onChange: (e) => setEditForm({ ...editForm, price: e.target.value }), placeholder: "Price in \u20a6", type: "number", min: "0", style: goInputStyle }),
            React.createElement("input", { value: editForm.deadline, onChange: (e) => setEditForm({ ...editForm, deadline: e.target.value }), type: "date", style: goInputStyle }),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                React.createElement("button", { disabled: editBusy, onClick: handleSaveEdit, style: { ...goBtnStyle(true), opacity: editBusy ? 0.5 : 1 } }, editBusy ? '\u2026' : 'Save changes'),
                React.createElement("button", { disabled: editBusy, onClick: () => setEditForm(null), style: goBtnStyle(false) }, "Cancel"))),

        actionError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63', textAlign: 'center', marginBottom: 14 } }, actionError),

        React.createElement(GoAnthologyPermissionsNote, { isOwner }),

        isOwner && selected.status !== 'published' && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center', flexWrap: 'wrap', marginBottom: 24 } },
            selected.status === 'open' && React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => closeAnthologySubmissions(selected.id)), style: goBtnStyle(true) }, "Close submissions"),
            selected.status === 'reviewing' && React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => reopenAnthologySubmissions(selected.id)), style: goBtnStyle(false) }, "Reopen submissions"),
            selected.status === 'reviewing' && React.createElement("button", { disabled: actionBusy || !agreementReady, onClick: () => runAction(() => publishAnthology(selected.id)), style: { ...goBtnStyle(true), opacity: agreementReady ? 1 : 0.4 } }, "Publish to the Guild Bookshelf"),
            React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => cancelAnthology(selected.id)), style: { ...goBtnStyle(false), color: '#B8735C' } }, "Cancel")),

        isOwner && selected.status === 'reviewing' && !agreementReady && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', textAlign: 'center', marginBottom: 20 } }, agreement ? 'Waiting on every contributor\u2019s approval before this can be published.' : 'Propose a revenue agreement below before publishing.'),

        selected.status === 'open' && React.createElement("div", { style: { textAlign: 'center', marginBottom: 20 } },
            React.createElement("button", { onClick: () => setShowPicker((s) => !s), style: goBtnStyle(true) }, showPicker ? 'Cancel' : 'Submit your work')),
        showPicker && React.createElement("div", { style: { marginBottom: 20, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
            eligible.length === 0 ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center' } }, 'No eligible manuscripts to submit yet.')
                : eligible.map((p) => React.createElement("button", {
                    key: p.id, style: { ...goBtnStyle(false), textAlign: 'left' },
                    onClick: () => runAction(async () => {
                        const content = await loadProjectManuscriptContent(p.id);
                        await submitToAnthology(selected.id, { projectId: p.id, title: p.title, wordCount: p.wordCount || 0, content });
                        setShowPicker(false);
                    }),
                }, `${p.title} (${(p.wordCount || 0).toLocaleString()} words)`))),

        detailError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63', textAlign: 'center', marginBottom: 10 } }, detailError),

        React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, `Submissions (${submissions.length})`),
        submissions.length === 0
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, 'No submissions yet.')
            : submissions.map((s) => React.createElement("div", { key: s.id, className: "gw-slip" },
                editSubmission && editSubmission.id === s.id
                    ? React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8] } },
                        React.createElement("input", { value: editSubmission.title, onChange: (e) => setEditSubmission({ ...editSubmission, title: e.target.value }), placeholder: 'Entry title', style: goInputStyle }),
                        React.createElement("textarea", { value: editSubmission.blurb, onChange: (e) => setEditSubmission({ ...editSubmission, blurb: e.target.value }), placeholder: "A few sentences\u2026", rows: 2, style: goInputStyle }),
                        React.createElement("input", { value: editSubmission.wordCount, onChange: (e) => setEditSubmission({ ...editSubmission, wordCount: e.target.value }), type: 'number', min: '0', placeholder: 'Word count', style: goInputStyle }),
                        editSubmissionError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#C97B63' } }, editSubmissionError),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                            React.createElement("button", { disabled: editSubmissionBusy, onClick: handleSaveSubmissionEdit, style: { ...goBtnStyle(true), fontSize: TYPE_SCALE[10.5], padding: '5px 10px', opacity: editSubmissionBusy ? 0.5 : 1 } }, editSubmissionBusy ? '\u2026' : 'Save changes'),
                            React.createElement("button", { disabled: editSubmissionBusy, onClick: () => setEditSubmission(null), style: { ...goBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '5px 10px' } }, "Cancel")))
                    : React.createElement(React.Fragment, null,
                        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] } },
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#EFE7D2' } }, s.title),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], fontWeight: 700, textTransform: 'uppercase', color: { pending: '#C89B3C', approved: '#8FCB8F', rejected: '#B8735C', withdrawn: '#5C5C64' }[s.review_status] || '#5C5C64' } }, s.review_status)),
                        s.blurb && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#8A8680', marginTop: 4 } }, s.blurb),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 8, flexWrap: 'wrap' } },
                            isOwner && s.review_status === 'pending' && React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => reviewSubmission(s.id, true)), style: { ...goBtnStyle(true), fontSize: TYPE_SCALE[10.5], padding: '5px 10px' } }, "Approve"),
                            isOwner && s.review_status === 'pending' && React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => reviewSubmission(s.id, false)), style: { ...goBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '5px 10px', color: '#B8735C' } }, "Reject"),
                            s.contributor_id === myUserId && s.review_status === 'pending' && React.createElement("button", { disabled: actionBusy, onClick: () => openSubmissionEdit(s), style: { ...goBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '5px 10px' } }, "Edit"),
                            s.contributor_id === myUserId && s.review_status !== 'withdrawn' && React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => withdrawSubmission(s.id)), style: { ...goBtnStyle(false), fontSize: TYPE_SCALE[10.5], padding: '5px 10px' } }, "Withdraw"))))),

        approved.length > 0 && React.createElement("div", { style: { marginTop: 24, marginBottom: 24 } },
            React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64' } }, "Revenue Agreement"),
                agreement && React.createElement("span", { style: { fontSize: TYPE_SCALE[9.5], fontWeight: 700, textTransform: 'uppercase', color: agreement.locked ? '#7FB2C9' : '#C89B3C' } }, agreement.locked ? 'Locked' : 'Awaiting approval')),
            agreement && shares.length > 0 && (() => {
                const totalBps = shares.reduce((sum, s) => sum + (s.share_bps || 0), 0);
                const approvedCount = shares.filter((s) => !!s.approved_at).length;
                const splitLabel = { equal: 'Equal split', contribution: 'By word count', custom: 'Custom split' }[agreement.split_type] || agreement.split_type;
                return React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginBottom: 14 } },
                    React.createElement("span", null, splitLabel),
                    React.createElement("span", { style: { color: totalBps === 10000 ? '#8FCB8F' : '#B8735C', fontWeight: 600 } }, `Total: ${(totalBps / 100).toFixed(1)}%`),
                    React.createElement("span", null, `${approvedCount} of ${shares.length} approved`));
            })(),
            isOwner && !(agreement && agreement.locked) && React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], flexWrap: 'wrap', marginBottom: 14 } },
                React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => proposeRevenueAgreement(selected.id, 'equal')), style: { ...goBtnStyle(agreement && agreement.split_type === 'equal'), fontSize: TYPE_SCALE[11] } }, "Equal split"),
                React.createElement("button", { disabled: actionBusy, onClick: () => runAction(() => proposeRevenueAgreement(selected.id, 'contribution')), style: { ...goBtnStyle(agreement && agreement.split_type === 'contribution'), fontSize: TYPE_SCALE[11] } }, "By word count"),
                React.createElement("button", { disabled: actionBusy, onClick: () => (showCustomBuilder ? setShowCustomBuilder(false) : openCustomBuilder()), style: { ...goBtnStyle(showCustomBuilder || (agreement && agreement.split_type === 'custom')), fontSize: TYPE_SCALE[11] } }, showCustomBuilder ? 'Cancel' : 'Custom split')),
            agreement && !agreement.locked && React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', marginBottom: 14 } }, "Proposing a new split resets everyone's approval \u2014 nobody's share can change quietly."),
            showCustomBuilder && React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[12], padding: 16, marginBottom: 16 } },
                approved.map((s) => React.createElement("div", { key: s.contributor_id, style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10], marginBottom: 8 } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#B9B2A0' } }, s.title),
                    React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } },
                        React.createElement("input", {
                            value: customDraft[s.contributor_id] || '', type: 'number', min: '0', max: '100', step: '0.1',
                            onChange: (e) => setCustomDraft({ ...customDraft, [s.contributor_id]: e.target.value }),
                            style: { ...goInputStyle, width: 70, padding: '6px 8px', textAlign: 'right' },
                        }),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82' } }, "%")))),
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 10, borderTop: '1px solid #2A2A30' } },
                    React.createElement("span", { style: { fontSize: TYPE_SCALE[11], color: Math.round(customTotalPct * 100) === 10000 ? '#8FCB8F' : '#B8735C' } }, `Total: ${customTotalPct.toFixed(1)}% (must be 100%)`),
                    React.createElement("button", { disabled: actionBusy || Math.round(customTotalPct * 100) !== 10000, onClick: submitCustom, style: { ...goBtnStyle(true), opacity: Math.round(customTotalPct * 100) === 10000 ? 1 : 0.4 } }, "Propose this split"))),
            !agreement && !showCustomBuilder && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', textAlign: 'center', padding: '10px 0' } }, isOwner ? 'No revenue agreement yet \u2014 propose one above.' : 'The guild owner hasn\u2019t proposed a revenue agreement yet.'),
            agreement && shares.map((s) => {
                const sub = submissionByContributor[s.contributor_id];
                const isMe = s.contributor_id === myUserId;
                return React.createElement("div", { key: s.id, style: { padding: '10px 0', borderBottom: '1px solid #2A2A30' } },
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[12.5], color: '#EFE7D2' } }, `${(sub && sub.title) || 'A contributor'}${isMe ? ' (you)' : ''}`),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[12], color: '#C89B3C', fontWeight: 600 } }, `${(s.share_bps / 100).toFixed(1)}% \u00B7 ${formatNaira((selected.price || 0) * s.share_bps / 10000)}`)),
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 } },
                        React.createElement(ProgressBar, { value: s.share_bps, max: 10000, color: '#C89B3C' }),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[10], fontWeight: 700, textTransform: 'uppercase', color: s.approved_at ? '#8FCB8F' : '#C89B3C', marginLeft: 10, whiteSpace: 'nowrap' } }, s.approved_at ? '\u2713 Approved' : 'Pending')),
                    isMe && !agreement.locked && React.createElement("button", {
                        disabled: actionBusy, onClick: () => runAction(() => setRevenueShareApproval(s.id, !s.approved_at)),
                        style: { ...goBtnStyle(!s.approved_at), fontSize: TYPE_SCALE[10.5], padding: '5px 10px', marginTop: 8 },
                    }, s.approved_at ? 'Withdraw approval' : 'Approve my share'));
            })),

        approved.length > 0 && React.createElement("div", { style: { marginTop: 24 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], textTransform: 'uppercase', letterSpacing: '0.08em', color: '#5C5C64', marginBottom: 10 } }, `Contributors (${approved.length})`),
            approved.map((s) => React.createElement("div", { key: s.id, style: { marginBottom: 10 } },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', fontSize: TYPE_SCALE[12], color: '#8A8680', marginBottom: 3 } },
                    React.createElement("span", null, s.title), React.createElement("span", null, `${Math.round((s.word_count / totalWords) * 1000) / 10}%`)),
                React.createElement(ProgressBar, { value: s.word_count, max: totalWords, color: '#C89B3C' })))));
}


// ---------- Landing page ----------
// initialAction/initialSeedProjectId/initialSelectedId: optional starting points for a caller
// that already knows what the writer wants to do \u2014 the Guild Homepage's compact Anthology
// preview (see guild-anthology-preview.jsx) uses these to land straight on the create form (with
// a project already chosen, if one was) or straight on a specific anthology's workspace, instead
// of always opening to the plain list. All three default to nothing, so every other caller
// behaves exactly as before.
function GuildAnthologyWorkshop({
    guild, guildType, guildId, playerRung, playerName, projects, state, patchState, remoteGuildId, isOwner, onViewPublishedBook,
    initialAction, initialSeedProjectId, initialSelectedId,
}) {
    const [anthologies, setAnthologies] = useState(null);
    const [contributorCounts, setContributorCounts] = useState({});
    const [listError, setListError] = useState(null);
    const [selectedId, setSelectedId] = useState(initialSelectedId || null);
    const [showCreate, setShowCreate] = useState(initialAction === 'create' || !!initialSeedProjectId);
    const [showQuickSubmit, setShowQuickSubmit] = useState(false);

    const loadAnthologies = () => {
        fetchGuildAnthologies(remoteGuildId).then(async (rows) => {
            setAnthologies(rows);
            const counts = {};
            await Promise.all(rows.map(async (a) => {
                try { counts[a.id] = (await fetchAnthologyContributors(a.id)).length; } catch (e) { counts[a.id] = 0; }
            }));
            setContributorCounts(counts);
        }).catch((e) => setListError(e.message || 'Could not open the anthologies.'));
    };
    useEffect(() => { loadAnthologies(); }, [remoteGuildId]);

    const selected = (anthologies || []).find((a) => a.id === selectedId) || null;

    const handleCreate = async (fields) => {
        const { seedProjectId, ...anthologyFields } = fields;
        const created = await createGuildAnthology(remoteGuildId, anthologyFields);
        // Bringing an existing project in is just the same submitToAnthology call the "Publish
        // an existing project" quick-submit path already makes, composed right after creation
        // instead of asking the writer to find their new anthology and submit to it separately.
        // Non-fatal if it fails: the anthology itself is already created either way, and the
        // writer can still submit normally from inside the workspace.
        if (seedProjectId) {
            const proj = (projects || []).find((p) => p.id === seedProjectId);
            if (proj) {
                try {
                    const content = await loadProjectManuscriptContent(proj.id);
                    await submitToAnthology(created.id, { projectId: proj.id, title: proj.title, wordCount: proj.wordCount || 0, content });
                } catch (e) { console.warn('Inkroot: could not submit the seed project to the new anthology', e); }
            }
        }
        setShowCreate(false);
        loadAnthologies();
        setSelectedId(created.id); // open the new workspace straight away
    };

    if (listError) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '30px 10px' } }, listError);
    }
    if (!anthologies) {
        return React.createElement("div", { style: { textAlign: 'center', color: '#5C5C64', fontSize: TYPE_SCALE[12.5], padding: '30px 10px' } }, "Opening the anthologies\u2026");
    }

    if (selected) {
        return React.createElement(AnthologyWorkspace, {
            selected, remoteGuildId, isOwner, projects, playerName, onViewPublishedBook,
            onBack: () => setSelectedId(null), onChanged: loadAnthologies,
            guild, guildType, guildId, playerRung, state, patchState,
        });
    }

    const openAnthologies = anthologies.filter((a) => a.status === 'open');

    return React.createElement("div", null,
        React.createElement("style", null, GW_ANTHOLOGY_STYLES + GA_STYLES),
        React.createElement("div", { className: "gw-desk-banner" },
            React.createElement("span", { className: "gw-quill" }, React.createElement(InkIcon, { name: "scroll", size: 22 })),
            React.createElement("div", { className: "gw-eyebrow" }, "The Workshop"),
            React.createElement("div", { className: "gw-title" }, "Guild Anthologies"),
            React.createElement("div", { className: "gw-sub" }, "Where the guild writes together \u2014 open a call, gather submissions, and split what it earns.")),

        anthologies.length === 0
            ? React.createElement(AnthologyEmptyState, { isOwner, onStart: () => setShowCreate(true) })
            : React.createElement(React.Fragment, null,
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], justifyContent: 'center', flexWrap: 'wrap', marginBottom: 20 } },
                    isOwner && React.createElement("button", { onClick: () => { setShowCreate((s) => !s); setShowQuickSubmit(false); }, style: goBtnStyle(true) }, showCreate ? 'Cancel' : '+ Start an Anthology'),
                    openAnthologies.length > 0 && React.createElement("button", { onClick: () => { setShowQuickSubmit((s) => !s); setShowCreate(false); }, style: goBtnStyle(false) }, showQuickSubmit ? 'Cancel' : 'Publish an existing project')),
                React.createElement("div", { className: "ga-grid" },
                    anthologies.map((a) => React.createElement(AnthologyCard, { key: a.id, anthology: a, contributorCount: contributorCounts[a.id], onOpen: () => setSelectedId(a.id) })))),

        showCreate && React.createElement(AnthologyCreateForm, { onCreate: handleCreate, onCancel: () => setShowCreate(false), seedProjects: projects, initialSeedProjectId }),
        showQuickSubmit && React.createElement(QuickSubmitPanel, {
            openAnthologies, projects,
            onSubmitted: (id) => { setShowQuickSubmit(false); loadAnthologies(); setSelectedId(id); },
            onCancel: () => setShowQuickSubmit(false),
        }));
}


// ---------- Simulated landing page + workspace (signed-out / offline only) ----------
// Same shell as GuildAnthologyWorkshop above — same banner, same single-card grid, same
// Overview/Manuscript/World Bible tabs — carrying the one deterministic, always-open preview
// anthology this guild has always had (see goBuildAnthologySeed/GoAnthologyOverviewSimulated in
// guild-order.jsx), instead of a real list fetched from guild_anthologies. There's no Start an
// Anthology or Publish an existing project here: those create/attach to a REAL anthology row,
// and there's no real anthology backend to create one in for a signed-out writer or offline
// session (a Founder Guild has a real one now too, same as a Player Guild — see this file's own
// HONESTY NOTE in guild-order.jsx) — inventing a second, fake multi-anthology system on top of
// the existing single-seasonal-anthology simulation would be a new fake feature, not a redesign
// of an existing one. What's real inside the workspace stays real even here, for whichever guild
// type this session happens to be in once it does get a real connection: Manuscript
// (GoManuscriptTab) and World Bible (GoWorldBibleTab) are both backed by their real tables for
// BOTH guild types (see guild-order.jsx's own HONESTY NOTE) — only the Overview tab's
// submissions/split are the illustrative part, exactly as they always were.
function GuildAnthologyWorkshopSimulated({ guild, guildType, guildId, playerRung, seedSubs, state, patchState, projects, playerName }) {
    const [open, setOpen] = useState(false);
    const [wtab, setWtab] = useState('overview');
    const submissionCount = (seedSubs || []).length + ((state && state.anthologySubmissions) || []).length;
    const WORKSPACE_TABS = [
        { key: 'overview', label: 'Overview' },
        { key: 'manuscript', label: 'Manuscript' },
        { key: 'worldbible', label: 'World Bible' },
    ];

    if (open) {
        return React.createElement("div", null,
            React.createElement("style", null, GW_ANTHOLOGY_STYLES + GA_STYLES),
            React.createElement("button", { onClick: () => setOpen(false), style: { ...goBtnStyle(false), marginBottom: 16 } }, "\u2190 All anthologies"),
            React.createElement("div", { className: "gw-desk-plate" },
                React.createElement("div", { style: { display: 'flex', justifyContent: 'center', marginBottom: 14 } },
                    React.createElement(BookCover, { title: `The ${guild.name} Anthology`, author: '', cover: null, size: 'sm' })),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontStyle: 'italic', fontSize: TYPE_SCALE[16], color: '#EFE7D2', marginBottom: 4 } }, `The ${guild.name} Anthology`),
                React.createElement("span", { className: "ga-sim-badge" }, "Simulated Preview")),
            React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', textAlign: 'center', margin: '0 0 18px', lineHeight: 1.5 } },
                "This guild's own anthology, workshop, and lore \u2014 not yet a real, guild-wide anthology. Create or join a Player Guild to run one with real members, submissions, and revenue splits."),
            React.createElement("div", { className: "ga-tabs" },
                WORKSPACE_TABS.map((t) => React.createElement("button", { key: t.key, className: `ga-tab${wtab === t.key ? ' active' : ''}`, onClick: () => setWtab(t.key) }, t.label))),
            wtab === 'overview' && React.createElement(GoAnthologyOverviewSimulated, { guild, seedSubs, state, patchState, projects, playerName }),
            wtab === 'manuscript' && React.createElement(GoManuscriptTab, { guild, guildType, guildId, playerRung }),
            wtab === 'worldbible' && React.createElement(GoWorldBibleTab, { guild, guildType, guildId, playerRung, playerName }));
    }

    return React.createElement("div", null,
        React.createElement("style", null, GW_ANTHOLOGY_STYLES + GA_STYLES),
        React.createElement("div", { className: "gw-desk-banner" },
            React.createElement("span", { className: "gw-quill" }, React.createElement(InkIcon, { name: "scroll", size: 22 })),
            React.createElement("div", { className: "gw-eyebrow" }, "The Workshop"),
            React.createElement("div", { className: "gw-title" }, "Guild Anthologies"),
            React.createElement("div", { className: "gw-sub" }, "A simulated preview \u2014 join or found a real Player Guild to run a real anthology with real members.")),
        React.createElement("div", { className: "ga-grid" },
            React.createElement("button", { className: "ga-card", onClick: () => setOpen(true) },
                React.createElement(BookCover, { title: `The ${guild.name} Anthology`, author: '', cover: null, size: 'sm' }),
                React.createElement("div", { style: { flex: 1, minWidth: 0 } },
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: SPACE_SCALE[10] } },
                        React.createElement("span", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14.5], color: '#EFE7D2', fontWeight: 600 } }, `The ${guild.name} Anthology`),
                        React.createElement("span", { className: "ga-sim-badge" }, "Simulated")),
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#7A7A82', margin: '8px 0 6px' } }, "Always open \u00B7 illustrative revenue split"),
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 } },
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82' } }, `${submissionCount} contributor${submissionCount === 1 ? '' : 's'}`),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[11], fontWeight: 600, color: '#C89B3C' } }, "Open \u2192"))))));
}

