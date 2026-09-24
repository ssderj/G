-- Migration 44: Guild Treasury permissions — Guild Leader / Treasurer / Officers / Members.
--
-- Everything guild-treasury-related up to now (33/34/37/41_migration_*.sql) only ever recognized
-- one authority over a Player Guild's own funds: player_guilds.owner_id (see 33's header —
-- "GO_PERMISSIONS' richer Council/rung system has no server-side counterpart yet"). This
-- migration is that server-side counterpart, scoped to the treasury specifically:
--
--   - Guild Leader — the existing owner_id. Still the one authority that can grant/revoke the
--     roles below; not stored as a role value on player_guild_members, so there is never a
--     second row that could disagree with player_guilds.owner_id about who leads the guild.
--   - Treasurer / Officer — new, explicit roles on player_guild_members.role, assignable only by
--     the Guild Leader, authorized to manage guild-owned funds exactly like the Leader today.
--   - Member — the default for everyone else. Unchanged: a member's own held-in-trust earnings
--     (bucket = 'member' in guild_treasury_transactions) were already only ever visible to and
--     movable by that member themselves (see 33 and 41's RLS policies and security-definer
--     RPCs, all keyed to auth.uid()) — nothing here touches that, and nothing here widens who
--     can see or move a 'member'-bucket row. A Leader/Treasurer/Officer's extra authority below
--     is strictly over the 'guild' bucket (money the guild collectively owns), never the
--     'member' bucket (money merely held in the guild's trust on a member's own behalf). That
--     separation is what makes "never allow one unauthorized user to transfer member-owned
--     earnings" true by construction, not just by convention: there is no function in this
--     migration, or any before it, that can move a 'member'-bucket row for anyone but that row's
--     own member_id.
--
-- Also added: multi-approval for large guild-owned-fund withdrawals. A single Leader/Treasurer/
-- Officer can still authorize a spend up to guild_treasury_multi_approval_threshold_kobo()
-- directly (spend_from_guild_treasury, unchanged in spirit from 33/34 — just re-scoped to any
-- authorized role instead of owner_id alone). At or above that threshold, spend_from_guild_
-- treasury refuses and the caller must go through propose_guild_treasury_spend() +
-- approve_guild_treasury_spend(), which requires a second, distinct authorized approver before
-- a kobo actually moves.
--
-- Safe to run anytime, including against a deployment with existing rows: the new role column
-- defaults every existing membership row to 'member' (nobody gains Treasurer/Officer authority
-- on deployment — the Leader has to grant it explicitly afterward), and every function below is
-- created with or-replace or if-not-exists.

-- ============================================================================================
-- player_guild_members.role — Treasurer/Officer/Member only. 'leader' is deliberately not a
-- valid value here: leadership is player_guilds.owner_id, exactly as it already was, so there's
-- never a second, independent place that could claim someone else is the guild's leader.
-- ============================================================================================

alter table player_guild_members add column if not exists role text not null default 'member';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_guild_members_role_check') then
    alter table player_guild_members
      add constraint player_guild_members_role_check check (role in ('treasurer', 'officer', 'member'));
  end if;
end $$;

-- No update policy is added for player_guild_members here, on purpose — same "no client write
-- policy, only a security-definer RPC that re-derives authority server-side" stance as
-- guild_treasury_transactions itself. A client cannot promote themselves (or anyone else) to
-- Treasurer/Officer by writing to this table directly; see set_guild_treasury_role() below.

-- ============================================================================================
-- Authority checks — the one place "is this caller allowed to manage guild-owned funds" is
-- decided, so spend_from_guild_treasury/propose_guild_treasury_spend/approve_guild_treasury_
-- spend all agree with each other and with whatever the UI displays.
-- ============================================================================================

-- 'leader' | 'treasurer' | 'officer' | 'member' | null (not a member of this guild at all).
create or replace function guild_treasury_role(p_guild_id uuid, p_user_id uuid default auth.uid())
returns text as $$
  select case
    when exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = p_user_id) then 'leader'
    else (select m.role from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_user_id)
  end;
$$ language sql stable security definer set search_path = public;

create or replace function is_guild_treasury_authorized(p_guild_id uuid, p_user_id uuid default auth.uid())
returns boolean as $$
  select guild_treasury_role(p_guild_id, p_user_id) in ('leader', 'treasurer', 'officer');
$$ language sql stable security definer set search_path = public;

revoke all on function guild_treasury_role(uuid, uuid) from public;
revoke all on function is_guild_treasury_authorized(uuid, uuid) from public;
grant execute on function guild_treasury_role(uuid, uuid) to authenticated;
grant execute on function is_guild_treasury_authorized(uuid, uuid) to authenticated;

-- Only the Guild Leader may grant/revoke Treasurer or Officer. Deliberately cannot target the
-- Leader's own membership row or set role = 'leader' — leadership only ever changes by
-- transferring player_guilds.owner_id itself (no feature does that today), never through this
-- function, so there's exactly one place ownership can ever be decided.
create or replace function set_guild_treasury_role(p_guild_id uuid, p_member_id uuid, p_role text)
returns player_guild_members
language plpgsql security definer set search_path = public as $$
declare
  v_owner uuid;
  v_row player_guild_members;
begin
  if p_role not in ('treasurer', 'officer', 'member') then
    raise exception 'Role must be treasurer, officer, or member.';
  end if;

  select owner_id into v_owner from player_guilds where id = p_guild_id;
  if v_owner is null then
    raise exception 'Guild not found.';
  end if;
  if auth.uid() <> v_owner then
    raise exception 'Only the guild leader can assign treasury roles.';
  end if;
  if p_member_id = v_owner then
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

revoke all on function set_guild_treasury_role(uuid, uuid, text) from public;
grant execute on function set_guild_treasury_role(uuid, uuid, text) to authenticated;

-- ============================================================================================
-- spend_from_guild_treasury — widened from "owner_id only" (33/34_migration_*.sql) to any
-- authorized role, and now refuses outright at or above the multi-approval threshold rather than
-- letting one person move a large sum alone. Same signature as 34_migration_guild_treasury_
-- ledger_hardening.sql left it (create-or-replace is enough; nothing here changes the argument
-- list), so every existing caller (guild-treasury.js's spendFromGuildTreasury) keeps working
-- unchanged for amounts under the threshold.
-- ============================================================================================

-- ₦100,000. A guild's own choice of "large" isn't configurable yet — same "reserved, not
-- invented" posture as everything else in this table that isn't live yet (see 33's header) —
-- but every caller of this threshold goes through this one function, so making it configurable
-- later (e.g. a per-guild setting) only ever needs one definition changed.
create or replace function guild_treasury_multi_approval_threshold_kobo()
returns bigint as $$
  select 10000000::bigint;
$$ language sql immutable;

revoke all on function guild_treasury_multi_approval_threshold_kobo() from public;
grant execute on function guild_treasury_multi_approval_threshold_kobo() to authenticated;

create or replace function spend_from_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_title text,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
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

-- ============================================================================================
-- Multi-approval spend requests — the large-withdrawal path. A pending request reserves its
-- amount against the guild's available balance (see the "reserved" subquery in both RPCs below)
-- so two large proposals can't both be approved against the same money; it stops reserving the
-- instant it's executed or cancelled.
-- ============================================================================================

create table if not exists guild_treasury_spend_requests (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  amount_kobo bigint not null check (amount_kobo > 0),
  title text not null,
  requested_by uuid not null references auth.users(id) on delete cascade,
  required_approvals int not null default 2 check (required_approvals >= 2),
  status text not null default 'pending' check (status in ('pending', 'executed', 'cancelled')),
  idempotency_key text,
  transaction_id uuid references guild_treasury_transactions(id),
  created_at timestamptz not null default now(),
  decided_at timestamptz
);

alter table guild_treasury_spend_requests enable row level security;

-- Same transparency stance as guild-owned guild_treasury_transactions rows: every guild member
-- can see a proposed spend, not just the authorized roles who can act on it — the actual
-- authority check happens inside the RPCs below, not in RLS.
create policy "guild members read guild treasury spend requests" on guild_treasury_spend_requests
  for select using (
    exists (
      select 1 from player_guild_members m
      where m.guild_id = guild_treasury_spend_requests.guild_id and m.user_id = auth.uid()
    )
  );

-- No insert/update/delete policy for any client role — every write goes through
-- propose_guild_treasury_spend()/approve_guild_treasury_spend()/cancel_guild_treasury_spend_
-- request() below, exactly the same "server re-checks everything" posture as
-- guild_treasury_transactions itself.

create index if not exists guild_treasury_spend_requests_guild_status_idx
  on guild_treasury_spend_requests (guild_id, status, created_at desc);
create unique index if not exists guild_treasury_spend_requests_idempotency_key_idx
  on guild_treasury_spend_requests (idempotency_key) where idempotency_key is not null;

create table if not exists guild_treasury_spend_approvals (
  request_id uuid not null references guild_treasury_spend_requests(id) on delete cascade,
  approver_id uuid not null references auth.users(id) on delete cascade,
  approved_at timestamptz not null default now(),
  primary key (request_id, approver_id)
);

alter table guild_treasury_spend_approvals enable row level security;

create policy "guild members read spend approvals" on guild_treasury_spend_approvals
  for select using (
    exists (
      select 1 from guild_treasury_spend_requests r
      join player_guild_members m on m.guild_id = r.guild_id and m.user_id = auth.uid()
      where r.id = guild_treasury_spend_approvals.request_id
    )
  );

-- No insert/update/delete policy here either — approve_guild_treasury_spend() below is the only
-- writer.

-- A pending request's own amount, not-yet-executed, reserved against the guild's available
-- balance so a second proposal can't be approved against money the first one is already
-- claiming. Excludes p_exclude_request_id so a request can check "everyone else's" reservation
-- without double-counting its own.
create or replace function guild_treasury_reserved_by_other_requests_kobo(p_guild_id uuid, p_exclude_request_id uuid default null)
returns bigint as $$
  select coalesce(sum(amount_kobo), 0) from guild_treasury_spend_requests
  where guild_id = p_guild_id and status = 'pending'
    and (p_exclude_request_id is null or id <> p_exclude_request_id);
$$ language sql stable security definer set search_path = public;

revoke all on function guild_treasury_reserved_by_other_requests_kobo(uuid, uuid) from public;
grant execute on function guild_treasury_reserved_by_other_requests_kobo(uuid, uuid) to authenticated;

-- Any authorized role (Leader/Treasurer/Officer) may propose a large spend. The proposer is
-- recorded as its first approval automatically (inserted right below, in the same transaction) —
-- a solo proposal can never execute itself, since required_approvals is at least 2 and the
-- primary key on guild_treasury_spend_approvals stops the same person voting twice.
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
  if p_amount_kobo < guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'Amounts under the multi-approval threshold can be authorized directly with spend_from_guild_treasury.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));
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

-- A second (or later) authorized role approves. Once enough distinct approvals exist, this
-- executes the spend itself — inserting into guild_treasury_transactions exactly like
-- spend_from_guild_treasury does, tagged with an idempotency key derived from the request's own
-- id so the same request can never execute twice even if two approvals raced each other to be
-- "the one that tips it over".
create or replace function approve_guild_treasury_spend(p_request_id uuid)
returns guild_treasury_spend_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req guild_treasury_spend_requests;
  v_txn guild_treasury_transactions;
  v_approval_count int;
begin
  select * into v_req from guild_treasury_spend_requests where id = p_request_id for update;
  if not found then
    raise exception 'Spend request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This spend request has already been decided.';
  end if;
  if not is_guild_treasury_authorized(v_req.guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can approve a treasury spend.';
  end if;

  insert into guild_treasury_spend_approvals (request_id, approver_id)
  values (p_request_id, auth.uid())
  on conflict (request_id, approver_id) do nothing;

  select count(*) into v_approval_count from guild_treasury_spend_approvals where request_id = p_request_id;
  if v_approval_count < v_req.required_approvals then
    return v_req; -- still pending, one more approval recorded
  end if;

  perform pg_advisory_xact_lock(hashtext(v_req.guild_id::text));
  if guild_treasury_available_kobo(v_req.guild_id)
     - guild_treasury_reserved_by_other_requests_kobo(v_req.guild_id, p_request_id) < v_req.amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance — cancel or wait for funds before it can execute.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     status, title, created_by, idempotency_key)
  values
    (v_req.guild_id, 'guild', null, 'debit', 'spend', v_req.amount_kobo, 'NGN', 'guild_treasury',
     'external', 'success', v_req.title, v_req.requested_by, 'spend_request:' || p_request_id::text)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_txn;

  if not found then
    select * into v_txn from guild_treasury_transactions where idempotency_key = 'spend_request:' || p_request_id::text;
  end if;

  update guild_treasury_spend_requests
  set status = 'executed', transaction_id = v_txn.id, decided_at = now()
  where id = p_request_id
  returning * into v_req;

  return v_req;
end;
$$;

-- Lets the proposer or the guild leader stand a pending proposal down (e.g. it's no longer
-- needed, or funds are wanted elsewhere) so it stops reserving against the available balance.
-- Never allowed once executed or already cancelled — this only ever moves 'pending' -> 'cancelled'.
create or replace function cancel_guild_treasury_spend_request(p_request_id uuid)
returns guild_treasury_spend_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req guild_treasury_spend_requests;
begin
  select * into v_req from guild_treasury_spend_requests where id = p_request_id for update;
  if not found then
    raise exception 'Spend request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This spend request has already been decided.';
  end if;
  if auth.uid() <> v_req.requested_by
     and not exists (select 1 from player_guilds g where g.id = v_req.guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the person who proposed this spend, or the guild leader, can cancel it.';
  end if;

  update guild_treasury_spend_requests set status = 'cancelled', decided_at = now()
  where id = p_request_id
  returning * into v_req;
  return v_req;
end;
$$;

revoke all on function propose_guild_treasury_spend(uuid, bigint, text, text) from public;
revoke all on function approve_guild_treasury_spend(uuid) from public;
revoke all on function cancel_guild_treasury_spend_request(uuid) from public;
grant execute on function propose_guild_treasury_spend(uuid, bigint, text, text) to authenticated;
grant execute on function approve_guild_treasury_spend(uuid) to authenticated;
grant execute on function cancel_guild_treasury_spend_request(uuid) to authenticated;

-- Safe to run anytime — see this migration's header.
