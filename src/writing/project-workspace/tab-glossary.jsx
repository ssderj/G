import React from 'react';
import { NavScrollBox } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { CardList } from '../../shared-ui/ui-primitives.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'glossary' block — only the
// state it read is now passed in as props instead of closed over.
export function GlossaryTab({ askConfirm, project, projectId, update }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-glossary`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Glossary"),
                React.createElement(CardList, { items: project.glossary, fields: [
                        { key: 'term', placeholder: 'Term or invented word' },
                        { key: 'definition', placeholder: 'What it means…', kind: 'textarea' },
                    ], onAdd: () => update((p) => { p.glossary.push({ id: uuid(), term: '', definition: '' }); }), onRemove: (id) => update((p) => { p.glossary = p.glossary.filter((x) => x.id !== id); }), onChange: (id, key, val) => update((p) => { p.glossary.find((x) => x.id === id)[key] = val; }), anchorPrefix: "glossary", addLabel: "Add term", emptyText: "No glossary terms yet. Track invented words, titles, and jargon so they stay consistent.", askConfirm: askConfirm })));
}
