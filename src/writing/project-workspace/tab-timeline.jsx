import React from 'react';
import { NavScrollBox, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { EmptyState, SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { selectStyle } from '../../shared-ui/ui-primitives.jsx';
import { inputStyle } from '../../shared-ui/form-fields.jsx';
import { IconPlus, IconTrash } from '../../shared-ui/icons.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'timeline' block — only the
// state it read is now passed in as props instead of closed over.
export function TimelineTab({ askConfirm, project, projectId, update }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-timeline`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Timeline"),
                React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[10], maxWidth: 720 } },
                    project.timeline.map((ev, i) => (React.createElement("div", { key: ev.id, id: "timeline-" + ev.id, className: "ink-row-in", style: { display: 'flex', gap: SPACE_SCALE[12], alignItems: 'flex-start', padding: 14, background: '#1D1D22', borderRadius: RADIUS_SCALE[8], border: '1px solid #2A2A30', '--i': Math.min(i, 8) } },
                        React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", color: '#C89B3C', fontSize: TYPE_SCALE[13], minWidth: 26, paddingTop: 6, textAlign: 'right', flexShrink: 0 } }, i + 1),
                        React.createElement("div", { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
                            React.createElement("input", { placeholder: "When (e.g. 'Year 3, dry season')", value: ev.when, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).when = e.target.value; }), style: inputStyle(13, 500) }),
                            React.createElement("input", { placeholder: "What happens", value: ev.what, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).what = e.target.value; }), style: inputStyle(14.5, 400) }),
                            React.createElement("select", { value: ev.characterId || '', onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).characterId = e.target.value; }), style: { ...selectStyle, width: 'auto', alignSelf: 'flex-start' } },
                                React.createElement("option", { value: "" }, "No character linked"),
                                project.characters.map((c) => React.createElement("option", { key: c.id, value: c.id }, c.name || 'Unnamed'))),
                            React.createElement("select", { value: ev.locationId || '', onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).locationId = e.target.value; }), style: { ...selectStyle, width: 'auto', alignSelf: 'flex-start' } },
                                React.createElement("option", { value: "" }, "No location linked"),
                                project.locations.map((l) => React.createElement("option", { key: l.id, value: l.id }, l.name || 'Unnamed')))),
                        React.createElement("button", { onClick: () => {
                                const label = ev.when && ev.when.trim() ? `"${ev.when.trim()}"` : 'this event';
                                askConfirm(`Delete ${label}? This cannot be undone.`, () => update((p) => { p.timeline = p.timeline.filter((x) => x.id !== ev.id); }));
                            }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex', paddingTop: 6 } },
                            React.createElement(IconTrash, null))))),
                    React.createElement("button", { onClick: () => update((p) => { p.timeline.push({ id: uuid(), when: '', what: '', characterId: '', locationId: '' }); }), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 4, background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '9px 12px', fontSize: TYPE_SCALE[13], cursor: 'pointer', alignSelf: 'flex-start' } },
                        React.createElement(IconPlus, null),
                        " Add event"),
                    project.timeline.length === 0 && React.createElement(EmptyState, { text: "No events yet. Track the moments your continuity depends on." }))));
}
