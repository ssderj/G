-- ============================================================================================
-- Migration 46: guild_event_entry_count() — lets anyone see how many of a guild-hosted event's
-- participant_limit slots are already taken, without exposing who took them.
--
-- guild_event_entries itself is deliberately NOT publicly readable (see its own RLS in
-- 42_migration_guild_events.sql — an entrant's own rows, or the guild owner's, only). That's the
-- right call for the entries themselves (nobody else needs to know who paid to enter), but it
-- means a reader deciding whether to enter a near-full event currently has no way to find out
-- it's near full at all. This is a narrow, count-only bypass of that same shape as
-- admin_list_guilds()/admin_list_pending_guild_events() — a security-definer function that
-- returns strictly less than the table it reads, here a bare integer rather than any row.
-- ============================================================================================

create or replace function guild_event_entry_count(p_event_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from guild_event_entries
  where event_id = p_event_id and status in ('pending', 'success');
$$;

revoke all on function guild_event_entry_count(uuid) from public;
grant execute on function guild_event_entry_count(uuid) to authenticated;

-- Safe to run anytime: purely additive, reads nothing this function's own definition doesn't
-- already scope down to a single integer.
