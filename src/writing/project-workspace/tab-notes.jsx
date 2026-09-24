import React from 'react';
import { NavScrollBox } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { CardList } from '../../shared-ui/ui-primitives.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'notes' block — only the
// state it read is now passed in as props instead of closed over.
export function NotesTab({ askConfirm, project, projectId, update }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-notes`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Notes"),
                React.createElement(CardList, { items: project.notes, fields: [
                        { key: 'title', placeholder: 'Note title' },
                        { key: 'body', placeholder: 'Anything worth remembering…', kind: 'textarea' },
                    ], onAdd: () => update((p) => { p.notes.push({ id: uuid(), title: '', body: '' }); }), onRemove: (id) => update((p) => { p.notes = p.notes.filter((x) => x.id !== id); }), onChange: (id, key, val) => update((p) => { p.notes.find((x) => x.id === id)[key] = val; }), anchorPrefix: "notes", addLabel: "Add note", emptyText: "A scratchpad for ideas that don't belong anywhere else yet.", askConfirm: askConfirm })));
}
