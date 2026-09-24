-- Migration 54: nairaWelcome ("complete your profile") — real signals for 5 of its 6 confirmed
-- criteria (a set pen name, a set avatar, a set motto, guild membership, following 3+ other
-- creators, and a successful guild-event entry), staged and ready. Deliberately NOT wired into
-- the payout path yet — see the decision at the end of this file. nairaWelcome stays exactly as
-- unbuilt/locked as it's always been until the 6th criterion (following Inkroot's official
-- Instagram account) has a real verification path; there is currently no way to check that
-- server-side (see the note below), and shipping the other 5 as sufficient on their own would
-- silently drop a requirement rather than build or flag it.
--
-- ============================================================================================
-- PART 1 — motto actually gets synced, for the first time
-- ============================================================================================
--
-- Confirmed against author-identity.jsx/ink-root.jsx before writing this: profile.motto has
-- always been edited locally (WriterIdentityCard's motto field, via onSaveProfile) but
-- saveProfile's call to syncProfile() only ever forwarded name/penName/avatar — motto never
-- reached the profiles table at all. This is the schema half of closing that gap; profile.js's
-- syncProfile() is updated in the same change to actually send it. This part ships regardless of
-- how the Instagram question above resolves — it's real, useful on its own, and every other
-- Naira achievement wiring in this migration depends on it existing.
--
-- Length cap (140) is a plain honesty-of-data-shape choice, same reasoning as pen_name/
-- display_name's 80-char cap earlier in the original table — nothing about this migration
-- depends on the exact number.

alter table profiles add column if not exists motto text check (motto is null or char_length(motto) <= 140);

-- ============================================================================================
-- PART 2 — the 5 confirmed real signals, staged as their own function, NOT yet wired to payout
-- ============================================================================================
--
-- naira_welcome_profile_signals_met() checks all 5 already-agreed, already-real criteria for the
-- calling user (auth.uid()) in one place, so wiring nairaWelcome into naira_achievement_current/
-- grant_naira_achievement/naira_achievement_progress once Instagram is resolved is a small,
-- mechanical change (call this function, AND it with the new Instagram check) rather than
-- rebuilding this logic from scratch. It is intentionally not called from anywhere in the
-- existing Tier 1/2 machinery yet — nairaWelcome is not in naira_achievement_progress's id list,
-- so it continues to report current: 0, unlocked: false exactly as it always has (see
-- computeNairaAchievements() in health-checks.jsx, which already treats "not in the progress
-- map" as "leave it locked").

create or replace function naira_welcome_profile_signals_met()
returns boolean
language sql stable security definer set search_path = public as $$
  select
    coalesce(nullif(trim(p.pen_name), ''), null) is not null
    and coalesce(nullif(trim(p.avatar_url), ''), null) is not null
    and coalesce(nullif(trim(p.motto), ''), null) is not null
    and exists (
      select 1 from player_guild_members m where m.user_id = auth.uid()
      union all
      select 1 from founder_guild_members m where m.user_id = auth.uid()
    )
    and (select count(distinct followee_id) from follows where follower_id = auth.uid()) >= 3
    and exists (
      select 1 from guild_event_entries e where e.entrant_id = auth.uid() and e.status = 'success'
    )
  from profiles p where p.id = auth.uid();
$$;

revoke all on function naira_welcome_profile_signals_met() from public;
grant execute on function naira_welcome_profile_signals_met() to authenticated;

-- ============================================================================================
-- NOT IN THIS MIGRATION — "follow the official Inkroot Instagram account", and therefore
-- nairaWelcome's actual payout wiring
-- ============================================================================================
-- Explicitly decided: ship the 5 verified criteria above now (they're real and useful — the
-- motto sync in particular closes a gap that existed independent of this achievement), but hold
-- nairaWelcome itself locked/ungrantable until Instagram has a real verification path. Adding it
-- to naira_achievement_current/grant_naira_achievement/naira_achievement_progress happens in a
-- follow-up migration once that's resolved — it isn't done here specifically so this achievement
-- can never be granted on 5 of its 6 agreed criteria while silently skipping the 6th.
--
-- There is no existing Instagram integration anywhere in this codebase to build on (checked —
-- zero references to Instagram/social links of any kind before this migration). More
-- importantly, this isn't just "expensive," the way the writing/reading signals in migration 53
-- were — it may not be checkable at all through Instagram's standard public API surface.
-- Instagram's Graph API lets a Business/Creator account see and manage things about ITSELF
-- (its own posts, its own followers list) once its owner completes Meta's app-review process;
-- it does not expose a general "does arbitrary user X follow account Y" lookup to third-party
-- apps. The only route that's actually real:
--   1. Inkroot's own Instagram account would need to be a Business/Creator account connected to
--      a Meta App that's passed Meta's review for the relevant permission.
--   2. Each writer would need to complete an Instagram Login OAuth consent flow in this app,
--      linking their own IG account.
--   3. The backend would then check whether that writer's IG user id appears in Inkroot's own
--      followers list via the Graph API.
-- That is a real, meaningfully-sized integration (a Meta app review, an OAuth flow, a new
-- linked-account concept in this schema), not a one-migration addition.
