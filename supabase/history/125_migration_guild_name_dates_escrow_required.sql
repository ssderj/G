-- ============================================================================================
-- Migration 125 — three hardening requests from a production report (the same "Host a Guild
-- Event → Guild not found" audit that produced migration 124's client-side fix):
--
--   1. A Player Guild must have a name before it can be founded — create_or_get_own_guild
--      happily accepted '' before this, which is how a guild ended up with no name at all
--      (ink-root.jsx's enterOwnGuild used to default a fresh guild's name to '' and let the
--      writer fill it in later, if ever). The real client-side fix — requiring a name in the
--      founding UI itself before it ever calls this RPC — lands alongside this migration; this
--      is the server-side backstop for it, so a blank-named guild can never exist even from a
--      direct call that skips the UI.
--
--   2. A guild event's start and end dates are now required at DRAFT creation, not just at
--      submission. submit_guild_event_for_approval already refused to submit a draft with no
--      dates (see its own "Fill in the title, entry fee, and start/end dates..." check) — but
--      create_guild_event_draft itself let both default to null, so a draft could sit around
--      indefinitely with no dates at all, undiscovered until submission. Requiring them at
--      creation surfaces the problem the moment it happens instead of several steps later.
--
--   3. An event that promises a guaranteed cash prize must have that prize actually escrowed
--      before it can even be SUBMITTED for approval — not just before it's activated/opened for
--      entries (activate_guild_event's existing escrow check, migration 108, is unchanged and
--      still the last line of defense). Without this, an event could be drafted, submitted,
--      reviewed, approved, and published all while promising a prize that was never actually
--      locked away — sitting in a confusing stuck state the moment an Inkroot admin or a writer
--      expected it to open. Requiring the deposit before submission means a promise to pay never
--      even enters the review queue unbacked.
--
-- Also folds in migration 124 (guild_officer_gate — "Guild not found" vs "Only the guild owner
-- can..."), which was written but never actually merged into supabase/schema.sql's fresh-install
-- copy of create_guild_event / create_guild_event_draft / update_guild_event_draft /
-- submit_guild_event_for_approval. A fresh install run from schema.sql alone was still missing
-- that fix entirely. The four functions below are each redefined once, combining 124's gate with
-- this migration's own checks, so there's one final version of each rather than two competing
-- partial ones.
--
-- Not run against a live database from this session. Verify after applying: creating a Player
-- Guild with a blank/whitespace-only name is refused; create_guild_event_draft without a
-- start_date or end_date is refused; submit_guild_event_for_approval on a draft that declares a
-- guaranteed_prize_kobo but has no successful event_prize_escrow transaction is refused with a
-- message pointing at depositing escrow first; all three still succeed exactly as before once the
-- missing piece is supplied.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 1. create_or_get_own_guild — name is now required, both for the first founding and for any
-- later edit through this same RPC (saveOwnGuild's edit path re-uses it) — a guild can never be
-- renamed to blank either.
-- ------------------------------------------------------------------------------------------

create or replace function create_or_get_own_guild(p_id uuid, p_name text, p_motto text, p_crest_url text)
returns setof player_guilds
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing player_guilds%rowtype;
begin
  if is_banned(auth.uid()) then
    raise exception 'Your account is suspended and can''t found or edit a guild.';
  end if;

  if p_name is null or length(trim(p_name)) = 0 then
    raise exception 'Give your guild a name.';
  end if;

  select * into v_existing from player_guilds where owner_id = auth.uid();
  if found and v_existing.id <> p_id then
    raise exception 'You already own a Player Guild — a writer can only found one.';
  end if;

  -- An id that already exists under a different owner is never ours to write to.
  if exists (select 1 from player_guilds where id = p_id and owner_id <> auth.uid()) then
    raise exception 'You can only edit a guild you own.';
  end if;

  insert into player_guilds (id, name, motto, crest_url, owner_id, updated_at)
  values (p_id, trim(p_name), p_motto, p_crest_url, auth.uid(), now())
  on conflict (id) do update set
    name = excluded.name,
    motto = excluded.motto,
    crest_url = excluded.crest_url,
    updated_at = now()
  where player_guilds.owner_id = auth.uid();

  insert into player_guild_members (guild_id, user_id)
  values (p_id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select * from player_guilds where id = p_id;
end;
$$;

grant execute on function create_or_get_own_guild(uuid, text, text, text) to authenticated;

-- ------------------------------------------------------------------------------------------
-- guild_officer_gate — migration 124's gate, folded in here since it never made it into
-- schema.sql. Existence check first (raises 'Guild not found.'), ownership check second (raises
-- the caller's own wording) — see migration 124's header for the full reasoning.
-- ------------------------------------------------------------------------------------------

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
-- 2. create_guild_event (host='inkroot'/'guild' single-event RPC) — 124's gate only; no date/
-- escrow requirement here since this path never took dates to begin with.
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
-- 3. create_guild_event_draft — 124's gate, plus start_date/end_date now required at creation
-- (previously only checked "end after start" if both happened to be given).
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

-- ------------------------------------------------------------------------------------------
-- 4. update_guild_event_draft — same two changes as create_guild_event_draft above.
-- ------------------------------------------------------------------------------------------

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

-- ------------------------------------------------------------------------------------------
-- 5. submit_guild_event_for_approval — 124's gate, plus: a guaranteed prize must already be
-- escrowed before the event can be submitted, not just before it's activated. The
-- activate_guild_event check from migration 108 is untouched and still applies as the final
-- backstop right before entries open.
-- ------------------------------------------------------------------------------------------

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
