import React from 'react';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { EmptyState, QuickStatsCard, SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { Field, TagInput, inputStyle } from '../../shared-ui/form-fields.jsx';
import { IconPlus, IconTrash } from '../../shared-ui/icons.jsx';
import { ImagePicker, selectStyle } from '../../shared-ui/ui-primitives.jsx';
import { InkIcon } from '../../shell/ink-icon.jsx';
import { CHARACTER_ROLES } from '../../worldbuilding/book-cover.jsx';
import { FamilyTreeView, HouseCrest, RelationshipManager, RelationshipWeb } from '../../worldbuilding/relationship-web.jsx';
import { SectionNav } from '../../worldbuilding/family-tree-gallery.jsx';
import { relationshipsForCharacter } from '../../worldbuilding/family-graph.jsx';
import { chapterLabel } from '../project-schema-and-backups.jsx';
import { uuid } from '../../shared-utils/storage-keys.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'characters' block — only the
// state it read is now passed in as props instead of closed over.
export function CharactersTab({ activeCharacter, askConfirm, autoEdges, chapters, charRoleFilter, charView, character, characterAppearsIn, characterFamilyIds, characterPaneRef, jumpToChapter, project, setActiveCharacter, setCharRoleFilter, setCharView, setGeneratedTreeOpen, setSubNavOpen, setTab, status, subNavOpen, unitTerm, update }) {
    return (React.createElement("div", { className: "tab-fade", style: { display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' } },
                React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], padding: '14px 16px 0' } }, ['list', 'web'].map((v) => (React.createElement("button", { key: v, onClick: () => setCharView(v), style: {
                        border: 'none', cursor: 'pointer', padding: '6px 12px', borderRadius: RADIUS_SCALE[6], fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                        background: charView === v ? '#232328' : 'transparent', color: charView === v ? '#C89B3C' : '#7A7A82',
                    } }, v === 'list' ? 'Cast list' : 'Relationship web')))),
                charView === 'list' ? (React.createElement("div", { style: { display: 'flex', flex: 1, minHeight: 0, position: 'relative' } },
                    subNavOpen && React.createElement("div", { className: "subnav-backdrop open", onClick: () => setSubNavOpen(false) }),
                    React.createElement("div", { className: "scrollbox sub-sidebar" + (subNavOpen ? ' open' : ''), style: { width: 230, borderRight: '1px solid #2A2A30', padding: 16, overflowY: 'auto', flexShrink: 0 } },
                        React.createElement(SectionLabel, null, "Cast"),
                        React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[3], marginBottom: 12 } }, [
                            { key: 'all', label: 'All' },
                            ...CHARACTER_ROLES,
                        ].map((r) => {
                            const count = r.key === 'all' ? project.characters.length : project.characters.filter((c) => c.role === r.key).length;
                            const active = charRoleFilter === r.key;
                            return React.createElement("button", { key: r.key, onClick: () => setCharRoleFilter(r.key), style: {
                                    display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer',
                                    border: 'none', borderRadius: RADIUS_SCALE[6], padding: '6px 8px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                                    background: active ? '#232328' : 'transparent', color: active ? '#C89B3C' : '#A6A6AD', textAlign: 'left',
                                } },
                                React.createElement("span", null, r.label),
                                React.createElement("span", { style: { color: '#5C5C64', fontWeight: 500 } }, count));
                        })),
                        (charRoleFilter === 'all' ? project.characters : project.characters.filter((c) => c.role === charRoleFilter)).map((c) => (React.createElement("div", { key: c.id, onClick: () => { setActiveCharacter(c.id); setSubNavOpen(false); }, className: "hoverable", style: {
                                padding: '9px 10px', borderRadius: RADIUS_SCALE[6], cursor: 'pointer', marginBottom: 2,
                                background: c.id === activeCharacter ? '#232328' : 'transparent',
                                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            } },
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[13.5], color: '#D9D2BE' } }, c.name || 'Unnamed'),
                            React.createElement("button", { onClick: (e) => {
                                    e.stopPropagation();
                                    const label = c.name && c.name.trim() ? `"${c.name.trim()}"` : 'this character';
                                    askConfirm(`Delete ${label}? Their profile, relationships, and linked life events will be permanently lost.`, () => {
                                        update((p) => { p.characters = p.characters.filter((x) => x.id !== c.id); });
                                        if (activeCharacter === c.id)
                                            setActiveCharacter(null);
                                    });
                                }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex' } },
                                React.createElement(IconTrash, null))))),
                        React.createElement("button", { onClick: () => update((p) => {
                                const nc = {
                                    id: uuid(), name: '', alias: '', age: '', birthday: '', race: '', occupation: '',
                                    status: '', lifeStatus: '', role: charRoleFilter === 'all' ? '' : charRoleFilter, portraitUrl: '', houseId: '', tags: [], goals: '', personality: '', biography: '', notes: '',
                                };
                                p.characters.push(nc);
                                setActiveCharacter(nc.id);
                            }), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], marginTop: 8, background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '7px 10px', fontSize: TYPE_SCALE[13], cursor: 'pointer', width: '100%' } },
                            React.createElement(IconPlus, null),
                            " New character")),
                    React.createElement("div", { ref: characterPaneRef, style: { flex: 1, padding: '28px 40px', overflowY: 'auto', maxWidth: 640 }, className: "scrollbox" }, character ? (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[22] } },
                        React.createElement(SectionNav, { scrollRef: characterPaneRef, sections: [
                                { id: 'char-sec-overview', label: 'Overview' },
                                { id: 'char-sec-relationships', label: 'Relationships' },
                                { id: 'char-sec-family', label: 'Family Tree' },
                                { id: 'char-sec-appears', label: 'Appears In' },
                                { id: 'char-sec-timeline', label: 'Timeline' },
                                { id: 'char-sec-notes', label: 'Notes' },
                            ] }),
                        React.createElement("div", { id: "char-sec-overview", style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[22] } },
                        React.createElement(QuickStatsCard, { rows: [
                                { label: 'Occupation', value: character.occupation },
                                { label: 'House / Clan', value: (project.world.find((w) => w.id === character.houseId) || {}).topic },
                                { label: 'Status', value: character.lifeStatus === 'alive' ? 'Alive' : character.lifeStatus === 'dead' ? 'Dead' : (character.status || '') },
                                { label: 'Age', value: character.age },
                            ] }),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[16], alignItems: 'flex-start' } },
                            React.createElement("div", { style: { width: 84, height: 84, borderRadius: RADIUS_SCALE[10], overflow: 'hidden', flexShrink: 0, background: '#1D1D22', border: '1px solid #2A2A30', display: 'flex', alignItems: 'center', justifyContent: 'center' } }, character.portraitUrl ? (React.createElement("img", { src: character.portraitUrl, style: { width: '100%', height: '100%', objectFit: 'cover' }, onError: (e) => { e.currentTarget.style.display = 'none'; } })) : (React.createElement(InkIcon, { name: "users", size: 26, color: "#5C5C64" }))),
                            React.createElement("div", { style: { flex: 1 } },
                                React.createElement(SectionLabel, null, "Portrait"),
                                React.createElement(ImagePicker, { value: character.portraitUrl || '', onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).portraitUrl = v; }), placeholder: "Paste an image link\u2026" }))),
                        React.createElement(Field, { label: "Name", value: character.name, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).name = v; }), large: true }),
                        React.createElement(TagInput, { tags: character.tags || [], onChange: (tags) => update((p) => { p.characters.find((x) => x.id === character.id).tags = tags; }) }),
                        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(140px, 1fr))', gap: SPACE_SCALE[14] } },
                            React.createElement(Field, { label: "Alias", value: character.alias, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).alias = v; }) }),
                            React.createElement(Field, { label: "Age", value: character.age, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).age = v; }) }),
                            React.createElement(Field, { label: "Birthday", value: character.birthday, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).birthday = v; }) }),
                            React.createElement(Field, { label: "Race", value: character.race, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).race = v; }) }),
                            React.createElement(Field, { label: "Occupation", value: character.occupation, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).occupation = v; }) }),
                            React.createElement("div", null,
                                React.createElement(SectionLabel, null, "Role"),
                                React.createElement("select", { value: character.role || '', onChange: (e) => update((p) => { p.characters.find((x) => x.id === character.id).role = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                    React.createElement("option", { value: "" }, "Unassigned"),
                                    CHARACTER_ROLES.map((r) => React.createElement("option", { key: r.key, value: r.key }, r.label)))),
                            React.createElement("div", null,
                                React.createElement(SectionLabel, null, "Alive / Dead"),
                                React.createElement("select", { value: character.lifeStatus || '', onChange: (e) => update((p) => { p.characters.find((x) => x.id === character.id).lifeStatus = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                    React.createElement("option", { value: "" }, "Unknown"),
                                    React.createElement("option", { value: "alive" }, "Alive"),
                                    React.createElement("option", { value: "dead" }, "Dead"))),
                            React.createElement("div", null,
                                React.createElement(SectionLabel, null, "House / Clan"),
                                React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[8] } },
                                    (character.houseId) && React.createElement(HouseCrest, { url: (project.world.find((w) => w.id === character.houseId) || {}).crestUrl || '', size: 30, radius: 8 }),
                                    React.createElement("select", { value: character.houseId || '', onChange: (e) => update((p) => { p.characters.find((x) => x.id === character.id).houseId = e.target.value; }), style: { ...selectStyle, width: '100%' } },
                                        React.createElement("option", { value: "" }, "None"),
                                        project.world.filter((w) => w.category === 'houses').map((w) => React.createElement("option", { key: w.id, value: w.id }, w.topic || 'Unnamed house')))),
                                project.world.filter((w) => w.category === 'houses').length === 0 && React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 4 } }, "Add a house in the World Bible first."))),
                        React.createElement(Field, { label: "Current Status", value: character.status, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).status = v; }), placeholder: "e.g. in hiding, imprisoned, on the run" }),
                        React.createElement(Field, { label: "Goals", value: character.goals, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).goals = v; }), textarea: true }),
                        React.createElement(Field, { label: "Personality", value: character.personality, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).personality = v; }), textarea: true }),
                        React.createElement(Field, { label: "Biography", value: character.biography, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).biography = v; }), textarea: true })),
                        React.createElement("div", { id: "char-sec-relationships" },
                            React.createElement(SectionLabel, null, "Relationships"),
                            (() => {
                                const rels = relationshipsForCharacter(character.id, project.characters, project.relationships, autoEdges);
                                return rels.length === 0 ? (React.createElement(EmptyState, { text: "No relationships yet \u2014 define one, or mention this character alongside others in your manuscript." })) : (React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } }, rels.map((r, i) => (React.createElement("div", { key: i, onClick: () => setActiveCharacter(r.otherId), className: "hoverable", style: {
                                        cursor: 'pointer', fontSize: TYPE_SCALE[13.5], color: '#D9D2BE', background: '#1D1D22',
                                        border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: '7px 10px',
                                    } },
                                    React.createElement("strong", { style: { color: '#EFE7D2' } }, r.otherName),
                                    React.createElement("span", { style: { color: '#7A7A82' } },
                                        " \u2014 ",
                                        r.label))))));
                            })(),
                            React.createElement("button", { onClick: () => setCharView('web'), style: { background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12.5], cursor: 'pointer', padding: '8px 0 0' } }, "View relationship web \u2192")),
                        React.createElement("div", { id: "char-sec-family" },
                            React.createElement(SectionLabel, null, "Family Tree"),
                            React.createElement(FamilyTreeView, { memberIds: characterFamilyIds, characters: project.characters, relationships: project.relationships, onSelectCharacter: (id) => setActiveCharacter(id), focusId: character.id, emptyText: "No family links yet \u2014 use \u201CParent of\u201D, \u201CSpouse of\u201D, or \u201CSibling of\u201D below to connect them." })),
                        React.createElement("div", { id: "char-sec-appears" },
                            React.createElement(SectionLabel, null, "Appears In"),
                            (() => {
                                const inChapters = characterAppearsIn;
                                return inChapters.length === 0 ? (React.createElement(EmptyState, { text: "Not mentioned in any chapter yet. Use @ in the manuscript to link them in." })) : (React.createElement("div", { style: { display: 'flex', flexWrap: 'wrap', gap: SPACE_SCALE[8] } }, inChapters.map((c) => (React.createElement("button", { key: c.id, onClick: () => jumpToChapter(c.id), style: {
                                        background: '#1D1D22', border: '1px solid #2A2A30', color: '#D9D2BE',
                                        borderRadius: RADIUS_SCALE[6], padding: '6px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer',
                                    } }, chapterLabel(project.chapters, c.id, unitTerm))))));
                            })()),
                        React.createElement("div", { id: "char-sec-timeline" },
                            React.createElement(SectionLabel, null, "Life Events"),
                            (() => {
                                const events = project.timeline.filter((ev) => ev.characterId === character.id);
                                return React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[6] } },
                                    events.length === 0 ? React.createElement(EmptyState, { text: "No life events yet \u2014 birth, key milestones, death. Add one and it'll also show up in the full Timeline." }) : events.map((ev) => React.createElement("div", { key: ev.id, style: { display: 'flex', gap: SPACE_SCALE[8], alignItems: 'flex-start', background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[6], padding: 10 } },
                                        React.createElement("div", { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[4] } },
                                            React.createElement("input", { placeholder: "When (e.g. 'Born, Year -22')", value: ev.when, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).when = e.target.value; }), style: inputStyle(12.5, 600) }),
                                            React.createElement("input", { placeholder: "What happened", value: ev.what, onChange: (e) => update((p) => { p.timeline.find((x) => x.id === ev.id).what = e.target.value; }), style: inputStyle(13, 400) })),
                                        React.createElement("button", { onClick: () => {
                                                const label = ev.when && ev.when.trim() ? `"${ev.when.trim()}"` : 'this event';
                                                askConfirm(`Delete ${label}? This cannot be undone.`, () => update((p) => { p.timeline = p.timeline.filter((x) => x.id !== ev.id); }));
                                            }, style: { background: 'none', border: 'none', color: '#5C5C64', cursor: 'pointer', display: 'flex', paddingTop: 4 } },
                                            React.createElement(IconTrash, null)))),
                                    React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], marginTop: 2 } },
                                        React.createElement("button", { onClick: () => update((p) => { p.timeline.push({ id: uuid(), when: '', what: '', characterId: character.id, locationId: '' }); }), style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: '1px dashed #3A3A42', color: '#A6A6AD', borderRadius: RADIUS_SCALE[6], padding: '7px 10px', fontSize: TYPE_SCALE[12.5], cursor: 'pointer' } },
                                            React.createElement(IconPlus, null),
                                            " Add life event"),
                                        React.createElement("button", { onClick: () => setTab('timeline'), style: { background: 'none', border: 'none', color: '#C89B3C', fontSize: TYPE_SCALE[12.5], cursor: 'pointer' } }, "View full timeline \u2192")));
                            })()),
                        React.createElement("div", { id: "char-sec-notes" },
                            React.createElement(Field, { label: "Notes", value: character.notes, onChange: (v) => update((p) => { p.characters.find((x) => x.id === character.id).notes = v; }), textarea: true })))) : React.createElement(EmptyState, { text: "No character selected. Add one to start building your cast." })))) : (React.createElement("div", { style: { flex: 1, padding: '20px 40px', overflowY: 'auto' }, className: "scrollbox" },
                    React.createElement("div", { style: { display: 'flex', justifyContent: 'flex-end', marginBottom: 12 } },
                        React.createElement("button", { onClick: () => setGeneratedTreeOpen(true), style: {
                                display: 'flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none', border: '1px solid #C89B3C',
                                color: '#C89B3C', borderRadius: RADIUS_SCALE[6], padding: '8px 14px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer',
                            } }, React.createElement(InkIcon, { name: "tree", size: 14 }), "Generate Family Tree")),
                    React.createElement(RelationshipWeb, { characters: project.characters, autoEdges: autoEdges, manualEdges: project.relationships, onSelectCharacter: (id) => { setCharView('list'); setActiveCharacter(id); }, houses: project.world.filter((w) => w.category === 'houses') }),
                    React.createElement(RelationshipManager, { characters: project.characters, relationships: project.relationships, onAdd: (r) => update((p) => { p.relationships.push(r); }), onRemove: (id) => update((p) => { p.relationships = p.relationships.filter((x) => x.id !== id); }), askConfirm: askConfirm })))));
}
