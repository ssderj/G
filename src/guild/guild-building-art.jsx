import React from 'react';
import { RADIUS_SCALE, SPACE_SCALE, TYPE_SCALE } from '../shell/nav-context.jsx';


// ---------- Guild Building Art ----------
// Each of the ten Founder Guilds reads as a real, distinct place — a castle, a manor, a spire,
// a gothic hall, a carnival tent — rather than a shared card with a swapped emoji. Every shape
// below is assembled from the same small vocabulary of parts (a wall, a roof, a glowing window,
// a drifting particle field) so the code stays one shared renderer, but the *combination* — the
// silhouette, the wall/roof material, the window color, the one signature detail (a banner, a
// vine, a beacon, a striped tent, a lit rose window) and the particle drifting past it (embers,
// petals, stardust, fog, rain, confetti, falling leaves) — is different for every guild, which is
// what actually reads as "a different building" rather than a different paint job on one box.
//
// GUILD_ATMOSPHERES is the single source of truth both this file and the Guild Hall itself read
// from: GuildBuildingScene (used on the Founder Guild picker below) and GuildHallAtmosphere (used
// once a writer is standing inside a Guild — see home-screen.jsx) both key off the same guildId,
// so the Hall a writer lands in is built from the same palette, materials, and mood as the
// building they picked it from, instead of the two drifting out of sync over time.
export const GUILD_ATMOSPHERES = {
    fantasy: {
        shape: 'castle', label: 'The Fantasy Guild',
        sky: ['#1B1710', '#241C12'], wall: '#4A3B26', wallDark: '#2E2416', roof: '#5C4A36', roofDark: '#3A2E1E',
        glow: '#F2CE7A', glowSoft: 'rgba(242,206,122,0.4)', accent: '#C89B3C',
        particle: 'ember', particleColor: '#F2A65A',
        mood: 'Torchlit stone and banners on the wind.',
    },
    romance: {
        shape: 'manor', label: 'The Romance Guild',
        sky: ['#231421', '#2E1A28'], wall: '#5C3A42', wallDark: '#38222A', roof: '#3E2530', roofDark: '#281620',
        glow: '#F2B6C6', glowSoft: 'rgba(242,182,198,0.38)', accent: '#D9A6B0',
        particle: 'petal', particleColor: '#E8A9BC',
        mood: 'Warm lamplight and climbing roses.',
    },
    scifi: {
        shape: 'spire', label: 'The Science Fiction Guild',
        sky: ['#0E1420', '#141C2C'], wall: '#2C3440', wallDark: '#1A2028', roof: '#39424E', roofDark: '#232830',
        glow: '#7FE0E8', glowSoft: 'rgba(127,224,232,0.32)', accent: '#7FC7CE',
        particle: 'stardust', particleColor: '#BFEFF2',
        mood: 'Cool starlight over polished steel.',
    },
    historical: {
        shape: 'hall', label: 'The Historical Guild',
        sky: ['#1E1A10', '#241F14'], wall: '#6B5A3E', wallDark: '#453A28', roof: '#7A6748', roofDark: '#4E4029',
        glow: '#E8C87A', glowSoft: 'rgba(232,200,122,0.35)', accent: '#C4A462',
        particle: 'motes', particleColor: '#E8D9AE',
        mood: 'Sunlit stone and old parchment.',
    },
    horror: {
        shape: 'gothic', label: 'The Horror Guild',
        sky: ['#12140F', '#171A13'], wall: '#3A3E36', wallDark: '#22251F', roof: '#282C24', roofDark: '#181B15',
        glow: '#9FCB9A', glowSoft: 'rgba(159,203,154,0.26)', accent: '#7C9678',
        particle: 'fog', particleColor: 'rgba(159,180,159,0.32)',
        mood: 'Fog-wrapped and dimly lit.',
    },
    mystery: {
        shape: 'noir', label: 'The Mystery Guild',
        sky: ['#12161C', '#181D24'], wall: '#33393F', wallDark: '#1E2226', roof: '#272C31', roofDark: '#181B1E',
        glow: '#E8C468', glowSoft: 'rgba(232,196,104,0.32)', accent: '#8A96A4',
        particle: 'drizzle', particleColor: 'rgba(180,196,214,0.42)',
        mood: 'Rain-slicked streets, one lit window.',
    },
    comedy: {
        shape: 'tent', label: 'The Comedy Guild',
        sky: ['#221408', '#2C1A0C'], wall: '#7A3B2E', wallDark: '#4E241A', roof: '#B8443A', roofDark: '#7A2A22',
        glow: '#F2CE7A', glowSoft: 'rgba(242,206,122,0.4)', accent: '#E8C468',
        particle: 'confetti', particleColor: '#E8A24A',
        mood: "String lights and a ringmaster's grin.",
    },
    worldbuilders: {
        shape: 'observatory', label: 'The Worldbuilders Guild',
        sky: ['#0E1522', '#131C2E'], wall: '#2E3A4A', wallDark: '#1B2430', roof: '#3E4E60', roofDark: '#26313E',
        glow: '#A8C8E8', glowSoft: 'rgba(168,200,232,0.32)', accent: '#8FB2D6',
        particle: 'stardust', particleColor: '#CFE4F4',
        mood: 'A dome full of unmapped stars.',
    },
    poetry: {
        shape: 'cottage', label: 'The Poetry Guild',
        sky: ['#101C1A', '#152420'], wall: '#4A3B26', wallDark: '#2E2416', roof: '#3E5C4A', roofDark: '#26382C',
        glow: '#F2CE7A', glowSoft: 'rgba(242,206,122,0.35)', accent: '#8FB89A',
        particle: 'leaf', particleColor: '#8FB89A',
        mood: 'A quiet cottage, one candle lit.',
    },
    general: {
        shape: 'guildhall', label: 'The General Writers Guild',
        sky: ['#181410', '#201A12'], wall: '#4A3B26', wallDark: '#2E2416', roof: '#5C4A36', roofDark: '#3A2E1E',
        glow: '#F2CE7A', glowSoft: 'rgba(242,206,122,0.4)', accent: '#C89B3C',
        particle: 'ember', particleColor: '#E8A65A',
        mood: 'Timber and hearth-smoke, doors open to all.',
    },
};


// A self-founded or joined Player Guild has no preset architecture (its crest and name are the
// writer's own) — it gets the same warm, neutral hall the General Writers Guild does rather than
// inventing an eleventh look for a "guild" that isn't really a place of its own.
export const GUILD_ATMOSPHERE_DEFAULT = GUILD_ATMOSPHERES.general;


export function guildAtmosphereFor(id) {
    return GUILD_ATMOSPHERES[id] || GUILD_ATMOSPHERE_DEFAULT;
}


// Which guild's entrance transition (see GuildHallAtmosphere's `justEntered`) has already played,
// persisted the same way most one-time "seen this before" flags in Inkroot are (a small
// localStorage key checked once on mount) — so the "stepping through the door" bloom plays once,
// the moment a writer actually arrives in a new Guild Hall, and never again for that same guild
// (including after closing and reopening the app), but does play again if they later join a
// different one.
export const GUILD_ENTERED_KEY = 'inkroot:guildHall:enteredGuildId';


export function readEnteredGuildId() {
    try {
        return localStorage.getItem(GUILD_ENTERED_KEY) || null;
    }
    catch (e) {
        return null;
    }
}


export function writeEnteredGuildId(id) {
    try {
        localStorage.setItem(GUILD_ENTERED_KEY, id || '');
    }
    catch (e) { }
}


// ---------- Shared parts ----------
function GbWindow({ left, bottom, width, height, glow, radius, delay }) {
    return React.createElement("div", { className: "gb-window", style: {
            position: 'absolute', left, bottom, width, height, borderRadius: radius || 1,
            background: `radial-gradient(circle, ${glow}, ${glow}66 70%, transparent 100%)`,
            boxShadow: `0 0 7px ${glow}`, animationDelay: `${delay || 0}s`,
        } });
}


function GbBanner({ left, top, colors, delay }) {
    return React.createElement("div", { style: { position: 'absolute', left, top } },
        React.createElement("div", { className: "gb-flag", style: {
                width: 10, height: 14, background: `linear-gradient(180deg, ${colors[0]}, ${colors[1]})`,
                clipPath: 'polygon(0 0, 100% 0, 100% 70%, 50% 100%, 0 70%)', animationDelay: `${delay || 0}s`,
            } }));
}


// One drifting particle field per building — the type controls both the shape/motion class and
// (for the wide, low ones like fog/drizzle) roughly where it sits, so "fog" reads as ground mist
// and "stardust" reads as sky motes rather than every type using the same rising-ember path.
function GbParticles({ type, color, count }) {
    const n = count || 9;
    const items = Array.from({ length: n });
    const wide = type === 'fog';
    return React.createElement("div", { style: { position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' } },
        items.map((_, i) => {
            const left = `${(i * 97) % 100}%`;
            const delay = `${(i * 0.55).toFixed(2)}s`;
            const dur = `${(3.4 + (i % 5) * 0.9).toFixed(1)}s`;
            if (type === 'fog')
                return React.createElement("span", { key: i, className: "gb-p-fog", style: {
                        position: 'absolute', left: `${(i * 41) % 130 - 15}%`, bottom: `${20 + (i * 11) % 40}px`,
                        width: 46, height: 8, background: color, animationDelay: delay, animationDuration: `${(6 + (i % 4)).toFixed(1)}s`,
                    } });
            if (type === 'drizzle')
                return React.createElement("span", { key: i, className: "gb-p-drizzle", style: {
                        position: 'absolute', left, top: '-6%', width: 1, height: 14, background: color,
                        animationDelay: delay, animationDuration: `${(1.1 + (i % 3) * 0.2).toFixed(1)}s`,
                    } });
            if (type === 'confetti')
                return React.createElement("span", { key: i, className: "gb-p-confetti", style: {
                        position: 'absolute', left, top: '-4%', width: 4, height: 4,
                        background: i % 2 ? color : '#E8C468', animationDelay: delay, animationDuration: dur,
                    } });
            if (type === 'leaf')
                return React.createElement("span", { key: i, className: "gb-p-leaf", style: {
                        position: 'absolute', left, top: '-4%', width: 6, height: 5, borderRadius: '60% 10%',
                        background: color, animationDelay: delay, animationDuration: `${(5 + (i % 4)).toFixed(1)}s`,
                    } });
            if (type === 'petal')
                return React.createElement("span", { key: i, className: "gb-p-petal", style: {
                        position: 'absolute', left, top: '-4%', width: 5, height: 4, borderRadius: '60% 10%',
                        background: color, animationDelay: delay, animationDuration: `${(5.5 + (i % 4) * 0.8).toFixed(1)}s`,
                    } });
            if (type === 'stardust')
                return React.createElement("span", { key: i, className: "gb-p-stardust", style: {
                        position: 'absolute', left, top: `${(i * 23) % 55}%`, width: 2, height: 2, borderRadius: '50%',
                        background: color, animationDelay: delay, animationDuration: `${(2.2 + (i % 4) * 0.5).toFixed(1)}s`,
                    } });
            if (type === 'motes')
                return React.createElement("span", { key: i, className: "gb-p-motes", style: {
                        position: 'absolute', left, bottom: '48px', width: 2, height: 2, borderRadius: '50%',
                        background: color, animationDelay: delay, animationDuration: `${(5 + (i % 5)).toFixed(1)}s`,
                    } });
            // ember (default) — small glowing points rising from the ground, e.g. a hearth or torches
            return React.createElement("span", { key: i, className: "gb-p-ember", style: {
                    position: 'absolute', left, bottom: '48px', width: 3, height: 3, borderRadius: '50%',
                    background: color, boxShadow: `0 0 5px ${color}`, animationDelay: delay, animationDuration: dur,
                } });
        }));
}


// ---------- Building shapes ----------
// Each takes the guild's own atmosphere palette and returns the silhouette + windows + one
// signature detail. Ground/sky/particles are added once by GuildBuildingScene around whichever
// of these renders, so every shape only needs to describe what makes it *that* building.
function ShapeCastle({ p }) {
    return React.createElement(React.Fragment, null,
        // two flanking turrets with conical caps
        [-58, 58].map((x) => React.createElement("div", { key: x, style: { position: 'absolute', left: `calc(50% + ${x}px)`, bottom: 40 } },
            React.createElement("div", { style: { width: 22, height: 58, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } }),
            React.createElement("div", { style: { position: 'absolute', top: -16, left: -3, width: 0, height: 0, borderLeft: '14px solid transparent', borderRight: '14px solid transparent', borderBottom: `18px solid ${p.roof}` } }),
            React.createElement(GbWindow, { left: 7, bottom: 30, width: 8, height: 10, glow: p.glow, delay: x === -58 ? 0.2 : 0.9 }))),
        // central keep
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 60, height: 74, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', top: -20, left: 6, right: 6, height: 0, borderLeft: '14px solid transparent', borderRight: '14px solid transparent', borderBottom: `22px solid ${p.roofDark}` } }),
            React.createElement(GbWindow, { left: '50%', bottom: 44, width: 12, height: 16, glow: p.glow, radius: '6px 6px 0 0', delay: 0.5 }),
            React.createElement(GbWindow, { left: 10, bottom: 10, width: 7, height: 9, glow: p.glow, delay: 1.3 }),
            React.createElement(GbWindow, { left: 43, bottom: 10, width: 7, height: 9, glow: p.glow, delay: 0.1 })),
        // the great door
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 16, height: 20, borderRadius: '8px 8px 0 0', background: p.roofDark, border: `1px solid ${p.wallDark}` } }),
        // a banner over the gate, stirring in the wind
        React.createElement(GbBanner, { left: 'calc(50% - 5px)', top: 44, colors: [p.accent, p.roofDark] }));
}
function ShapeManor({ p }) {
    return React.createElement(React.Fragment, null,
        // a wide manor body with a soft, sloped roofline and two dormer windows
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 96, height: 56, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}`, borderRadius: '3px 3px 0 0' } },
            React.createElement("div", { style: { position: 'absolute', top: -18, left: -6, right: -6, height: 0, borderLeft: '54px solid transparent', borderRight: '54px solid transparent', borderBottom: `20px solid ${p.roof}` } }),
            [-30, -3, 30].map((x, i) => React.createElement(GbWindow, { key: x, left: `calc(50% + ${x}px)`, bottom: 12, width: 12, height: 16, glow: p.glow, radius: '6px 6px 0 0', delay: i * 0.6 })),
            React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 18, height: 24, borderRadius: '9px 9px 0 0', background: p.roofDark, border: `1px solid ${p.wallDark}` } })),
        // a small chimney with a soft curl of smoke
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% + 32px)', bottom: 88, width: 7, height: 14, background: p.wallDark } }),
        React.createElement("div", { className: 'gb-smoke', style: { position: 'absolute', left: 'calc(50% + 35px)', bottom: 102, width: 6, height: 6, borderRadius: '50%', background: 'rgba(230,220,224,0.3)' } }),
        // climbing rose vines up the corner of the manor
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% - 48px)', bottom: 40, width: 3, height: 46, background: 'linear-gradient(180deg, #6E8A5C, #4A6640)', borderRadius: 2 } }),
        [8, 20, 32, 42].map((y, i) => React.createElement("div", { key: y, className: 'gb-p-stardust', style: { position: 'absolute', left: 'calc(50% - 51px)', bottom: 40 + y, width: 4, height: 4, borderRadius: '50%', background: p.glow, animationDuration: `${2.4 + i * 0.3}s`, animationDelay: `${i * 0.4}s` } })));
}
function ShapeSpire({ p }) {
    return React.createElement(React.Fragment, null,
        // a low base structure
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 70, height: 26, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement(GbWindow, { left: 8, bottom: 8, width: 46, height: 4, glow: p.glow, radius: 2, delay: 0 })),
        // a tall, tapered spire rising above it
        React.createElement("div", { style: {
                position: 'absolute', left: '50%', bottom: 64, width: 0, height: 0, transform: 'translateX(-50%)',
                borderLeft: '18px solid transparent', borderRight: '18px solid transparent', borderBottom: `86px solid ${p.roof}`,
                filter: `drop-shadow(0 0 10px ${p.glowSoft})`,
            } }),
        // horizontal light-strips running up the spire, evenly spaced
        [14, 34, 54, 72].map((y, i) => React.createElement("div", { key: y, className: 'gb-window', style: {
                position: 'absolute', left: '50%', bottom: 64 + y, transform: 'translateX(-50%)',
                width: 16 - i * 3, height: 2, background: p.glow, boxShadow: `0 0 6px ${p.glow}`, borderRadius: 1,
                animationDelay: `${i * 0.4}s`,
            } })),
        // a beacon at the tip
        React.createElement("div", { className: 'gb-window', style: { position: 'absolute', left: '50%', bottom: 148, transform: 'translateX(-50%)', width: 4, height: 4, borderRadius: '50%', background: p.glow, boxShadow: `0 0 10px ${p.glow}` } }));
}
function ShapeHall({ p }) {
    return React.createElement(React.Fragment, null,
        // a wide, symmetrical stone hall with a triangular pediment, like an old academy
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 100, height: 50, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', top: -18, left: -2, right: -2, height: 0, borderLeft: '52px solid transparent', borderRight: '52px solid transparent', borderBottom: `18px solid ${p.roof}` } }),
            // a row of pillars
            [-38, -22, -6, 10, 26].map((x) => React.createElement("div", { key: x, style: { position: 'absolute', left: `calc(50% + ${x}px)`, bottom: 0, width: 6, height: 44, background: `linear-gradient(180deg, ${p.roof}, ${p.roofDark})` } })),
            React.createElement(GbWindow, { left: 40, bottom: 30, width: 10, height: 6, glow: p.glow, delay: 0.4 })),
        // a wide, low step leading up to the entrance
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 36, width: 110, height: 5, background: p.roofDark, opacity: 0.6 } }),
        // a slanted shaft of light falling across the steps, with dust motes drifting through it
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-60px) rotate(8deg)', top: 20, width: 30, height: 90, background: `linear-gradient(180deg, ${p.glowSoft}, transparent)`, opacity: 0.5, pointerEvents: 'none' } }));
}
function ShapeGothic({ p }) {
    return React.createElement(React.Fragment, null,
        // a crooked manor with an asymmetrical, jagged roofline
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%) rotate(-1deg)', bottom: 40, width: 70, height: 64, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', top: -30, left: 6, width: 0, height: 0, borderLeft: '10px solid transparent', borderRight: '10px solid transparent', borderBottom: `32px solid ${p.roofDark}` } }),
            React.createElement("div", { style: { position: 'absolute', top: -20, left: 34, width: 0, height: 0, borderLeft: '16px solid transparent', borderRight: '6px solid transparent', borderBottom: `22px solid ${p.roof}` } }),
            React.createElement("div", { className: 'gb-window gb-window-flicker', style: { position: 'absolute', left: 24, bottom: 26, width: 10, height: 14, borderRadius: '50% 50% 0 0', background: `radial-gradient(circle, ${p.glow}, ${p.glow}44 70%, transparent)`, boxShadow: `0 0 8px ${p.glow}` } })),
        // a leaning, narrow tower beside it
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% - 48px)', bottom: 40, width: 16, height: 78, transform: 'rotate(-3deg)', transformOrigin: 'bottom center', background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', top: -14, left: -2, width: 0, height: 0, borderLeft: '10px solid transparent', borderRight: '10px solid transparent', borderBottom: `16px solid ${p.roofDark}` } })),
        // a bare, gnarled tree in silhouette
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% + 46px)', bottom: 40, width: 4, height: 30, background: '#181A15' } }),
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% + 40px)', bottom: 64, width: 20, height: 14, borderLeft: '2px solid #181A15', borderTop: '2px solid #181A15', transform: 'rotate(-20deg)' } }));
}
function ShapeNoir({ p }) {
    return React.createElement(React.Fragment, null,
        // a flat-roofed brownstone
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 74, height: 70, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            [[10, 46], [30, 46], [50, 46], [10, 20], [50, 20]].map(([x, y], i) => React.createElement(GbWindow, { key: i, left: x, bottom: y, width: 9, height: 11, glow: i === 1 ? p.glow : '#3A3E44', delay: i * 0.3 })),
            React.createElement("div", { style: { position: 'absolute', left: 26, bottom: 0, width: 20, height: 22, background: p.roofDark, border: `1px solid ${p.wallDark}` } })),
        // a single lantern swinging over the entrance
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(6px)', top: 30, width: 1, height: 16, background: p.roofDark } }),
        React.createElement("div", { className: 'gb-lantern-swing', style: { position: 'absolute', left: '50%', top: 44, transformOrigin: 'top center' } },
            React.createElement("div", { style: { width: 8, height: 10, borderRadius: 2, background: `radial-gradient(circle, ${p.glow}, ${p.glow}55 70%, transparent)`, boxShadow: `0 0 10px ${p.glow}` } })),
        // a faint spotlight beam raking across the wall
        React.createElement("div", { style: { position: 'absolute', left: '30%', bottom: 40, width: 46, height: 60, background: `linear-gradient(15deg, transparent, ${p.glowSoft}, transparent)`, opacity: 0.35, pointerEvents: 'none' } }));
}
function ShapeTent({ p }) {
    return React.createElement(React.Fragment, null,
        // a striped big-top pavilion
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 96, height: 40, overflow: 'hidden', borderRadius: '50% 50% 0 0 / 100% 100% 0 0' } },
            React.createElement("div", { style: { position: 'absolute', inset: 0, background: `repeating-linear-gradient(90deg, ${p.wall} 0 10px, ${p.roof} 10px 20px)` } })),
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-3px)', bottom: 76, width: 3, height: 18, background: p.roofDark } }),
        React.createElement(GbBanner, { left: 'calc(50% - 3px)', top: -2, colors: [p.accent, p.wallDark], delay: 0.4 }),
        // string lights along the tent's edge, twinkling
        Array.from({ length: 7 }).map((_, i) => React.createElement("div", { key: i, className: 'gb-window gb-window-flicker', style: {
                position: 'absolute', left: `calc(50% - 42px + ${i * 14}px)`, bottom: 38 - Math.abs(i - 3) * 2,
                width: 5, height: 5, borderRadius: '50%', background: p.glow, boxShadow: `0 0 6px ${p.glow}`,
                animationDelay: `${i * 0.2}s`,
            } })),
        // the entrance flap
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 16, height: 20, background: p.wallDark, borderRadius: '8px 8px 0 0' } }));
}
function ShapeObservatory({ p }) {
    return React.createElement(React.Fragment, null,
        // a squat tower topped with a dome
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 46, height: 54, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement(GbWindow, { left: 17, bottom: 12, width: 12, height: 14, glow: p.glow, radius: '6px 6px 0 0', delay: 0.3 })),
        React.createElement("div", { className: 'gb-dome-turn', style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 92, width: 50, height: 25, borderRadius: '50% 50% 0 0', overflow: 'hidden', background: `linear-gradient(180deg, ${p.roof}, ${p.roofDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', left: 6, top: 4, width: 8, height: 16, background: p.wallDark, transform: 'rotate(-20deg)' } })),
        // a telescope aimed up through a slit in the dome
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%) rotate(-32deg)', bottom: 110, width: 4, height: 26, background: p.accent, transformOrigin: 'bottom center', borderRadius: 2 } }),
        // wing buildings either side
        [-38, 38].map((x) => React.createElement("div", { key: x, style: { position: 'absolute', left: `calc(50% + ${x}px)`, bottom: 40, width: 20, height: 28, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement(GbWindow, { left: 6, bottom: 8, width: 8, height: 10, glow: p.glow, delay: x > 0 ? 0.7 : 0.1 }))));
}
function ShapeCottage({ p }) {
    return React.createElement(React.Fragment, null,
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 54, height: 34, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { className: 'gb-window gb-window-flicker', style: { position: 'absolute', left: 20, bottom: 8, width: 14, height: 16, borderRadius: '7px 7px 0 0', background: `radial-gradient(circle, ${p.glow}, ${p.glow}55 70%, transparent)`, boxShadow: `0 0 9px ${p.glow}` } }),
            React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 12, height: 16, borderRadius: '6px 6px 0 0', background: p.roofDark } })),
        // a thick, textured thatched roof
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 70, width: 70, height: 0, borderLeft: '35px solid transparent', borderRight: '35px solid transparent', borderBottom: `26px solid ${p.roof}` } }),
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 68, width: 74, height: 5, background: p.roofDark, opacity: 0.7 } }),
        // ivy climbing the near wall
        React.createElement("div", { style: { position: 'absolute', left: 'calc(50% - 30px)', bottom: 40, width: 3, height: 30, background: 'linear-gradient(180deg, #6E8A5C, #4A6640)', borderRadius: 2 } }));
}
function ShapeGuildhall({ p }) {
    return React.createElement(React.Fragment, null,
        // a broad, timber-framed hall
        React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 40, width: 90, height: 50, background: `linear-gradient(180deg, ${p.wall}, ${p.wallDark})`, border: `1px solid ${p.roofDark}` } },
            React.createElement("div", { style: { position: 'absolute', top: -22, left: -4, right: -4, height: 0, borderLeft: '49px solid transparent', borderRight: '49px solid transparent', borderBottom: `22px solid ${p.roof}` } }),
            // exposed timber cross-bracing
            React.createElement("div", { style: { position: 'absolute', inset: 4, border: `1px solid ${p.roofDark}`, opacity: 0.5 } }),
            React.createElement(GbWindow, { left: 12, bottom: 12, width: 14, height: 14, glow: p.glow, radius: '7px 7px 0 0', delay: 0.2 }),
            React.createElement(GbWindow, { left: 64, bottom: 12, width: 14, height: 14, glow: p.glow, radius: '7px 7px 0 0', delay: 0.9 }),
            React.createElement("div", { style: { position: 'absolute', left: '50%', transform: 'translateX(-50%)', bottom: 0, width: 16, height: 24, borderRadius: '8px 8px 0 0', background: p.roofDark } })),
        // twin banners flanking the entrance
        React.createElement(GbBanner, { left: 'calc(50% - 26px)', top: 30, colors: [p.accent, p.roofDark], delay: 0 }),
        React.createElement(GbBanner, { left: 'calc(50% + 18px)', top: 30, colors: [p.accent, p.roofDark], delay: 0.6 }));
}


const SHAPES = {
    castle: ShapeCastle, manor: ShapeManor, spire: ShapeSpire, hall: ShapeHall, gothic: ShapeGothic,
    noir: ShapeNoir, tent: ShapeTent, observatory: ShapeObservatory, cottage: ShapeCottage, guildhall: ShapeGuildhall,
};


// A single guild's building, fully self-contained (sky, ground, silhouette, particles) — used on
// the Founder Guild picker (see GuildWelcomeScreen in guild-hall.jsx). `compact` sizes it for a
// grid card; the default size matches the Hall's own establishing shot (see GuildHallAtmosphere).
export function GuildBuildingScene({ guildId, compact, className }) {
    const p = guildAtmosphereFor(guildId);
    const Shape = SHAPES[p.shape] || ShapeGuildhall;
    const height = compact ? 118 : 150;
    return React.createElement("div", { className, style: {
            position: 'relative', height, overflow: 'hidden', borderRadius: RADIUS_SCALE[12],
            background: `linear-gradient(180deg, ${p.sky[0]} 0%, ${p.sky[1]} 70%, ${p.wallDark} 100%)`,
            border: `1px solid ${p.roofDark}`,
        } },
        React.createElement(GbParticles, { type: p.particle, color: p.particleColor, count: compact ? 7 : 10 }),
        React.createElement("div", { style: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 40, background: `linear-gradient(180deg, ${p.wallDark}, #000)`, opacity: 0.7 } }),
        React.createElement(Shape, { p }),
        React.createElement("div", { className: "gb-vignette", style: { position: 'absolute', inset: 0, pointerEvents: 'none', background: `radial-gradient(ellipse at 50% 65%, transparent 40%, rgba(0,0,0,0.45) 100%)` } }));
}


// Wraps whatever's inside the Guild Hall in that guild's own background, lighting, and mood —
// the same palette and materials GuildBuildingScene drew the building from, so stepping inside
// reads as walking into that specific place rather than the Hall just getting a tinted filter.
// A soft particle field keeps drifting behind the Hall's own content (the same signature ember/
// petal/stardust/fog/etc. the building outside had), and `justEntered` plays a brief warm bloom
// from the guild's own glow color on mount — the "stepping through the door" beat — rather than a
// generic fade, without touching anything about the Hall's actual content or layout underneath.
export function GuildHallAtmosphere({ guildId, justEntered, children }) {
    const p = guildAtmosphereFor(guildId);
    return React.createElement("div", { className: justEntered ? "gb-hall-enter" : undefined, style: {
            position: 'relative', borderRadius: RADIUS_SCALE[18],
            background: `linear-gradient(180deg, ${p.sky[0]} 0%, #17171B 340px)`,
            boxShadow: `inset 0 1px 0 ${p.glowSoft}`,
        } },
        React.createElement(GuildBuildingArtStyles, null),
        React.createElement("div", { style: { position: 'absolute', top: 0, left: 0, right: 0, height: 340, overflow: 'hidden', borderRadius: `${RADIUS_SCALE[18]}px ${RADIUS_SCALE[18]}px 0 0`, pointerEvents: 'none' } },
            React.createElement(GbParticles, { type: p.particle, color: p.particleColor, count: 10 }),
            React.createElement("div", { style: { position: 'absolute', inset: 0, background: `radial-gradient(ellipse at 50% 0%, ${p.glowSoft}, transparent 60%)`, opacity: 0.55 } })),
        justEntered && React.createElement("div", { className: "gb-hall-bloom", style: { position: 'absolute', inset: 0, borderRadius: RADIUS_SCALE[18], background: p.glow, pointerEvents: 'none' } }),
        React.createElement("div", { style: { position: 'relative', paddingTop: 4 } }, children));
}


// The small "you are stepping into <mood>" caption shown once on the Founder Guild join button,
// and reused as the first line inside the Hall itself so the two moments read as one place.
export function GuildMoodCaption({ guildId, style }) {
    const p = guildAtmosphereFor(guildId);
    return React.createElement("div", { style: Object.assign({ fontSize: TYPE_SCALE[11], color: p.accent, fontStyle: 'italic' }, style) }, p.mood);
}


// ---------- Founder Guild Heraldic Crest (Guild Hero Card) ----------
// The crest shown at the top of a Founder Guild's banner in the Guild Hall (the "Guild Hero
// Card") — a single engraved seal, not a building scene: a crown, a heater shield, a laurel
// wreath, and a hanging banner of cloth behind it, all in one antique-gold-on-charcoal
// composition. Every Founder Guild shares this exact frame (crown, wreath, banner, shield
// border) — only the emblem engraved into the shield's face changes, so the ten guilds read as
// the same order of official seals rather than ten differently-colored badges. The Fantasy
// Guild alone gets the dragon-head sigil; every other guild gets its own emblem below, but none
// of them borrow Fantasy's. This intentionally does not touch GuildBuildingScene above — that
// remains the animated building art used on the Founder Guild picker; this is only for the
// banner a writer sees once they've actually taken a seat in a Founder Guild.
const CREST_GOLD_LIGHT = '#F2CE7A';
const CREST_GOLD_MID = '#C89B3C';
const CREST_GOLD_DARK = '#8A6B2E';
const CREST_SHIELD_DARK = '#15110B';


const CREST_SHIELD_OUTER = 'M 64 92 L 156 92 L 156 156 Q 156 198 110 230 Q 64 198 64 156 Z';
const CREST_SHIELD_INNER = 'M 70 98 L 150 98 L 150 154 Q 150 190 110 218 Q 70 190 70 154 Z';


const CREST_WREATH_LEFT = [
    { cx: 60, cy: 208, rot: -25 }, { cx: 52, cy: 188, rot: -10 }, { cx: 48, cy: 166, rot: 5 },
    { cx: 49, cy: 144, rot: 20 }, { cx: 54, cy: 124, rot: 35 },
];
const CREST_WREATH_RIGHT = [
    { cx: 160, cy: 208, rot: 25 }, { cx: 168, cy: 188, rot: 10 }, { cx: 172, cy: 166, rot: -5 },
    { cx: 171, cy: 144, rot: -20 }, { cx: 166, cy: 124, rot: -35 },
];


// The shield's central sigil, one per Founder Guild, drawn in local coordinates around (0,0) —
// the caller wraps this in a <g transform="translate(110,160)">. Kept to simple engraved-line
// shapes (not a painting) so every guild's emblem reads at the same weight and finish as the
// crown and wreath around it.
function crestEmblemChildren(guildId, gold) {
    const g = `url(#${gold})`;
    switch (guildId) {
        case 'fantasy':
            return [
                React.createElement("path", { key: "head", d: "M -20 6 C -22 -6 -10 -18 6 -16 C 18 -15 25 -8 24 -1 C 23 5 17 8 11 6 C 13 10 11 14 7 13 L 6 7 C 1 9 -6 9 -12 6 L -13 13 L -18 13 L -17 6 C -19 7 -20 7 -20 6 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("path", { key: "horn", d: "M 2 -16 L 6 -25 L 10 -15 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.5 }),
                React.createElement("circle", { key: "eye", cx: 13, cy: -4, r: 1.6, fill: CREST_SHIELD_DARK }),
                React.createElement("path", { key: "nostril", d: "M 22 -2 L 26 -1 L 24 2 Z", fill: CREST_GOLD_DARK }),
            ];
        case 'romance':
            return [
                ...[0, 72, 144, 216, 288].map((a, i) => {
                    const rad = a * Math.PI / 180;
                    const cx = +(7 * Math.cos(rad)).toFixed(2), cy = +(7 * Math.sin(rad)).toFixed(2);
                    return React.createElement("ellipse", { key: "petal" + i, cx, cy, rx: 9, ry: 5, fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.4, transform: `rotate(${a} ${cx} ${cy})` });
                }),
                React.createElement("circle", { key: "center", cx: 0, cy: 0, r: 3, fill: CREST_GOLD_DARK }),
                React.createElement("ellipse", { key: "leafL", cx: -9, cy: 15, rx: 6, ry: 3, fill: g, transform: "rotate(-35 -9 15)" }),
                React.createElement("ellipse", { key: "leafR", cx: 9, cy: 15, rx: 6, ry: 3, fill: g, transform: "rotate(35 9 15)" }),
                React.createElement("line", { key: "stem", x1: 0, y1: 18, x2: 0, y2: 24, stroke: CREST_GOLD_MID, strokeWidth: 2 }),
            ];
        case 'scifi':
            return [
                React.createElement("path", { key: "star", d: "M 0 -22 L 5 -6 L 22 0 L 5 6 L 0 22 L -5 6 L -22 0 L -5 -6 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("circle", { key: "hub", cx: 0, cy: 0, r: 4, fill: "none", stroke: CREST_GOLD_DARK, strokeWidth: 1.2 }),
            ];
        case 'historical':
            return [
                React.createElement("path", { key: "feather", d: "M -14 -18 C -4 -18 8 -8 13 4 C 15 9 11 12 7 9 C -3 2 -12 -8 -14 -18 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("line", { key: "nib", x1: 13, y1: 4, x2: 20, y2: 16, stroke: CREST_GOLD_MID, strokeWidth: 2 }),
                React.createElement("line", { key: "v1", x1: -10, y1: -14, x2: -2, y2: -6, stroke: CREST_GOLD_DARK, strokeWidth: 0.6, opacity: 0.7 }),
                React.createElement("line", { key: "v2", x1: -6, y1: -10, x2: 2, y2: -2, stroke: CREST_GOLD_DARK, strokeWidth: 0.6, opacity: 0.7 }),
                React.createElement("rect", { key: "scroll", x: -15, y: 15, width: 16, height: 6, rx: 3, fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.5 }),
            ];
        case 'horror':
            return [
                React.createElement("path", { key: "moon", d: "M 8 -20 A 14 14 0 1 0 8 8 A 10 10 0 1 1 8 -20 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.5 }),
                React.createElement("path", { key: "raven", d: "M -16 16 Q -8 8 0 14 Q 8 8 16 16 Q 8 12 0 18 Q -8 12 -16 16 Z", fill: CREST_GOLD_DARK, opacity: 0.9 }),
            ];
        case 'mystery':
            return [
                React.createElement("circle", { key: "glass", cx: -3, cy: -5, r: 11, fill: "none", stroke: g, strokeWidth: 3 }),
                React.createElement("line", { key: "handle", x1: 5, y1: 3, x2: 17, y2: 15, stroke: g, strokeWidth: 4, strokeLinecap: "round" }),
            ];
        case 'comedy':
            return [
                React.createElement("ellipse", { key: "maskL", cx: -9, cy: 0, rx: 8, ry: 10, fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("ellipse", { key: "maskR", cx: 9, cy: 0, rx: 8, ry: 10, fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("circle", { key: "eL1", cx: -12, cy: -3, r: 1.3, fill: CREST_SHIELD_DARK }),
                React.createElement("circle", { key: "eL2", cx: -6, cy: -3, r: 1.3, fill: CREST_SHIELD_DARK }),
                React.createElement("circle", { key: "eR1", cx: 6, cy: -3, r: 1.3, fill: CREST_SHIELD_DARK }),
                React.createElement("circle", { key: "eR2", cx: 12, cy: -3, r: 1.3, fill: CREST_SHIELD_DARK }),
                React.createElement("path", { key: "mouthHappy", d: "M -14 5 Q -9 10 -4 5", stroke: CREST_SHIELD_DARK, strokeWidth: 1.2, fill: "none" }),
                React.createElement("path", { key: "mouthSad", d: "M 4 7 Q 9 2 14 7", stroke: CREST_SHIELD_DARK, strokeWidth: 1.2, fill: "none" }),
            ];
        case 'worldbuilders':
            return [
                React.createElement("circle", { key: "globe", cx: 0, cy: 0, r: 17, fill: "none", stroke: g, strokeWidth: 2 }),
                React.createElement("ellipse", { key: "eq", cx: 0, cy: 0, rx: 17, ry: 5.5, fill: "none", stroke: g, strokeWidth: 1.2 }),
                React.createElement("ellipse", { key: "mer", cx: 0, cy: 0, rx: 5.5, ry: 17, fill: "none", stroke: g, strokeWidth: 1.2 }),
                React.createElement("line", { key: "tN", x1: 0, y1: -21, x2: 0, y2: -17, stroke: g, strokeWidth: 1.4 }),
                React.createElement("line", { key: "tS", x1: 0, y1: 17, x2: 0, y2: 21, stroke: g, strokeWidth: 1.4 }),
                React.createElement("line", { key: "tW", x1: -21, y1: 0, x2: -17, y2: 0, stroke: g, strokeWidth: 1.4 }),
                React.createElement("line", { key: "tE", x1: 17, y1: 0, x2: 21, y2: 0, stroke: g, strokeWidth: 1.4 }),
            ];
        case 'poetry':
            return [
                React.createElement("path", { key: "feather", d: "M -16 -16 C -6 -18 8 -8 13 3 C 15 8 10 11 6 8 C -6 1 -14 -7 -16 -16 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("line", { key: "nib", x1: 13, y1: 3, x2: 17, y2: 13, stroke: CREST_GOLD_MID, strokeWidth: 2 }),
                React.createElement("ellipse", { key: "rim", cx: 0, cy: 17, rx: 8, ry: 2.2, fill: g }),
                React.createElement("path", { key: "well", d: "M -7 17 L 7 17 L 5 25 L -5 25 Z", fill: CREST_GOLD_DARK, stroke: g, strokeWidth: 0.5 }),
            ];
        case 'general':
        default:
            return [
                React.createElement("path", { key: "pageL", d: "M -20 8 L -2 3 L -2 -11 L -20 -5 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("path", { key: "pageR", d: "M 20 8 L 2 3 L 2 -11 L 20 -5 Z", fill: g, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
                React.createElement("line", { key: "spine", x1: -2, y1: 3, x2: 2, y2: 3, stroke: CREST_GOLD_DARK, strokeWidth: 1 }),
                React.createElement("path", { key: "quill", d: "M -6 -14 C -2 -14 4 -9 6 -3 L 2 -1 C -1 -6 -5 -10 -8 -11 Z", fill: CREST_GOLD_DARK, opacity: 0.85 }),
            ];
    }
}


// The full seal: hanging banner cloth, laurel wreath, shield (with that guild's emblem), and a
// crown perched at the shield's peak. One shared SVG frame for every Founder Guild — see the
// comment above crestEmblemChildren for why only the emblem itself varies.
export function FounderGuildCrest({ guildId, size }) {
    const s = size || 190;
    const gid = guildId || 'general';
    const goldId = `crestGold-${gid}`, shieldId = `crestShield-${gid}`, fabricId = `crestFabric-${gid}`;
    return React.createElement("svg", { viewBox: "0 0 220 300", width: s, height: Math.round(s * 300 / 220), style: { display: 'block', overflow: 'visible' } },
        React.createElement("defs", null,
            React.createElement("linearGradient", { id: goldId, x1: "0%", y1: "0%", x2: "100%", y2: "100%" },
                React.createElement("stop", { offset: "0%", stopColor: CREST_GOLD_LIGHT }),
                React.createElement("stop", { offset: "55%", stopColor: CREST_GOLD_MID }),
                React.createElement("stop", { offset: "100%", stopColor: CREST_GOLD_DARK })),
            React.createElement("radialGradient", { id: shieldId, cx: "35%", cy: "22%", r: "78%" },
                React.createElement("stop", { offset: "0%", stopColor: "#241C11" }),
                React.createElement("stop", { offset: "100%", stopColor: CREST_SHIELD_DARK })),
            React.createElement("linearGradient", { id: fabricId, x1: "0%", y1: "0%", x2: "0%", y2: "100%" },
                React.createElement("stop", { offset: "0%", stopColor: "#241E15" }),
                React.createElement("stop", { offset: "100%", stopColor: "#120E09" }))),
        // hanging banner cloth
        React.createElement("path", { d: "M 55 6 L 165 6 L 165 172 L 140 236 L 110 200 L 80 236 L 55 172 Z", fill: `url(#${fabricId})`, stroke: CREST_GOLD_DARK, strokeWidth: 1.2, opacity: 0.96 }),
        React.createElement("line", { x1: 82, y1: 10, x2: 82, y2: 168, stroke: CREST_GOLD_DARK, strokeWidth: 0.5, opacity: 0.25 }),
        React.createElement("line", { x1: 138, y1: 10, x2: 138, y2: 168, stroke: CREST_GOLD_DARK, strokeWidth: 0.5, opacity: 0.25 }),
        React.createElement("line", { x1: 140, y1: 236, x2: 140, y2: 258, stroke: CREST_GOLD_MID, strokeWidth: 1 }),
        React.createElement("line", { x1: 80, y1: 236, x2: 80, y2: 258, stroke: CREST_GOLD_MID, strokeWidth: 1 }),
        React.createElement("rect", { x: 136, y: 256, width: 8, height: 8, fill: `url(#${goldId})`, transform: "rotate(45 140 260)" }),
        React.createElement("rect", { x: 76, y: 256, width: 8, height: 8, fill: `url(#${goldId})`, transform: "rotate(45 80 260)" }),
        // laurel wreath
        React.createElement("path", { d: "M 62 222 Q 40 175 56 118", stroke: CREST_GOLD_MID, strokeWidth: 1.6, fill: "none", opacity: 0.85 }),
        ...CREST_WREATH_LEFT.map((leaf, i) => React.createElement("ellipse", { key: "wl" + i, cx: leaf.cx, cy: leaf.cy, rx: 9, ry: 4, fill: `url(#${goldId})`, stroke: CREST_GOLD_DARK, strokeWidth: 0.4, transform: `rotate(${leaf.rot} ${leaf.cx} ${leaf.cy})` })),
        React.createElement("path", { d: "M 158 222 Q 180 175 164 118", stroke: CREST_GOLD_MID, strokeWidth: 1.6, fill: "none", opacity: 0.85 }),
        ...CREST_WREATH_RIGHT.map((leaf, i) => React.createElement("ellipse", { key: "wr" + i, cx: leaf.cx, cy: leaf.cy, rx: 9, ry: 4, fill: `url(#${goldId})`, stroke: CREST_GOLD_DARK, strokeWidth: 0.4, transform: `rotate(${leaf.rot} ${leaf.cx} ${leaf.cy})` })),
        // shield
        React.createElement("path", { d: CREST_SHIELD_OUTER, fill: `url(#${shieldId})`, stroke: `url(#${goldId})`, strokeWidth: 3.5 }),
        React.createElement("path", { d: CREST_SHIELD_INNER, fill: "none", stroke: CREST_GOLD_MID, strokeWidth: 1, opacity: 0.8 }),
        React.createElement("g", { transform: "translate(110 160)" }, ...crestEmblemChildren(gid, goldId)),
        // crown
        React.createElement("rect", { x: 84, y: 84, width: 52, height: 10, rx: 2, fill: `url(#${goldId})`, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
        React.createElement("path", { d: "M 84 84 L 84 60 L 96 76 L 110 52 L 124 76 L 136 60 L 136 84 Z", fill: `url(#${goldId})`, stroke: CREST_GOLD_DARK, strokeWidth: 0.6 }),
        React.createElement("circle", { cx: 84, cy: 60, r: 2.4, fill: CREST_GOLD_LIGHT }),
        React.createElement("circle", { cx: 110, cy: 52, r: 3, fill: CREST_GOLD_LIGHT }),
        React.createElement("circle", { cx: 136, cy: 60, r: 2.4, fill: CREST_GOLD_LIGHT }),
        React.createElement("circle", { cx: 97, cy: 89, r: 1.7, fill: CREST_SHIELD_DARK }),
        React.createElement("circle", { cx: 123, cy: 89, r: 1.7, fill: CREST_SHIELD_DARK }),
        React.createElement("circle", { cx: 110, cy: 89, r: 2, fill: CREST_SHIELD_DARK }));
}


// A small gold corner flourish for the bottom corners of the Guild Hero Card — pure ornament,
// mirrored horizontally for the opposite corner via CSS transform on the wrapper.
export function CrestCornerFlourish({ style }) {
    return React.createElement("svg", { viewBox: "0 0 60 60", width: 34, height: 34, style },
        React.createElement("path", {
            d: "M 2 58 Q 2 30 20 20 Q 32 13 30 2 M 8 52 Q 10 34 24 26 M 2 44 Q 6 40 10 40",
            fill: "none", stroke: CREST_GOLD_MID, strokeWidth: 1.4, opacity: 0.75, strokeLinecap: "round",
        }));
}


export function GuildBuildingArtStyles() {
    return React.createElement("style", null, `
      /* Windows/lanterns breathe rather than blink — a slow, uneven glow so a row of them never
         reads as synchronized Christmas lights; each instance staggers its own animation-delay. */
      @keyframes gbWindowGlow { 0%, 100% { opacity: 0.75; filter: brightness(1); } 50% { opacity: 1; filter: brightness(1.25); } }
      .gb-window { animation: gbWindowGlow 3s ease-in-out infinite; }
      .gb-window-flicker { animation-name: gbWindowFlicker; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
      @keyframes gbWindowFlicker { 0%, 100% { opacity: 0.8; } 30% { opacity: 1; } 45% { opacity: 0.55; } 70% { opacity: 0.95; } }
      @keyframes gbFlagWave { 0%, 100% { transform: skewX(0deg) scaleY(1); } 50% { transform: skewX(-8deg) scaleY(0.97); } }
      .gb-flag { animation: gbFlagWave 2.6s ease-in-out infinite; transform-origin: left center; }
      @keyframes gbSmokeDrift { 0% { transform: translate(0, 0) scale(0.6); opacity: 0; } 20% { opacity: 0.5; } 100% { transform: translate(8px, -34px) scale(1.6); opacity: 0; } }
      .gb-smoke { animation: gbSmokeDrift 4.5s ease-out infinite; }
      @keyframes gbLanternSwing { 0%, 100% { transform: rotate(-6deg); } 50% { transform: rotate(6deg); } }
      .gb-lantern-swing { animation: gbLanternSwing 3.2s ease-in-out infinite; }
      @keyframes gbDomeTurn { 0% { background-position: 0 0; } 100% { background-position: 40px 0; } }
      .gb-dome-turn { transition: none; }
      /* Particle drift, one keyframe set per signature type. */
      @keyframes gbEmberRise { 0% { transform: translateY(0) translateX(0); opacity: 0; } 15% { opacity: 1; } 100% { transform: translateY(-70px) translateX(6px); opacity: 0; } }
      .gb-p-ember { animation-name: gbEmberRise; animation-timing-function: ease-out; animation-iteration-count: infinite; }
      @keyframes gbPetalDrift { 0% { transform: translate(0, 0) rotate(0deg); opacity: 0; } 12% { opacity: 0.9; } 100% { transform: translate(-22px, 130px) rotate(140deg); opacity: 0; } }
      .gb-p-petal { animation-name: gbPetalDrift; animation-timing-function: ease-in; animation-iteration-count: infinite; }
      @keyframes gbLeafDrift { 0% { transform: translate(0, 0) rotate(0deg); opacity: 0; } 12% { opacity: 0.9; } 50% { transform: translate(14px, 65px) rotate(90deg); } 100% { transform: translate(-10px, 130px) rotate(200deg); opacity: 0; } }
      .gb-p-leaf { animation-name: gbLeafDrift; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
      @keyframes gbStardustTwinkle { 0%, 100% { opacity: 0.15; transform: scale(1); } 50% { opacity: 1; transform: scale(1.6); } }
      .gb-p-stardust { animation-name: gbStardustTwinkle; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
      @keyframes gbMotesFloat { 0% { transform: translate(0,0); opacity: 0; } 20% { opacity: 0.6; } 100% { transform: translate(10px, -40px); opacity: 0; } }
      .gb-p-motes { animation-name: gbMotesFloat; animation-timing-function: ease-in-out; animation-iteration-count: infinite; }
      @keyframes gbFogDrift { 0% { transform: translateX(0); opacity: 0; } 30% { opacity: 0.6; } 70% { opacity: 0.6; } 100% { transform: translateX(60px); opacity: 0; } }
      .gb-p-fog { animation-name: gbFogDrift; animation-timing-function: ease-in-out; animation-iteration-count: infinite; filter: blur(4px); border-radius: 50%; }
      @keyframes gbDrizzleFall { 0% { transform: translateY(0); opacity: 0; } 10% { opacity: 0.8; } 100% { transform: translateY(160px); opacity: 0; } }
      .gb-p-drizzle { animation-name: gbDrizzleFall; animation-timing-function: linear; animation-iteration-count: infinite; }
      @keyframes gbConfettiFall { 0% { transform: translate(0,0) rotate(0deg); opacity: 0; } 12% { opacity: 1; } 100% { transform: translate(18px, 130px) rotate(260deg); opacity: 0; } }
      .gb-p-confetti { animation-name: gbConfettiFall; animation-timing-function: ease-in; animation-iteration-count: infinite; }
      @media (prefers-reduced-motion: reduce) {
        .gb-window, .gb-window-flicker, .gb-flag, .gb-smoke, .gb-lantern-swing,
        .gb-p-ember, .gb-p-petal, .gb-p-leaf, .gb-p-stardust, .gb-p-motes, .gb-p-fog, .gb-p-drizzle, .gb-p-confetti {
          animation-duration: 0.01ms !important; animation-iteration-count: 1 !important;
        }
      }
      /* The brief warm bloom from the guild's own light on first stepping into its Hall — plays
         once on mount, never repeats, and never blocks the content underneath from being read or
         interacted with while it fades. */
      @keyframes gbHallBloomFade { 0% { opacity: 0.55; } 100% { opacity: 0; } }
      .gb-hall-bloom { animation: gbHallBloomFade 1100ms ease-out both; }
      @keyframes gbHallEnter { 0% { opacity: 0; transform: translateY(10px) scale(0.99); } 100% { opacity: 1; transform: translateY(0) scale(1); } }
      .gb-hall-enter { animation: gbHallEnter 620ms cubic-bezier(0.16, 1, 0.3, 1) both; }
    `);
}
