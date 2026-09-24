import React from 'react';
import { TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- Reading Settings (manuscript reader) ----------
// Stored separately from any one project — these are reading preferences for this device/reader,
// not part of the manuscript data, so they apply the same way across every project opened here.
export const READING_SETTINGS_KEY = 'inkroot:readingSettings:v1';


export const DEFAULT_READING_SETTINGS = {
    fontFamily: 'serif', // 'serif' | 'sans' | 'mono'
    fontSize: TYPE_SCALE[18],
    lineSpacing: 2.05,
    paragraphSpacing: 1, // em added below each paragraph
    pageWidth: 'medium', // 'narrow' | 'medium' | 'wide'
    textAlign: 'left', // 'left' | 'justify'
    theme: 'dark', // 'light' | 'sepia' | 'dark'
    showChapterTitle: true,
    immersive: false,
};


export function loadReadingSettings() {
    try {
        const raw = localStorage.getItem(READING_SETTINGS_KEY);
        if (!raw)
            return { ...DEFAULT_READING_SETTINGS };
        return { ...DEFAULT_READING_SETTINGS, ...JSON.parse(raw) };
    }
    catch (e) {
        return { ...DEFAULT_READING_SETTINGS };
    }
}


// ---------- Sound Effects (achievement unlocks) ----------
// Small, synthesized fantasy-flavored stingers for each achievement rarity, generated on the fly
// with the Web Audio API rather than shipped as audio files — that keeps them working fully
// offline like the rest of the app and adds no network weight. Every sound is short and quiet by
// design (a celebratory accent, not a game-show fanfare) and gated entirely behind the toggle
// below: nothing ever plays unless sound is explicitly turned on, and any failure to play (no
// Web Audio support, a blocked AudioContext, etc.) is swallowed silently rather than surfaced,
// since a missing sound effect should never look like an error to the writer.
export const SOUND_SETTINGS_KEY = 'inkroot:soundSettings:v1';


export const DEFAULT_SOUND_SETTINGS = { enabled: true };


export function loadSoundSettings() {
    try {
        const raw = localStorage.getItem(SOUND_SETTINGS_KEY);
        if (!raw)
            return { ...DEFAULT_SOUND_SETTINGS };
        return { ...DEFAULT_SOUND_SETTINGS, ...JSON.parse(raw) };
    }
    catch (e) {
        return { ...DEFAULT_SOUND_SETTINGS };
    }
}


export function saveSoundSettings(next) {
    try {
        localStorage.setItem(SOUND_SETTINGS_KEY, JSON.stringify(next));
    }
    catch (e) { }
}


// Created lazily on first playback attempt — browsers won't let a page start an AudioContext
// before a user gesture has happened somewhere on it — and reused after that rather than spun up
// fresh per sound.
export let sharedAudioCtx = null;


export function getAudioCtx() {
    if (sharedAudioCtx)
        return sharedAudioCtx;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx)
        return null;
    try {
        sharedAudioCtx = new Ctx();
    }
    catch (e) {
        sharedAudioCtx = null;
    }
    return sharedAudioCtx;
}


// One soft plucked note: quick attack, exponential decay, optional upward/downward glide and
// detune — the building block every rarity's stinger below is assembled from.
export function pluckTone(ctx, dest, { freq, start, dur, type = 'sine', peak = 0.2, glideTo = null, detune = 0 }) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo)
        osc.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    if (detune)
        osc.detune.setValueAtTime(detune, start);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(peak, start + Math.min(0.02, dur * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(dest);
    osc.start(start);
    osc.stop(start + dur + 0.05);
}


// A brief burst of filtered noise, used only for Legendary's low "hit" so it reads as a
// percussive thump rather than another pitched note.
export function noiseHit(ctx, dest, { start, dur, peak = 0.2, filterFreq = 300 }) {
    const bufferSize = Math.max(1, Math.ceil(ctx.sampleRate * dur));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++)
        data[i] = (Math.random() * 2 - 1) * (1 - i / bufferSize);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(filterFreq, start);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, start);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    src.connect(filter).connect(gain).connect(dest);
    src.start(start);
    src.stop(start + dur + 0.05);
}


// Per-rarity note recipes, mirroring the escalating spectacle of RARITY_UNLOCK_FX above: Common
// is a single soft chime, Uncommon a brighter two-note bell, Rare a quick metallic flourish, Epic
// a shimmering high cluster, and Legendary a deep hit followed by a trailing sparkle of notes —
// timed to land under the badge spring and then keep going alongside the drifting embers.
export const RARITY_SOUND_FX = {
    common: (ctx, dest, t0) => {
        pluckTone(ctx, dest, { freq: 880, start: t0, dur: 0.5, type: 'sine', peak: 0.18 });
    },
    uncommon: (ctx, dest, t0) => {
        pluckTone(ctx, dest, { freq: 987.77, start: t0, dur: 0.7, type: 'sine', peak: 0.2 });
        pluckTone(ctx, dest, { freq: 1479.98, start: t0 + 0.02, dur: 0.6, type: 'sine', peak: 0.12 });
    },
    rare: (ctx, dest, t0) => {
        [783.99, 987.77, 1174.66].forEach((freq, i) => {
            pluckTone(ctx, dest, { freq, start: t0 + i * 0.07, dur: 0.35, type: 'triangle', peak: 0.16 });
        });
        pluckTone(ctx, dest, { freq: 2349.32, start: t0 + 0.21, dur: 0.4, type: 'sine', peak: 0.1 });
    },
    epic: (ctx, dest, t0) => {
        [1046.5, 1318.51, 1567.98, 2093].forEach((freq, i) => {
            pluckTone(ctx, dest, { freq, start: t0 + i * 0.05, dur: 0.8 - i * 0.08, type: 'sine', peak: 0.11, detune: i * 6 });
        });
    },
    legendary: (ctx, dest, t0) => {
        pluckTone(ctx, dest, { freq: 98, start: t0, dur: 0.9, type: 'sine', peak: 0.3, glideTo: 80 });
        pluckTone(ctx, dest, { freq: 196, start: t0, dur: 0.6, type: 'triangle', peak: 0.14 });
        noiseHit(ctx, dest, { start: t0, dur: 0.35, peak: 0.22, filterFreq: 220 });
        [1567.98, 1975.53, 2349.32, 2793.83, 3135.96].forEach((freq, i) => {
            pluckTone(ctx, dest, { freq, start: t0 + 0.32 + i * 0.11, dur: 0.7 - i * 0.05, type: 'sine', peak: 0.09, detune: (i % 2 ? 8 : -8) });
        });
    },
};


// Plays the stinger for a given achievement rarity, respecting the writer's sound setting. Does
// nothing — quietly — if sound is off, Web Audio isn't available, or scheduling the notes throws
// for any reason.
export function playAchievementSound(rarity) {
    try {
        if (!loadSoundSettings().enabled)
            return;
        const ctx = getAudioCtx();
        if (!ctx)
            return;
        if (ctx.state === 'suspended')
            ctx.resume().catch(() => { });
        const master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
        const fx = RARITY_SOUND_FX[rarity] || RARITY_SOUND_FX.common;
        fx(ctx, master, ctx.currentTime);
    }
    catch (e) { /* sound is a nice-to-have; never let it break the unlock moment */ }
}


export const READING_FONT_STACKS = {
    serif: "'Fraunces', Georgia, serif",
    sans: "'Inter', ui-sans-serif, -apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace",
};


export const READING_PAGE_WIDTHS = { narrow: 560, medium: 720, wide: 920 };


export const READING_PAGE_WIDTH_ORDER = ['narrow', 'medium', 'wide'];


export const READING_THEMES = {
    // panel intentionally equals bg in every theme — the toolbar, the Reading Settings modal,
    // and the manuscript background must all be the exact same color so nothing reads as a
    // mismatched "leftover" shade when the theme is switched.
    // `link` and `selection` round out the set so every themed surface (body text, headings,
    // links, blockquotes, text selection) is driven from this one table instead of scattered
    // hard-coded hex values that only ever matched the dark theme.
    light: { bg: '#FFFFFF', text: '#1A1A1A', muted: '#6B6B6B', border: '#E0E0E0', panel: '#FFFFFF', link: '#8A5A2B', selection: '#C89B3C40' },
    sepia: { bg: '#F5ECD9', text: '#4A3B2A', muted: '#8A7458', border: '#C9AE84', panel: '#F5ECD9', link: '#7A4A22', selection: '#8A5A2B40' },
    dark: { bg: '#121212', text: '#F2F2F2', muted: '#A0A0A0', border: '#333333', panel: '#121212', link: '#DCC38A', selection: '#C89B3C55' },
};
