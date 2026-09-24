import React from 'react';
import { computeAuthorReputation } from '../library/author-reputation.jsx';


// REMOVED — computeMembersOnline(guild), a pure function that always returned null because there
// was no presence signal to compute from. Members Online is now real for Player Guilds: a
// Supabase Realtime Presence channel (see subscribeGuildPresence in lib/player-guild.js),
// subscribed to from home-screen.jsx and passed down as a plain onlineCount/onlineUserIds prop
// rather than something GuildBanner derives from `guild` itself — presence is inherently
// transient session state, not a property of the guild record, so it doesn't belong in this
// file's guild -> derived-number pattern the way Reputation does. Founder Guilds still show
// "not yet chronicled" (GuildBanner's own notYet check), honestly: they have no real
// player_guild_members-style roster to key a presence channel off of.


// ---------- Guild Reputation ----------
// REMOVED — Guild Level/XP (computeGuildXP/computeSharedGuildXP, computeGuildProgress/
// computeSharedGuildProgress, the whole GUILD_LEVEL_* ladder and the GUILD_HALL_STRUCTURES/
// readSeenGuildHallStage machinery that drove the Living Guild Hall's construction ceremony).
// That was a second, separate "leveling up" system layered on top of Guild Reputation — a guild
// now has exactly one standing, Reputation, same as a writer has exactly one, and it's driven the
// same way: "the members inside decide the amount of reputation it has" (as literally as Inkroot
// can currently make true — see below) rather than a guild's own bespoke XP curve.
//
// Guild Reputation reuses computeAuthorReputation's exact formula (diminishing returns, same
// per-source weighting) rather than inventing a second one, applied to the guild-wide totals
// sumGuildMemberStats already gathers — mapped onto the two Reputation sources that have a real
// live signal today: publishedCount -> publishedBook, and questsCompleted -> completedProject (a
// completed Guild Quest is a real, shared accomplishment in the same spirit as a completed
// project). This is deliberately NOT literally "sum each member's own already-computed Reputation
// number" — an individual's Reputation can itself include a guildContribution term fed BY this
// same guild total (see authors-hall-screen.jsx), so summing full member Reputation here would be
// circular. Reusing the shared totals instead keeps the causality one-directional: members'
// tracked output -> Guild Reputation -> (partially) feeds back into members' own Reputation.
// writingDayCount / firesidePostCount are accepted for backward compatibility with existing
// callers but don't contribute yet — same honesty policy as author-reputation.jsx's non-live
// sources: no real per-guild signal for either exists yet, so they stay at zero rather than being
// invented.
export function computeGuildReputation({ publishedCount = 0, questsCompleted = 0, writingDayCount = 0, firesidePostCount = 0 } = {}) {
    return computeAuthorReputation({ publishedCount, completedCount: questsCompleted });
}


// ---------- Shared (multi-member) progression ----------
// computeGuildReputation above is fed by one device's own locally-tracked activity — the only
// real accounting Inkroot could do before a guild had a real, joinable, multi-member roster to
// sum across (see schema_phase5.sql for Player Guilds; founder_guild_members, held since Phase
// 8, for Founder Guilds). Both guild types now have a real roster AND a real per-member stats
// table to sum — player_guild_members/guild_member_stats for a Player Guild,
// founder_guild_members/founder_guild_member_stats for a Founder Guild (migration 88) — so
// computeGuildReputation above is now purely the "still loading, offline, or signed out"
// fallback for either type, not a standing Founder-Guild limitation. See
// src/lib/guild-progression-remote.js for the push/fetch pair each type uses, and
// home-screen.jsx's resolveGuildReputation for which one wins once real totals have loaded.

// Reduces the raw rows fetched by fetchGuildMemberStats into the same shape computeGuildReputation's
// inputs already take, so the shared path below reuses one formula per concern instead of a
// second copy that could drift from the local one.
export function sumGuildMemberStats(rows) {
    return (rows || []).reduce((totals, row) => ({
        publishedCount: totals.publishedCount + (row.published_count || 0),
        questsCompleted: totals.questsCompleted + (row.quests_completed || 0),
        questGuildXP: totals.questGuildXP + (row.quest_guild_xp || 0),
        writingDayCount: totals.writingDayCount + (row.writing_day_count || 0),
        firesidePostCount: totals.firesidePostCount + (row.fireside_post_count || 0),
    }), { publishedCount: 0, questsCompleted: 0, questGuildXP: 0, writingDayCount: 0, firesidePostCount: 0 });
}


// Same formula as computeGuildReputation, applied to guild-wide totals — questsCompleted here is
// the sum of every member's own completed-quest count, which is real, separate completions (each
// writer completes Guild Quests on their own account), not one quest double-counted.
export function computeSharedGuildReputation(totals) {
    return computeGuildReputation(totals);
}


// ---------- Guild Rank ----------
// REMOVED — a duplicate GUILD_REPUTATION_TITLES ladder used to live here too. guild-reputation-
// panel.jsx already has one (GUILD_RANK_TIERS / guildRankForReputation), wired to GuildReputationPanel
// and its honest per-source breakdown (GUILD_REPUTATION_SOURCES) — that one is Guild Rank now,
// rather than introducing a second, redundant one next to it.
