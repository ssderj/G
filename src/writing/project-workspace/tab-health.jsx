import React from 'react';
import { NavScrollBox, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { SectionLabel } from '../../shared-ui/ui-cards.jsx';
import { HealthScoreSummary, HealthSection } from '../health-checks.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'health' block — only the
// state it read is now passed in as props instead of closed over.
export function HealthTab({ healthScore, healthSections, projectId, totalHealthIssues }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-health`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Story Health"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[13], color: '#7A7A82', marginBottom: 20, maxWidth: 560, lineHeight: 1.6 } }, "A quick check for things that need attention. We'll add more checks here over time."),
                React.createElement("div", { style: { marginBottom: 28 } },
                    React.createElement(HealthScoreSummary, { score: healthScore, totalIssues: totalHealthIssues })),
                healthSections.map((section) => React.createElement(HealthSection, { key: section.key, icon: section.icon, label: section.label, issues: section.issues, emptyText: section.emptyText }))));
}
