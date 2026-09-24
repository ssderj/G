import React, { useState } from 'react';
import { IconCopy } from './icons.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


export function QuickStatsCard({ rows, compact }) {
    const [copied, setCopied] = useState(false);
    const visibleRows = (rows || []).filter((r) => r && r.value);
    if (visibleRows.length === 0)
        return null;
    const handleCopy = () => {
        const text = visibleRows.map((r) => `${r.label}\n${r.value}`).join('\n\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
            }).catch(() => { });
        }
    };
    return (React.createElement("div", { style: {
            position: 'relative', background: compact ? '#232328' : '#1D1D22', border: '1px solid #2A2A30', borderRadius: compact ? 10 : 14,
            padding: compact ? '12px 14px' : '22px 26px', display: 'flex', flexDirection: compact ? 'row' : 'column',
            flexWrap: compact ? 'wrap' : 'nowrap', gap: compact ? '10px 22px' : 18, marginTop: compact ? 8 : 0,
        } },
        React.createElement("button", { onClick: handleCopy, title: copied ? 'Copied!' : 'Copy stats', style: {
                position: 'absolute', top: compact ? 8 : 16, right: compact ? 8 : 16, background: 'none', border: 'none',
                color: copied ? '#C89B3C' : '#7A7A82', cursor: 'pointer', display: 'flex', padding: 4,
            } },
            React.createElement(IconCopy, { width: compact ? 14 : 18, height: compact ? 14 : 18 })),
        visibleRows.map((r, i) => (React.createElement("div", { key: i, style: compact ? { paddingRight: 20 } : undefined },
            React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: compact ? 11 : 13, color: '#7A7A82', marginBottom: 4 } }, r.label),
            React.createElement("div", { style: { fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: compact ? 13 : 15, color: r.accent === 'gold' ? '#C89B3C' : '#D9D2BE' } }, r.value))))));
}


export function SectionLabel({ children }) {
    return (React.createElement("div", { style: {
            fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[12], letterSpacing: '0.14em',
            textTransform: 'uppercase', color: '#C89B3C', marginBottom: 10, fontWeight: 600,
        } }, children));
}


// A small ornamental rule — a fleuron flanked by hairlines that fade toward the edges — used to
// close off a section heading the way a chapter-heading flourish would in a printed book. Also
// reused as a plain mid-content divider elsewhere (Guild Hall, Guild Banner, Writer Identity
// Card, LibraryHero) wherever a section break called for the same motif rather than a flat rule
// — those spots only ever varied the width/margin/glyph size, never the pattern itself, so those
// values are now the only things callers pass in.
export function ArchiveDivider({ maxWidth = 90, margin = '8px 0 4px', gap, fontSize, glyph = "\u2766", color = '#C89B3C', opacity = 0.8 }) {
    return React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: gap != null ? gap : SPACE_SCALE[10], margin } },
        React.createElement("span", { style: { flex: 1, maxWidth, height: 1, background: 'linear-gradient(to right, transparent, #4A3D22)' } }),
        React.createElement("span", { style: { color, fontSize: fontSize != null ? fontSize : TYPE_SCALE[12], opacity, transform: 'translateY(-1px)' } }, glyph),
        React.createElement("span", { style: { flex: 1, maxWidth, height: 1, background: 'linear-gradient(to left, transparent, #4A3D22)' } }));
}


// The decorative heading for one shelf of the archive (a NAV_GROUPS entry): a small emblem over
// a tracked, small-caps title, closed off underneath by an ArchiveDivider.
export function ArchiveSectionHeading({ icon, label }) {
    return React.createElement("div", { style: { textAlign: 'center', marginBottom: 4 } },
        React.createElement("div", { style: { fontSize: TYPE_SCALE[19], marginBottom: 6, opacity: 0.9, filter: 'drop-shadow(0 0 6px rgba(200,155,60,0.25))' } }, icon),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[15], letterSpacing: '0.22em', textTransform: 'uppercase', color: '#EFE7D2', fontWeight: 600 } }, label),
        React.createElement(ArchiveDivider, null));
}


export function StatCard({ label, value, accent }) {
    return (React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '18px 16px' } },
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[26], fontWeight: 600, color: accent ? '#C89B3C' : '#EFE7D2' } }, value),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 4 } }, label)));
}


export function ProgressBar({ value, max, color }) {
    const pct = max > 0 ? Math.max(0, Math.min(100, Math.round((value / max) * 100))) : 0;
    return React.createElement("div", { style: { background: '#232328', borderRadius: RADIUS_SCALE[6], height: 8, overflow: 'hidden', width: '100%' } }, React.createElement("div", { style: { width: `${pct}%`, height: '100%', background: color || '#C89B3C', borderRadius: RADIUS_SCALE[6], transition: 'width 0.3s ease' } }));
}


// A goal stat with an inline-editable target, so the writer sets their own daily/weekly goal.
export function GoalCard({ label, current, goal, onSetGoal, color }) {
    const [editing, setEditing] = useState(false);
    const [draft, setDraft] = useState(String(goal));
    const pct = goal > 0 ? Math.max(0, Math.min(100, Math.round((current / goal) * 100))) : 0;
    const commit = () => {
        const n = parseInt(draft, 10);
        if (!isNaN(n) && n > 0)
            onSetGoal(n);
        setEditing(false);
    };
    return React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: '18px 18px' } },
        React.createElement("div", { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#A6A6AD', fontWeight: 600 } }, label),
            editing
                ? React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6] } },
                    React.createElement("input", { type: "number", value: draft, onChange: (e) => setDraft(e.target.value), autoFocus: true, onKeyDown: (e) => { if (e.key === 'Enter')
                            commit(); if (e.key === 'Escape')
                            setEditing(false); }, style: { width: 64, background: '#232328', border: '1px solid #3A3A42', borderRadius: RADIUS_SCALE[5], color: '#EFE7D2', fontSize: TYPE_SCALE[12], padding: '3px 6px' } }),
                    React.createElement("button", { onClick: commit, style: { background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12], cursor: 'pointer', fontWeight: 600, padding: 0 } }, "Save"))
                : React.createElement("button", { onClick: () => { setDraft(String(goal)); setEditing(true); }, style: { background: 'none', border: 'none', color: '#5C5C64', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', padding: 0 } }, "Edit goal")),
        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[22], fontWeight: 600, marginBottom: 8 } }, current.toLocaleString(), " / ", goal.toLocaleString()),
        React.createElement(ProgressBar, { value: current, max: goal, color: color }),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 6 } }, `${pct}%`));
}


export function EmptyState({ text }) {
    return React.createElement("div", { style: { color: '#5C5C64', fontSize: TYPE_SCALE[13.5], padding: '20px 0', fontStyle: 'italic' } }, text);
}
