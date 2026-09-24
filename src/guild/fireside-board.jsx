import React, { useState, useEffect } from 'react';
import { storage } from '../lib/storage.js';
import { supabase } from '../lib/supabaseClient.js';
import { fetchFiresidePosts, postFiresideMessage, subscribeFiresideRealtime, toggleFiresidePin, toggleFiresideReaction } from '../lib/library-guild.js';
import { FIRESIDE_CATEGORIES, FIRESIDE_KEY, FIRESIDE_REACTIONS } from './guild-hall.jsx';
import { EmptyState } from '../shared-ui/ui-cards.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { ReportButton } from '../shared-ui/report-content-modal.jsx';
import { MessagingSafetyBanner } from '../shared-ui/messaging-safety-banner.jsx';
import { uuid } from '../shared-utils/storage-keys.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Matches fireside_posts.body's DB check constraint (char_length(body) <= 8000) — see
// 22_migration_text_field_length_caps.sql. Kept as one shared constant since both the main
// composer and the reply input write to the same column.
const FIRESIDE_BODY_MAX = 8000;


// One message bubble — styled like a scrap of parchment rather than a chat bubble. Handles both
// top-level posts (which can be pinned and replied to) and replies (a single level deep, no
// further nesting) via the isReply flag.
export function FiresideMessage({ msg, profile, isReply, onReply, onTogglePin, onToggleReaction, showReplyComposer, replyDraft, onReplyDraftChange, onSubmitReply, onCancelReply, isRemote, guildId }) {
    const cat = FIRESIDE_CATEGORIES.find((c) => c.key === msg.category) || FIRESIDE_CATEGORIES[0];
    const dateLabel = new Date(msg.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return React.createElement("div", { style: {
            background: 'linear-gradient(160deg, #EFE3C4 0%, #E1CE9F 55%, #CBB07E 100%)', color: '#2A1D10',
            borderRadius: RADIUS_SCALE[10], padding: '14px 16px', marginLeft: isReply ? 30 : 0, position: 'relative',
            boxShadow: '0 6px 14px rgba(0,0,0,0.3)', marginBottom: 12, textAlign: 'left',
        } },
        msg.pinned && React.createElement("div", { style: { position: 'absolute', top: -8, right: 12 } }, React.createElement(InkIcon, { name: "pin", size: 13, color: "#C89B3C" })),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], marginBottom: 6, flexWrap: 'wrap' } },
            React.createElement("div", { style: {
                    width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                    background: profile.avatar ? `center/cover url(${profile.avatar})` : 'radial-gradient(circle at 34% 28%, #cbb07e, #8a6b25 72%)',
                    border: '1px solid #8A6B25',
                } }),
            React.createElement("span", { style: { fontWeight: 700, fontSize: TYPE_SCALE[12.5] } }, msg.authorName || profile.name || 'Unnamed Writer'),
            // Anti-impersonation badge, piece 2 — see supabase schema.sql's `profiles.verified`
            // and lib/profile.js's fetchVerifiedIds. Fireside is exactly the kind of surface
            // (real messages, real accounts, trust built over a conversation) impersonation
            // scams target, which makes this the most important place the badge shows up.
            msg.authorVerified && React.createElement("span", { title: "Verified account", style: { color: '#4D7A5F', fontSize: TYPE_SCALE[12] } }, '\u2713'),
            React.createElement("span", { style: { display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[10], color: '#6B5A3E' } }, cat.icon, cat.label),
            React.createElement("span", { style: { fontSize: TYPE_SCALE[10], color: '#8A7355', marginLeft: 'auto' } }, dateLabel)),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], lineHeight: 1.5, whiteSpace: 'pre-wrap' } }, msg.text),
        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], marginTop: 10, flexWrap: 'wrap' } },
            FIRESIDE_REACTIONS.map((r) => React.createElement("button", { key: r.key, onClick: () => onToggleReaction(msg.id, r.key), title: r.label, style: {
                    background: msg.reactions && msg.reactions[r.key] ? 'rgba(59,42,24,0.18)' : 'none',
                    border: '1px solid rgba(59,42,24,0.3)', borderRadius: RADIUS_SCALE[999], padding: '3px 8px', fontSize: TYPE_SCALE[11], cursor: 'pointer', color: '#3B2A18',
                } }, r.icon)),
            !isReply && React.createElement("button", { onClick: () => onReply(msg.id), style: {
                    background: 'none', border: '1px solid rgba(59,42,24,0.3)', borderRadius: RADIUS_SCALE[999], padding: '3px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer', color: '#3B2A18',
                } }, "\u21A9 Reply"),
            !isReply && React.createElement("button", { onClick: () => onTogglePin(msg.id), style: {
                    background: 'none', border: '1px solid rgba(59,42,24,0.3)', borderRadius: RADIUS_SCALE[999], padding: '3px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer', color: '#3B2A18',
                } }, msg.pinned ? "Unpin" : "Pin"),
            // Reporting only makes sense once a post is actually shared server-side — a local-only
            // message's id doesn't correspond to any fireside_posts row content_reports could point to.
            isRemote && React.createElement(ReportButton, {
                contentType: "fireside_post", contentId: msg.id, guildId,
                buttonStyle: { background: 'none', border: '1px solid rgba(59,42,24,0.3)', borderRadius: RADIUS_SCALE[999], padding: '3px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer', color: '#7A4A3A' },
            })),
        showReplyComposer && React.createElement("div", { style: { marginTop: 10, display: 'flex', gap: SPACE_SCALE[8] } },
            React.createElement("input", { value: replyDraft, onChange: (e) => onReplyDraftChange(e.target.value), placeholder: "Write a reply\u2026", maxLength: FIRESIDE_BODY_MAX, style: {
                    flex: 1, borderRadius: RADIUS_SCALE[8], border: '1px solid rgba(59,42,24,0.3)', padding: '7px 10px', fontSize: TYPE_SCALE[12.5], background: 'rgba(255,255,255,0.35)', color: '#2A1D10',
                } }),
            React.createElement("button", { onClick: () => onSubmitReply(msg.id), style: {
                    background: '#3B2A18', color: '#EFE3C4', border: 'none', borderRadius: RADIUS_SCALE[8], padding: '7px 12px', fontSize: TYPE_SCALE[12], cursor: 'pointer',
                } }, "Post"),
            React.createElement("button", { onClick: onCancelReply, style: {
                    background: 'none', color: '#3B2A18', border: 'none', fontSize: TYPE_SCALE[12], cursor: 'pointer',
                } }, "Cancel")));
}


// The Fireside itself: a fireplace visual, a category-tagged composer, pinned messages surfaced
// above the rest, and single-level reply threads. Two persistence modes behind one identical
// render path: local-only via FIRESIDE_KEY (unsigned-in, or no active Founder Guild — the
// original behavior, unchanged), or shared via Supabase + Realtime once signed in to a Founder
// Guild (see library-guild.js). Both modes produce the exact same `messages` shape, so
// everything below this point (topLevel/pinned/rest/repliesFor/renderThread) doesn't need to
// know or care which mode it's in.
export function FiresideBoard({ profile, guildId }) {
    const [mode, setMode] = useState('checking'); // 'checking' | 'remote' | 'local'
    const [userId, setUserId] = useState(null);
    const [messages, setMessages] = useState(null); // null while loading
    const [draft, setDraft] = useState('');
    const [draftCategory, setDraftCategory] = useState('discussion');
    const [replyingTo, setReplyingTo] = useState(null);
    const [replyDraft, setReplyDraft] = useState('');
    // Surfaces a failed remote post/reply — previously postFiresideMessage's rejection (most
    // commonly the session having expired or signed out mid-visit, since a fresh open of this
    // screen already routes around that via the mode check above) was only ever
    // console.warn'd, while the draft cleared regardless as if it had sent. That's silent data
    // loss: the writer sees their message vanish from the box with no error and no copy of what
    // they wrote. This keeps the draft in place and tells them plainly what happened instead.
    const [postError, setPostError] = useState('');

    const toLocalShape = (posts, reactionsByPost, myId) => posts.map((p) => ({
        id: p.id, parentId: p.parent_id, category: p.category, text: p.body,
        createdAt: new Date(p.created_at).getTime(), pinned: p.pinned, authorName: p.author_name, authorVerified: p.author_verified,
        reactions: FIRESIDE_REACTIONS.reduce((acc, r) => {
            acc[r.key] = (reactionsByPost[p.id] || []).some((x) => x.reaction === r.key && x.user_id === myId);
            return acc;
        }, {}),
    }));

    const refetchRemote = React.useCallback(() => {
        fetchFiresidePosts(guildId)
            .then(({ posts, reactionsByPost }) => setMessages(toLocalShape(posts, reactionsByPost, userId)))
            .catch((e) => console.warn('Inkroot: fireside fetch failed', e));
    }, [guildId, userId]);

    // Decide mode once: local-only unless there's both a Founder Guild to post into and a
    // signed-in reader to post as. Falling back to local rather than blocking is deliberate —
    // the Fireside should never be unusable just because sync isn't configured.
    useEffect(() => {
        let cancelled = false;
        if (!guildId) {
            setMode('local');
            return;
        }
        supabase.auth.getUser().then(({ data }) => {
            if (cancelled) return;
            if (data.user) {
                setUserId(data.user.id);
                setMode('remote');
            } else {
                setMode('local');
            }
        });
        return () => { cancelled = true; };
    }, [guildId]);

    useEffect(() => {
        if (mode === 'local') {
            (async () => {
                const res = await storage.get(FIRESIDE_KEY);
                if (res) {
                    setMessages(JSON.parse(res.value));
                    return;
                }
                await storage.set(FIRESIDE_KEY, JSON.stringify([]));
                setMessages([]);
            })();
        } else if (mode === 'remote') {
            refetchRemote();
            const unsubscribe = subscribeFiresideRealtime(guildId, refetchRemote);
            return unsubscribe;
        }
    }, [mode, refetchRemote]);

    const persistLocal = (next) => {
        setMessages(next);
        storage.set(FIRESIDE_KEY, JSON.stringify(next));
    };

    const handlePost = () => {
        const text = draft.trim();
        if (!text)
            return;
        setPostError('');
        if (mode === 'remote') {
            // Draft is only cleared once the post actually lands — on failure it stays put (and
            // the writer sees why) rather than disappearing as if it had sent. See postError's
            // own comment above for why this matters.
            postFiresideMessage(guildId, draftCategory, text, null)
                .then(() => { setDraft(''); return refetchRemote(); })
                .catch((e) => {
                    console.warn('Inkroot: fireside post failed', e);
                    setPostError("Your message didn't send — you're still signed in, but something went wrong. It's still here in the box, try Post again.");
                });
        } else {
            const msg = { id: uuid(), parentId: null, category: draftCategory, text, createdAt: Date.now(), pinned: false, reactions: {} };
            persistLocal([msg, ...(messages || [])]);
            setDraft('');
        }
    };
    const handleReply = (parentId) => {
        setReplyingTo(parentId);
        setReplyDraft('');
        setPostError('');
    };
    const handleSubmitReply = (parentId) => {
        const text = replyDraft.trim();
        if (!text)
            return;
        setPostError('');
        if (mode === 'remote') {
            postFiresideMessage(guildId, 'discussion', text, parentId)
                .then(() => { setReplyingTo(null); setReplyDraft(''); return refetchRemote(); })
                .catch((e) => {
                    console.warn('Inkroot: fireside reply failed', e);
                    setPostError("Your reply didn't send \u2014 something went wrong. It's still here, try again.");
                });
        } else {
            const msg = { id: uuid(), parentId, category: 'discussion', text, createdAt: Date.now(), pinned: false, reactions: {} };
            persistLocal([...(messages || []), msg]);
            setReplyingTo(null);
            setReplyDraft('');
        }
    };
    const handleTogglePin = (id) => {
        if (mode === 'remote') {
            const current = (messages || []).find((m) => m.id === id);
            toggleFiresidePin(id, !(current && current.pinned)).then(refetchRemote).catch((e) => console.warn('Inkroot: fireside pin failed \u2014 you can only pin your own posts', e));
        } else {
            persistLocal((messages || []).map((m) => m.id === id ? { ...m, pinned: !m.pinned } : m));
        }
    };
    const handleToggleReaction = (id, key) => {
        if (mode === 'remote') {
            const current = (messages || []).find((m) => m.id === id);
            const active = !!(current && current.reactions && current.reactions[key]);
            toggleFiresideReaction(id, key, active).then(refetchRemote).catch((e) => console.warn('Inkroot: fireside reaction failed', e));
        } else {
            persistLocal((messages || []).map((m) => m.id === id ? { ...m, reactions: { ...m.reactions, [key]: !(m.reactions && m.reactions[key]) } } : m));
        }
    };
    if (messages === null) {
        return React.createElement("div", { style: { textAlign: 'center', padding: '40px 12px', fontSize: TYPE_SCALE[12.5], color: '#5C5C64' } }, "The fire is catching\u2026");
    }
    const topLevel = messages.filter((m) => !m.parentId).sort((a, b) => b.createdAt - a.createdAt);
    const pinned = topLevel.filter((m) => m.pinned);
    const rest = topLevel.filter((m) => !m.pinned);
    const repliesFor = (id) => messages.filter((m) => m.parentId === id).sort((a, b) => a.createdAt - b.createdAt);
    const renderThread = (m) => React.createElement(React.Fragment, { key: m.id },
        React.createElement(FiresideMessage, {
            msg: m, profile, isReply: false, onReply: handleReply, onTogglePin: handleTogglePin, onToggleReaction: handleToggleReaction,
            showReplyComposer: replyingTo === m.id, replyDraft, onReplyDraftChange: setReplyDraft, onSubmitReply: handleSubmitReply, onCancelReply: () => setReplyingTo(null),
            isRemote: mode === 'remote', guildId,
        }),
        repliesFor(m.id).map((r) => React.createElement(FiresideMessage, { key: r.id, msg: r, profile, isReply: true, onReply: () => { }, onTogglePin: () => { }, onToggleReaction: handleToggleReaction, showReplyComposer: false, replyDraft: '', onReplyDraftChange: () => { }, onSubmitReply: () => { }, onCancelReply: () => { }, isRemote: mode === 'remote', guildId })));
    return React.createElement("div", { className: "fireside-hall" },
        React.createElement("div", { className: "fireside-fire" },
            React.createElement("div", { className: "fireside-flame f1" }),
            React.createElement("div", { className: "fireside-flame f2" }),
            React.createElement("div", { className: "fireside-flame f3" })),
        mode === 'local' && guildId && React.createElement("div", { style: { textAlign: 'center', fontSize: TYPE_SCALE[10.5], color: '#5C5C64', fontStyle: 'italic', padding: '10px 18px 0' } },
            "Local only right now \u2014 sign in to share this Fireside with the rest of the guild."),
        React.createElement("div", { style: { padding: '22px 18px 0' } },
            mode === 'remote' && React.createElement(MessagingSafetyBanner, { context: "the Fireside" }),
            React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], flexWrap: 'wrap', marginBottom: 12, justifyContent: 'center' } },
                FIRESIDE_CATEGORIES.map((c) => React.createElement("button", { key: c.key, onClick: () => setDraftCategory(c.key), style: {
                        background: draftCategory === c.key ? 'linear-gradient(160deg, #241F14, #1A160D)' : 'none',
                        border: '1px solid #3A3020', color: draftCategory === c.key ? '#E8C468' : '#A6A6AD',
                        borderRadius: RADIUS_SCALE[999], padding: '6px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer',
                        display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[5],
                    } }, c.icon, c.label))),
            React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4], marginBottom: 22 } },
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8] } },
                    React.createElement("textarea", { value: draft, onChange: (e) => setDraft(e.target.value), placeholder: "Share something by the fire\u2026", rows: 2, maxLength: FIRESIDE_BODY_MAX, style: {
                            flex: 1, borderRadius: RADIUS_SCALE[10], border: '1px solid #3A3020', background: '#1D1A14', color: '#EFE7D2', padding: '10px 12px', fontSize: TYPE_SCALE[13], resize: 'vertical', fontFamily: 'inherit',
                        } }),
                    React.createElement("button", { onClick: handlePost, style: {
                            background: 'linear-gradient(160deg, #241F14, #17140F)', border: '1px solid #4A3D22', color: '#E8C468',
                            borderRadius: RADIUS_SCALE[10], padding: '0 18px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                        } }, "Post")),
                // Matches fireside_posts.body's DB check constraint (see 22_migration_text_field_length_caps.sql)
                // — this is purely so a writer sees the limit coming rather than hitting a raw insert
                // error at 8001 characters; the maxLength above is what actually stops them.
                draft.length > FIRESIDE_BODY_MAX * 0.8 && React.createElement("div", { style: { textAlign: 'right', fontSize: TYPE_SCALE[10], color: draft.length >= FIRESIDE_BODY_MAX ? '#D98A8A' : '#7A7A82' } },
                    `${draft.length} / ${FIRESIDE_BODY_MAX}`),
                postError && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D98A8A', marginTop: 2 } }, postError)),
            pinned.length > 0 && React.createElement("div", { style: { marginBottom: 20 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#C89B3C', letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 10, display: 'flex', alignItems: 'center', gap: SPACE_SCALE[4] } }, React.createElement(InkIcon, { name: "pin", size: 11 }), "Pinned"),
                pinned.map(renderThread)),
            (rest.length === 0 && pinned.length === 0)
                ? React.createElement(EmptyState, { text: "The fire is quiet \u2014 be the first to share something." })
                : rest.map(renderThread)),
        React.createElement("div", { className: "fireside-bench" }));
}
