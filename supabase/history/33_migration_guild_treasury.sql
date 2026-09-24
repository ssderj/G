-- Migration 33: Guild Treasury — a real, server-authoritative money pot for a Player Guild.
--
-- Replaces GuildOrderScreen's GoTreasuryTab "Guild Coin" — a per-device, locally-stored number
-- (`Math.round(guildReputation / 8) - treasurySpent`, see guild-order.jsx) that wasn't real
-- currency and could be set to anything by editing local storage. This migration is what makes
-- it real, following the exact pattern purchases/withdrawals/author_balance_kobo already
-- established in 32_migration_naira_payments.sql:
--   - one append-only ledger table, not a stored/incrementable balance column
--   - every balance is a `stable security definer` SQL function derived from that ledger, so
--     there is nothing for a client write to desync from the truth
--   - no client insert/update/delete policy on the ledger at all — every financial change goes
--     through a `security definer` RPC that re-checks membership/ownership and the real balance
--     itself, server-side, before writing a row
--
-- Scoped to Player Guilds only (`player_guilds` / `player_guild_members`), same scope cut Phase 6
-- made for guild_member_stats: a Founder Guild's roster is still a simulated presence (see
-- guild-order.jsx's HONESTY NOTE), so there's no real membership to check spend authorization or
-- ledger visibility against yet. GoTreasuryTab keeps its existing simulated preview for Founder
-- Guilds and for anyone signed out; only a real, signed-in Player Guild member gets real numbers.
--
-- The ledger separates two independent things that were conflated in the old fake balance:
--   1. WHO the money belongs to — `bucket`: 'guild' (the guild's own collective purse, spendable
--      by its owner) vs 'member' (a specific member's own earnings, just held here in trust —
--      e.g. a future Anthology sale's per-contributor share once Anthologies exists to write one;
--      reserved now, not wired to a real source yet, same "reserved, not invented" policy as
--      GUILD_REPUTATION_SOURCES' non-live rows).
--   2. WHETHER it's settled — `status`: 'pending' vs 'success' (mirrors purchases/withdrawals'
--      own pending -> success/failed lifecycle for anything that ever needs to wait on an async
--      settlement; every row this migration's own RPCs write is synchronous, so they insert
--      'success' directly, but the column exists for a future source that isn't).
--
-- The only real, live way money enters a guild's treasury today is a member voluntarily moving
-- part of their own actual Naira earnings into their guild's purse (contribute_to_guild_treasury
-- below) — genuinely real money, debited from that member's own author_balance_kobo the same
-- instant it's credited here, not a second, disconnected pot. Anthology-share and event-revenue
-- credit sources are reserved in the `kind` check below for when those features exist to write
-- real ones; nothing fabricates a balance from either today.

-- ============================================================================================
-- guild_treasury_transactions — the ledger. One row per financial event touching a guild's
-- treasury. Every balance this migration exposes is computed FROM this table, never stored
-- separately, so there is no ledger/balance pair that can ever drift apart.
-- ============================================================================================

create table if not exists guild_treasury_transactions (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  bucket text not null check (bucket in ('guild', 'member')),
  -- Set iff bucket = 'member' — whose earnings this row is. Null for 'guild' rows: that money
  -- belongs to the guild collectively, not to any one member.
  member_id uuid references auth.users(id) on delete set null,
  direction text not null check (direction in ('credit', 'debit')),
  -- contribution      -> a member moving their own real earnings into the guild's purse (live)
  -- spend             -> a guild-owned-funds withdrawal authorized by the guild owner (live)
  -- anthology_share   -> a contributor's cut of an anthology sale (reserved for Anthologies)
  -- event_revenue     -> revenue from a Guild Event (reserved for Guild Events)
  -- release_to_member -> a member-bucket balance paid back out to that member's own
  --                      author_balance_kobo (reserved — no feature settles member earnings out
  --                      of a guild treasury yet, so nothing writes this kind today)
  kind text not null check (kind in ('contribution', 'spend', 'anthology_share', 'event_revenue', 'release_to_member')),
  amount_kobo bigint not null check (amount_kobo > 0),
  status text not null default 'success' check (status in ('pending', 'success', 'failed')),
  title text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  check ((bucket = 'member') = (member_id is not null))
);

alter table guild_treasury_transactions enable row level security;

-- Every guild member can see the guild's own shared ledger — same "real, checked membership"
-- shape as guild_member_stats' select policy, not just "signed in".
create policy "guild members read guild-owned treasury transactions" on guild_treasury_transactions
  for select using (
    bucket = 'guild'
    and exists (
      select 1 from player_guild_members m
      where m.guild_id = guild_treasury_transactions.guild_id and m.user_id = auth.uid()
    )
  );

-- A member-bucket row is that member's own earnings, not the guild's — visible only to them
-- (and to the guild owner via the RPCs below, which run as security definer), same privacy
-- stance purchases/withdrawals already take on an individual's own money.
create policy "a member reads their own member-earnings treasury rows" on guild_treasury_transactions
  for select using (bucket = 'member' and member_id = auth.uid());

-- No insert/update/delete policy for any client role, on purpose: every write below goes
-- through contribute_to_guild_treasury()/spend_from_guild_treasury(), which re-check membership,
-- ownership, and the real balance server-side before writing anything. A client cannot move a
-- kobo by writing to this table directly.

create index if not exists guild_treasury_transactions_guild_id_idx
  on guild_treasury_transactions (guild_id, created_at desc);
create index if not exists guild_treasury_transactions_member_id_idx
  on guild_treasury_transactions (member_id) where member_id is not null;

-- ============================================================================================
-- Balances — derived, not stored. Mirrors author_balance_kobo's own reasoning exactly (see
-- 32_migration_naira_payments.sql): there is no ledger balance that can ever drift, because
-- there is no ledger balance — only a query over guild_treasury_transactions.
-- ============================================================================================

-- Guild-owned funds: everything the guild has ever actually earned into its own bucket
-- (lifetime settled credits). This is the guild's total treasury income, not what's left to
-- spend — see guild_treasury_available_kobo for that.
create or replace function guild_treasury_owned_kobo(p_guild_id uuid)
returns bigint as $$
  select coalesce(sum(amount_kobo), 0) from guild_treasury_transactions
  where guild_id = p_guild_id and bucket = 'guild' and direction = 'credit' and status = 'success';
$$ language sql stable security definer set search_path = public;

-- Available funds: guild-owned funds minus every guild-bucket debit already spent or in flight
-- — what the guild can actually authorize a new spend against right now.
create or replace function guild_treasury_available_kobo(p_guild_id uuid)
returns bigint as $$
  select
    guild_treasury_owned_kobo(p_guild_id)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where guild_id = p_guild_id and bucket = 'guild' and direction = 'debit'
                and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

-- Pending funds: anything, in either bucket, still waiting on settlement for this guild.
create or replace function guild_treasury_pending_kobo(p_guild_id uuid)
returns bigint as $$
  select coalesce(sum(amount_kobo), 0) from guild_treasury_transactions
  where guild_id = p_guild_id and status = 'pending';
$$ language sql stable security definer set search_path = public;

-- Member earnings: total currently held in this guild's treasury on behalf of members
-- collectively (settled member-bucket credits minus any already released back out) — money
-- that passed through the guild but belongs to individual writers, not the guild itself.
create or replace function guild_treasury_member_earnings_kobo(p_guild_id uuid)
returns bigint as $$
  select
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where guild_id = p_guild_id and bucket = 'member' and direction = 'credit' and status = 'success'), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where guild_id = p_guild_id and bucket = 'member' and direction = 'debit'
                and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

-- One round trip for the whole summary a Treasury tab needs. Also returns the caller's own
-- member-bucket balance within this guild specifically (memberEarningsMineKobo) alongside the
-- guild-wide member_earnings total, since "your own held earnings" and "everyone's held
-- earnings" are both meaningful and different numbers.
create or replace function guild_treasury_summary(p_guild_id uuid)
returns table (
  guild_owned_kobo bigint,
  available_kobo bigint,
  pending_kobo bigint,
  member_earnings_kobo bigint,
  member_earnings_mine_kobo bigint
)
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this guild.';
  end if;
  return query select
    guild_treasury_owned_kobo(p_guild_id),
    guild_treasury_available_kobo(p_guild_id),
    guild_treasury_pending_kobo(p_guild_id),
    guild_treasury_member_earnings_kobo(p_guild_id),
    (
      coalesce((select sum(amount_kobo) from guild_treasury_transactions
                where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid()
                  and direction = 'credit' and status = 'success'), 0)
      -
      coalesce((select sum(amount_kobo) from guild_treasury_transactions
                where guild_id = p_guild_id and bucket = 'member' and member_id = auth.uid()
                  and direction = 'debit' and status in ('pending', 'success')), 0)
    );
end;
$$;

revoke all on function guild_treasury_owned_kobo(uuid) from public;
revoke all on function guild_treasury_available_kobo(uuid) from public;
revoke all on function guild_treasury_pending_kobo(uuid) from public;
revoke all on function guild_treasury_member_earnings_kobo(uuid) from public;
revoke all on function guild_treasury_summary(uuid) from public;
grant execute on function guild_treasury_owned_kobo(uuid) to authenticated;
grant execute on function guild_treasury_available_kobo(uuid) to authenticated;
grant execute on function guild_treasury_pending_kobo(uuid) to authenticated;
grant execute on function guild_treasury_member_earnings_kobo(uuid) to authenticated;
grant execute on function guild_treasury_summary(uuid) to authenticated;

-- ============================================================================================
-- author_balance_kobo — extended in place (same function, same signature, still the one place a
-- writer's withdrawable balance is computed) to also subtract their own successful/pending
-- contributions into any guild treasury. Without this, a contribution would create money: the
-- kobo would be credited to the guild's bucket AND still count toward the member's own
-- withdrawable balance, spendable twice. This keeps it the single source of truth Phase 32's own
-- comment describes ("no separate ledger balance that can ever drift") now that a second
-- withdrawal-shaped drain on a member's earnings exists.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(author_amount_kobo) from purchases
              where author_id = check_user_id and status = 'success'), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

-- ============================================================================================
-- Writes — the only two ways a kobo moves in or out of a guild treasury today. Both are
-- `security definer` so they can check the caller's real balance/ownership against tables the
-- caller's own RLS wouldn't otherwise expose, but both start by re-deriving every fact they act
-- on (membership, ownership, current balance) from the database itself — never from an argument
-- the client could lie about beyond the amount it's requesting.
-- ============================================================================================

-- A member moves part of their own real, already-earned balance into their guild's purse.
-- Real money leaving one honest total (author_balance_kobo) and landing in another
-- (guild_treasury_owned_kobo) in the same transaction — nothing is created or destroyed.
create or replace function contribute_to_guild_treasury(p_guild_id uuid, p_amount_kobo bigint, p_note text default null)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not exists (select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = auth.uid()) then
    raise exception 'Not a member of this guild.';
  end if;
  -- Serializes concurrent contributions from the same writer so two simultaneous requests can't
  -- both read the same starting balance and together overdraw it — the same race
  -- guild_member_stats' delta-cap trigger guards against for a different table, done here with
  -- an advisory lock instead since this is a balance check, not a bounded increment.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if author_balance_kobo(auth.uid()) < p_amount_kobo then
    raise exception 'That would exceed your available balance.';
  end if;
  insert into guild_treasury_transactions (guild_id, bucket, member_id, direction, kind, amount_kobo, status, title, created_by)
  values (p_guild_id, 'guild', null, 'credit', 'contribution', p_amount_kobo, 'success', p_note, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

-- The guild owner authorizes a spend from the guild's own available funds. Scoped to
-- player_guilds.owner_id specifically — the one real, server-known authority for a Player
-- Guild today (see this migration's header). GO_PERMISSIONS' richer Council/rung system
-- (guild-order.jsx) has no server-side counterpart yet, so it isn't checked here; widening who
-- may call this to a real Council is a reasonable next step once guild roles exist as rows
-- instead of a client-side computation.
create or replace function spend_from_guild_treasury(p_guild_id uuid, p_amount_kobo bigint, p_title text)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
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
  insert into guild_treasury_transactions (guild_id, bucket, member_id, direction, kind, amount_kobo, status, title, created_by)
  values (p_guild_id, 'guild', null, 'debit', 'spend', p_amount_kobo, 'success', p_title, auth.uid())
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function contribute_to_guild_treasury(uuid, bigint, text) from public;
revoke all on function spend_from_guild_treasury(uuid, bigint, text) from public;
grant execute on function contribute_to_guild_treasury(uuid, bigint, text) to authenticated;
grant execute on function spend_from_guild_treasury(uuid, bigint, text) to authenticated;

-- Safe to run anytime: every object above is created with if-not-exists/or-replace, and
-- author_balance_kobo's extra subtraction is 0 for every writer who has never contributed to a
-- guild treasury, so this doesn't change any existing balance on deployment.
