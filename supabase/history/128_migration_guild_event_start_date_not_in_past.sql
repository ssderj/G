-- ============================================================================================
-- Migration 128 — closes the "event cannot unexpectedly start in the past" gap found in the
-- final audit: create_guild_event_draft() / update_guild_event_draft() required end_date after
-- start_date (migration 125 required both to be non-null), but never checked start_date against
-- now() at all. A draft could be created — or edited — with a start_date years in the past and
-- sail all the way through submit -> approve -> publish -> activate with nothing ever catching
-- it.
--
-- Fix, same "fail fast at the form, then re-check as a backstop" shape this schema already uses
-- for the guaranteed-prize escrow requirement (migration 125: checked at both
-- create/update_guild_event_draft-adjacent points and again at submission):
--   1. create_guild_event_draft() / update_guild_event_draft() now refuse a start_date in the
--      past at the moment it's set — the same fail-fast UX every other field on this form
--      already gets (title, entry fee, dates-both-present, end-after-start).
--   2. submit_guild_event_for_approval() re-checks start_date against now() as a backstop: a
--      draft can legitimately sit untouched for days or weeks after being created with a
--      perfectly valid future date, so the moment that actually matters — the last owner-
--      controlled step before the event enters Inkroot's review queue — is re-verified rather
--      than trusted from creation time. If it's since slipped into the past, the owner is told
--      to update the date rather than having the event silently queue for review with a start
--      date that's already wrong.
--
-- Deliberately unchanged: approve_guild_event / publish_guild_event / activate_guild_event.
-- Once an event is approved and published, the owner is the one who chooses when to actually
-- call activate_guild_event() to open it for entries — that's a deliberate manual step already,
-- not a date the system auto-fires on, so there's no "unexpectedly" left to guard against past
-- that point the way there was at creation/submission.
--
-- Not run against a live database from this session. Verify after applying:
--   * create_guild_event_draft() with a start_date before now() is refused with "Start date
--     can't be in the past."; the same start_date at or after now() still succeeds.
--   * update_guild_event_draft() enforces the same check.
--   * A draft created with a valid future start_date, left untouched until that date has
--     passed, is refused by submit_guild_event_for_approval() with a clear message pointing at
--     updating the date, rather than being silently queued for review.
--   * Every other check on all three functions (title, entry fee, end-after-start, organizer
--     membership, guaranteed-prize escrow) is unchanged.
-- ============================================================================================

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
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null
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
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: the event's own stated start can't already be in the past.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status, guaranteed_prize_kobo
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    p_entry_fee_kobo, p_participant_limit, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed', p_guaranteed_prize_kobo
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
  p_cover_image_url text default null,
  p_guaranteed_prize_kobo bigint default null
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
  if p_start_date is null or p_end_date is null then
    raise exception 'Choose a start and end date for the event.';
  end if;
  -- Migration 128: same past-start-date check as create_guild_event_draft above — an edit can
  -- just as easily set (or leave) a stale date as a first save can.
  if p_start_date < now() then
    raise exception 'Start date can''t be in the past.';
  end if;
  if p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;
  if p_guaranteed_prize_kobo is not null and p_guaranteed_prize_kobo <= 0 then
    raise exception 'A guaranteed prize must be a positive amount.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
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
    guaranteed_prize_kobo = p_guaranteed_prize_kobo,
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

revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) from public;
grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) to authenticated;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) from public;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text, bigint) to authenticated;

-- submit_guild_event_for_approval — redefined to add the same check as a backstop (see header).
-- Every other check (draft/rejected only, required fields, financial agreement, guaranteed-
-- prize escrow) is unchanged, byte-for-byte, from the current final definition.
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
  -- Migration 128: a draft can sit untouched for a while after being created (or last edited)
  -- with a perfectly valid future date — re-check it here, the last owner-controlled step
  -- before this event enters Inkroot's review queue.
  if v_event.start_date < now() then
    raise exception 'This event''s start date has passed — update it before submitting.';
  end if;
  if v_event.host = 'guild' and not exists (
    select 1 from guild_event_financial_agreements a where a.event_id = p_event_id
  ) then
    raise exception 'Set how entry fees will be divided — prize pool, guild share, and any other allocations — before submitting.';
  end if;
  if v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0 and not exists (
    select 1 from guild_treasury_transactions
    where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
  ) then
    raise exception 'Deposit the guaranteed prize into escrow before submitting an event that promises to pay it.';
  end if;

  update guild_events set approval_status = 'pending_approval', submitted_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

revoke all on function submit_guild_event_for_approval(uuid, uuid) from public;
grant execute on function submit_guild_event_for_approval(uuid, uuid) to authenticated;

-- Safe to run anytime: every check added is strictly additive (a start_date that was already
-- required to be non-null and before end_date now also has to be >= now()); no existing draft
-- row is touched, and a row already past pending_approval is never re-validated by this
-- migration's changes.
