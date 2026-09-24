-- Fix 1 & 2: pin search_path on the two SECURITY DEFINER trigger functions that were missing it
-- (mutable search_path on SECURITY DEFINER is a known Postgres/Supabase hijack vector).
alter function protect_admin_profile_columns() set search_path = public;
alter function stamp_report_resolution() set search_path = public;

-- Fix 3-6: shared per-user rate limiting for the edge functions that had no cap at all
-- (download-book, paystack-resolve-account, paystack-init-purchase, paystack-init-event-entry,
-- paystack-init-hosting-fee, paystack-init-pack-purchase). One small table + one callable
-- function, in the same style as enforce_fireside_post_cooldown()/enforce_content_report_rate_limit()
-- elsewhere in this schema, but usable from an edge function via .rpc() rather than tied to a
-- table insert, since several of these routes don't insert anything themselves.
create table if not exists api_rate_limits (
  user_id uuid not null references profiles(id) on delete cascade,
  action text not null,
  window_start timestamptz not null default now(),
  call_count integer not null default 0,
  primary key (user_id, action)
);

alter table api_rate_limits enable row level security;
-- No client-facing policies on purpose: this table is only ever touched through the
-- SECURITY DEFINER function below, never directly by a user's own queries.

-- Checks + atomically bumps a fixed-window per-user counter for `p_action`. Raises (blocking the
-- caller) once more than p_max_calls have been made inside the trailing p_window_seconds. The
-- advisory lock serializes concurrent calls from the same user+action so two requests racing
-- each other can't both read the same pre-increment count and both slip through.
create or replace function check_and_bump_rate_limit(p_action text, p_max_calls integer, p_window_seconds integer)
returns void as $$
declare
  v_uid uuid := auth.uid();
  v_window_start timestamptz;
  v_count integer;
begin
  if v_uid is null then
    raise exception 'Not signed in.';
  end if;

  perform pg_advisory_xact_lock(hashtext('api_rate_limit:' || v_uid::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from api_rate_limits where user_id = v_uid and action = p_action;

  if v_window_start is null or now() - v_window_start > (p_window_seconds || ' seconds')::interval then
    insert into api_rate_limits (user_id, action, window_start, call_count)
    values (v_uid, p_action, now(), 1)
    on conflict (user_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= p_max_calls then
    raise exception 'Too many requests — please slow down and try again shortly.';
  end if;

  update api_rate_limits set call_count = call_count + 1
  where user_id = v_uid and action = p_action;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function check_and_bump_rate_limit(text, integer, integer) to authenticated;
