import React, { useState, useEffect } from 'react';
import { checkInToday, fetchCheckInsForMonth } from '../lib/check-ins.js';
import { InkIcon } from '../shell/ink-icon.jsx';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

function ymd(year, month, day) {
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// A real, server-verified daily check-in — distinct from the client-derived per-project
// "writing streak" in writing/project-workspace/tab-progress.jsx. See lib/check-ins.js and
// supabase/history/94_migration_official_badge_and_checkins.sql. Only meaningful for the
// signed-in writer's own Hall — render this conditionally on `isSelf` the same way the Naira
// Rewards section above it already is.
export function CheckInCalendarCard() {
    const today = new Date();
    const [cursor, setCursor] = useState({ year: today.getFullYear(), month: today.getMonth() + 1 });
    const [days, setDays] = useState(null); // null while loading; Set<'YYYY-MM-DD'> once loaded
    const [streak, setStreak] = useState(null);
    const [checkingIn, setCheckingIn] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setDays(null);
        fetchCheckInsForMonth(cursor.year, cursor.month).then((result) => { if (!cancelled) setDays(result || new Set()); });
        return () => { cancelled = true; };
    }, [cursor.year, cursor.month]);

    const todayKey = ymd(today.getFullYear(), today.getMonth() + 1, today.getDate());
    const alreadyCheckedInToday = days && days.has(todayKey);

    const handleCheckIn = () => {
        if (checkingIn || alreadyCheckedInToday) return;
        setCheckingIn(true);
        checkInToday().then((result) => {
            setCheckingIn(false);
            if (!result) return;
            setStreak(result.currentStreak);
            setDays((prev) => new Set([...(prev || []), todayKey]));
        });
    };

    const firstWeekday = new Date(cursor.year, cursor.month - 1, 1).getDay();
    const daysInMonth = new Date(cursor.year, cursor.month, 0).getDate();
    const isCurrentMonth = cursor.year === today.getFullYear() && cursor.month === today.getMonth() + 1;
    const cells = [];
    for (let i = 0; i < firstWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);

    return React.createElement("div", { style: {
            background: 'linear-gradient(160deg, #1F1B12, #17140F)', border: '1px solid #2E2A1E',
            borderRadius: RADIUS_SCALE[12], padding: '18px 18px 20px',
        } },
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 } },
            React.createElement("button", {
                onClick: () => setCursor((c) => (c.month === 1 ? { year: c.year - 1, month: 12 } : { year: c.year, month: c.month - 1 })),
                "aria-label": "Previous month",
                style: { background: 'none', border: 'none', color: '#7A7A82', cursor: 'pointer', fontSize: TYPE_SCALE[16], padding: 4 },
            }, "\u2039"),
            React.createElement("div", { style: { fontFamily: "'Fraunces', Georgia, serif", fontSize: TYPE_SCALE[14], color: '#EFE7D2' } },
                new Date(cursor.year, cursor.month - 1, 1).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })),
            React.createElement("button", {
                onClick: () => setCursor((c) => (c.month === 12 ? { year: c.year + 1, month: 1 } : { year: c.year, month: c.month + 1 })),
                "aria-label": "Next month", disabled: isCurrentMonth,
                style: { background: 'none', border: 'none', color: isCurrentMonth ? '#3A3A40' : '#7A7A82', cursor: isCurrentMonth ? 'default' : 'pointer', fontSize: TYPE_SCALE[16], padding: 4 },
            }, "\u203A")),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 } },
            WEEKDAY_LABELS.map((w, i) => React.createElement("div", { key: i, style: { textAlign: 'center', fontSize: TYPE_SCALE[10], color: '#5C5C64', letterSpacing: '0.04em' } }, w))),
        React.createElement("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 } },
            cells.map((d, i) => {
                if (d === null) return React.createElement("div", { key: i });
                const key = ymd(cursor.year, cursor.month, d);
                const checked = days && days.has(key);
                const isToday = isCurrentMonth && d === today.getDate();
                return React.createElement("div", { key: i, style: {
                        aspectRatio: '1', display: 'flex', alignItems: 'center', justifyContent: 'center',
                        borderRadius: RADIUS_SCALE[6], fontSize: TYPE_SCALE[11.5],
                        background: checked ? 'rgba(200,155,60,0.16)' : 'transparent',
                        border: isToday ? '1px solid #C89B3C' : '1px solid transparent',
                        color: checked ? '#C89B3C' : '#8A8A92',
                    } }, checked ? React.createElement(InkIcon, { name: "starFilled", size: 12 }) : d);
            })),
        React.createElement("div", { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, gap: SPACE_SCALE[10] } },
            streak !== null && React.createElement("div", { style: { fontSize: TYPE_SCALE[11.5], color: '#5C5C64' } },
                React.createElement(InkIcon, { name: "flame", size: 12, style: { verticalAlign: '-2px', marginRight: 4 } }),
                `${streak} day${streak === 1 ? '' : 's'}`),
            React.createElement("button", {
                onClick: handleCheckIn, disabled: checkingIn || !!alreadyCheckedInToday,
                style: {
                    marginLeft: 'auto', background: alreadyCheckedInToday ? 'none' : '#C89B3C',
                    border: alreadyCheckedInToday ? '1px solid #3A3020' : 'none',
                    color: alreadyCheckedInToday ? '#7A7A82' : '#17140F',
                    borderRadius: RADIUS_SCALE[10], padding: '8px 16px', fontSize: TYPE_SCALE[12.5], fontWeight: 600,
                    cursor: alreadyCheckedInToday ? 'default' : 'pointer', fontFamily: 'inherit',
                },
            }, alreadyCheckedInToday ? "Checked in today" : (checkingIn ? "Checking in\u2026" : "Check in today"))));
}
