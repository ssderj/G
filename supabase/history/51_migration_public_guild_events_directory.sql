-- ============================================================================================
-- Migration 51: list_public_guild_events() / get_public_guild_profile() — the read path Living
-- Universe's Guild Events, Guilds on the Rise, and Best/Most-Read cards all need to link a reader
-- straight to the guild that hosted them, without exposing anything player_guilds' own
-- owner/member-scoped RLS keeps private (invite_code above all).
--
-- guild_events itself already has an "anyone can read" policy (see 42_migration_guild_events.sql)
-- — the actual gap is that a non-member has no RLS-safe way to resolve guild_events.guild_id into
-- a guild_name/crest_url to show, and no way to know how full an event's entrant list is (same
-- gap guild_event_entry_count() closed for a single event — see
-- 46_migration_guild_event_entry_count.sql). Both functions below are the same narrow,
-- security-definer bypass shape as admin_list_guilds()/admin_list_pending_guild_events(): each
-- returns strictly less than the table(s) it reads, and neither ever returns invite_code.
--
-- "Approved and published" is deliberately not just approval_status = 'published' — an event
-- that has since gone 'active' (open for entry) or 'completed' (wrapped up) was published at some
-- point along the way and never un-published, so a reader browsing Living Universe should still
-- see it. This mirrors fetchGuildEvents()'s own default filter in lib/guild-events.js exactly:
-- ('published', 'active', 'completed'). A 'draft', 'pending_approval', 'rejected', or merely
-- 'approved'-but-not-yet-published row never reaches this function, same as it never reaches a
-- guild's own public event list.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. list_public_guild_events — every approved-and-published (or later) Guild Event across every
-- guild, newest-starting-first, for a platform-wide discovery feed like Living Universe. Not
-- guild-scoped (fetchGuildEvents(guildId) already covers that case) and not admin-scoped
-- (admin_list_pending_guild_events already covers that one).
--
-- participant_count/collected_net_kobo are computed from guild_event_entries the same
-- "count/sum only, never a row" way guild_event_entry_count() does — entries themselves stay
-- non-public. collected_net_kobo sums net_kobo (post-platform-fee) from successful entries only,
-- so a host='guild' event's displayed pool is exactly the verified amount actually available to
-- pay out, never a projection from entry_fee_kobo × some assumed turnout.
-- ----------------------------------------------------------------------------------------------

create or replace function list_public_guild_events(p_result_limit integer default null)
returns table (
  id uuid, guild_id uuid, guild_name text, guild_crest_url text,
  host text, title text, description text, event_type text, cover_image_url text,
  entry_fee_kobo bigint, cash_prize_kobo bigint, participant_limit integer,
  start_date timestamptz, end_date timestamptz, approval_status text, status text,
  participant_count integer, collected_net_kobo bigint
)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select
      e.id, e.guild_id, g.name, g.crest_url,
      e.host, e.title, e.description, e.event_type, e.cover_image_url,
      e.entry_fee_kobo, e.cash_prize_kobo, e.participant_limit,
      e.start_date, e.end_date, e.approval_status, e.status,
      coalesce(c.participant_count, 0)::integer,
      coalesce(c.collected_net_kobo, 0)::bigint
    from guild_events e
    join player_guilds g on g.id = e.guild_id
    left join lateral (
      select
        count(*) filter (where x.status = 'success')::integer as participant_count,
        sum(x.net_kobo) filter (where x.status = 'success')::bigint as collected_net_kobo
      from guild_event_entries x
      where x.event_id = e.id
    ) c on true
    where e.approval_status in ('published', 'active', 'completed')
    order by
      case e.approval_status when 'active' then 0 when 'published' then 1 else 2 end,
      coalesce(e.start_date, e.created_at) desc
    limit coalesce(p_result_limit, 30);
end;
$$;

revoke all on function list_public_guild_events(integer) from public;
grant execute on function list_public_guild_events(integer) to authenticated;

-- ----------------------------------------------------------------------------------------------
-- 2. get_public_guild_profile — the minimal, safe-to-show-anyone read of a single Player Guild by
-- id, for a card or link (Living Universe's Guilds on the Rise, Guild Events, Best/Most-Read) to
-- land on a real guild page without needing that reader to already be a member. Same fields
-- admin_list_guilds() already treats as safe to expose broadly, plus a live member_count —
-- nothing else player_guilds holds (owner_id aside, which is not sensitive but also not needed
-- here) ever leaves this function.
-- ----------------------------------------------------------------------------------------------

create or replace function get_public_guild_profile(p_guild_id uuid)
returns table (
  id uuid, name text, motto text, crest_url text, member_count integer, created_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  return query
    select g.id, g.name, g.motto, g.crest_url,
      (select count(*)::integer from player_guild_members m where m.guild_id = g.id) as member_count,
      g.created_at
    from player_guilds g
    where g.id = p_guild_id;
end;
$$;

revoke all on function get_public_guild_profile(uuid) from public;
grant execute on function get_public_guild_profile(uuid) to authenticated;

-- Safe to run anytime: both functions are purely additive reads, neither writes anything, and
-- neither returns a column (invite_code) that any existing broad-read function doesn't already
-- treat as sensitive.
