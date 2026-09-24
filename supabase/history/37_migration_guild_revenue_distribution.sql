-- Migration 37: Guild revenue distribution — connects a verified sale to the Guild Treasury.
--
-- Closes a gap migration 36 (guild_anthology_revenue_agreements) left open by its own design:
-- proposing and approving a revenue split was real, but nothing ever paid it out. An anthology
-- sale still flows through the same `purchases` row every solo book uses — `author_id` on that
-- row is whoever called publish_guild_anthology (the guild owner), so until this migration, a
-- successful anthology sale's entire `author_amount_kobo` landed in the owner's own personal
-- withdrawable balance via author_balance_kobo(), in full, regardless of what the contributors
-- had agreed to split it. Nobody's row was wrong on its own — purchases/author_balance_kobo
-- never knew an anthology was a different kind of sale — but the two features were never wired
-- together.
--
-- What this migration adds:
--   1. Two new columns on guild_treasury_transactions (source_purchase_id, anthology_id) so a
--      distribution row can point back at the exact verified sale and anthology that produced
--      it — needed for both the dedup check below and an honest ledger/UI.
--   2. distribute_guild_revenue() — a generic, source-agnostic engine: given a guild, an
--      already-fee-applied gross amount, and a set of {contributor_id, share_bps} shares, it
--      credits each contributor's earnings (bucket='member', held in trust — see migration 33's
--      original comment on that bucket), credits whatever's left over to the guild's own bucket,
--      and does both as permanent ledger rows. Nothing about it is anthology-specific; a future
--      Guild Events feature can call it the same way with source='event_sale' once one exists —
--      see the header of that reserved vocabulary in migration 33's guild_treasury_transactions
--      comments. Deliberately NOT granted to authenticated/public: it trusts its arguments
--      completely (guild_id, shares, amount), so it may only ever be called from another
--      security-definer function that has independently re-derived those facts itself — never
--      directly by a client.
--   3. distribute_anthology_sale_to_treasury() — a trigger on `purchases`, firing only on the
--      genuine pending -> success transition (the same transition paystack-webhook alone can
--      cause), which is the concrete wiring: for a sale of an anthology's published book, look
--      up its locked revenue agreement's shares and call the engine above. An ordinary solo
--      book's sale finds no matching guild_anthologies row and is untouched — this is also the
--      "clean hook" for a future event trigger to follow the same shape.
--   4. author_balance_kobo() updated in place to stop counting anthology-book purchases toward
--      the *personal* balance of whoever's on the purchases row — that money is now distributed
--      through the treasury instead, and counting it in both places would pay it out twice.
--   5. A one-time backfill: any anthology purchase that was already 'success' before this
--      migration ran (so its money is already sitting in the owner's personal balance, never
--      distributed) gets distributed now, the same way a new sale would be — see the comment
--      on the backfill block below for what this means for that balance going forward.
--
-- Duplicate-processing protection, three independent layers:
--   a. paystack-webhook's own update is scoped `.eq('status', 'pending')` — a retried webhook
--      event for an already-'success' row updates zero rows, so the trigger below never re-fires
--      for it in the first place.
--   b. The trigger's own WHEN clause only fires on an actual old-status-is-not-success ->
--      new-status-is-success transition, not on every UPDATE.
--   c. distribute_guild_revenue() itself checks, under an advisory lock keyed to the specific
--      purchase, whether any guild_treasury_transactions row already references this
--      source_purchase_id before writing anything — belt-and-suspenders even if (a) and (b) were
--      ever bypassed by a direct, unanticipated call.
--
-- Safe to run once on an existing deployment; a fresh install gets all of this from schema.sql
-- with nothing extra to run.

-- ============================================================================================
-- 1. New columns
-- ============================================================================================

alter table guild_treasury_transactions
  add column if not exists source_purchase_id uuid references purchases(id) on delete set null;
alter table guild_treasury_transactions
  add column if not exists anthology_id uuid references guild_anthologies(id) on delete set null;

create index if not exists guild_treasury_transactions_source_purchase_idx
  on guild_treasury_transactions (source_purchase_id) where source_purchase_id is not null;
create index if not exists guild_treasury_transactions_anthology_idx
  on guild_treasury_transactions (anthology_id) where anthology_id is not null;

-- ============================================================================================
-- 2. The generic distribution engine
-- ============================================================================================

create or replace function distribute_guild_revenue(
  p_guild_id uuid,
  p_gross_amount_kobo bigint,     -- already platform-fee-applied — see the header above
  p_shares jsonb,                 -- [{"contributor_id": uuid, "share_bps": int}, ...], sum <= 10000
  p_kind text,                    -- 'anthology_share' today; 'event_revenue' reserved for later
  p_source text,                  -- 'anthology_sale' today; 'event_sale' reserved for later
  p_source_purchase_id uuid,      -- the verified purchases.id this revenue came from — the dedup key
  p_anthology_id uuid default null,
  p_project_event_id uuid default null,
  p_title text default null
)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_already_processed boolean;
  v_shares_sum integer;
  v_member_credited bigint;
  v_guild_share bigint;
begin
  if p_gross_amount_kobo is null or p_gross_amount_kobo <= 0 then
    return; -- nothing to distribute
  end if;
  if p_source_purchase_id is null then
    raise exception 'A source purchase id is required — every distribution must trace back to one verified sale.';
  end if;

  -- Locked to this specific sale, not the whole guild, so an anthology sale and a (future) event
  -- sale for the same guild can be distributed concurrently without blocking on each other.
  perform pg_advisory_xact_lock(hashtext('guild_revenue_distribution:' || p_source_purchase_id::text));

  select exists(
    select 1 from guild_treasury_transactions where source_purchase_id = p_source_purchase_id
  ) into v_already_processed;
  if v_already_processed then
    return; -- this exact sale has already been distributed — never pay it out twice
  end if;

  select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
  from jsonb_array_elements(p_shares) s;
  if v_shares_sum < 0 or v_shares_sum > 10000 then
    raise exception 'Contributor shares must add up to no more than 100%% of the sale.';
  end if;

  -- Largest-remainder distribution, same method propose_anthology_revenue_agreement's
  -- 'contribution' split already uses: floor everyone first, then hand the leftover kobo (at
  -- most one per contributor) to whoever was closest to rounding up. Guarantees every member
  -- credit plus the guild's own share sums to exactly p_gross_amount_kobo — no kobo invented or
  -- lost to rounding.
  with shares as (
    select (s->>'contributor_id')::uuid as contributor_id, (s->>'share_bps')::integer as share_bps
    from jsonb_array_elements(p_shares) s
    where (s->>'share_bps')::integer > 0
  ),
  amounts as (
    select contributor_id, share_bps,
      floor(p_gross_amount_kobo * share_bps::numeric / 10000)::bigint as base,
      (p_gross_amount_kobo * share_bps::numeric / 10000) - floor(p_gross_amount_kobo * share_bps::numeric / 10000) as frac
    from shares
  ),
  total_base as (
    select coalesce(sum(base), 0)::bigint as sum_base from amounts
  ),
  ranked as (
    select a.contributor_id, a.base, a.frac,
           row_number() over (order by a.frac desc, a.contributor_id) as rn,
           (p_gross_amount_kobo - t.sum_base) as leftover
    from amounts a cross join total_base t
  )
  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, source_purchase_id, anthology_id)
  select p_guild_id, 'member', contributor_id, 'credit', p_kind,
         base + case when rn <= leftover then 1 else 0 end, 'NGN', p_source, 'member_earnings_held',
         p_project_event_id, 'success', p_title, p_source_purchase_id, p_anthology_id
  from ranked
  where base + case when rn <= leftover then 1 else 0 end > 0;

  select coalesce(sum(amount_kobo), 0) into v_member_credited
  from guild_treasury_transactions
  where source_purchase_id = p_source_purchase_id and bucket = 'member';

  v_guild_share := p_gross_amount_kobo - v_member_credited;
  if v_guild_share > 0 then
    insert into guild_treasury_transactions
      (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
       project_event_id, status, title, source_purchase_id, anthology_id)
    values
      (p_guild_id, 'guild', null, 'credit', p_kind, v_guild_share, 'NGN', p_source, 'guild_treasury',
       p_project_event_id, 'success', p_title, p_source_purchase_id, p_anthology_id);
  end if;
end;
$$;

-- Deliberately no grant to authenticated/public — see the header above. Only a security-definer
-- function that has already re-derived guild_id/shares/amount itself (never from a client
-- argument) may call this.
revoke all on function distribute_guild_revenue(uuid, bigint, jsonb, text, text, uuid, uuid, uuid, text) from public;

-- ============================================================================================
-- 3. Wiring: anthology sales
-- ============================================================================================

create or replace function distribute_anthology_sale_to_treasury()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_anth guild_anthologies%rowtype;
  v_agreement guild_anthology_revenue_agreements%rowtype;
  v_shares jsonb;
begin
  if new.status <> 'success' or old.status = 'success' or new.book_id is null then
    return new;
  end if;

  select * into v_anth from guild_anthologies where published_book_id = new.book_id;
  if not found then
    return new; -- an ordinary solo book sale — untouched, exactly today's existing behavior
  end if;

  select * into v_agreement from guild_anthology_revenue_agreements where anthology_id = v_anth.id;
  if not found or not v_agreement.locked then
    -- publish_guild_anthology requires a locked, fully-approved agreement before an anthology
    -- can go live at all, so this shouldn't happen — but if it somehow does, don't guess: leave
    -- the sale exactly as it landed rather than distributing against a stale or missing split.
    return new;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('contributor_id', contributor_id, 'share_bps', share_bps)), '[]'::jsonb)
    into v_shares
  from guild_anthology_revenue_shares
  where agreement_id = v_agreement.id;

  perform distribute_guild_revenue(
    p_guild_id := v_anth.guild_id,
    p_gross_amount_kobo := new.author_amount_kobo,
    p_shares := v_shares,
    p_kind := 'anthology_share',
    p_source := 'anthology_sale',
    p_source_purchase_id := new.id,
    p_anthology_id := v_anth.id,
    p_title := 'Anthology sale — ' || v_anth.title
  );

  return new;
end;
$$;

drop trigger if exists purchases_distribute_anthology_sale on purchases;
create trigger purchases_distribute_anthology_sale
  after update on purchases
  for each row
  when (new.status = 'success' and old.status is distinct from 'success')
  execute function distribute_anthology_sale_to_treasury();

-- ============================================================================================
-- 4. author_balance_kobo — stop double-counting anthology sales
-- ============================================================================================

create or replace function author_balance_kobo(check_user_id uuid)
returns bigint as $$
  select
    coalesce((select sum(p.author_amount_kobo) from purchases p
              where p.author_id = check_user_id and p.status = 'success'
                -- An anthology sale's proceeds are distributed through the guild treasury (see
                -- distribute_anthology_sale_to_treasury above) instead of landing in the
                -- publishing owner's personal balance whole — counting it here too would pay the
                -- same sale out twice. A solo book (the vast majority of purchases rows) has no
                -- matching guild_anthologies row and is completely unaffected.
                and not exists (
                  select 1 from guild_anthologies a where a.published_book_id = p.book_id
                )), 0)
    -
    coalesce((select sum(amount_kobo) from withdrawals
              where user_id = check_user_id and status in ('pending', 'success')), 0)
    -
    coalesce((select sum(amount_kobo) from guild_treasury_transactions
              where created_by = check_user_id and kind = 'contribution' and status in ('pending', 'success')), 0);
$$ language sql stable security definer set search_path = public;

revoke all on function author_balance_kobo(uuid) from public;
grant execute on function author_balance_kobo(uuid) to authenticated;

-- ============================================================================================
-- 5. One-time backfill for anthology sales that already succeeded before this migration
-- ============================================================================================
-- Without this, any anthology sale that completed before today keeps its proceeds sitting in the
-- owner's personal balance (already paid out under the old, unwired behavior) while
-- author_balance_kobo above stops counting it going forward — silently shrinking that balance
-- with nothing to explain why. Running the exact same distribution for those past sales now
-- means: the owner's balance moves to reflect only their own contributor share (if any) plus
-- whatever the guild's cut is, same as a sale processed today would; every other contributor
-- gets the treasury credit they were always owed by the locked agreement they approved.
do $$
declare
  r record;
  v_agreement guild_anthology_revenue_agreements%rowtype;
  v_shares jsonb;
begin
  for r in
    select p.id as purchase_id, p.author_amount_kobo, a.id as anthology_id, a.guild_id, a.title
    from purchases p
    join guild_anthologies a on a.published_book_id = p.book_id
    where p.status = 'success'
      and not exists (
        select 1 from guild_treasury_transactions t where t.source_purchase_id = p.id
      )
  loop
    select * into v_agreement from guild_anthology_revenue_agreements where anthology_id = r.anthology_id;
    if not found or not v_agreement.locked then
      continue; -- shouldn't happen for a published anthology, but skip rather than guess
    end if;

    select coalesce(jsonb_agg(jsonb_build_object('contributor_id', contributor_id, 'share_bps', share_bps)), '[]'::jsonb)
      into v_shares
    from guild_anthology_revenue_shares
    where agreement_id = v_agreement.id;

    perform distribute_guild_revenue(
      p_guild_id := r.guild_id,
      p_gross_amount_kobo := r.author_amount_kobo,
      p_shares := v_shares,
      p_kind := 'anthology_share',
      p_source := 'anthology_sale',
      p_source_purchase_id := r.purchase_id,
      p_anthology_id := r.anthology_id,
      p_title := 'Anthology sale — ' || r.title
    );
  end loop;
end $$;
