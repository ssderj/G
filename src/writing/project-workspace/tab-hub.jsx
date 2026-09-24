import React from 'react';
import { ArchiveSectionHeading } from '../../shared-ui/ui-cards.jsx';
import { InkIcon } from '../../shell/ink-icon.jsx';
import { NavScrollBox, RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { NAV_GROUPS } from '../../shell/nav-labels.jsx';

// Extracted from the monolithic project-workspace.jsx `tab === 'hub'` block, unchanged in
// behavior — only the state it read is now passed in as props instead of closed over.
export function HubTab({
    projectId, project, chapters, totalHealthIssues, streak, totalWords,
    achievements, unlockedAchievementCount, setTab, setWorldCategory,
}) {
    return React.createElement(NavScrollBox, { navKey: `ws-${projectId}-hub`, style: { flex: 1, padding: '48px 40px 64px', overflowY: 'auto', display: 'flex', justifyContent: 'center' }, className: "scrollbox tab-fade" },
        React.createElement("div", { style: { width: '100%', maxWidth: 560 } },
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 8 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "The Archive"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 6, letterSpacing: '0.04em' } }, project.title || 'Untitled Novel')),
            (() => {
                const subtitleFor = (item) => {
                    if (item.key === 'manuscript')
                        return `${chapters.length} chapter${chapters.length === 1 ? '' : 's'}`;
                    if (item.key === 'notes')
                        return `${project.notes.length} note${project.notes.length === 1 ? '' : 's'}`;
                    if (item.key === 'locations')
                        return `${project.locations.length} place${project.locations.length === 1 ? '' : 's'}`;
                    if (item.key === 'maps')
                        return `${project.maps.length} map${project.maps.length === 1 ? '' : 's'}`;
                    if (item.key === 'timeline')
                        return `${project.timeline.length} event${project.timeline.length === 1 ? '' : 's'}`;
                    if (item.key === 'glossary')
                        return `${project.glossary.length} term${project.glossary.length === 1 ? '' : 's'}`;
                    if (item.key === 'characters')
                        return `${project.characters.length} in your cast`;
                    if (item.key === 'health')
                        return totalHealthIssues > 0 ? `${totalHealthIssues} thing${totalHealthIssues === 1 ? '' : 's'} to check` : 'All clear';
                    if (item.key === 'progress')
                        return streak > 0 ? `${streak}-day streak` : `${totalWords.toLocaleString()} words`;
                    if (item.key === 'achievements')
                        return `${unlockedAchievementCount} of ${achievements.length} unlocked`;
                    if (item.key === 'settings')
                        return 'title, backup, delete';
                    if (item.key === 'packs')
                        return `${project.worldbuildingPacks.length} pack${project.worldbuildingPacks.length === 1 ? '' : 's'}`;
                    if (item.key === 'world' && item.worldCategory) {
                        const count = project.world.filter((w) => w.category === item.worldCategory).length;
                        return `${count} entr${count === 1 ? 'y' : 'ies'}`;
                    }
                    return `${project.world.length} entr${project.world.length === 1 ? 'y' : 'ies'}`;
                };
                return NAV_GROUPS.map((group, gIdx) => React.createElement("div", { key: group.key, className: "archive-section-in", style: { marginBottom: 46, '--i': gIdx } },
                    React.createElement(ArchiveSectionHeading, { icon: React.createElement(InkIcon, { name: group.icon, size: 20, style: { display: "inline-block" } }), label: group.label }),
                    React.createElement("div", { style: { display: 'flex', flexDirection: 'column', gap: SPACE_SCALE[8], marginTop: 18 } }, group.items.map((item, idx) => React.createElement("div", { key: `${item.key}-${item.worldCategory || idx}`, onClick: () => { setTab(item.key); if (item.worldCategory)
                            setWorldCategory(item.worldCategory); }, className: "archive-row", style: {
                            display: 'flex', alignItems: 'center', gap: SPACE_SCALE[14], cursor: 'pointer',
                            padding: '15px 18px', borderRadius: RADIUS_SCALE[9], background: '#1B1912', border: '1px solid #2E2A1E',
                        } },
                        React.createElement("span", { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', width: 22, flexShrink: 0 } }, React.createElement(InkIcon, { name: item.icon, size: 20 })),
                        React.createElement("div", { style: { flex: 1 } },
                            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[16], fontWeight: 600, color: '#EFE7D2' } }, item.label),
                            React.createElement("div", { style: { fontSize: TYPE_SCALE[12], color: '#7A7A82', marginTop: 2, fontStyle: 'italic' } }, subtitleFor(item))),
                        React.createElement("span", { className: "archive-row-arrow", style: { color: '#5C5C64' } }, "\u203A"))))));
            })()));
}
