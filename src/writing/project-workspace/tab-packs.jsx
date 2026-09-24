import React from 'react';
import { NavScrollBox } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { PublishingHub } from '../publishing-hub.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'packs' block — only the
// state it read is now passed in as props instead of closed over.
export function PacksTab({ askConfirm, handleDeletePack, handleSetPackPublishStatus, handleSetPublishStatus, project, projectId, publishStatus, setPackBuilderState, setPublishWizard, update, writerGuildName }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-packs`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Publishing"),
                React.createElement(PublishingHub, {
                    project, projectId, askConfirm, update, publishStatus, writerGuildName, setPublishWizard,
                    handleSetPublishStatus, setPackBuilderState, handleDeletePack, handleSetPackPublishStatus,
                })));
}
