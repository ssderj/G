-- Migration 34: hardens guild_treasury_transactions (33_migration_guild_treasury.sql) into the
-- permanent financial ledger it was always meant to be, rather than introducing a second table.
-- Everything below extends that same table in place — same id, same guild_id/member_id/
-- amount_kobo/status/created_at it already had, nothing renamed or moved.
--
-- Three gaps this closes:
--
-- 1. RECORD-KEEPING FIELDS. The row already recorded guild, member (when applicable), amount,
--    a kind, and a status/timestamp, but had no explicit currency, no explicit source/
--    destination (only inferable from bucket+direction+kind), and nothing to tie a row back to
--    the Anthology or Guild Event that generated it. `currency`, `source`, `destination`, and
--    `project_event_id` below are additive columns — no existing column changes meaning.
--
-- 2. IDEMPOTENCY. Neither RPC had any way to recognize a retried call as the same request — a
--    dropped connection after a successful insert, followed by a client retry, would move a
--    member's kobo twice. `idempotency_key` plus the on-conflict handling in both RPCs below
--    means the same request (same key) can be safely retried any number of times and only the
--    first attempt ever moves money; every retry just returns the original row.
--
-- 3. IMMUTABILITY. RLS already grants no client role an update/delete policy on this table (see
--    33_migration_guild_treasury.sql), which stops the app's own users from editing history —
--    but RLS doesn't apply to service_role or a human operator working directly against the
--    database, so nothing actually stopped a row from being altered or removed there. The
--    trigger at the bottom of this file closes that gap for real: it raises on ANY update or
--    delete, unconditionally, for every role including service_role and the table owner. A
--    financial ledger's whole value is being an unimpeachable record of what happened — once
--    this migration runs, the only way to change what a row says is to have never written it
--    that way, and the only way to correct a mistake is to insert a new row, never to rewrite an
--    old one. This does mean the `settled_at`/pending -> success transition 33_migration_
--    guild_treasury.sql reserved status for can no longer happen by updating the pending row in
--    place — a future async-settlement source needs its own append-only completion event
--    instead. That's a real constraint this migration accepts on purpose, not an oversight.
--
-- Safe to run anytime, including against a deployment with existing rows: every ADD COLUMN is
-- guarded with IF NOT EXISTS, the backfill below only touches rows that don't have source/
-- destination yet, and the function replacements only add new, defaulted trailing parameters —
-- see the DROP FUNCTION calls below for why they're dropped and recreated rather than
-- CREATE OR REPLACE'd (Postgres treats a changed argument list as a different function).

-- ============================================================================================
-- New columns
-- ============================================================================================

alter table guild_treasury_transactions add column if not exists currency text;
alter table guild_treasury_transactions add column if not exists source text;
alter table guild_treasury_transactions add column if not exists destination text;
alter table guild_treasury_transactions add column if not exists project_event_id uuid;
alter table guild_treasury_transactions add column if not exists idempotency_key text;

-- Only NGN moves through Inkroot today (see 32_migration_naira_payments.sql) — amount_kobo is
-- already NGN's minor unit, so this column records that explicitly rather than leaving it
-- implicit, without inventing multi-currency support that doesn't exist yet. Widening the check
-- constraint is the whole job if/when a second currency becomes real.
update guild_treasury_transactions set currency = 'NGN' where currency is null;
alter table guild_treasury_transactions alter column currency set default 'NGN';
alter table guild_treasury_transactions alter column currency set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guild_treasury_transactions_currency_check') then
    alter table guild_treasury_transactions
      add constraint guild_treasury_transactions_currency_check check (currency = 'NGN');
  end if;
end $$;

-- source/destination make explicit what was previously only inferable from bucket+direction+
-- kind together. Deliberately a fixed vocabulary, not free text, and deliberately set by the
-- RPCs themselves below rather than accepted as a client argument — same "never trust a
-- classification the client could lie about" stance as every other check in these two
-- functions. Every kind (including the three still-reserved ones from migration 33) has a
-- source/destination pair defined here already, so this table doesn't need another migration
-- when Anthologies/Guild Events start writing anthology_share/event_revenue rows for real.
update guild_treasury_transactions set
  source = case kind
    when 'contribution' then 'member_balance'
    when 'spend' then 'guild_treasury'
    when 'anthology_share' then 'anthology_sale'
    when 'event_revenue' then 'event_sale'
    when 'release_to_member' then 'member_earnings_held'
  end,
  destination = case kind
    when 'contribution' then 'guild_treasury'
    when 'spend' then 'external'
    when 'anthology_share' then 'member_earnings_held'
    when 'event_revenue' then 'guild_treasury'
    when 'release_to_member' then 'member_balance'
  end
where source is null or destination is null;

alter table guild_treasury_transactions alter column source set not null;
alter table guild_treasury_transactions alter column destination set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guild_treasury_transactions_source_check') then
    alter table guild_treasury_transactions add constraint guild_treasury_transactions_source_check
      check (source in ('member_balance', 'guild_treasury', 'anthology_sale', 'event_sale', 'member_earnings_held'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'guild_treasury_transactions_destination_check') then
    alter table guild_treasury_transactions add constraint guild_treasury_transactions_destination_check
      check (destination in ('guild_treasury', 'member_balance', 'member_earnings_held', 'external'));
  end if;
end $$;

-- project_event_id: which Anthology or Guild Event this row belongs to, when it belongs to one
-- (a plain contribution or an owner spend has none — null is the normal case today). No foreign
-- key yet, on purpose, matching this table's existing pattern for reserved-but-not-yet-real
-- concepts (see member_id/bucket='member' in 33_migration_guild_treasury.sql, written before
-- anything populated it): Anthologies and Guild Events don't have tables of their own yet, so
-- there's nothing to reference. Add the FK when those tables exist instead of widening this
-- migration's scope to build them here.
comment on column guild_treasury_transactions.project_event_id is
  'The Anthology or Guild Event this transaction belongs to, if any. No FK yet -- neither feature has a table of its own today; add one once they do.';

-- idempotency_key: a caller-supplied token identifying one logical request, not a row id. Left
-- nullable (a call made without one gets no replay protection, same as before this migration)
-- rather than required, so this stays backward-compatible with anything that doesn't pass one.
-- The partial unique index (not a plain unique constraint) is what lets that be true: Postgres
-- unique indexes/constraints already treat every NULL as distinct from every other NULL, so a
-- plain `unique` would already allow unlimited null rows -- the explicit `where idempotency_key
-- is not null` isn't strictly required for that reason alone, but it's added anyway so the
-- index only ever has to cover the rows that actually carry a key, keeping it smaller.
create unique index if not exists guild_treasury_transactions_idempotency_key_idx
  on guild_treasury_transactions (idempotency_key) where idempotency_key is not null;

create index if not exists guild_treasury_transactions_project_event_idx
  on guild_treasury_transactions (project_event_id) where project_event_id is not null;

-- ============================================================================================
-- Immutability — the core of "permanent ledger". Fires for every role, unconditionally,
-- regardless of any RLS policy (RLS governs whether a statement is allowed to run at all for a
-- given role; this trigger governs what happens once it runs, and applies even to roles RLS
-- doesn't restrict, i.e. service_role). Insert is untouched -- this only blocks update/delete.
-- ============================================================================================

create or replace function forbid_guild_treasury_transactions_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'guild_treasury_transactions is a permanent, append-only ledger -- rows can never be updated or deleted. Insert a new row to record a correction or reversal instead.';
end;
$$;

drop trigger if exists guild_treasury_transactions_immutable on guild_treasury_transactions;
create trigger guild_treasury_transactions_immutable
  before update or delete on guild_treasury_transactions
  for each row execute function forbid_guild_treasury_transactions_mutation();

-- ============================================================================================
-- Writes, redone for idempotency + the new columns. Dropped and recreated (not CREATE OR
-- REPLACE) because both gain new trailing parameters -- Postgres identifies a function by its
-- full argument list, so a changed argument list is a different function as far as CREATE OR
-- REPLACE is concerned, and would leave the old 3-argument version callable alongside this one
-- rather than actually replacing it.
--
-- Idempotency shape, identical in both: if the caller supplies p_idempotency_key, look for a
-- row with that key FIRST, before taking any lock or touching a balance -- the common case (a
-- plain retry of an already-completed request) is then just one cheap read, no lock contention,
-- no risk of a second balance check giving a different answer than the first. The insert itself
-- also carries `on conflict (idempotency_key) where idempotency_key is not null do nothing`, as
-- a second layer, for the rare case where two calls carrying the same key genuinely race each
-- other and both pass the first check before either has inserted -- exactly one of them wins the
-- insert; the loser's `if not found` branch reads back the winner's row and returns that instead
-- of erroring, so both callers see the same successful result either way.
-- ============================================================================================

drop function if exists contribute_to_guild_treasury(uuid, bigint, text);
drop function if exists spend_from_guild_treasury(uuid, bigint, text);

-- A member moves part of their own real, already-earned balance into their guild's purse.
create or replace function contribute_to_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_note text default null,
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
  if not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this guild.';
  end if;
  -- Serializes concurrent contributions from the same writer so two simultaneous requests can't
  -- both read the same starting balance and together overdraw it.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if author_balance_kobo(auth.uid()) < p_amount_kobo then
    raise exception 'That would exceed your available balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'credit', 'contribution', p_amount_kobo, 'NGN', 'member_balance',
     'guild_treasury', p_project_event_id, 'success', p_note, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

-- The guild owner authorizes a spend from the guild's own available funds. Scoped to
-- player_guilds.owner_id — the one real, server-known authority for a Player Guild today (see
-- 33_migration_guild_treasury.sql).
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
  if not exists (select 1 from player_guilds g where g.id = p_guild_id and g.owner_id = auth.uid()) then
    raise exception 'Only the guild owner can authorize a treasury spend.';
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

revoke all on function contribute_to_guild_treasury(uuid, bigint, text, text, uuid) from public;
revoke all on function spend_from_guild_treasury(uuid, bigint, text, text, uuid) from public;
grant execute on function contribute_to_guild_treasury(uuid, bigint, text, text, uuid) to authenticated;
grant execute on function spend_from_guild_treasury(uuid, bigint, text, text, uuid) to authenticated;
