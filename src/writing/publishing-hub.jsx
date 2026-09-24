import React, { useState } from 'react';
import { WorldbuildingPackCard } from '../library/publishing.jsx';
import { EmptyState, SectionLabel } from '../shared-ui/ui-cards.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';
import { InkIcon } from '../shell/ink-icon.jsx';
import { AddonStudioPanel } from './addon-studio.jsx';
import { ImportWorkPanel, ExportWorkPanel } from './import-export.jsx';
import { TemplatesPanel } from './templates.jsx';


// ---------- Publishing ----------
// One hub for everything to do with getting work out of this project, or bringing work in.
// Books, Worldbuilding Packs, and Guild publishing are the same systems that existed before —
// same state, same handlers, same PublishingWizard — just given a proper home here instead of
// being split between this tab and Settings. Import Work, Export Work, Templates, and Addons are
// new, self-contained sub-sections that don't touch any of that existing logic.
const PUBLISHING_SUBTABS = [
    { key: 'books', label: 'Books', icon: React.createElement(InkIcon, { name: 'book', size: 13 }) },
    { key: 'packs', label: 'Worldbuilding Packs', icon: React.createElement(InkIcon, { name: 'package', size: 13 }) },
    { key: 'guild', label: 'Guild', icon: React.createElement(InkIcon, { name: 'castle', size: 13 }) },
    { key: 'import', label: 'Import Work', icon: React.createElement(InkIcon, { name: 'download', size: 13 }) },
    { key: 'export', label: 'Export Work', icon: React.createElement(InkIcon, { name: 'upload', size: 13 }) },
    { key: 'templates', label: 'Templates', icon: React.createElement(InkIcon, { name: 'scroll', size: 13 }) },
    { key: 'addons', label: 'Addons', icon: React.createElement(InkIcon, { name: 'puzzle', size: 13 }) },
];


function PublishingSubTabBar({ active, onSelect }) {
    return React.createElement("div", { style: { display: 'flex', gap: SPACE_SCALE[6], overflowX: 'auto', marginBottom: 26, paddingBottom: 2 } },
        PUBLISHING_SUBTABS.map((t) => React.createElement("button", {
            key: t.key, onClick: () => onSelect(t.key), style: {
                flexShrink: 0, border: active === t.key ? '1px solid #C89B3C' : '1px solid #3A3020',
                borderRadius: RADIUS_SCALE[999], padding: '8px 15px', fontSize: TYPE_SCALE[12], fontWeight: 600,
                cursor: 'pointer', whiteSpace: 'nowrap', letterSpacing: '0.02em',
                background: active === t.key ? 'linear-gradient(160deg, #3A2F1C, #241E12)' : 'none',
                color: active === t.key ? '#E8C468' : '#A6A6AD',
            },
        }, t.icon, " ", t.label)));
}


// Books sub-tab: the exact same completed/publishStatus data and handlers Settings uses
// (see handleSetPublishStatus, publishStatus, writerGuildName), just surfaced here too.
function BooksPublishingPanel({ project, publishStatus, writerGuildName, setPublishWizard, handleSetPublishStatus }) {
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Books"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "Publish this project itself as a book \u2014 to the Grand Library, or privately to your Guild."),
        !project.completed
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64', fontStyle: 'italic' } }, "Mark this project as completed, in Settings, before publishing the book.")
            : React.createElement("div", { style: { display: 'flex', alignItems: 'center', gap: SPACE_SCALE[10], flexWrap: 'wrap' } },
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
                    } }, "Unpublish")));
}


// Worldbuilding Packs sub-tab: unchanged from before — same list, same builder, same wizard.
function PacksPublishingPanel({ project, askConfirm, setPackBuilderState, handleDeletePack, handleSetPackPublishStatus, setPublishWizard }) {
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Worldbuilding Packs"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "Package characters, locations, houses, lore, timeline events, and glossary terms from this project into a standalone pack \u2014 something readers or fellow writers can browse, and one day buy, on its own, separately from the book itself."),
        React.createElement("button", { onClick: () => setPackBuilderState('new'), style: {
                background: 'linear-gradient(160deg, #241F14, #1A160D)', border: '1px solid #4A3D22', color: '#E8C468',
                borderRadius: RADIUS_SCALE[8], padding: '9px 16px', fontSize: TYPE_SCALE[13], fontWeight: 600, cursor: 'pointer', marginBottom: 22,
            } }, "+ Create Worldbuilding Pack"),
        project.worldbuildingPacks.length === 0
            ? React.createElement(EmptyState, { text: "No Worldbuilding Packs yet. Create one to share your world's lore on its own." })
            : React.createElement("div", { style: { display: 'grid', gap: SPACE_SCALE[14], maxWidth: 640 } },
                project.worldbuildingPacks.map((pack) => React.createElement(WorldbuildingPackCard, {
                    key: pack.id, project, pack,
                    onEdit: () => setPackBuilderState(pack.id),
                    onDelete: () => askConfirm(`Delete the pack "${pack.title || 'Untitled Pack'}"? This can't be undone.`, () => handleDeletePack(pack.id)),
                    onSetPublishStatus: handleSetPackPublishStatus,
                    onOpenPublishWizard: (packId) => setPublishWizard({ type: 'pack', packId }),
                }))));
}


// Guild sub-tab: a read-only summary of what this project has published to the Guild — same
// publishStatus data as the Books panel above, just filtered to the 'guild' destination.
function GuildPublishingPanel({ project, publishStatus, writerGuildName, setPublishWizard }) {
    const bookPublishedToGuild = publishStatus === 'guild';
    return React.createElement("div", null,
        React.createElement(SectionLabel, null, "Guild"),
        React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "Publishing to your Guild shares work privately with fellow members \u2014 for feedback, competitions, beta reading, and guild events \u2014 rather than the open Grand Library."),
        !writerGuildName
            ? React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#5C5C64', fontStyle: 'italic' } }, "Join or found a Guild to publish privately here.")
            : React.createElement("div", null,
                React.createElement("div", { style: { background: '#1D1D22', border: '1px solid #2A2A30', borderRadius: RADIUS_SCALE[10], padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: SPACE_SCALE[12], flexWrap: 'wrap' } },
                    React.createElement("div", null,
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[14], fontWeight: 600, color: '#EFE7D2' } }, project.title || 'This book'),
                        React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#7A7A82', marginTop: 4 } }, bookPublishedToGuild ? `Published \u00B7 ${writerGuildName}` : 'Not yet published to your Guild')),
                    !bookPublishedToGuild && React.createElement("button", { onClick: () => setPublishWizard({ type: 'book' }), style: {
                            background: 'none', border: '1px solid #3A3020', color: '#C89B3C', borderRadius: RADIUS_SCALE[8],
                            padding: '5px 12px', fontSize: TYPE_SCALE[11.5], cursor: 'pointer', fontWeight: 600, flexShrink: 0,
                        } }, "Publish to Guild")),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11], color: '#5C5C64', marginTop: 10 } }, "Worldbuilding Packs currently publish to Inkroot only.")));
}


export function PublishingHub(props) {
    const { project, projectId, askConfirm, update, publishStatus, writerGuildName, setPublishWizard, handleSetPublishStatus, setPackBuilderState, handleDeletePack, handleSetPackPublishStatus } = props;
    const [subTab, setSubTab] = useState('books');
    return React.createElement("div", null,
        React.createElement(PublishingSubTabBar, { active: subTab, onSelect: setSubTab }),
        subTab === 'books' && React.createElement(BooksPublishingPanel, { project, publishStatus, writerGuildName, setPublishWizard, handleSetPublishStatus }),
        subTab === 'packs' && React.createElement(PacksPublishingPanel, { project, askConfirm, setPackBuilderState, handleDeletePack, handleSetPackPublishStatus, setPublishWizard }),
        subTab === 'guild' && React.createElement(GuildPublishingPanel, { project, publishStatus, writerGuildName, setPublishWizard }),
        subTab === 'import' && React.createElement(ImportWorkPanel, { project, update }),
        subTab === 'export' && React.createElement(ExportWorkPanel, { project }),
        subTab === 'templates' && React.createElement(TemplatesPanel, { project, update, askConfirm }),
        subTab === 'addons' && React.createElement(AddonStudioPanel, { askConfirm, project, update }));
}
