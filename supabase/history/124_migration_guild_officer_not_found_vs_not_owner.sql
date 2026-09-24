-- ============================================================================================
-- Migration 124 — the guild-event "host/create/edit/submit" RPCs now tell "this guild doesn't
-- exist yet on the server" apart from "you're not its owner", instead of collapsing both into
-- the same "Only the guild owner can…" text (production audit — Host a Guild Event returning
-- that message for the guild's actual, rightful owner).
--
-- The gap: is_guild_officer(p_guild_id) returns a plain boolean —
--
--   select * into v_guild from player_guilds where id = p_guild_id;
--   if not found then
--     return false;
--   end if;
--   ...
--   return v_guild.owner_id = auth.uid();
--
-- — and every write-path call site follows the same shape:
--
--   if not is_guild_officer(p_guild_id) then
--     raise exception 'Only the guild owner can host a guild event.';  -- (or edit/submit/etc.)
--   end if;
--
-- So "no player_guilds row with this id at all" and "a row exists but you don't own it" both
-- produce the identical false, and therefore the identical "Only the guild owner can…" message,
-- even though only one of those is actually a permission problem. Why this matters in practice:
-- player_guilds.id is generated client-side (uuid()) and pushed to the server via a separate,
-- historically fire-and-forget syncPlayerGuild() call (ink-root.jsx) that could fail — or simply
-- not have finished yet — without the client ever finding out (see the client-side fix landing
-- alongside this migration, which now surfaces that failure instead of a silent console.warn).
-- Until that sync actually lands, player_guilds has no row for the id the client is using, so
-- every RPC above raised "Only the guild owner can…" for the guild's genuine, rightful owner —
-- indistinguishable, from the error text alone, from someone who plain isn't the owner.
--
-- Deliberately NOT touched: is_guild_officer() itself. It's also the authority check inside
-- several RLS policies' USING clauses (guild_anthologies, guild_anthology_submissions,
-- guild_event_entries, guild_event_hosting_fee_payments — see 69_migration_founder_guild_
-- parity.sql) and inside plain `exists(...)` read-side checks elsewhere. A policy's USING clause
-- runs per row scanned; making is_guild_officer raise on a missing guild would turn an ordinary
-- filtered SELECT into a hard error the moment it scanned a row for any guild_id that doesn't
-- resolve, which is a much bigger (and riskier) blast radius than this audit asked for. So
-- is_guild_officer's own signature and behavior are unchanged — new function below instead.
--
-- The fix: a small new guild_officer_gate(p_guild_id, p_denied_message) that write-path RPCs
-- call in place of the `if not is_guild_officer(...) then raise '<message>'` pattern above. It
-- checks existence first and raises 'Guild not found.' there; only once a row is confirmed to
-- exist does it fall through to the existing is_guild_officer() ownership check, raising
-- p_denied_message on that specific failure — so the caller's existing wording is preserved
-- exactly for genuine non-owners, and only the previously-ambiguous "not found" case gets its own
-- honest message.
--
-- Scope: this pass covers the four RPCs on the actual "Host a Guild Event" path reported (create
-- /edit/submit a guild event draft) — create_guild_event, create_guild_event_draft,
-- update_guild_event_draft, submit_guild_event_for_approval. The same ambiguity exists in the
-- sibling event lifecycle RPCs (close/publish/activate/complete_guild_event, propose_guild_event_
-- financial_agreement — 69_migration_founder_guild_parity.sql, 108/109/113/120/121's escrow
-- functions) and in the guild-anthology equivalents, all following the identical `if not is_guild_
-- officer(...) then raise '...'` shape — left as a follow-up rather than folded into this pass,
-- same narrow-scoping call migration 122's own header makes for a comparable choice.
--
-- Not run against a live database from this session. Verify after applying: calling any of the
-- four RPCs above with a p_guild_id that has no player_guilds row raises 'Guild not found.';
-- calling one against a real guild you don't own still raises the existing "Only the guild owner
-- can…" text; calling one as the real owner still succeeds exactly as before.
-- ============================================================================================

create or replace function guild_officer_gate(p_guild_id uuid, p_denied_message text)
returns void
language plpgsql stable security definer set search_path = public
as $$
begin
  if not exists (select 1 from player_guilds where id = p_guild_id) then
    raise exception 'Guild not found.';
  end if;
  if not is_guild_officer(p_guild_id) then
    raise exception '%', p_denied_message;
  end if;
end;
$$;

revoke all on function guild_officer_gate(uuid, text) from public;
grant execute on function guild_officer_gate(uuid, text) to authenticated;

-- ------------------------------------------------------------------------------------------
-- create_guild_event — host='guild' branch's ownership check only (host='inkroot' already has
-- its own explicit "Guild not found." check just above it, untouched).
-- ------------------------------------------------------------------------------------------
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
    if exists (select 1 from player_guilds g where g.id = p_guild_id and g.is_founder_guild) then
      raise exception 'A Founder Guild cannot host its own event — Inkroot can still run an official cash-prize event for it.';
    end if;
    perform guild_officer_gate(p_guild_id, 'Only the guild owner can host a guild event.');
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    if p_cash_prize_kobo is not null then
      raise exception 'A guild-hosted event funds its own prize from entry fees — it has no separate cash prize.';
    end if;
    insert into guild_events (guild_id, host, title, entry_fee_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'guild', trim(p_title), p_entry_fee_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    return v_row;
  else
    raise exception 'Unknown event host.';
  end if;
end;
$$;

revoke all on function create_guild_event(uuid, text, text, bigint, bigint) from public;
grant execute on function create_guild_event(uuid, text, text, bigint, bigint) to authenticated;

-- ------------------------------------------------------------------------------------------
-- create_guild_event_draft / update_guild_event_draft / submit_guild_event_for_approval — the
-- actual "Host a Guild Event" form path (guild-events-section.jsx's handleSaveForm).
-- ------------------------------------------------------------------------------------------
create or replace function create_guild_event_draft(
  p_guild_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can host a guild event.');
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    p_entry_fee_kobo, p_participant_limit, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed'
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function update_guild_event_draft(
  p_guild_id uuid,
  p_event_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can edit this event.');
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Only a draft or rejected event can be edited.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  update guild_events set
    title = trim(p_title),
    description = nullif(trim(coalesce(p_description, '')), ''),
    rules = nullif(trim(coalesce(p_rules, '')), ''),
    event_type = coalesce(p_event_type, 'other'),
    entry_fee_kobo = p_entry_fee_kobo,
    participant_limit = p_participant_limit,
    prize_structure = coalesce(p_prize_structure, '[]'::jsonb),
    guild_share_bps = coalesce(p_guild_share_bps, 0),
    start_date = p_start_date,
    end_date = p_end_date,
    organizer_id = p_organizer_id,
    cover_image_url = p_cover_image_url,
    approval_status = 'draft',
    rejection_reason = null,
    reviewed_by = null,
    reviewed_at = null,
    submitted_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function submit_guild_event_for_approval(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  perform guild_officer_gate(p_guild_id, 'Only the guild owner can submit this event.');
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'This event has already been submitted.';
  end if;
  if v_event.title is null or length(trim(v_event.title)) = 0
     or v_event.entry_fee_kobo is null or v_event.start_date is null or v_event.end_date is null then
    raise exception 'Fill in the title, entry fee, and start/end dates before submitting.';
  end if;
  if v_event.host = 'guild' and not exists (
    select 1 from guild_event_financial_agreements a where a.event_id = p_event_id
  ) then
    raise exception 'Set how entry fees will be divided — prize pool, guild share, and any other allocations — before submitting.';
  end if;

  update guild_events set approval_status = 'pending_approval', submitted_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) from public;
grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) to authenticated;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) from public;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) to authenticated;
revoke all on function submit_guild_event_for_approval(uuid, uuid) from public;
grant execute on function submit_guild_event_for_approval(uuid, uuid) to authenticated;
