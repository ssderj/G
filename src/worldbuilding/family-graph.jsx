import React from 'react';


export function chaptersContainingCharacter(chapters, characterId) {
    return chapters.filter((c) => {
        const div = document.createElement('div');
        div.innerHTML = c.text || '';
        return Array.from(div.querySelectorAll('[data-mention-type="character"]'))
            .some((el) => el.getAttribute('data-mention-id') === characterId);
    }).map((c) => ({ id: c.id, title: c.title }));
}


export function relationshipsForCharacter(characterId, characters, relationships, autoEdges) {
    const byId = (id) => characters.find((c) => c.id === id);
    const manual = relationships
        .filter((r) => r.fromId === characterId || r.toId === characterId)
        .map((r) => {
        const otherId = r.fromId === characterId ? r.toId : r.fromId;
        const other = byId(otherId);
        return { otherId, otherName: (other === null || other === void 0 ? void 0 : other.name) || 'Unnamed', label: r.label, kind: 'manual' };
    });
    const auto = autoEdges
        .filter((e) => e.source === characterId || e.target === characterId)
        .map((e) => {
        const otherId = e.source === characterId ? e.target : e.source;
        const other = byId(otherId);
        return { otherId, otherName: (other === null || other === void 0 ? void 0 : other.name) || 'Unnamed', label: `mentioned together in ${e.weight} chapter${e.weight > 1 ? 's' : ''}`, kind: 'auto' };
    })
        .filter((e) => !manual.some((m) => m.otherId === e.otherId)); // manual label takes priority
    return [...manual, ...auto].filter((r) => byId(r.otherId));
}


// ---------- Shared family/genealogy graph ----------
// A single source of truth (project.relationships, the same array behind the Relationship Web)
// also drives both family trees: the per-character tree and the World Bible house/clan tree.
// Any relationship can optionally carry a `familyKind`. The three original kinds ('parent',
// 'spouse', 'sibling') are joined by a richer set of presets (mother/father/son/daughter/husband/
// wife/brother/sister/grandparent/grandchild/uncle-aunt/cousin/adoptive-parent/adopted-child) —
// see FAMILY_RELATIONSHIP_TYPES below, which maps each preset onto one of these underlying kinds.
export const FAMILY_RELATIONSHIP_TYPES = [
    { value: 'parent', label: 'Parent of', familyKind: 'parent' },
    { value: 'mother', label: 'Mother of', familyKind: 'parent' },
    { value: 'father', label: 'Father of', familyKind: 'parent' },
    { value: 'child', label: 'Child of', familyKind: 'child' },
    { value: 'son', label: 'Son of', familyKind: 'child' },
    { value: 'daughter', label: 'Daughter of', familyKind: 'child' },
    { value: 'spouse', label: 'Spouse of', familyKind: 'spouse' },
    { value: 'husband', label: 'Husband of', familyKind: 'spouse' },
    { value: 'wife', label: 'Wife of', familyKind: 'spouse' },
    { value: 'sibling', label: 'Sibling of', familyKind: 'sibling' },
    { value: 'brother', label: 'Brother of', familyKind: 'sibling' },
    { value: 'sister', label: 'Sister of', familyKind: 'sibling' },
    { value: 'grandparent', label: 'Grandparent of', familyKind: 'grandparent' },
    { value: 'grandchild', label: 'Grandchild of', familyKind: 'grandchild' },
    { value: 'uncle', label: 'Uncle of', familyKind: 'auncle' },
    { value: 'aunt', label: 'Aunt of', familyKind: 'auncle' },
    { value: 'cousin', label: 'Cousin of', familyKind: 'cousin' },
    { value: 'adoptiveParent', label: 'Adoptive Parent of', familyKind: 'adoptiveParent' },
    { value: 'adoptedChild', label: 'Adopted Child of', familyKind: 'adoptedChild' },
];


export function familyTypeMeta(value) {
    return FAMILY_RELATIONSHIP_TYPES.find((t) => t.value === value) || null;
}


export function buildFamilyGraph(relationships) {
    const parentsOf = {}, childrenOf = {}, spousesOf = {}, siblingsOf = {};
    const grandparentsOf = {}, grandchildrenOf = {}, unclesAuntsOf = {}, niblingsOf = {}, cousinsOf = {};
    const push = (map, key, val) => {
        if (!map[key])
            map[key] = [];
        if (map[key].indexOf(val) === -1)
            map[key].push(val);
    };
    relationships.forEach((r) => {
        if (!r.fromId || !r.toId)
            return;
        const kind = r.familyKind;
        if (kind === 'parent' || kind === 'adoptiveParent') {
            push(childrenOf, r.fromId, r.toId);
            push(parentsOf, r.toId, r.fromId);
        }
        else if (kind === 'child' || kind === 'adoptedChild') {
            // Inverse of 'parent': fromId is the child, toId is the parent.
            push(childrenOf, r.toId, r.fromId);
            push(parentsOf, r.fromId, r.toId);
        }
        else if (kind === 'spouse') {
            push(spousesOf, r.fromId, r.toId);
            push(spousesOf, r.toId, r.fromId);
        }
        else if (kind === 'sibling') {
            push(siblingsOf, r.fromId, r.toId);
            push(siblingsOf, r.toId, r.fromId);
        }
        else if (kind === 'grandparent') {
            push(grandchildrenOf, r.fromId, r.toId);
            push(grandparentsOf, r.toId, r.fromId);
        }
        else if (kind === 'grandchild') {
            push(grandchildrenOf, r.toId, r.fromId);
            push(grandparentsOf, r.fromId, r.toId);
        }
        else if (kind === 'auncle') {
            push(niblingsOf, r.fromId, r.toId);
            push(unclesAuntsOf, r.toId, r.fromId);
        }
        else if (kind === 'cousin') {
            push(cousinsOf, r.fromId, r.toId);
            push(cousinsOf, r.toId, r.fromId);
        }
    });
    return { parentsOf, childrenOf, spousesOf, siblingsOf, grandparentsOf, grandchildrenOf, unclesAuntsOf, niblingsOf, cousinsOf };
}


export function familyKindTag(r) {
    if (r.familyKind === 'parent' || r.familyKind === 'adoptiveParent')
        return 'parent \u2192 child';
    if (r.familyKind === 'child' || r.familyKind === 'adoptedChild')
        return 'child \u2192 parent';
    if (r.familyKind === 'spouse')
        return 'spouse';
    if (r.familyKind === 'sibling')
        return 'sibling';
    if (r.familyKind === 'grandparent')
        return 'grandparent \u2192 grandchild';
    if (r.familyKind === 'grandchild')
        return 'grandchild \u2192 grandparent';
    if (r.familyKind === 'auncle')
        return 'uncle/aunt \u2192 niece/nephew';
    if (r.familyKind === 'cousin')
        return 'cousin';
    return '';
}


// Every character reachable from startId by walking parent/child/spouse/sibling edges — their whole family.
export function familyComponent(startId, graph) {
    const seen = new Set();
    const queue = [startId];
    while (queue.length) {
        const id = queue.shift();
        if (seen.has(id))
            continue;
        seen.add(id);
        const neighbors = [].concat(graph.parentsOf[id] || [], graph.childrenOf[id] || [], graph.spousesOf[id] || [], graph.siblingsOf[id] || [], graph.grandparentsOf[id] || [], graph.grandchildrenOf[id] || [], graph.unclesAuntsOf[id] || [], graph.niblingsOf[id] || [], graph.cousinsOf[id] || []);
        neighbors.forEach((n) => { if (!seen.has(n))
            queue.push(n); });
    }
    return Array.from(seen);
}


// Assigns each member a generation number (0 = oldest known) by relaxing parent/child/spouse/sibling
// constraints a few passes — good enough for a story bible without needing a full layout engine.
export function computeGenerations(memberIds, graph) {
    const idSet = new Set(memberIds);
    const gen = {};
    memberIds.forEach((id) => { gen[id] = 0; });
    for (let pass = 0; pass < 8; pass++) {
        let changed = false;
        memberIds.forEach((id) => {
            (graph.parentsOf[id] || []).forEach((p) => {
                if (idSet.has(p) && gen[p] + 1 > gen[id]) {
                    gen[id] = gen[p] + 1;
                    changed = true;
                }
            });
            (graph.grandparentsOf[id] || []).forEach((p) => {
                if (idSet.has(p) && gen[p] + 2 > gen[id]) {
                    gen[id] = gen[p] + 2;
                    changed = true;
                }
            });
            (graph.unclesAuntsOf[id] || []).forEach((p) => {
                if (idSet.has(p) && gen[p] + 1 > gen[id]) {
                    gen[id] = gen[p] + 1;
                    changed = true;
                }
            });
            [].concat(graph.spousesOf[id] || [], graph.siblingsOf[id] || [], graph.cousinsOf[id] || []).forEach((o) => {
                if (idSet.has(o) && gen[o] > gen[id]) {
                    gen[id] = gen[o];
                    changed = true;
                }
            });
        });
        if (!changed)
            break;
    }
    const min = Math.min(...memberIds.map((id) => gen[id]));
    memberIds.forEach((id) => { gen[id] -= min; });
    return gen;
}


// Walks a House's parentHouseId chain upward and returns the set of ancestor ids (its parent,
// grandparent, and so on). Used to keep the cadet-branch picker from ever creating a cycle —
// a house can't be linked as a branch of its own descendant.
export function houseAncestorIds(houseId, allHouses) {
    const ids = new Set();
    let current = allHouses.find((h) => h.id === houseId);
    let guard = 0;
    while (current && current.parentHouseId && guard++ < 100) {
        if (ids.has(current.parentHouseId))
            break;
        ids.add(current.parentHouseId);
        current = allHouses.find((h) => h.id === current.parentHouseId);
    }
    return ids;
}


// Walks a Location's parentLocationId chain upward and returns the set of ancestor ids. Used to
// keep the Parent Location picker from ever creating a cycle (e.g. a Kingdom can't be set as a
// child of one of its own Cities).
export function locationAncestorIds(locationId, allLocations) {
    const ids = new Set();
    let current = allLocations.find((l) => l.id === locationId);
    let guard = 0;
    while (current && current.parentLocationId && guard++ < 100) {
        if (ids.has(current.parentLocationId))
            break;
        ids.add(current.parentLocationId);
        current = allLocations.find((l) => l.id === current.parentLocationId);
    }
    return ids;
}


// Full ancestor chain for a Location, ordered from the topmost parent down to (but not
// including) the location itself — e.g. [World, Continent, Kingdom] for a City. Powers the
// breadcrumb at the top of a location's profile.
export function locationBreadcrumbChain(locationId, allLocations) {
    const chain = [];
    const seen = new Set();
    let current = allLocations.find((l) => l.id === locationId);
    let guard = 0;
    while (current && current.parentLocationId && guard++ < 100) {
        if (seen.has(current.parentLocationId))
            break;
        const parent = allLocations.find((l) => l.id === current.parentLocationId);
        if (!parent)
            break;
        chain.unshift(parent);
        seen.add(parent.id);
        current = parent;
    }
    return chain;
}


// Preset labels offered for a Connected Locations link. Purely a suggestion list for the
// dropdown — any custom text can be typed instead, since the label is just a free string.
export const LOCATION_CONNECTION_LABELS = ['Nearby', 'Borders', 'North of', 'South of', 'Capital of', 'Inside', 'Contains', 'Connected by Road', 'Connected by River'];


// Which travel network a connection belongs to, for the Distance Calculator's road/sea/portal
// routing. A connection's descriptive label (above) is still just flavor text for people reading
// the location page — this is the separate, structured field the pathfinding actually reads.
export const CONNECTION_KINDS = [
    { value: 'road', label: 'Road \u2014 horse & foot' },
    { value: 'sea', label: 'Sea / river \u2014 ship' },
    { value: 'portal', label: 'Portal \u2014 instant' },
];


export const connectionKindLabel = (kind) => (CONNECTION_KINDS.find((k) => k.value === kind) || CONNECTION_KINDS[0]).label;


// Member count + generation count for one House & Clan entry, for the Family Trees gallery cards.
export function familyTreeStatsForHouse(house, characters, graph) {
    const tagged = characters.filter((c) => c.houseId === house.id).map((c) => c.id);
    const expanded = new Set();
    tagged.forEach((id) => familyComponent(id, graph).forEach((x) => expanded.add(x)));
    const memberIds = Array.from(expanded);
    if (memberIds.length === 0)
        return { memberIds, memberCount: 0, generationCount: 0, genById: {} };
    const genById = computeGenerations(memberIds, graph);
    const generationCount = Math.max(...memberIds.map((id) => genById[id])) + 1;
    return { memberIds, memberCount: memberIds.length, generationCount, genById };
}
