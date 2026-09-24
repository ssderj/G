import React from 'react';
import { NavScrollBox, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { CoverPicker, Field, ImageOptimizePanel } from '../../shared-ui/form-fields.jsx';
import { BackupHistoryPanel } from '../backup-history-panel.jsx';
import { StorageUsageNote, patchProjectDefaults } from '../project-schema-and-backups.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'settings' block — only the
// state it read is now passed in as props instead of closed over.
export function SettingsTab({ askConfirm, chapters, handleSetPublishStatus, now, onDeleteProject, project, projectId, publishStatus, setProject, setPublishWizard, soundSettings, totalWords, update, updateSoundSettings, writerGuildName }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-settings`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Settings"),
                React.createElement("div", { style: { maxWidth: 480, display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[22] } },
                    React.createElement(Field, { label: "Project title", value: project.title, onChange: (v) => update((p) => { p.title = v; }), large: true }),
                    React.createElement(Field, { label: "Subtitle (optional)", value: project.subtitle, placeholder: "e.g. A Novel of the Fractured Isles", onChange: (v) => update((p) => { p.subtitle = v; }) }),
                    React.createElement(Field, { label: "Series name (optional)", value: project.seriesName, placeholder: "e.g. The Salt Throne, Book One", onChange: (v) => update((p) => { p.seriesName = v; }) }),
                    React.createElement(Field, { label: "Author name", value: project.author, placeholder: "Your name or pen name", onChange: (v) => update((p) => { p.author = v; }) }),
                    React.createElement(CoverPicker, { cover: project.cover, onChange: (patch) => update((p) => { p.cover = Object.assign({}, p.cover, patch); }), title: project.title, subtitle: project.subtitle, seriesName: project.seriesName, author: project.author }),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Story Format"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginBottom: 10, lineHeight: 1.5, maxWidth: 440 } }, "A traditional full-length book is told in Chapters. A shorter, serialized story \u2014 released and read one installment at a time \u2014 is told in Episodes instead. Both use the same manuscript underneath; this only changes what it's called and how readers browse it."),
                        React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[8], maxWidth: 360 } }, [
                            ['book', 'Full Book', 'Chapters'],
                            ['series', 'Serialized Story', 'Episodes'],
                        ].map(([key, label, unit]) => React.createElement("button", { key, onClick: () => update((p) => { p.storyFormat = key; }), style: {
                                flex: 1, textAlign: 'left', borderRadius: RADIUS_SCALE[10], padding: '10px 12px', cursor: 'pointer',
                                background: (project.storyFormat || 'book') === key ? 'linear-gradient(160deg, #2C2415, #1D170E)' : 'linear-gradient(160deg, #211C13, #17130E)',
                                border: (project.storyFormat || 'book') === key ? '1px solid #C89B3C' : '1px solid #3A3020',
                            } },
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], fontWeight: 600, color: (project.storyFormat || 'book') === key ? '#E8C468' : '#D9D2BE' } }, label),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[10.5], color: '#7A7A82', marginTop: 2 } }, unit))))),
                    React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], cursor: 'pointer', userSelect: 'none' } },
                        React.createElement("span", { onClick: () => update((p) => { p.completed = !p.completed; p.completedAt = p.completed ? Date.now() : null; }), style: {
                                width: 34, height: 20, borderRadius: RADIUS_SCALE[12], flexShrink: 0, position: 'relative',
                                background: project.completed ? '#C89B3C' : '#2A2A30', transition: 'background var(--ink-dur) var(--ink-ease)',
                            } },
                            React.createElement("span", { style: {
                                    position: 'absolute', top: 2, left: project.completed ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
                                    background: '#17171B', transition: 'left var(--ink-dur) var(--ink-ease)',
                                } })),
                        React.createElement("span", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD' } }, "Mark this project as completed")),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Publishing"),
                        project.completed
                            ? React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
                                publishStatus !== 'none' && React.createElement("span", { style: {
                                        fontSize: TYPE_SCALE[10.5], fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                                        padding: '3px 9px', borderRadius: RADIUS_SCALE[999], background: 'rgba(200,155,60,0.12)', color: '#C89B3C',
                                    } }, publishStatus === 'inkroot' ? 'Published \u00B7 Inkroot' : `Published \u00B7 ${writerGuildName || 'Guild'}`),
                                publishStatus === 'none' && React.createElement("button", { onClick: () => setPublishWizard({ type: 'book' }), style: {
                                        background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                                        padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                                    } }, "Publish"),
                                publishStatus !== 'none' && React.createElement("button", { onClick: () => setPublishWizard({ type: 'book' }), style: {
                                        background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                                        padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                                    } }, "Manage listing"),
                                publishStatus === 'guild' && React.createElement("button", { onClick: () => handleSetPublishStatus('inkroot'), style: {
                                        background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                                        padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600,
                                    } }, "Promote to Inkroot"),
                                publishStatus !== 'none' && React.createElement("button", { onClick: () => handleSetPublishStatus('none'), style: {
                                        background: 'none', border: 'none', color: '#7A7A82', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', textDecoration: 'underline', padding: 0,
                                    } }, "Unpublish"))
                            : React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', fontStyle: 'italic' } }, "Mark this project as completed, above, to publish it."),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 8 } }, "The same Publishing Wizard is also available from Author Studio in the Grand Library, and from any Worldbuilding Pack in the Packs tab \u2014 one shared publishing system.")),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Sound"),
                        React.createElement("label", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], cursor: 'pointer', userSelect: 'none' } },
                            React.createElement("span", { onClick: () => updateSoundSettings({ enabled: !soundSettings.enabled }), style: {
                                    width: 34, height: 20, borderRadius: RADIUS_SCALE[12], flexShrink: 0, position: 'relative',
                                    background: soundSettings.enabled ? '#C89B3C' : '#2A2A30', transition: 'background var(--ink-dur) var(--ink-ease)',
                                } },
                                React.createElement("span", { style: {
                                        position: 'absolute', top: 2, left: soundSettings.enabled ? 16 : 2, width: 16, height: 16, borderRadius: '50%',
                                        background: '#17171B', transition: 'left var(--ink-dur) var(--ink-ease)',
                                    } })),
                            React.createElement("span", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD' } }, "Play a sound when an achievement unlocks")),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 8 } }, "This preference is shared across every project on this device.")),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "At a glance"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[13.5], color: '#A6A6AD', lineHeight: 1.9 } },
                            chapters.length,
                            " chapter",
                            chapters.length === 1 ? '' : 's',
                            " \u00B7 ",
                            totalWords.toLocaleString(),
                            " words",
                            React.createElement("br", null),
                            project.characters.length,
                            " character",
                            project.characters.length === 1 ? '' : 's',
                            " \u00B7 ",
                            project.locations.length,
                            " location",
                            project.locations.length === 1 ? '' : 's')),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Backup"),
                        React.createElement("button", { onClick: () => {
                                const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement('a');
                                a.href = url;
                                a.download = (project.title || 'inkroot-project').trim().toLowerCase().replace(/\s+/g, '-') + '.json';
                                a.click();
                                URL.revokeObjectURL(url);
                            }, style: {
                                background: '#232328', border: '1px solid #2A2A30', color: '#EFE7D2', borderRadius: RADIUS_SCALE[6],
                                padding: '9px 14px', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                            } }, "Download backup (.json)"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', marginTop: 8 } }, "Everything here lives only in this browser. Keep a backup somewhere safe, especially before clearing browser data.")),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Backup Versions"),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#5C5C64', marginBottom: 10 } }, "Inkroot keeps several recent autosaved versions on this device, in addition to the very latest one it always saves as you work \u2014 so a bad edit (or an app crash) doesn't have to be the last word. To keep backups small and reliable, they don't include map or portrait images \u2014 only your current, live project does."),
                        React.createElement(StorageUsageNote, null),
                        React.createElement("div", { style: { marginBottom: 14 } },
                            React.createElement(ImageOptimizePanel, { project: project, projectId: projectId, onOptimized: (optimized) => setProject(optimized) }),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64', marginTop: 8 } }, "Shrinks any already-embedded map, portrait, banner, or crest images in this project that are larger than they need to be \u2014 useful if a save ever fails, or if images were added before this device started compressing new uploads automatically.")),
                        React.createElement(BackupHistoryPanel, { projectId: projectId, askConfirm: askConfirm, onRestore: (data) => setProject(patchProjectDefaults(structuredClone(data))) })),
                    React.createElement("div", null,
                        React.createElement(SectionLabel, null, "Danger zone"),
                        React.createElement("button", { onClick: () => {
                                const label = project.title && project.title.trim() ? `"${project.title.trim()}"` : 'this project';
                                const words = totalWords ? ` (${totalWords.toLocaleString()} words)` : '';
                                askConfirm(`Delete ${label}${words}? Everything in it will be permanently lost.`, () => onDeleteProject(projectId));
                            }, style: {
                                background: 'none', border: '1px solid #5C2A2A', color: '#D98A8A', borderRadius: RADIUS_SCALE[6],
                                padding: '9px 14px', fontSize: TYPE_SCALE[13], cursor: 'pointer',
                            } }, "Delete this project")))));
}
