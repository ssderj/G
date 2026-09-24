import React from 'react';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- "Coming soon" — the honest placeholder for anything that needs a shared backend ----------
// Inkroot runs entirely on-device today, so any feature that depends on other readers/writers
// (public ratings, reviews, cross-library reading stats, editorial curation, sales, earnings)
// can't really exist yet. Rather than fake it, every such spot uses this same small, clearly
// marked notice — honest about what's missing, and easy to swap out for a real panel once a
// backend service exists, without touching any of the surrounding UI.
export function ComingSoonNotice({ icon, text }) {
    return React.createElement("div", { style: {
            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8], fontSize: TYPE_SCALE[11.5], color: '#8A8272',
            background: 'rgba(122,122,130,0.06)', border: '1px dashed #3A3020', borderRadius: RADIUS_SCALE[8],
            padding: '8px 12px', fontStyle: 'italic',
        } },
        React.createElement("span", { style: { fontSize: TYPE_SCALE[12], flexShrink: 0 } }, icon || "\u23F3"),
        React.createElement("span", null, text));
}
