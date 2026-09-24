-- Migration 112: guild treasury spends had no velocity limits, and any platform admin carried
-- Founder Guild treasury authority (production audit, High).
--
-- Two gaps, one migration:
--
-- A. No velocity limit on spends. spend_from_guild_treasury() only refuses an amount at or above
--    the ₦100,000 multi-approval threshold. Anyone holding Leader/Treasurer/Officer authority
--    (including a compromised session) could therefore call it repeatedly with sub-threshold
--    amounts and empty the treasury alone, never touching the multi-approval path. This adds:
--      1. A per-GUILD rate limit: 5 spend/propose calls per guild per 24 hours.
--      2. A rolling 24-hour cumulative cap of ₦300,000 on DIRECT (single-authorizer) spends per
--         guild, computed from the ledger itself under the guild's existing advisory lock so
--         two concurrent spends can't both read the pre-spend total.
--    Spends that legitimately need more go through propose_guild_treasury_spend(), which needs a
--    second approver — and, so a capped guild isn't stuck on small amounts, propose now also
--    accepts an amount UNDER the threshold when that amount would not fit inside the remaining
--    direct-spend allowance (it used to refuse anything under the threshold outright).
--
-- B. Founder Guild treasury authority rode on is_platform_admin. guild_treasury_role() made every
--    platform admin the Founder Guild's 'leader', so ordinary admin duties (moderation, event
--    approval, manual-withdrawal settlement) implicitly included the ability to authorize spends
--    from the Founder Guild's treasury. A new profiles.is_founder_guild_treasurer flag is now what
--    the Founder Guild branch checks, and it is locked exactly like is_platform_admin
--    (protect_admin_profile_columns): settable only by service_role / the SQL editor.
--
-- WHAT YOU MUST DO AFTER APPLYING B: nobody carries the new flag yet, so until you set it the
-- Founder Guild treasury cannot be spent from or approved against by anyone (it fails closed —
-- balances and contributions are unaffected). From the SQL editor, for each person who should
-- hold this authority:
--     update profiles set is_founder_guild_treasurer = true where id = '<auth-user-id>';
-- To keep today's behavior exactly (every current platform admin retains authority) instead,
-- run this once — though narrowing it is the point of the change:
--     update profiles set is_founder_guild_treasurer = true where is_platform_admin;
-- No in-app UI grants or revokes this flag (same as is_platform_admin's original grant).
-- Note it is independent of is_platform_admin: revoking someone's admin role does not clear it.
--
-- Design notes:
--   * The per-guild counter is NOT an action added to check_and_bump_rate_limit(). That function
--     is granted to `authenticated` and keys on auth.uid(); giving it a guild-id argument would let
--     any signed-in user call it directly with someone else's guild id and burn that guild's
--     quota (a denial-of-service on its treasury). The guild counter lives in its own table behind
--     check_and_bump_guild_rate_limit(), which no client role can execute — only the
--     security-definer spend functions below call it. Limits are server-side constants there, in
--     the same style as migration 98.
--   * The counter is bumped only after authorization, idempotent-replay and threshold checks, and
--     a call that later raises (insufficient balance, cap hit) rolls the bump back with the
--     transaction — so only spends that actually happen consume a slot, and an unauthorized caller
--     can never burn a guild's quota.
--   * The cap counts only DIRECT spends. Rows executed by approve_guild_treasury_spend() (linked
--     from guild_treasury_spend_requests.transaction_id) are excluded: they were approved by
--     multiple people, and counting them would let one large approved spend lock the guild out of
--     small direct ones for a day. Excluded by that link, not by idempotency_key, because the key
--     is client-supplied on the direct path.
--   * The limits are fixed-window (window opens at the first counted call), matching every other
--     limiter in this file.
--
-- Safe to run anytime: additive column/table, and the two spend functions only gain checks.
-- Every guild's existing behavior is unchanged until it exceeds 5 spend calls or ₦300,000 direct
-- spend in a day; the one deliberate loosening is propose accepting under-threshold amounts once
-- the direct allowance is exhausted.

-- ============================================================================================
-- 1. is_founder_guild_treasurer — the Founder Guild's own treasury authority flag.
-- ============================================================================================

alter table profiles add column if not exists is_founder_guild_treasurer boolean not null default false;

-- protect_admin_profile_columns — migration 43's version (the latest) plus one locked column.
-- `set search_path = public` is restated because create-or-replace would otherwise drop the
-- setting the hardening pass applied to this function with `alter function`.
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
  -- Same treatment as is_platform_admin immediately above: locked in every client path,
  -- including an admin acting on someone else's row (or their own).
  if new.is_founder_guild_treasurer is distinct from old.is_founder_guild_treasurer then
    new.is_founder_guild_treasurer := old.is_founder_guild_treasurer;
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
$$ language plpgsql security definer set search_path = public;

-- guild_treasury_role — migration 44's version (the latest); the only change is the Founder Guild
-- branch, which now requires is_founder_guild_treasurer instead of is_platform_admin.
create or replace function guild_treasury_role(p_guild_id uuid, p_user_id uuid default auth.uid())
returns text as $$
  select case
    when exists (
      select 1 from player_guilds g
      where g.id = p_guild_id
        and (
          (not g.is_founder_guild and g.owner_id = p_user_id)
          or (g.is_founder_guild and exists (
            select 1 from profiles p where p.id = p_user_id and p.is_founder_guild_treasurer
          ))
        )
    ) then 'leader'
    else (select m.role from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_user_id)
  end;
$$ language sql stable security definer set search_path = public;

-- ============================================================================================
-- 2. Per-guild rate limit
-- ============================================================================================

create table if not exists guild_rate_limits (
  guild_id uuid not null references player_guilds(id) on delete cascade,
  action text not null,
  window_start timestamptz not null default now(),
  call_count integer not null default 0,
  primary key (guild_id, action)
);

alter table guild_rate_limits enable row level security;
-- No policies at all: only ever touched through the function below.

create or replace function check_and_bump_guild_rate_limit(p_guild_id uuid, p_action text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_max_calls integer;
  v_window_seconds integer;
  v_window_start timestamptz;
  v_count integer;
begin
  -- Server-side limits. To change one, edit it here — never accept it from a caller.
  case p_action
    when 'spend_from_guild_treasury' then v_max_calls := 5; v_window_seconds := 86400;
    else
      raise exception 'Unknown rate limit action.';
  end case;

  perform pg_advisory_xact_lock(hashtext('guild_rate_limit:' || p_guild_id::text || ':' || p_action));

  select window_start, call_count into v_window_start, v_count
  from guild_rate_limits where guild_id = p_guild_id and action = p_action;

  if v_window_start is null or now() - v_window_start > make_interval(secs => v_window_seconds) then
    insert into guild_rate_limits (guild_id, action, window_start, call_count)
    values (p_guild_id, p_action, now(), 1)
    on conflict (guild_id, action) do update set window_start = now(), call_count = 1;
    return;
  end if;

  if v_count >= v_max_calls then
    raise exception 'This guild has reached its limit of % treasury spend requests in 24 hours. Try again later.', v_max_calls;
  end if;

  update guild_rate_limits set call_count = call_count + 1
  where guild_id = p_guild_id and action = p_action;
end;
$$;

-- Callable only from the security-definer spend/propose functions below (owner privileges).
revoke all on function check_and_bump_guild_rate_limit(uuid, text) from public, anon, authenticated;

-- ============================================================================================
-- 3. Rolling 24-hour cap on direct spends
-- ============================================================================================

-- ₦300,000. Like the multi-approval threshold, one definition every caller goes through.
create or replace function guild_treasury_direct_spend_cap_kobo()
returns bigint as $$
  select 30000000::bigint;
$$ language sql immutable;

revoke all on function guild_treasury_direct_spend_cap_kobo() from public, anon, authenticated;

-- Direct (single-authorizer) spends in the trailing 24 hours. Spends executed through
-- approve_guild_treasury_spend() are excluded by their link from guild_treasury_spend_requests —
-- see this migration's header.
create or replace function guild_treasury_direct_spent_24h_kobo(p_guild_id uuid)
returns bigint
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(t.amount_kobo), 0)::bigint
  from guild_treasury_transactions t
  where t.guild_id = p_guild_id
    and t.kind = 'spend'
    and t.status in ('pending', 'success')
    and t.created_at > now() - interval '24 hours'
    and not exists (select 1 from guild_treasury_spend_requests r where r.transaction_id = t.id);
$$;

revoke all on function guild_treasury_direct_spent_24h_kobo(uuid) from public, anon, authenticated;

-- ============================================================================================
-- 4. spend_from_guild_treasury / propose_guild_treasury_spend
-- ============================================================================================

-- spend_from_guild_treasury — migration 44's version (the latest) plus: the guild lock is taken
-- before the rate-limit and cap checks, the idempotency lookup is repeated once the lock is held
-- (so a concurrent replay returns the original row instead of being counted against the limits),
-- and the two new checks.
create or replace function spend_from_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_title text,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
  v_cap bigint;
begin
  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
  end if;
  if p_amount_kobo >= guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'Withdrawals of this size require multiple approvals — use propose_guild_treasury_spend instead.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  v_cap := guild_treasury_direct_spend_cap_kobo();
  if guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo > v_cap then
    raise exception 'This guild has reached its direct-spend limit of ₦% for a rolling 24 hours. Propose the spend for multi-approval, or try again later.',
      to_char(v_cap / 100, 'FM999,999,999');
  end if;

  if guild_treasury_available_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'debit', 'spend', p_amount_kobo, 'NGN', 'guild_treasury',
     'external', p_project_event_id, 'success', p_title, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

-- propose_guild_treasury_spend — migration 44's version (the latest) plus the same lock-first
-- ordering, the rate limit, and the widened "under threshold" rule described in the header.
create or replace function propose_guild_treasury_spend(
  p_guild_id uuid, p_amount_kobo bigint, p_title text, p_idempotency_key text default null
)
returns guild_treasury_spend_requests
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_spend_requests;
begin
  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'A spend request needs a title.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can propose a treasury spend.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));

  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  -- Under the threshold, a direct spend is the normal route — unless it wouldn't fit in what's
  -- left of this guild's 24-hour direct-spend allowance, in which case multi-approval is the way.
  if p_amount_kobo < guild_treasury_multi_approval_threshold_kobo()
     and guild_treasury_direct_spent_24h_kobo(p_guild_id) + p_amount_kobo <= guild_treasury_direct_spend_cap_kobo() then
    raise exception 'Amounts under the multi-approval threshold can be authorized directly with spend_from_guild_treasury.';
  end if;

  perform check_and_bump_guild_rate_limit(p_guild_id, 'spend_from_guild_treasury');

  if guild_treasury_available_kobo(p_guild_id) - guild_treasury_reserved_by_other_requests_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance once pending proposals are accounted for.';
  end if;

  insert into guild_treasury_spend_requests (guild_id, amount_kobo, title, requested_by, idempotency_key)
  values (p_guild_id, p_amount_kobo, trim(p_title), auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_spend_requests where idempotency_key = p_idempotency_key;
    return v_row;
  end if;

  insert into guild_treasury_spend_approvals (request_id, approver_id) values (v_row.id, auth.uid());
  return v_row;
end;
$$;

-- set_guild_treasury_role — migration 44's version (the latest), with only the Founder Guild
-- error message updated: it claimed every Inkroot admin carries full authority there, which is no
-- longer true.
create or replace function set_guild_treasury_role(p_guild_id uuid, p_member_id uuid, p_role text)
returns player_guild_members
language plpgsql security definer set search_path = public as $$
declare
  v_guild player_guilds%rowtype;
  v_row player_guild_members;
begin
  if p_role not in ('treasurer', 'officer', 'member') then
    raise exception 'Role must be treasurer, officer, or member.';
  end if;

  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    raise exception 'Guild not found.';
  end if;
  if v_guild.is_founder_guild then
    raise exception 'A Founder Guild has no single leader to delegate Treasurer/Officer roles — its treasury authority is held by the Inkroot admins flagged as Founder Guild treasurers.';
  end if;
  if auth.uid() <> v_guild.owner_id then
    raise exception 'Only the guild leader can assign treasury roles.';
  end if;
  if p_member_id = v_guild.owner_id then
    raise exception 'The guild leader''s own role cannot be changed here.';
  end if;

  update player_guild_members set role = p_role
  where guild_id = p_guild_id and user_id = p_member_id
  returning * into v_row;

  if not found then
    raise exception 'That writer is not a member of this guild.';
  end if;
  return v_row;
end;
$$;
