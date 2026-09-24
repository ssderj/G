import React, { createContext, useContext, useState, useRef, useEffect } from 'react';


// ---------- Universal navigation (Back button, breadcrumbs, scroll restoration) ----------
// A single history stack shared by the whole app — Home, the Grand Library, the Writer Profile,
// every Project Workspace tab, and anything nested inside them. Any screen that descends a level
// calls nav.push() with a breadcrumb label and an `undo` function that restores whatever was
// showing before. UniversalBackButton and Breadcrumbs both read this same stack, so Back always
// returns to wherever the reader actually came from (never hard-coded to Home), and the
// breadcrumb trail always matches exactly what Back will do.
export const NavContext = createContext(null);


export function useNav() {
    return useContext(NavContext);
}


// Type scale, deliberately consolidated to 8 steps (11 / 13 / 15 / 17 / 20 / 24 / 30 / 38,
// plus 6 and 46 kept as rare decorative/hero outliers). Every call site still reads
// TYPE_SCALE[N] with its original bare number as the key -- only the output pixel values
// changed, so no component code needed to change. This replaces the old literal registry
// (30+ near-duplicate sizes, most under 12px) that was the single biggest source of the
// small, busy text across the app -- see the UI clutter audit.
export const TYPE_SCALE = {
  6: 6,
  8.5: 11, 9: 11, 9.5: 11, 10: 11, 10.5: 11, 11: 11,
  11.5: 13, 12: 13, 12.5: 13, 13: 13,
  13.5: 15, 14: 15, 14.5: 15, 15: 15,
  15.5: 17, 16: 17, 17: 17,
  18: 20, 19: 20, 20: 20,
  21: 24, 22: 24, 24: 24, 25: 24, 26: 24,
  28: 30, 30: 30,
  32: 38, 34: 38, 38: 38,
  46: 46,
};


// Radius scale, consolidated to 5 real steps (4 / 8 / 12 / 16 / 20) plus the two special
// cases (100 = fully-rounded pill, 999 = circle). Same principle as TYPE_SCALE: same lookup
// keys, fewer distinct output values, so borders and corners read as one consistent family
// instead of a dozen near-identical roundings.
export const RADIUS_SCALE = {
  1: 4, 2: 4, 3: 4,
  4: 8, 5: 8, 6: 8, 7: 8, 8: 8, 9: 8,
  10: 12, 11: 12, 12: 12,
  14: 16, 15: 16, 16: 16, 18: 16,
  20: 20,
  100: 100, 999: 999,
};


// Space scale, tightened to a clean 4px-ish grid (2 / 4 / 8 / 12 / 16 / 20 / 24) so gaps and
// padding stop landing on odd, hard-to-tell-apart values like 18 vs 20 vs 22.
export const SPACE_SCALE = {
  1: 2, 2: 2,
  3: 4, 4: 4,
  5: 8, 6: 8, 7: 8, 8: 8,
  9: 12, 10: 12, 12: 12,
  14: 16, 16: 16,
  18: 20, 20: 20,
  22: 24, 24: 24,
};


export function NavigationProvider({ rootLabel, children }) {
    const [stack, setStack] = useState([{ label: rootLabel || 'Home', key: 'root' }]);
    // Scroll offsets keyed by a caller-chosen string (see NavScrollBox) so returning to a screen —
    // via Back, a breadcrumb click, or just switching tabs and back — restores exactly where the
    // reader left off instead of snapping to the top.
    const scrollPositions = useRef({});
    // Mirror this stack's depth onto the browser/device history so the hardware or edge-swipe
    // Back gesture retraces the same steps as UniversalBackButton and Breadcrumbs, instead of
    // leaving the app outright (nothing was ever pushed onto history before this) or landing on
    // a screen the in-app stack doesn't know about. Each push() adds one history entry tagged
    // with the resulting depth; pop()/goTo() drive the browser the same number of steps back
    // rather than touching history state directly, so this stays a thin mirror of the same stack
    // rather than a second, independent source of truth. The one popstate listener below is what
    // turns an external Back gesture into the same undo the in-app Back button runs — comparing
    // the depth on the entry being landed on against the current stack length makes it a no-op
    // whenever the change already came from push()/pop()/goTo() themselves, so real (external)
    // and self-driven history moves can share one handler without double-firing.
    useEffect(() => {
        if (!window.history.state || typeof window.history.state.inkNavDepth !== 'number') {
            window.history.replaceState({ inkNavDepth: 1 }, '');
        }
        const onPopState = (e) => {
            const targetDepth = (e.state && typeof e.state.inkNavDepth === 'number') ? e.state.inkNavDepth : 1;
            setStack((s) => {
                // Exact match means this popstate is the trailing echo of a push()/pop()/goTo()
                // we already applied ourselves — a genuine no-op, not a missed navigation.
                if (targetDepth === s.length)
                    return s;
                if (targetDepth > s.length) {
                    // targetDepth can only exceed the current stack here because resetTo() (see
                    // below) relabels just the CURRENT history entry when it collapses the stack,
                    // leaving every OLDER real history entry still stamped with its pre-reset
                    // depth. Landing back on one of those stale entries used to look identical to
                    // "nothing to do" (targetDepth >= s.length was one no-op condition), so Back
                    // silently did nothing — for as many taps as there were stale entries between
                    // here and wherever resetTo() was called from — instead of returning to Home.
                    // resetTo() already discarded whatever those older levels meant (the whole
                    // point of resetTo is that undoing back into them "no longer makes sense"), so
                    // the correct target for this tap is the same place resetTo() itself unwound
                    // to: run every remaining undo and land on Home. Re-stamping the entry we just
                    // arrived on with the CURRENT (correct) depth means the next stale entry, if
                    // any, resyncs the same way instead of drifting further out of step.
                    for (let i = s.length - 1; i >= 1; i--) {
                        if (s[i] && s[i].undo)
                            s[i].undo();
                    }
                    window.history.replaceState({ inkNavDepth: 1 }, '');
                    return s.slice(0, 1);
                }
                for (let i = s.length - 1; i >= targetDepth; i--) {
                    if (s[i] && s[i].undo)
                        s[i].undo();
                }
                return s.slice(0, targetDepth);
            });
        };
        window.addEventListener('popstate', onPopState);
        return () => window.removeEventListener('popstate', onPopState);
    }, []);
    const push = (entry) => {
        setStack((s) => {
            const next = [...s, { key: entry.label + ':' + s.length + ':' + Date.now(), ...entry }];
            window.history.pushState({ inkNavDepth: next.length }, '');
            return next;
        });
    };
    const pop = () => {
        setStack((s) => {
            if (s.length <= 1)
                return s;
            const leaving = s[s.length - 1];
            if (leaving.undo)
                leaving.undo();
            window.history.back();
            return s.slice(0, -1);
        });
    };
    const goTo = (index) => {
        setStack((s) => {
            if (index >= s.length - 1 || index < 0)
                return s;
            // Undo every level from the top down to (but not including) the target, so jumping
            // straight to a breadcrumb three levels up leaves state exactly as three Backs would.
            for (let i = s.length - 1; i > index; i--) {
                if (s[i].undo)
                    s[i].undo();
            }
            window.history.go(index + 1 - s.length);
            return s.slice(0, index + 1);
        });
    };
    // Swaps the current top-of-stack entry for a new one at the SAME depth — used when moving
    // directly between two sibling tabs (e.g. Guild Hall -> Grand Library) without unwinding
    // through Home first. This undoes the outgoing entry and rewrites the browser's current
    // history entry in place with replaceState (synchronous), instead of the previous approach of
    // combining an async `window.history.go(-1)` with an immediate `pushState()` right after it.
    // That combination raced the browser's own pending back-navigation against our forward push:
    // the delayed popstate for the go(-1) would land *after* the push had already completed, and
    // — mistaking the swap for a real Back — fire the new entry's own `undo` (which just sets the
    // tab back to Home), snapping the screen back to Home right after the tap looked like it
    // worked. Tapping again "fixed" it only because the stray popstate had settled by then.
    // replaceState never asks the browser to traverse history, so there's no async step to race.
    const replaceTop = (entry) => {
        setStack((s) => {
            if (s.length < 2)
                return s;
            const leaving = s[s.length - 1];
            if (leaving.undo)
                leaving.undo();
            const next = [...s.slice(0, -1), { key: entry.label + ':' + (s.length - 1) + ':' + Date.now(), ...entry }];
            window.history.replaceState({ inkNavDepth: next.length }, '');
            return next;
        });
    };
    // Used when a whole new top-level context replaces the current one outright (deleting the
    // project you're standing in, for instance) rather than descending from it — trail restarts
    // from Home instead of trying to undo a screen that no longer makes sense. Only the current
    // history entry is relabeled (not unwound step-by-step, since there's no single "undo" this
    // jump corresponds to). Real browser history entries further back keep their pre-reset depth
    // stamps, so a later Back tap can land on one of those and report a depth greater than this
    // (now-shorter) stack — the popstate handler above treats that case as "unwind the rest of
    // the way to Home" specifically so that landing there resolves in one tap instead of silently
    // no-op'ing once per stale entry.
    const resetTo = (entry) => {
        window.history.replaceState({ inkNavDepth: entry ? 2 : 1 }, '');
        setStack(entry ? [{ label: rootLabel || 'Home', key: 'root' }, entry] : [{ label: rootLabel || 'Home', key: 'root' }]);
    };
    const saveScroll = (key, top) => { scrollPositions.current[key] = top; };
    const getScroll = (key) => scrollPositions.current[key] || 0;
    const value = { stack, push, pop, goTo, resetTo, replaceTop, saveScroll, getScroll };
    return React.createElement(NavContext.Provider, { value }, children);
}


// Locks the page's own scroll while a full-screen overlay (a modal, drawer, or similar) is
// showing on top of it, so the content underneath can't still be scrolled — via wheel, touch
// drag, or arrow keys — at the same time the overlay itself scrolls. Restores whatever
// `overflow` was already set on <body> beforehand on cleanup/close, so it composes safely
// however many times it's used across the app rather than assuming it owns that style outright.
export function useBodyScrollLock(active) {
    useEffect(() => {
        if (!active)
            return;
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { document.body.style.overflow = prev; };
    }, [active]);
}


// Consistent Back button for every page in the app. Always labeled with, and always returns to,
// whatever page the reader actually came from — not a hard-coded trip to Home.
export function UniversalBackButton({ style, compact }) {
    const nav = useNav();
    if (!nav || nav.stack.length <= 1)
        return null;
    const prev = nav.stack[nav.stack.length - 2];
    return React.createElement("button", {
        onClick: () => nav.pop(), className: "ink-universal-back", title: "Back to " + prev.label,
        style: Object.assign({
            display: 'inline-flex', alignItems: 'center', gap: SPACE_SCALE[6], background: 'none',
            border: '1px solid #2A2A30', color: '#C4C4CC', borderRadius: RADIUS_SCALE[8],
            padding: compact ? '5px 10px' : '7px 13px', fontSize: compact ? 12 : 13, cursor: 'pointer',
            fontFamily: 'inherit', transition: 'border-color var(--ink-dur) var(--ink-ease), color var(--ink-dur) var(--ink-ease)',
        }, style),
    }, "\u2190 ", prev.label);
}


// Breadcrumb trail, e.g. Home › Grand Library › Book › Reviews. Every crumb but the last is
// clickable and jumps straight back to that level via nav.goTo — same restore logic Back uses.
export function Breadcrumbs({ style }) {
    const nav = useNav();
    if (!nav || nav.stack.length <= 1)
        return null;
    return React.createElement("div", { style: Object.assign({
            display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: SPACE_SCALE[4], fontSize: TYPE_SCALE[12.5],
            color: '#8A8A92', marginBottom: 14,
        }, style) },
        nav.stack.map((entry, i) => {
            const isLast = i === nav.stack.length - 1;
            return React.createElement(React.Fragment, { key: entry.key },
                i > 0 && React.createElement("span", { style: { opacity: 0.5, padding: '0 2px' } }, "\u203A"),
                React.createElement("button", {
                    onClick: () => !isLast && nav.goTo(i), disabled: isLast,
                    style: {
                        background: 'none', border: 'none', padding: '2px 3px', font: 'inherit',
                        color: isLast ? '#EFE7D2' : '#8A8A92', fontWeight: isLast ? 600 : 400,
                        cursor: isLast ? 'default' : 'pointer',
                    },
                }, entry.label));
        }));
}


// Wraps a scrollable region so its scroll position survives navigating away and back — through
// Back, a breadcrumb jump, or switching tabs and returning. `navKey` should be unique to the
// content shown (include a project/book id and tab) so different screens don't share one offset.
export function NavScrollBox({ navKey, className, style, children }) {
    const nav = useNav();
    const ref = useRef(null);
    useEffect(() => {
        const el = ref.current;
        if (!el || !nav)
            return;
        el.scrollTop = nav.getScroll(navKey);
        const onScroll = () => nav.saveScroll(navKey, el.scrollTop);
        el.addEventListener('scroll', onScroll, { passive: true });
        return () => {
            nav.saveScroll(navKey, el.scrollTop);
            el.removeEventListener('scroll', onScroll);
        };
    }, [navKey]);
    return React.createElement("div", { ref, className, style }, children);
}
