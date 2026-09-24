-- Migration 56: Referral Rewards — pays a referrer real Naira, but ONLY once the referred
-- account produces genuine economic activity of one of three kinds. A signup alone (covered by
-- 55_migration_referral_tracking.sql) never pays anything, and never has — this migration adds
-- the reward layer that migration 55's header explicitly deferred, using the exact shape it
-- named there: a new grants table feeding one more credit term into author_balance_kobo(),
-- reusing grant_naira_achievement()'s lock-then-recheck-then-idempotent-insert shape. No new
-- wallet, no new payout pipeline — a referral reward reaches a bank account through the exact
-- same withdrawals / paystack-withdraw flow every other credit source already uses.
--
-- The three reward kinds and what "genuine" means for each, all deliberately requiring a REAL
-- signal already recorded elsewhere by a trusted, server-only writer (Paystack's webhook, or
-- distribute_guild_revenue()) — never something the client reports about itself or about the
-- person it referred:
--
--   reader_purchase — the referred user, as a BUYER, has at least one `purchases` row with
--     status = 'success' (Paystack has actually confirmed the money moved) for at least
--     READER_REFERRAL_MIN_PURCHASE_KOBO. The floor exists specifically so "meaningless activity"
--     — a one-Naira tip solely to trigger a payout — doesn't qualify; ₦500 is a real purchase,
--     not a rounding error.
--
--   writer_earnings — the referred user, as an AUTHOR, satisfies BOTH halves of "successfully
--     publishes AND generates qualifying earnings", not just one:
--       (a) a real publication — reusing the exact signal
--           naira_achievement_current('nairaFirstPublication') already established in
--           52_migration_naira_achievement_grants.sql: a published_books or
--           guild_published_books row with word_count >= 30000. Not redefined here — a second,
--           slightly-different definition of "really published" would only invite drift.
--       (b) real earnings — sum(purchases.author_amount_kobo) across that author's successful
--           sales reaches WRITER_REFERRAL_MIN_EARNINGS_KOBO. A single ₦50 sale of a 30k-word book
--           satisfies (a) but not (b) on its own — both are required, matching "publishes AND
--           generates qualifying earnings" in the request rather than either alone.
--
--   guild_activity — the referred user OWNS a player_guild (player_guilds.owner_id) whose
--     treasury has actually received real, externally-verified sale revenue — a
--     guild_treasury_transactions row with kind in ('anthology_share', 'event_revenue') (see
--     that table's own header: these two kinds are the ones distribute_guild_revenue() writes
--     from a real Anthology or Guild Event sale, not a member's own pocket via `contribution`)
--     — summing to at least GUILD_REFERRAL_MIN_REVENUE_KOBO. Deliberately NOT triggered by
--     member count, `contribution` rows (a member moving their own money into their own guild's
--     purse proves nothing), or simply creating a guild — none of those are "genuinely active" in
--     the economic sense this migration is scoped to.
--
-- The three kobo floors above (and the three payout amounts below) are a business threshold, not
-- a technical constant — tune them in a follow-up migration if the amounts prove wrong; nothing
-- about the mechanism changes if they do.
--
-- One referral, up to three rewards: a referral is NOT typed at redemption time (there is one
-- referral_code per user, per 55_migration_referral_tracking.sql, not a separate "writer" vs
-- "reader" link) — whether it ever pays out, and as which kind(s), depends entirely on what the
-- referred account actually goes on to do. The same referee triggering both a qualifying
-- purchase and, later, qualifying writer earnings pays the referrer twice — once per kind, each
-- exactly once ever (`unique (referral_id, kind)` below).
--
-- referrals.status: moves from 'pending' to 'rewarded' the first time ANY reward kind is granted
-- for that referral, and never moves back — a coarse "has this referral ever produced real
-- value" flag. The row-level detail (which kind, how much, when) lives in referral_grants below;
-- status is not overloaded to track per-kind state.
--
-- Safe to run anytime: referral_grants is new and additive, and author_balance_kobo()'s new term
-- is 0 for every account until its first real referral reward exists.

-- ============================================================================================
-- referral_grants — one row per (referral, reward kind) ever paid out. Permanent once written —
-- never updated or deleted by anything in this schema. Mirrors achievement_grants' shape exactly.
-- ============================================================================================

create table if not exists referral_grants (
  id uuid primary key default gen_random_uuid(),
  referral_id uuid not null references referrals(id) on delete cascade,
  kind text not null check (kind in ('reader_purchase', 'writer_earnings', 'guild_activity')),
  naira_reward_kobo bigint not null check (naira_reward_kobo > 0),
  created_at timestamptz not null default now(),
  unique (referral_id, kind)
);

alter table referral_grants enable row level security;

-- Readable by the referrer (whose balance it feeds) via a join back to referrals — there is no
-- referrer_id column directly on this table, so the policy has to look it up the same way a
-- caller would.
create policy "a referrer reads their own referral grants" on referral_grants
  for select using (
    exists (select 1 from referrals r where r.id = referral_grants.referral_id and r.referrer_id = auth.uid())
  );
-- No client insert/update/delete policy at all — every row is created only by
-- grant_referral_reward() below, a security definer function that re-derives eligibility itself
-- from purchases / published_books / guild_treasury_transactions — never from anything the
-- client reports.

create index if not exists referral_grants_referral_id_idx on referral_grants (referral_id);

-- ============================================================================================
-- referral_reader_signal / referral_writer_signal / referral_guild_signal — the real,
-- server-verified eligibility check for one referee, for one reward kind. Each is `security
-- definer` specifically so it CAN read the referee's own purchases/published_books/guild rows
-- (which the referrer's own RLS would otherwise correctly hide) while returning only a boolean —
-- never a raw row — back out. That's the same shape admin_set_login_ban() uses to touch data an
-- ordinary RLS-scoped call couldn't: elevated privilege internally, a narrow, non-leaking result
-- externally.
-- ============================================================================================

create or replace function referral_reader_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from purchases
    where buyer_id = p_referee_id and status = 'success' and amount_kobo >= 50000 -- ₦500 floor
  );
$$;

revoke all on function referral_reader_signal(uuid) from public;
grant execute on function referral_reader_signal(uuid) to authenticated;

create or replace function referral_writer_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select
    exists (
      select 1 from published_books where author_id = p_referee_id and word_count >= 30000
      union all
      select 1 from guild_published_books where author_id = p_referee_id and word_count >= 30000
    )
    and
    coalesce((select sum(author_amount_kobo) from purchases
              where author_id = p_referee_id and status = 'success'), 0) >= 500000; -- ₦5,000 floor
$$;

revoke all on function referral_writer_signal(uuid) from public;
grant execute on function referral_writer_signal(uuid) to authenticated;

create or replace function referral_guild_signal(p_referee_id uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(sum(t.amount_kobo), 0) >= 500000 -- ₦5,000 floor, real sale revenue only
  from guild_treasury_transactions t
  join player_guilds g on g.id = t.guild_id
  where g.owner_id = p_referee_id
    and t.kind in ('anthology_share', 'event_revenue')
    and t.status = 'success';
$$;

revoke all on function referral_guild_signal(uuid) from public;
grant execute on function referral_guild_signal(uuid) to authenticated;

-- ============================================================================================
-- grant_referral_reward — the one place a referral_grants row is ever created. Re-derives
-- eligibility itself (via the three signal functions above) rather than trusting anything the
-- caller reports, locks per (referral, kind) before checking "already granted" so two concurrent
-- calls can never both pass, and is a no-op (returns the existing row) on a retry against an
-- already-granted (referral, kind) pair rather than raising — same idempotency contract
-- grant_naira_achievement() and redeem_referral_code() already use, for the same reason:
-- referral_reward_progress() below depends on it to call this safely on every read.
-- ============================================================================================

create or replace function grant_referral_reward(p_referral_id uuid, p_kind text)
returns referral_grants
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral referrals%rowtype;
  v_row referral_grants;
  v_reward_kobo bigint;
  v_eligible boolean;
begin
  select * into v_referral from referrals where id = p_referral_id;
  if not found then
    raise exception 'No such referral.';
  end if;

  -- Only the referrer who stands to be paid can trigger an attempt for their own referral — the
  -- caller-scoping half of "never trust a client-supplied target"; the eligibility check itself
  -- (the other half) is re-derived from the referee's real data below, never from the caller.
  if v_referral.referrer_id <> auth.uid() then
    raise exception 'Not your referral.';
  end if;

  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row; -- already granted — idempotent, not an error
  end if;

  -- Reward amounts mirror NAIRA_ACHIEVEMENTS' own convention (kobo = Naira x100). See this
  -- migration's header for why each is sized the way it is.
  case p_kind
    when 'reader_purchase' then v_reward_kobo := 20000;   -- ₦200
    when 'writer_earnings' then v_reward_kobo := 200000;  -- ₦2,000
    when 'guild_activity'  then v_reward_kobo := 300000;  -- ₦3,000
    else
      raise exception 'Unknown referral reward kind.';
  end case;

  -- Locked per (referral, kind) — same lock-then-recheck shape grant_naira_achievement() and
  -- settle_guild_event() already use, scoped narrowly since two different reward kinds for the
  -- same referral have nothing to serialize against each other.
  perform pg_advisory_xact_lock(hashtext('referral_reward:' || p_referral_id::text || ':' || p_kind));

  -- Re-read under the lock in case a concurrent call just granted it.
  select * into v_row from referral_grants where referral_id = p_referral_id and kind = p_kind;
  if found then
    return v_row;
  end if;

  case p_kind
    when 'reader_purchase' then v_eligible := referral_reader_signal(v_referral.referee_id);
    when 'writer_earnings' then v_eligible := referral_writer_signal(v_referral.referee_id);
    when 'guild_activity'  then v_eligible := referral_guild_signal(v_referral.referee_id);
  end case;

  if not coalesce(v_eligible, false) then
    raise exception 'This referral has not produced qualifying activity yet.';
  end if;

  insert into referral_grants (referral_id, kind, naira_reward_kobo)
  values (p_referral_id, p_kind, v_reward_kobo)
  returning * into v_row;

  -- One-directional: a referral that has already reached 'rewarded' (from an earlier reward of
  -- a different kind) stays there — this never resets or overwrites it.
  update referrals set status = 'rewarded' where id = p_referral_id and status = 'pending';

  return v_row;
end;
$$;

revoke all on function grant_referral_reward(uuid, text) from public;
grant execute on function grant_referral_reward(uuid, text) to authenticated;

-- ============================================================================================
-- referral_reward_progress — one round trip for a "your referrals" screen. For every referral
-- the CALLING user (auth.uid()) is the referrer of, attempts all three reward kinds (each call
-- independently locked and idempotent — see above), swallowing the expected "not eligible yet"
-- outcome, then reports current unlocked/amount state per (referral, kind). Same
-- read-doubles-as-grant shape as naira_achievement_progress() — there is no separate claim step
-- here either.
-- ============================================================================================

create or replace function referral_reward_progress()
returns table (referral_id uuid, referee_id uuid, kind text, unlocked boolean, naira_reward_kobo bigint)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referral referrals%rowtype;
  v_kind text;
  v_kinds text[] := array['reader_purchase', 'writer_earnings', 'guild_activity'];
begin
  for v_referral in select * from referrals where referrer_id = auth.uid() loop
    foreach v_kind in array v_kinds loop
      begin
        perform grant_referral_reward(v_referral.id, v_kind);
      exception when others then
        null; -- not eligible yet — expected, not an error worth surfacing here
      end;

      referral_id := v_referral.id;
      referee_id := v_referral.referee_id;
      kind := v_kind;
      select g.naira_reward_kobo into naira_reward_kobo
        from referral_grants g where g.referral_id = v_referral.id and g.kind = v_kind;
      unlocked := naira_reward_kobo is not null;
      return next;
    end loop;
  end loop;
end;
$$;

revoke all on function referral_reward_progress() from public;
grant execute on function referral_reward_progress() to authenticated;

-- ============================================================================================
-- author_balance_kobo — extended once more (same function, same signature, still the one place
-- a writer's withdrawable balance is computed) to add successful referral grants as a credit.
-- Based on the copy in 52_migration_naira_achievement_grants.sql (the latest one actually
-- redefined since 41_migration_guild_member_earnings_withdrawal.sql) — not the older copy still
-- sitting in supabase/schema.sql, which has been drifting since migration 41 and is flagged
-- there already; this migration doesn't fix that pre-existing drift, only adds to it in the same
-- already-documented way.
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = check_user_id and p.status = 'success'
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0)
    +
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where member_id = check_user_id and kind = 'release_to_member' and status = 'success'), 0)
    +
    coalesce((select sum(naira_reward_kobo) from achievement_grants
              where user_id = check_user_id), 0)
    +
    coalesce((select sum(rg.naira_reward_kobo) from referral_grants rg
              join referrals r on r.id = rg.referral_id
              where r.referrer_id = check_user_id), 0);
$$ language sql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;
