import React from 'react';


// ---------- Guild feedback (local-only today, shaped for a shared service later) ----------
// Feedback guildmates leave on a book published to the Guild — kept as a list per book (not a
// single value, like a personal rating is) so it reads as a thread. Only this device's writer
// exists today, so in practice this is "your own notes on your own guild book" until Inkroot has
// a real shared guild service — GuildBookshelf and GuildBookFeedbackModal say so honestly. The
// shape (an array of { author, stars, note, at }) is exactly what a real multi-member feed would
// need, so nothing here has to change once one exists — new entries just start arriving from
// other members alongside the ones already saved.
export const LIBRARY_GUILD_FEEDBACK_KEY = 'inkroot:library:guildFeedback';


export function readGuildFeedback() {
    try {
        return JSON.parse(localStorage.getItem(LIBRARY_GUILD_FEEDBACK_KEY) || '{}');
    }
    catch (e) {
        return {};
    }
}


export function writeGuildFeedback(map) {
    try {
        localStorage.setItem(LIBRARY_GUILD_FEEDBACK_KEY, JSON.stringify(map));
    }
    catch (e) { }
}
