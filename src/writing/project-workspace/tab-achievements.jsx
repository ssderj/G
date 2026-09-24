import React from 'react';
import { NavScrollBox, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { AchievementCard, AchievementCategoryHeading, AchievementUnlockToast } from '../achievements.jsx';
import { ACHIEVEMENT_CATEGORIES } from '../health-checks.jsx';

// AchievementUnlockOverlay (full-screen) and LevelUpOverlay/WriterLevelBanner (Writer Level, this
// project's slice of it) are gone — see achievements.jsx and health-checks.jsx. The small corner
// toast (AchievementUnlockToast) is what's left to acknowledge an unlock: it still tells the
// writer what they earned without interrupting the page. project-workspace.jsx now shows it
// regardless of which tab is active, the same way it drains unlockQueue one at a time — see its
// own comment for that.
export function AchievementsTab({ achievements, project, projectId, unlockedAchievementCount }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-achievements`, style: { flex: 1, padding: '40px 40px 64px', overflowY: 'auto', display: 'flex', justifyContent: 'center' }, className: "scrollbox tab-fade" },
        React.createElement("div", { style: { width: '100%', maxWidth: 720 } },
            React.createElement("div", { style: { textAlign: 'center', marginBottom: 26 } },
                React.createElement("div", { style: { fontSize: TYPE_SCALE[22], color: '#C89B3C', opacity: 0.85, marginBottom: 6 } }, "\u2766"),
                React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[28], fontStyle: 'italic', fontWeight: 600, color: '#EFE7D2' } }, "Hall of Achievements"),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[12.5], color: '#7A7A82', marginTop: 6 } }, "Honors earned in the writing of ", project.title || 'your novel'),
                React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#C89B3C', marginTop: 8 } }, `${unlockedAchievementCount} / ${achievements.length} unlocked`)),
            ACHIEVEMENT_CATEGORIES.map((cat, gIdx) => {
                const items = achievements.filter((a) => a.group === cat.key);
                const unlockedInCat = items.filter((a) => a.unlocked).length;
                return React.createElement("div", { key: cat.key, className: "archive-section-in", style: { marginBottom: 46, '--i': gIdx } },
                    React.createElement(AchievementCategoryHeading, { icon: cat.icon, label: cat.label, unlocked: unlockedInCat, total: items.length }),
                    React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: SPACE_SCALE[12], marginTop: 18 } }, items.map((a) => React.createElement(AchievementCard, { key: a.id, achievement: a }))));
            }))));
}
