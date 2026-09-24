import React from 'react';


export function truncate(text, n) {
    if (!text)
        return '';
    return text.length > n ? text.slice(0, n).trim() + '…' : text;
}


// ---------- Writing stats (word count, reading time, streaks — no AI) ----------
export function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}


export function todayKey() { return dateKey(new Date()); }
