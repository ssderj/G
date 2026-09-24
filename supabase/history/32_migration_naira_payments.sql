-- Migration 32: Naira payments (Paystack) — saved bank accounts, purchase/tip ledger, withdrawals
--
-- Everywhere else in the schema (published_books.price, reviews, etc.) predates real money
-- moving through Inkroot at all — see publishing.jsx's long-standing "no payment processor yet"
-- comments. This migration is what makes that real, scoped to what was asked for: readers paying
-- for books/tips in Naira, and authors withdrawing their earnings to a saved Nigerian bank
-- account. Nothing about published_books.price itself changes shape — it's read as Naira from
-- here on (see formatLibraryPrice in publishing.jsx), same numeric column as before.
--
-- All real money movement (charging a card/bank transfer, paying out to a bank account) happens
-- through Paystack from the two Supabase Edge Functions that own a service-role key + the
-- Paystack secret key — never from the client, and never trusted from whatever the client
-- reports. These tables are the durable record those functions write to; RLS below only ever
-- grants clients read access to their own rows (and authors read on their own sales), never
-- direct insert/update of amount or status.

-- ============================================================================================
-- bank_accounts — a reader/author's saved Nigerian payout bank account. One row per saved
-- account; `is_default` marks which one withdrawals use when a user has more than one saved.
-- Storing paystack_recipient_code is what lets "save a bank account" actually mean something —
-- Paystack's Transfer Recipient object is what a later withdrawal transfers to, so this is
-- created once (via the paystack-save-bank-account Edge Function, which also verifies the
-- account name against the account number+bank before saving) and reused, instead of asking for
-- account details again on every withdrawal.
-- ============================================================================================

create table if not exists bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_code text not null,
  bank_name text not null,
  account_number text not null check (account_number ~ '^[0-9]{10}$'),
  -- Returned by Paystack's account-resolve call, not typed by the user — this is what confirms
  -- the account number actually belongs to a real account before anything is saved.
  account_name text not null,
  paystack_recipient_code text not null unique,
  is_default boolean not null default true,
  created_at timestamptz not null default now(),
  unique (user_id, bank_code, account_number)
);

alter table bank_accounts enable row level security;

create policy "a user reads their own saved bank accounts" on bank_accounts
  for select using (auth.uid() = user_id);
-- Insert/update/delete happen through the Edge Functions using the service role (so the
-- Paystack recipient_code is always created/retired in lockstep with the row) — no direct client
-- insert/update policy. Delete is safe to allow directly since it's just removing a saved
-- convenience, not something that needs Paystack coordination first.
create policy "a user deletes their own saved bank account" on bank_accounts
  for delete using (auth.uid() = user_id);

-- Only one default per user — the app always has exactly one "the" saved account to withdraw to
-- unless the user is mid-way through adding a second.
create unique index if not exists bank_accounts_one_default_per_user
  on bank_accounts (user_id) where is_default;

-- Switches which saved bank account is the default withdrawal target. A plain client update
-- can't do this safely in one step (two rows would both need touching, and the partial unique
-- index above would reject a moment where both are true) — same shape as this schema's other
-- "needs to happen atomically, as the caller, without a bespoke policy" cases (see
-- join_player_guild_by_code below for the pattern this follows).
create or replace function set_default_bank_account(target_account_id uuid)
returns void as $$
begin
  if not exists (select 1 from bank_accounts where id = target_account_id and user_id = auth.uid()) then
    raise exception 'Not your saved bank account';
  end if;
  update bank_accounts set is_default = false where user_id = auth.uid();
  update bank_accounts set is_default = true where id = target_account_id;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function set_default_bank_account(uuid) from public;
grant execute on function set_default_bank_account(uuid) to authenticated;

-- ============================================================================================
-- purchases — a completed (or pending/failed) Naira payment from a reader: either a book
-- purchase or a tip to an author. One row per Paystack transaction attempt. amount_kobo is the
-- full amount the reader paid; author_amount_kobo is what the author is credited after
-- Inkroot's platform fee (see PLATFORM_FEE_BPS in the paystack-webhook function) — kept as its
-- own column rather than computed at read time so a later change to the fee percentage never
-- reclassifies a past sale's payout.
-- ============================================================================================

create table if not exists purchases (
  id uuid primary key default gen_random_uuid(),
  paystack_reference text not null unique,
  buyer_id uuid not null references auth.users(id) on delete cascade,
  author_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('book', 'tip')),
  book_id text references published_books(id) on delete set null,
  amount_kobo bigint not null check (amount_kobo > 0),
  author_amount_kobo bigint not null check (author_amount_kobo >= 0),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

alter table purchases enable row level security;

create policy "buyer reads their own purchases" on purchases
  for select using (auth.uid() = buyer_id);
create policy "author reads sales of their own work" on purchases
  for select using (auth.uid() = author_id);
-- No client insert/update policy at all: a purchase row is only ever created (pending) by
-- paystack-init-purchase and only ever confirmed (success/failed) by paystack-webhook, both
-- running as service_role — a client claiming its own payment "succeeded" is worth exactly
-- nothing without Paystack itself having said so server-side.

create index if not exists purchases_author_id_status_idx on purchases (author_id, status);

-- ============================================================================================
-- withdrawals — an author cashing out to a saved bank account. Mirrors purchases: one row per
-- Paystack Transfer attempt, created pending by paystack-withdraw and moved to success/failed by
-- the same webhook that confirms purchases (Paystack sends both transaction and transfer events
-- to one webhook URL).
-- ============================================================================================

create table if not exists withdrawals (
  id uuid primary key default gen_random_uuid(),
  paystack_transfer_code text unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  bank_account_id uuid not null references bank_accounts(id) on delete restrict,
  amount_kobo bigint not null check (amount_kobo > 0),
  status text not null default 'pending' check (status in ('pending', 'success', 'failed')),
  failure_reason text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table withdrawals enable row level security;

create policy "a user reads their own withdrawals" on withdrawals
  for select using (auth.uid() = user_id);
-- Same reasoning as purchases: created/updated only by the paystack-withdraw and
-- paystack-webhook Edge Functions (service_role) — never directly by a client, since a
-- withdrawal must be checked against the author's actual available balance server-side first.

create index if not exists withdrawals_user_id_idx on withdrawals (user_id);

-- ============================================================================================
-- author_balance_kobo — an author's current withdrawable balance in kobo: total received from
-- successful sales/tips, minus withdrawals already paid out or in flight. A function rather than
-- a stored column on purpose (same reasoning as this codebase's other derived-not-duplicated
-- state, e.g. guild_member_stats' comments) — there is no separate ledger balance that can ever
-- drift from the purchases/withdrawals rows themselves.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(author_amount_kobo) from purchases
              where author_id = check_user_id and status = 'success'), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

-- security definer so a caller can check their own balance without needing broad read access to
-- other authors' purchases/withdrawals rows — grant execute, not table access.
revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
