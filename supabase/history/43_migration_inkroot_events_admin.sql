-- ============================================================================================
-- Migration 43: Inkroot Admin — Guild Events. Adds the actual admin surface for the
-- host='inkroot' half of 42_migration_guild_events.sql, which until now had no client-callable
-- path at all (by design, at the time — see that migration's header): create_guild_event() and
-- settle_guild_event() both flatly refused to act on a host='inkroot' row for any signed-in
-- caller, leaving only a direct service-role/SQL action outside the app.
--
-- This migration gives Inkroot's own staff an in-app way to do that, gated by a new, narrowly-
-- scoped trust flag rather than reusing profiles.is_moderator. Deliberately a separate column:
-- is_moderator already means "can read reports and ban accounts" (see the Trust & Safety
-- migration's own comment on that column) — a content moderator authorizing a real cash payout
-- is a different trust domain, and conflating the two would silently hand payout authority to
-- every existing moderator the day this migration runs. is_platform_admin gets the exact same
-- lockdown profiles.is_moderator already has: settable only by service_role (see
-- protect_admin_profile_columns below, extended in place), never self-grantable, never grantable
-- by another admin through the app.
--
-- is_inkroot_admin() (the actual authorization check create_guild_event/settle_guild_event now
-- use for the host='inkroot' path) also still accepts a null auth.uid() — i.e. a genuine
-- service-role/direct-SQL call with no user session at all — so the original "Inkroot ops runs
-- this directly against the database" path from the Guild Events migration still works
-- unchanged; this migration only adds a second, in-app path alongside it, not a replacement.
-- ============================================================================================

alter table profiles add column if not exists is_platform_admin boolean not null default false;

-- Redefined in place (same function, extended) rather than a second trigger, so there is still
-- exactly one place that decides what a moderator-acting-on-someone-else's-row vs an
-- ordinary-user-acting-on-their-own-row is allowed to touch — see the Trust & Safety migration's
-- own comment on why this needs to be one trigger, not several independently-reasoned ones.
create or replace function protect_admin_profile_columns()
returns trigger as $$
declare
  acting_is_moderator boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;
  if coalesce(current_setting('inkroot.trusted_admin_rpc', true), '') = 'true' then
    return new;
  end if;
  if new.is_moderator is distinct from old.is_moderator then
    new.is_moderator := old.is_moderator;
  end if;
  -- Same treatment as is_moderator immediately above: locked to service_role in every path,
  -- full stop, including a platform admin acting on someone else's row — an admin can't mint
  -- another admin any more than a moderator can mint another moderator.
  if new.is_platform_admin is distinct from old.is_platform_admin then
    new.is_platform_admin := old.is_platform_admin;
  end if;
  if new.login_banned is distinct from old.login_banned then
    new.login_banned := old.login_banned;
  end if;
  if new.login_ban_reason is distinct from old.login_ban_reason then
    new.login_ban_reason := old.login_ban_reason;
  end if;
  select p.is_moderator into acting_is_moderator from profiles p where p.id = auth.uid();
  if coalesce(acting_is_moderator, false) and auth.uid() <> old.id then
    new.pen_name := old.pen_name;
    new.display_name := old.display_name;
    new.avatar_url := old.avatar_url;
  else
    new.banned := old.banned;
    new.ban_reason := old.ban_reason;
    new.verified := old.verified;
  end if;
  return new;
end;
$$ language plpgsql security definer;
-- No need to re-create the trigger itself — protect_admin_profile_columns_trigger already calls
-- this function by name, so the redefinition above takes effect immediately.

-- The one authorization check both create_guild_event() and settle_guild_event() use for their
-- host='inkroot' branch. True for a genuine platform admin, OR for a call with no user session
-- at all (auth.uid() is null) — a direct service-role/SQL action, e.g. Inkroot ops working
-- straight from the Supabase SQL editor rather than through the app.
create or replace function is_inkroot_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or exists (
    select 1 from profiles where id = auth.uid() and is_platform_admin
  );
$$;

revoke all on function is_inkroot_admin() from public;
grant execute on function is_inkroot_admin() to authenticated;

-- ============================================================================================
-- admin_list_guilds — lets a platform admin find a guild to host a cash-prize event for.
-- player_guilds' own select policy is scoped to a guild's owner/members only (see its
-- migration's comment on why — protecting invite_code), so an admin who isn't a member of every
-- guild couldn't otherwise browse them to pick one. This is a narrow, read-only bypass of that
-- restriction, gated the same way every other admin action here is, and never returns
-- invite_code (same "never leak the invite code outside the owner/member policy" posture
-- join_player_guild_by_code() already takes).
-- ============================================================================================

create or replace function admin_list_guilds(p_search text default null)
returns table (id uuid, name text, owner_id uuid, member_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can browse every guild.';
  end if;
  return query
    select g.id, g.name, g.owner_id,
           (select count(*) from player_guild_members m where m.guild_id = g.id) as member_count
    from player_guilds g
    where p_search is null or p_search = '' or g.name ilike '%' || p_search || '%'
    order by g.name
    limit 50;
end;
$$;

revoke all on function admin_list_guilds(text) from public;
grant execute on function admin_list_guilds(text) to authenticated;

-- ============================================================================================
-- create_guild_event — rewritten to branch on host instead of flatly refusing 'inkroot'.
-- host='guild' keeps its exact original behavior (owner-only, positive entry fee, no cash
-- prize). host='inkroot' is new: gated by is_inkroot_admin() instead of guild ownership (an
-- Inkroot-funded prize isn't the guild owner's money to authorize), requires a positive cash
-- prize and no entry fee, and — unlike a guild-hosted event — can target any guild that exists,
-- not just one the caller owns.
-- ============================================================================================

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
    insert into guild_events (guild_id, host, title, cash_prize_kobo, created_by)
    values (p_guild_id, 'inkroot', trim(p_title), p_cash_prize_kobo, auth.uid())
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
    insert into guild_events (guild_id, host, title, entry_fee_kobo, created_by)
    values (p_guild_id, 'guild', trim(p_title), p_entry_fee_kobo, auth.uid())
    returning * into v_row;
    return v_row;
  else
    raise exception 'Unknown event host.';
  end if;
end;
$$;

revoke all on function create_guild_event(uuid, text, text, bigint, bigint) from public;
grant execute on function create_guild_event(uuid, text, text, bigint, bigint) to authenticated;

-- ============================================================================================
-- settle_guild_event — only its host='inkroot' authorization branch changes: was "reject any
-- signed-in caller", now "accept a platform admin (or, unchanged, a call with no user session at
-- all)". The host='guild' branch, the advisory lock, the settled-status guard, the
-- every-winner-must-be-a-member check, and the distribute_guild_revenue() call are all identical
-- to the Guild Events migration's original version.
-- ============================================================================================

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_gross bigint;
  v_bad_contributor uuid;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if v_event.host = 'guild' then
    if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
      raise exception 'Only the guild owner can settle this event.';
    end if;
  else -- 'inkroot'
    if not is_inkroot_admin() then
      raise exception 'Only an Inkroot admin can settle a cash-prize event.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  select (s->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_shares) s
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  if v_event.host = 'guild' then
    select coalesce(sum(net_kobo), 0) into v_gross
    from guild_event_entries where event_id = p_event_id and status = 'success';
  else
    v_gross := v_event.cash_prize_kobo;
  end if;

  perform distribute_guild_revenue(
    p_guild_id := p_guild_id,
    p_gross_amount_kobo := v_gross,
    p_shares := p_shares,
    p_kind := 'event_revenue',
    p_source := 'event_sale',
    p_source_purchase_id := null,
    p_anthology_id := null,
    p_project_event_id := p_event_id,
    p_title := 'Guild event \u2014 ' || v_event.title
  );

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

revoke all on function settle_guild_event(uuid, uuid, jsonb) from public;
grant execute on function settle_guild_event(uuid, uuid, jsonb) to authenticated;

-- Safe to run anytime: is_platform_admin defaults to false for every existing profile (nobody
-- gains admin access on deployment), create_guild_event/settle_guild_event's host='guild'
-- branches are byte-for-byte the same logic as before, and is_inkroot_admin() still accepts a
-- null auth.uid() exactly as the original inline checks did, so the pre-existing
-- direct-service-role path is unaffected. Flip is_platform_admin on for a real staff account
-- the same way is_moderator is flipped on today: manually, e.g. via the Supabase SQL editor,
-- logged in as the project owner.
