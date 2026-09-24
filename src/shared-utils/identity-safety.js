// ---------- Identity safety: reserved names + lookalike-name detection ----------
// First piece of Inkroot's anti-impersonation system. Two independent checks, both applied to
// a writer's `name` and `penName` fields (see shell/ink-root.jsx's saveProfile):
//
// 1. RESERVED NAMES (hard block) — nobody may set their name/pen name to something that reads
//    as Inkroot itself or one of its staff/moderation roles. This is what stops a scammer from
//    posing as "Inkroot Support" in a Fireside post or guild message to solicit payment outside
//    the app. Enforced by refusing to save a reserved name at all — see saveProfile.
//
// 2. LOOKALIKE NAMES (soft warning) — nobody is blocked from picking a name close to an
//    existing published author's name (that would be too blunt an instrument: real people share
//    names, and a hard block invites false-positive lockouts), but the writer is warned before
//    saving so an *accidental* collision gets caught, and a deliberate impersonation attempt at
//    least has to click past a warning naming the account it resembles — which also means any
//    report against the impersonator has a paper trail.
//
// (Server-side backstop, added later and independent of the two checks above: an EXACT match of
// another writer's display name or pen name — ignoring case and outer spaces — is now refused by
// the database itself, and reserved names are re-checked there too; see migrations 141 and 142.
// Lookalike detection is unchanged: near-matches are still only this file's soft warning.)
//
// Both checks work off a NORMALIZED form of the name (see normalizeIdentityName) so trivial
// evasions — extra spaces, mixed case, common lookalike-character substitutions ("1nkroot",
// "Inkr00t") — don't slip past a naive exact-match check.

// Confusable-character substitutions commonly used to dodge naive blocklists. Deliberately
// modest (digits/@ that visually resemble letters) rather than a full homoglyph table — the
// goal is to catch casual evasion, not to be a complete security boundary on its own (that's
// what the report system and moderation review are for).
const CONFUSABLE_MAP = {
    '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's',
};

// Lowercases, strips accents, maps confusable characters to the letter they're standing in for,
// then drops everything that isn't a letter or digit — so "Ink-Root Support!", "INKROOT  Support",
// and "1nkr00t suppOrt" all normalize to the same string and get caught by the same check.
export function normalizeIdentityName(name) {
    return String(name || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
        .toLowerCase()
        .split('')
        .map((ch) => CONFUSABLE_MAP[ch] || ch)
        .join('')
        .replace(/[^a-z0-9]/g, '');
}

// Names/handles that always belong to Inkroot itself, never to an individual writer. Matched
// after normalization, so variants and spacing don't matter.
const RESERVED_NAMES = [
    'inkroot',
    'inkrootsupport',
    'inkrootstaff',
    'inkrootteam',
    'inkrootofficial',
    'inkrootadmin',
    'inkrootmoderator',
    'inkrootmod',
    'inkrootsecurity',
    'inkroothelp',
    'support',
    'staff',
    'admin',
    'administrator',
    'moderator',
    'mod',
    'official',
    'system',
    'inkrootteamofficial',
];

// True if `name` normalizes to one of the reserved handles above. Used to hard-block saving —
// see saveProfile in shell/ink-root.jsx.
export function isReservedName(name) {
    const n = normalizeIdentityName(name);
    return n.length > 0 && RESERVED_NAMES.includes(n);
}

// Classic edit distance (insert/delete/substitute), used to measure how close two normalized
// names are. Only ever called on already-short (<=80 char) profile names, so the O(n*m) table
// here is negligible — no need for a memory-optimized rolling-row version.
function levenshteinDistance(a, b) {
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    const prev = new Array(n + 1);
    const curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,      // deletion
                curr[j - 1] + 1,  // insertion
                prev[j - 1] + cost // substitution
            );
        }
        for (let j = 0; j <= n; j++) prev[j] = curr[j];
    }
    return prev[n];
}

// How many edits still count as "suspiciously close" — scaled to name length so a 4-character
// name isn't flagged for sharing a single letter with something else, while a longer name still
// catches a one- or two-character swap ("Jonathan Reed" vs "Jonathon Reed").
function distanceThresholdFor(length) {
    if (length <= 4) return 0;   // very short names: only an exact normalized match counts
    if (length <= 9) return 1;
    return 2;
}

// Compares `candidateName` against a list of existing names (e.g. published authors) and
// returns the closest one that's suspiciously similar — either identical after normalization,
// or within the length-scaled edit-distance threshold — or null if nothing is close enough to
// warn about. `existing` is an array of { id, name } so the caller can exclude the writer's own
// existing name/account from the comparison (editing your own already-published name shouldn't
// warn you about yourself).
export function findSimilarName(candidateName, existing, { excludeId } = {}) {
    const candidate = normalizeIdentityName(candidateName);
    if (!candidate) return null;
    let best = null;
    let bestDistance = Infinity;
    for (const entry of existing || []) {
        if (!entry || !entry.name) continue;
        if (excludeId && entry.id === excludeId) continue;
        const other = normalizeIdentityName(entry.name);
        if (!other) continue;
        if (other === candidate) {
            return { name: entry.name, distance: 0 };
        }
        // Skip the expensive distance calc for pairs whose length alone rules out a close match.
        if (Math.abs(other.length - candidate.length) > distanceThresholdFor(Math.max(other.length, candidate.length)))
            continue;
        const d = levenshteinDistance(candidate, other);
        if (d <= distanceThresholdFor(Math.max(candidate.length, other.length)) && d < bestDistance) {
            best = { name: entry.name, distance: d };
            bestDistance = d;
        }
    }
    return best;
}
