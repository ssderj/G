-- ============================================================================================
-- Migration 127 — closes the Guild Events creation-workflow bypass found in the final audit:
-- create_guild_event(uuid, text, text, bigint, bigint) — the original 42_migration_guild_events.sql
-- quick-create RPC — was still GRANTed to `authenticated` and, for p_host = 'guild', inserted a
-- row with approval_status = 'active', status = 'open' directly. That skips every step
-- 45_migration_guild_event_creation_workflow.sql (and everything built on top of it since) added:
-- DRAFT -> SUBMITTED -> ADMIN REVIEW -> APPROVED, the locked financial agreement, the judging/
-- objective config, the Inkroot hosting-fee payment, escrow for a guaranteed prize, and even
-- start_date/end_date (both stayed null through this path). Nothing in the current UI calls this
-- for host='guild' anymore (guild-events-panel.jsx/guild-events-section.jsx both go through
-- create_guild_event_draft -> submit_guild_event_for_approval -> ... as intended), but the RPC
-- grant is what actually matters: any signed-in guild owner could call
-- `supabase.rpc('create_guild_event', { p_guild_id, p_title, p_host: 'guild', p_entry_fee_kobo,
-- p_cash_prize_kobo: null })` directly and get a fully live, real-money event in one call with no
-- review at all.
--
-- Fix: create_guild_event() now only ever accepts p_host = 'inkroot' (the admin-only,
-- Inkroot-funds-its-own-prize path it was always meant to keep serving instantly — see the
-- original migration's own header on why that path has no review step to route through). Calling
-- it with p_host = 'guild' now raises, pointing the caller at the real form
-- (create_guild_event_draft). Every check already inside the p_host = 'inkroot' branch —
-- is_inkroot_admin(), the positive-cash-prize check, the founder-guild-cannot-self-host check,
-- the platform-reserve-availability check and reservation insert — is unchanged, byte-for-byte,
-- from the current final definition (schema.sql:18331).
--
-- Not run against a live database from this session. Verify after applying:
--   * `supabase.rpc('create_guild_event', {..., p_host: 'guild', ...})` from any signed-in guild
--     owner now raises "Guild-hosted events must go through the draft/review workflow..." and
--     creates no row.
--   * `supabase.rpc('create_guild_event', {..., p_host: 'inkroot', ...})` from an Inkroot admin
--     still succeeds exactly as before (active/open immediately, platform reserve debited).
--   * The normal path (create_guild_event_draft -> submit_guild_event_for_approval -> approve ->
--     publish -> activate) is completely untouched by this migration.
-- ============================================================================================

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
  v_available bigint;
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;

  if p_host = 'inkroot' then
    if not is_inkroot_admin() then
      raise exception 'Only an Inkroot admin can host a cash-prize event.';
    end if;
    if p_cash_prize_kobo is null or p_cash_prize_kobo <= 0 then
      raise exception 'An Inkroot-hosted event needs a positive cash prize.';
    end if;
    if p_entry_fee_kobo is not null then
      raise exception 'An Inkroot-hosted event has no entry fee — it''s funded directly.';
    end if;
    if not exists (select 1 from player_guilds g where g.id = p_guild_id) then
      raise exception 'Guild not found.';
    end if;
    perform pg_advisory_xact_lock(hashtext('platform_reserve'));
    v_available := platform_reserve_available_kobo();
    if p_cash_prize_kobo > v_available then
      raise exception 'Inkroot''s prize reserve can''t cover this prize: ₦% is available and this event needs ₦%. Top up the reserve first.',
        trim(to_char(v_available / 100.0, 'FM999,999,999,990.00')),
        trim(to_char(p_cash_prize_kobo / 100.0, 'FM999,999,999,990.00'));
    end if;
    insert into guild_events (guild_id, host, title, cash_prize_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'inkroot', trim(p_title), p_cash_prize_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    insert into platform_reserve_kobo (kind, amount_kobo, event_id, note, created_by)
    values ('event_prize_reserved', p_cash_prize_kobo, v_row.id, 'Reserved at event creation — ' || left(v_row.title, 200), auth.uid());
    return v_row;
  elsif p_host = 'guild' then
    -- Migration 127: a guild-hosted event must go through the real workflow — draft, review,
    -- financial agreement, judging config, hosting fee, and (if promised) escrow — never
    -- straight to active/open. See this migration's header.
    raise exception 'Guild-hosted events must go through the draft/review workflow — use create_guild_event_draft() and submit it for approval instead.';
  else
    raise exception 'Unknown event host.';
  end if;
end;
$$;

revoke all on function create_guild_event(uuid, text, text, bigint, bigint) from public;
grant execute on function create_guild_event(uuid, text, text, bigint, bigint) to authenticated;

-- Safe to run anytime: the p_host = 'inkroot' branch is byte-for-byte unchanged, and the
-- p_host = 'guild' branch already required is_guild_officer/guild_officer_gate before doing
-- anything — no existing row is affected, this only closes a creation path going forward.
