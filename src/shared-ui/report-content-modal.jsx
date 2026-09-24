import React, { useState } from 'react';
import { REPORT_REASONS, submitReport } from '../lib/reports.js';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

// Self-contained "Report" trigger + modal, meant to be dropped in anywhere content from another
// user is shown to a reader — a published book (PublishedBookReader), a Fireside post
// (FiresideMessage), etc. Manages its own open/submitted state so callers only need to pass what
// content is being reported.
//
// Visual style matches GuildBookFeedbackModal (guild-book-feedback-modal.jsx) — same dark
// parchment-gold panel, same overlay/close pattern — so this reads as part of the same UI rather
// than a bolted-on afterthought.
export function ReportButton({ contentType, contentId, guildId = null, label = 'Report', buttonStyle }) {
    const [open, setOpen] = useState(false);
    return React.createElement(React.Fragment, null,
        React.createElement("button", { onClick: () => setOpen(true), style: buttonStyle || {
                background: 'none', border: '1px solid #3A2A2A', color: '#B08585',
                borderRadius: RADIUS_SCALE[999], padding: '3px 10px', fontSize: TYPE_SCALE[11], cursor: 'pointer',
            } }, label ? "\u2691 " + label : "\u2691"),
        open && React.createElement(ReportModal, { contentType, contentId, guildId, onClose: () => setOpen(false) }));
}

function ReportModal({ contentType, contentId, guildId, onClose }) {
    const [reason, setReason] = useState(null);
    const [details, setDetails] = useState('');
    const [status, setStatus] = useState('idle'); // 'idle' | 'sending' | 'sent' | 'error'
    const [errorMsg, setErrorMsg] = useState('');
    const handleSubmit = () => {
        if (!reason || status === 'sending')
            return;
        setStatus('sending');
        submitReport({ contentType, contentId, guildId, reason, details })
            .then(() => setStatus('sent'))
            .catch((e) => {
                setStatus('error');
                setErrorMsg(e && e.message ? e.message : 'Something went wrong — please try again.');
            });
    };
    return React.createElement("div", { onClick: onClose, style: {
            position: 'fixed', inset: 0, zIndex: 70, background: 'rgba(10,9,7,0.72)', backdropFilter: 'blur(3px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        } },
        React.createElement("div", { onClick: (e) => e.stopPropagation(), style: {
                width: '100%', maxWidth: 400, maxHeight: '86vh', overflowY: 'auto',
                background: 'linear-gradient(160deg, #241F16, #17130E)', border: '1px solid #4A3D22', borderRadius: RADIUS_SCALE[16],
                padding: 22, boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            } },
            React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 } },
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, "Report content"),
                React.createElement("button", { onClick: onClose, style: {
                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[18], cursor: 'pointer', padding: 0, lineHeight: 1,
                    } }, "\u2715")),
            status === 'sent'
                ? React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#8FCB8F', padding: '8px 0' } }, "Thanks \u2014 your report has been sent for review.")
                : React.createElement(React.Fragment, null,
                    React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginBottom: 12 } }, "Let us know what's wrong. Reports are reviewed by Inkroot, not shown to other users."),
                    React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6], marginBottom: 12 } },
                        REPORT_REASONS.map((r) => React.createElement("label", { key: r.key, style: {
                                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[12.5], color: '#EFE7D2', cursor: 'pointer',
                            } },
                            React.createElement("input", { type: "radio", name: "report-reason", checked: reason === r.key, onChange: () => setReason(r.key) }),
                            r.label))),
                    React.createElement("textarea", { value: details, onChange: (e) => setDetails(e.target.value), placeholder: "Additional details (optional)", rows: 3, maxLength: 1000, style: {
                            width: '100%', boxSizing: 'border-box', borderRadius: RADIUS_SCALE[8], border: '1px solid #3A3020',
                            background: 'rgba(0,0,0,0.25)', color: '#EFE7D2', padding: '8px 10px', fontSize: TYPE_SCALE[12.5], fontFamily: 'inherit', resize: 'vertical', marginBottom: 12,
                        } }),
                    status === 'error' && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#D97878', marginBottom: 10 } }, errorMsg),
                    React.createElement("button", { onClick: handleSubmit, disabled: !reason || status === 'sending', style: {
                            width: '100%', background: (!reason || status === 'sending') ? '#2A2A30' : 'linear-gradient(160deg, #241F14, #17140F)',
                            border: '1px solid #4A3D22', color: (!reason || status === 'sending') ? '#7A7A82' : '#E8C468',
                            borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600,
                            cursor: (!reason || status === 'sending') ? 'default' : 'pointer',
                        } }, status === 'sending' ? "Sending\u2026" : "Submit report"))));
}
