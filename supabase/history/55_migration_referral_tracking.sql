-- Migration 55: Referral Tracking — every user gets a shareable referral code, and a permanent,
-- append-only record is created the first time a NEW account redeems someone else's code.
--
-- Scope note, and what's deliberately NOT in this migration: this migration only tracks WHO
-- referred WHOM and WHEN. It does not pay anyone anything. `referrals.status` starts (and, as of
-- this migration, only ever sits at) 'pending' — there is no code path anywhere below that moves
-- it to 'rewarded' or that touches author_balance_kobo()/achievement_grants/any ledger. A signup
-- alone must not generate a cash reward; wiring an actual Naira payout on top of a referral is a
-- separate decision for a later migration, at which point it should reuse the exact
-- lock-then-recheck-then-idempotent-insert shape grant_naira_achievement() already uses in
-- 52_migration_naira_achievement_grants.sql — a new `referral_grants` table (mirroring
-- `achievement_grants`) feeding one more `coalesce(sum(...), 0)` term into author_balance_kobo(),
-- not a new wallet and not a second payout pipeline. Not built here because it isn't asked for
-- here, and because "what actually qualifies a referral for a reward" (referee's first purchase?
-- first publish? just staying signed up N days?) is a product decision this migration shouldn't
-- guess at.
--
-- Referral codes live on `profiles`, not a separate table or a secret like player_guilds'
-- invite_code (see 03_migration_restrict_player_guild_invite_code.sql, which deliberately closed
-- public read on THAT code). The two are opposite by design: a guild invite code gates who can
-- join a private guild, so it has to stay hidden from non-members. A referral code's entire
-- purpose is to be handed out publicly — putting it on `profiles`, which already has an
-- unconditional "anyone can read profiles" select policy, is exactly right, not an oversight.
--
-- Self-referral and repeat-referral, both closed structurally rather than just by convention:
--   - Self-referral: `check (referrer_id <> referee_id)` on the table itself, PLUS an explicit
--     check inside redeem_referral_code() so a self-referral attempt gets a clear error message
--     instead of an opaque constraint-violation.
--   - Repeatedly referring the same account: `referee_id` is UNIQUE. An account can appear as a
--     referee at most once, ever, full stop — not just "once per referrer". Whoever's code an
--     account redeems first is that account's referrer permanently; the row is never updated or
--     deleted by anything in this schema.
--
-- Safe to run anytime: both the new column and the new table are additive, and the backfill for
-- existing profiles below only fills a null, never overwrites an existing value.

-- ============================================================================================
-- profiles.referral_code — one short, permanent, publicly-readable code per account. Same
-- generation shape as player_guilds.invite_code (schema.sql) — lowercase hex, 8 chars, taken from
-- a fresh gen_random_uuid() — reused here rather than inventing a different scheme, chosen
-- deliberately for exactly this migration ("keep the existing structure").
-- ============================================================================================

alter table profiles add column if not exists referral_code text;

-- Backfill for every account that existed before this migration ran. New rows get this same
-- value from the column default added right after, so this UPDATE never needs to run again.
update profiles set referral_code = substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)
where referral_code is null;

alter table profiles alter column referral_code set default substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
alter table profiles alter column referral_code set not null;

do $$ begin
  alter table profiles add constraint profiles_referral_code_unique unique (referral_code);
exception when duplicate_object then null; -- already added by a previous run of this migration
end $$;

-- No RLS change needed: profiles' existing "anyone can read profiles" / "a user updates their
-- own profile" policies already cover this column exactly the way they cover pen_name or
-- avatar_url. protect_admin_profile_columns() (schema.sql) is untouched — referral_code isn't
-- one of the admin-only columns it guards, and doesn't need to be; a user changing their own
-- referral_code is no more sensitive than changing their own display name would be. (Nothing
-- in this migration exposes an update path for it beyond that ordinary self-service one, and
-- nothing here needs to — a user is welcome to know their own code, which they'd need to be able
-- to read anyway to share it.)

-- ============================================================================================
-- referrals — one permanent row per successfully-redeemed referral. Append-only: nothing in this
-- schema ever updates or deletes a row here.
-- ============================================================================================

create table if not exists referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_id uuid not null references auth.users(id) on delete cascade,
  referee_id uuid not null references auth.users(id) on delete cascade,
  -- Tracking only, as of this migration — see the header above. 'rewarded' is reserved for a
  -- future migration to actually use; nothing here ever writes it.
  status text not null default 'pending' check (status in ('pending', 'rewarded')),
  created_at timestamptz not null default now(),
  -- An account can be someone's referee at most once, ever — the structural half of "prevent
  -- repeatedly referring the same account" (the other half is the idempotent redeem function
  -- below, which turns a second attempt into a no-op read instead of a constraint-violation
  -- error).
  unique (referee_id),
  -- The structural half of "prevent users from referring themselves".
  check (referrer_id <> referee_id)
);

alter table referrals enable row level security;

-- Both sides of a referral can see it: a referrer building a "your referrals" list, and a referee
-- who wants to see who referred them. Neither can see anyone else's row.
create policy "a user reads referrals where they are the referrer" on referrals
  for select using (auth.uid() = referrer_id);
create policy "a user reads referrals where they are the referee" on referrals
  for select using (auth.uid() = referee_id);
-- No client insert/update/delete policy at all — same stance as achievement_grants and
-- purchases: every row is created only by redeem_referral_code() below, a security definer
-- function that re-derives the referrer from the code server-side and always inserts the
-- referee as auth.uid(), never a client-supplied id. There is deliberately no update policy
-- either, since even the future reward migration should flip `status` via its own
-- security-definer function (mirroring grant_naira_achievement()), not via a client-writable
-- column.

create index if not exists referrals_referrer_id_idx on referrals (referrer_id, created_at desc);

-- ============================================================================================
-- redeem_referral_code — the one place a `referrals` row is ever created. Looks the code up
-- server-side (so this works regardless of profiles' select policy shape) and always inserts the
-- CALLING user as referee_id — never a client-supplied id, the same "never trust what the client
-- reports" stance as join_player_guild_by_code() and grant_naira_achievement().
--
-- Idempotent by design, matching grant_naira_achievement()'s own idempotency: if this account is
-- already someone's referee (from an earlier successful call), this returns that existing row
-- rather than raising. That matters here specifically because the realistic caller (see the
-- client-side note in src/lib/referrals.js) is "attempt this once after every fresh sign-in,
-- guarded by a locally-cached code" — a network hiccup or a duplicate call must not be able to
-- produce a second row for the same account, and doesn't need to surface as an error either.
-- ============================================================================================

create or replace function redeem_referral_code(p_code text)
returns referrals
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer_id uuid;
  v_row referrals;
begin
  select * into v_row from referrals where referee_id = auth.uid();
  if found then
    return v_row; -- already referred — idempotent, not an error (see header above)
  end if;

  select id into v_referrer_id from profiles where referral_code = lower(trim(p_code));
  if v_referrer_id is null then
    raise exception 'No account found with that referral code.';
  end if;

  if v_referrer_id = auth.uid() then
    raise exception 'You cannot refer yourself.';
  end if;

  -- on conflict (referee_id): guards the race between this function's own two reads above and a
  -- concurrent call for the same referee (e.g. two tabs both finishing sign-in at once) — the
  -- same kind of race grant_naira_achievement() closes with an explicit advisory lock, handled
  -- here with a plain insert-conflict instead since there is nothing to compute under the lock
  -- beyond the insert itself.
  insert into referrals (referrer_id, referee_id)
  values (v_referrer_id, auth.uid())
  on conflict (referee_id) do nothing
  returning * into v_row;

  if v_row.id is null then
    -- Lost that race — read back whichever row actually landed for this referee.
    select * into v_row from referrals where referee_id = auth.uid();
  end if;

  return v_row;
end;
$$;

revoke all on function redeem_referral_code(text) from public;
grant execute on function redeem_referral_code(text) to authenticated;
