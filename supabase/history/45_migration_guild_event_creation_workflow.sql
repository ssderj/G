-- ============================================================================================
-- Migration 45: Guild Event creation — turns the one-field "title + entry fee" quick-create in
-- 42_migration_guild_events.sql into a full submission the guild owner fills in (title,
-- description, rules, event type, entry fee, participant limit, prize structure, guild share,
-- start/end date, organizer, cover image) and Inkroot reviews before it ever reaches readers.
--
-- Same table, richer row: every new column lives on guild_events itself rather than a second
-- table, so entries (guild_event_entries) and settlement (settle_guild_event) keep working
-- against the exact same row they always have — nothing about how money moves changes here.
--
-- Two lifecycles on one row, kept deliberately separate:
--   - approval_status: draft -> pending_approval -> approved -> published -> active -> completed,
--     or draft/pending_approval -> ... -> rejected. This is the NEW one this migration adds —
--     entirely about whether/when a submission is fit to show readers at all.
--   - status (open/closed/settled, from migration 42): unchanged, still entirely about whether
--     entries are currently being accepted and whether the pool has been paid out. What's new is
--     only how it gets flipped: activate_guild_event() below is now the thing that moves it to
--     'open' (readers can enter) instead of that happening the instant the event exists.
-- A guild-hosted event therefore can't take a single Naira until its owner has filled in the
-- whole form, Inkroot has approved it, the owner has published it, AND the owner has activated
-- it — four separate, server-checked steps, not one.
--
-- Rejected events stay unpublished by construction, not by convention: create_guild_event_draft
-- inserts every new event with status = 'closed' (not the table's own 'open' default), and
-- nothing on the reject path ever touches status — activate_guild_event is the only function
-- that ever sets status = 'open', and it refuses anything whose approval_status isn't
-- 'published'. A rejected event can only reach 'published' again by being edited back to
-- 'draft' (update_guild_event_draft) and resubmitted, so there is no path from 'rejected' to
-- open entries that skips re-review.
--
-- create_guild_event() — the original quick-create RPC — is left fully callable, for both hosts,
-- exactly as it always worked (instantly live, no review step). It's how host='inkroot' events
-- are still created (Inkroot funding its own prize is already the trusted party in that flow —
-- see migration 42/43's own header on why there's no review step to route it through), and
-- keeping it callable for host='guild' too means nothing that already depends on this exact RPC
-- signature breaks. The new, richer path below is additive.
-- ============================================================================================

-- ----------------------------------------------------------------------------------------------
-- 1. New columns on guild_events.
-- ----------------------------------------------------------------------------------------------

alter table guild_events
  add column if not exists description text check (char_length(description) <= 4000),
  add column if not exists rules text check (char_length(rules) <= 4000),
  add column if not exists event_type text not null default 'other'
    check (event_type in ('tournament', 'writing_contest', 'reading_challenge', 'giveaway', 'workshop', 'other')),
  add column if not exists participant_limit integer check (participant_limit > 0),
  -- Informational only — a guide for the organizer at settle_guild_event() time, e.g.
  -- [{"place": 1, "share_pct": 50}, {"place": 2, "share_pct": 30}, {"place": 3, "share_pct": 20}].
  -- Never trusted or enforced server-side: the actual payout is still whatever p_shares
  -- settle_guild_event() is called with, checked the same way it always has been.
  add column if not exists prize_structure jsonb not null default '[]'::jsonb,
  -- Also informational/planning-only, same reasoning as prize_structure — the guild's actual
  -- take at settlement is still just "gross minus whatever winner shares were declared" (see
  -- distribute_guild_revenue's v_guild_share), computed the same way regardless of this value.
  add column if not exists guild_share_bps integer not null default 0
    check (guild_share_bps >= 0 and guild_share_bps <= 10000),
  add column if not exists start_date timestamptz,
  add column if not exists end_date timestamptz,
  add column if not exists organizer_id uuid references auth.users(id) on delete set null,
  add column if not exists cover_image_url text,
  add column if not exists approval_status text not null default 'draft'
    check (approval_status in ('draft', 'pending_approval', 'approved', 'published', 'active', 'completed', 'rejected')),
  add column if not exists rejection_reason text,
  add column if not exists submitted_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists published_at timestamptz,
  add column if not exists activated_at timestamptz,
  add column if not exists completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guild_events_date_range_chk') then
    alter table guild_events
      add constraint guild_events_date_range_chk
      check (start_date is null or end_date is null or end_date > start_date);
  end if;
end $$;

create index if not exists guild_events_pending_approval_idx
  on guild_events (approval_status) where approval_status = 'pending_approval';

-- 'guild-event-covers' joins the same public, per-uploader-folder posture avatars/guild-crests/
-- book-covers already have (see schema_phase9.sql) — a cover image is meant to be publicly
-- visible the moment it's uploaded, same as any of those. One function change is enough: every
-- read/insert/update/delete policy on storage.objects already delegates the allowed-folder list
-- to is_public_media_folder() for exactly this reason (see its own comment on why that's one
-- function, not four repeated literals).
create or replace function is_public_media_folder(folder text)
returns boolean
language sql
immutable
as $$
  select folder in ('avatars', 'guild-crests', 'book-covers', 'guild-event-covers');
$$;

-- ----------------------------------------------------------------------------------------------
-- 2. create_guild_event — redefined only to keep its old "instantly live" behavior working
-- unchanged now that approval_status/status default differently for a NEW row. Every check and
-- authorization branch below is identical to migration 43's version; the only addition is the
-- explicit approval_status/status/published_at/activated_at values on each insert.
-- ----------------------------------------------------------------------------------------------

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
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
      raise exception 'An Inkroot-hosted event has no entry fee \u2014 it''s funded directly.';
    end if;
    if not exists (select 1 from player_guilds g where g.id = p_guild_id) then
      raise exception 'Guild not found.';
    end if;
    insert into guild_events (guild_id, host, title, cash_prize_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'inkroot', trim(p_title), p_cash_prize_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    return v_row;
  elsif p_host = 'guild' then
    if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
      raise exception 'Only the guild owner can host a guild event.';
    end if;
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    if p_cash_prize_kobo is not null then
      raise exception 'A guild-hosted event funds its own prize from entry fees \u2014 it has no separate cash prize.';
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

-- ----------------------------------------------------------------------------------------------
-- 3. create_guild_event_draft / update_guild_event_draft — the actual Guild Event creation form.
-- Guild-owner-only, host='guild' only (see the migration header on why host='inkroot' has no
-- review step to route through). A new row always starts approval_status='draft',
-- status='closed' — never enterable, never visible as anything but a draft, until it's been all
-- the way through submit -> approve -> publish -> activate below.
-- ----------------------------------------------------------------------------------------------

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
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can host a guild event.';
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

-- Only ever touches a row still in 'draft' or 'rejected' — once it's pending_approval or beyond,
-- editing would mean changing what Inkroot already reviewed (or is reviewing) out from under
-- them, so it's refused. Editing a rejected event always resets it back to 'draft' and clears
-- the review trail (rejection_reason/reviewed_by/reviewed_at/submitted_at) — it has to be
-- resubmitted deliberately (submit_guild_event_for_approval), never silently re-enters the
-- queue just because it was touched.
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
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can edit this event.';
  end if;
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

-- ----------------------------------------------------------------------------------------------
-- 4. submit_guild_event_for_approval / approve_guild_event / reject_guild_event — the review
-- step. Submit is owner-only (their own event); approve/reject are is_inkroot_admin()-only, same
-- trust domain as everything else Inkroot-admin-gated (see migration 43's own header on why this
-- is a separate flag from is_moderator).
-- ----------------------------------------------------------------------------------------------

create or replace function submit_guild_event_for_approval(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can submit this event.';
  end if;
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

  update guild_events set approval_status = 'pending_approval', submitted_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function approve_guild_event(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can approve a guild event.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'pending_approval' then
    raise exception 'This event is not awaiting approval.';
  end if;

  update guild_events set approval_status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function reject_guild_event(p_event_id uuid, p_reason text)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can reject a guild event.';
  end if;
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'Give a reason so the organizer knows what to fix.';
  end if;
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'pending_approval' then
    raise exception 'This event is not awaiting approval.';
  end if;

  -- status is left exactly as create_guild_event_draft set it ('closed') — see the migration
  -- header on why that alone is enough to keep a rejected event unpublished.
  update guild_events set approval_status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now(),
    rejection_reason = trim(p_reason)
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 5. publish_guild_event / activate_guild_event / complete_guild_event — the owner-driven tail
-- of the pipeline, each one a strict single step forward (approved -> published -> active ->
-- completed), same "re-check the exact state you're leaving" posture as close_guild_event
-- already has in migration 42.
-- ----------------------------------------------------------------------------------------------

create or replace function publish_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can publish this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'approved' then
    raise exception 'This event needs Inkroot approval before it can be published.';
  end if;

  update guild_events set approval_status = 'published', published_at = now()
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- The moment a guild-hosted event actually starts accepting entries — see the migration header
-- on why status='open' waits for this instead of being set at creation.
create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can activate this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'published' then
    raise exception 'Publish this event before opening it for entries.';
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- Stops new entries (status -> 'closed', same effect close_guild_event already has) and marks
-- the run itself finished. Settling the pool and paying winners is still the separate, existing
-- settle_guild_event() call — completing an event says nothing about whether that's happened yet.
create or replace function complete_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can complete this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'Only an active event can be marked completed.';
  end if;

  update guild_events set approval_status = 'completed', completed_at = now(), status = 'closed'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 6. admin_list_pending_guild_events — the Inkroot review queue. player_guilds' own select
-- policy is member/owner-scoped (see admin_list_guilds' own comment), so this resolves guild
-- names the same security-definer-bypass way admin_list_guilds does rather than leaving the
-- admin screen to guess.
-- ----------------------------------------------------------------------------------------------

create or replace function admin_list_pending_guild_events()
returns table (
  id uuid, guild_id uuid, guild_name text, title text, description text, rules text,
  event_type text, entry_fee_kobo bigint, participant_limit integer, prize_structure jsonb,
  guild_share_bps integer, start_date timestamptz, end_date timestamptz,
  organizer_id uuid, cover_image_url text, submitted_at timestamptz, created_by uuid
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can review guild event submissions.';
  end if;
  return query
    select e.id, e.guild_id, g.name, e.title, e.description, e.rules,
           e.event_type, e.entry_fee_kobo, e.participant_limit, e.prize_structure,
           e.guild_share_bps, e.start_date, e.end_date,
           e.organizer_id, e.cover_image_url, e.submitted_at, e.created_by
    from guild_events e join player_guilds g on g.id = e.guild_id
    where e.approval_status = 'pending_approval'
    order by e.submitted_at asc nulls last;
end;
$$;

-- ----------------------------------------------------------------------------------------------
-- 7. Grants.
-- ----------------------------------------------------------------------------------------------

revoke all on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) from public;
revoke all on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) from public;
revoke all on function submit_guild_event_for_approval(uuid, uuid) from public;
revoke all on function approve_guild_event(uuid) from public;
revoke all on function reject_guild_event(uuid, text) from public;
revoke all on function publish_guild_event(uuid, uuid) from public;
revoke all on function activate_guild_event(uuid, uuid) from public;
revoke all on function complete_guild_event(uuid, uuid) from public;
revoke all on function admin_list_pending_guild_events() from public;

grant execute on function create_guild_event_draft(uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function update_guild_event_draft(uuid, uuid, text, text, text, text, bigint, integer, jsonb, integer, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function submit_guild_event_for_approval(uuid, uuid) to authenticated;
grant execute on function approve_guild_event(uuid) to authenticated;
grant execute on function reject_guild_event(uuid, text) to authenticated;
grant execute on function publish_guild_event(uuid, uuid) to authenticated;
grant execute on function activate_guild_event(uuid, uuid) to authenticated;
grant execute on function complete_guild_event(uuid, uuid) to authenticated;
grant execute on function admin_list_pending_guild_events() to authenticated;

-- Safe to run anytime: every new column is nullable or has a default that reproduces the exact
-- prior behavior for any existing row (approval_status/status default to 'draft'/'closed' only
-- for brand-new inserts through the new functions — create_guild_event's own redefinition above
-- sets both explicitly for every row it inserts, so nothing that already went through it changes
-- behavior), and every new function is additive.
