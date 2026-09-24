import React from 'react';


// "47 minutes", "1h 12m"
export function formatDuration(mins) {
    const m = Math.max(0, Math.round(mins));
    if (m < 60)
        return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.floor(m / 60), rem = m % 60;
    return rem ? `${h}h ${rem}m` : `${h}h`;
}


// "12:05 PM"
export function formatClockTime(d) {
    let h = d.getHours();
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    if (h === 0)
        h = 12;
    return `${h}:${m} ${ampm}`;
}


export function formatReadingTime(words) {
    const mins = Math.round(words / 200); // ~200 wpm average adult reading speed
    if (mins < 1)
        return '< 1 min';
    if (mins < 60)
        return `${mins} min`;
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? `${h}h ${m}m` : `${h}h`;
}


// Renders a timestamp as "2 hours ago", "just now", "3 days ago", etc.
export function formatRelativeTime(ts) {
    if (!ts)
        return '';
    const diffMs = Date.now() - ts;
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24)
        return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7)
        return `${days} day${days === 1 ? '' : 's'} ago`;
    const weeks = Math.floor(days / 7);
    if (weeks < 5)
        return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
    const months = Math.floor(days / 30);
    if (months < 12)
        return `${months} month${months === 1 ? '' : 's'} ago`;
    const years = Math.floor(days / 365);
    return `${years} year${years === 1 ? '' : 's'} ago`;
}
