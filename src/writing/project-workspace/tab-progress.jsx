import React from 'react';
import { NavScrollBox, SPACE_SCALE, TYPE_SCALE } from '../../shell/nav-context.jsx';
import { GoalCard, SectionLabel, StatCard } from '../../shared-ui/ui-cards.jsx';
import { formatClockTime, formatDuration, formatReadingTime } from '../../shared-utils/format-duration.jsx';

// Extracted unchanged from the monolithic project-workspace.jsx tab === 'progress' block — only the
// state it read is now passed in as props instead of closed over.
export function ProgressTab({ avgChapterLength, dailyGoal, projectId, sessionMinutes, sessionStart, streak, totalWords, update, weeklyGoal, weeklyWords, wordsToday }) {
    return (React.createElement(NavScrollBox, { navKey: `ws-${projectId}-progress`, style: { flex: 1, padding: '28px 40px', overflowY: 'auto' }, className: "scrollbox tab-fade" },
                React.createElement(SectionLabel, null, "Writing Progress"),
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: SPACE_SCALE[14], maxWidth: 780, marginBottom: 14 } },
                    React.createElement(StatCard, { label: "Today's words", value: wordsToday.toLocaleString(), accent: true }),
                    React.createElement(StatCard, { label: "Total words", value: totalWords.toLocaleString() }),
                    React.createElement(StatCard, { label: "Reading time", value: formatReadingTime(totalWords) }),
                    React.createElement(StatCard, { label: "Avg. chapter length", value: `${avgChapterLength.toLocaleString()} words` })),
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: SPACE_SCALE[14], maxWidth: 780, marginBottom: 14 } },
                    React.createElement(GoalCard, { label: "Today's Goal", current: wordsToday, goal: dailyGoal, color: "#C89B3C", onSetGoal: (n) => update((p) => { p.stats.dailyGoal = n; }) }),
                    React.createElement(GoalCard, { label: "Weekly Goal", current: weeklyWords, goal: weeklyGoal, color: "#7FA9C8", onSetGoal: (n) => update((p) => { p.stats.weeklyGoal = n; }) })),
                React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: SPACE_SCALE[14], maxWidth: 780 } },
                    React.createElement(StatCard, { label: "Current Streak", value: `${streak} day${streak === 1 ? '' : 's'}${streak > 0 ? ' 🔥' : ''}`, accent: streak > 0 }),
                    React.createElement(StatCard, { label: "Started writing", value: formatClockTime(sessionStart) }),
                    React.createElement(StatCard, { label: "Current session", value: formatDuration(sessionMinutes) })),
                React.createElement("div", { style: { marginTop: 22, fontSize: TYPE_SCALE[12], color: '#5C5C64', maxWidth: 560 } }, "Your streak counts consecutive days you've added new words \u2014 it won't break until a full day passes without any. The weekly goal tracks a rolling 7-day window, and the session timer resets each time you open this project. Reading time assumes about 200 words a minute.")));
}
