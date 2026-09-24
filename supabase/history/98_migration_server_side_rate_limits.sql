-- ============================================================================
-- 98_migration_server_side_rate_limits.sql
-- check_and_bump_rate_limit() used to take p_max_calls / p_window_seconds from its caller. It is
-- granted to `authenticated`, so any signed-in user could call it directly through PostgREST
-- (supabase.rpc) with limits of their own choosing — e.g. a huge p_max_calls, or a 1-second
-- p_window_seconds, which makes the "window expired" branch fire on nearly every call and resets
-- the counter that the Edge Functions rely on. The limits now live inside the function, keyed by
-- p_action; callers only name the action. Every limit below is exactly the value the callers
-- previously passed. Unknown actions are rejected, which also stops a client from filling
-- api_rate_limits with arbitrary action names.
-- ============================================================================

-- New signature. Same fixed-window + advisory-lock behavior as 96_migration_security_audit_fixes.sql.
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

-- enforce_user_storage_quota() (97) called the old three-argument form; re-created here with the
-- one-line call change only, before the old signature is dropped below.
create or replace function enforce_user_storage_quota()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_quota_bytes bigint := 209715200; -- 200 MB per user, combined across media + media-private
  v_current_bytes bigint;
  v_new_size bigint;
  v_owner uuid;
begin
  if new.bucket_id not in ('media', 'media-private') then
    return new;
  end if;

  v_owner := coalesce(new.owner, nullif(new.owner_id, '')::uuid);
  if v_owner is null then
    -- No identifiable uploader — shouldn't happen for a real client upload (both buckets'
    -- storage policies already require auth.uid() to match the folder's own user-id segment),
    -- but fail closed rather than let an unattributable row skip the quota check entirely.
    raise exception 'Upload rejected: could not identify the uploading user.';
  end if;

  -- Rate limit: the same per-user counter every rate-limited Edge Function already uses (see
  -- 96_migration_security_audit_fixes.sql) — 60 uploads/hour (defined inside
  -- check_and_bump_rate_limit, see 98) is well above normal cover/avatar usage while blocking a
  -- scripted upload loop. auth.uid() resolves correctly here because a Storage upload runs as a
  -- real authenticated request under the uploader's own JWT, not a service-role bypass.
  perform check_and_bump_rate_limit('storage_upload');

  -- Quota: total bytes this user already has stored across both buckets, serialized with an
  -- advisory lock so two uploads racing right at the boundary can't both read the same
  -- pre-insert total and both slip through.
  perform pg_advisory_xact_lock(hashtext('storage_quota:' || v_owner::text));

  v_new_size := coalesce((new.metadata->>'size')::bigint, 0);

  select coalesce(sum((metadata->>'size')::bigint), 0) into v_current_bytes
  from storage.objects
  where bucket_id in ('media', 'media-private') and owner = v_owner;

  if v_current_bytes + v_new_size > v_quota_bytes then
    raise exception 'Storage quota exceeded (200MB total) — delete some uploads to free up space.';
  end if;

  return new;
end;
$$;

-- Remove the caller-controlled overload. Without this, the old function would stay callable and
-- the fix would do nothing.
drop function if exists check_and_bump_rate_limit(text, integer, integer);
