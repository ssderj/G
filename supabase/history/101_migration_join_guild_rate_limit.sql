-- Migration 101: rate-limit Player Guild invite-code guessing (production audit).
--
-- The bug: join_player_guild_by_code() had no rate limit at all, and invite_code is only 8 hex
-- characters (32 bits, see player_guilds.invite_code). Any signed-in account could script guesses
-- through supabase.rpc at network speed; a hit joins a private guild — and membership is the
-- read gate for that guild's guild-only books (see the "guild members read their guild's book
-- content" policies), so a lucky guess is free access to guild-exclusive manuscripts.
--
-- The fix: a new server-side action 'join_guild' (20 attempts/hour/user — far above any real
-- use) in check_and_bump_rate_limit(), called at the top of join_player_guild_by_code(). A wrong
-- code now returns no rows rather than raising, so the failed attempt's counter increment is
-- actually committed (a raise would roll it back). Client behavior is unchanged: the client
-- already calls .single() and falls back to "No guild found with that invite code." on any
-- non-message error. Both functions are otherwise byte-for-byte their previous definitions.
-- Safe to run anytime; no data changes.

create or replace function check_and_bump_rate_limit(p_action text)
returns void as $$
declare
  v_uid uuid := auth.uid();
  v_max_calls integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  -- Server-side limits. To change one, edit it here — never accept it from the caller.
  case p_action
    when 'init_purchase'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'download_book'        then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_event_entry'     then v_max_calls := 20; v_window_seconds := 3600;
    when 'init_hosting_fee'     then v_max_calls := 10; v_window_seconds := 3600;
    when 'list_banks'           then v_max_calls := 30; v_window_seconds := 3600;
    when 'init_pack_purchase'   then v_max_calls := 20; v_window_seconds := 3600;
    when 'resolve_bank_account' then v_max_calls := 10; v_window_seconds := 3600;
    when 'storage_upload'       then v_max_calls := 60; v_window_seconds := 3600;
    when 'join_guild'           then v_max_calls := 20; v_window_seconds := 3600;
    else
      raise exception 'Unknown rate limit action.';
  end case;

  perform pg_advisory_xact_lock(hashtext('api_rate_limit:' || v_uid::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from api_rate_limits where user_id = v_uid and action = p_action;

  if v_window_start is null or now() - v_window_start > (v_window_seconds || ' seconds')::interval then
    insert into api_rate_limits (user_id, action, window_start, call_count)
    values (v_uid, p_action, now(), 1)
    on conflict (user_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= v_max_calls then
    raise exception 'Too many requests — please slow down and try again shortly.';
  end if;

  update api_rate_limits set call_count = call_count + 1
  where user_id = v_uid and action = p_action;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function check_and_bump_rate_limit(text) to authenticated;

create or replace function join_player_guild_by_code(p_code text)
returns table (id uuid, name text, motto text, crest_url text, owner_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  -- Counted BEFORE the lookup, and a miss below returns no rows instead of raising: a raised
  -- exception would roll back this function's own transaction, un-counting exactly the failed
  -- guesses the limit exists to catch.
  perform check_and_bump_rate_limit('join_guild');

  select * into v_guild from player_guilds g where g.invite_code = lower(p_code);
  if not found then
    return; -- no rows -> the client's .single() errors and shows "No guild found with that invite code."
  end if;

  insert into player_guild_members (guild_id, user_id)
  values (v_guild.id, auth.uid())
  on conflict (guild_id, user_id) do nothing;

  return query select v_guild.id, v_guild.name, v_guild.motto, v_guild.crest_url, v_guild.owner_id;
end;
$$;

grant execute on function join_player_guild_by_code(text) to authenticated;
