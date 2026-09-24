-- ============================================================================================
-- Migration 106 — closes a double-charge race in paystack-init-purchase (production audit —
-- Paystack payment handling / duplicate purchase).
--
-- The bug: paystack-init-purchase's "do you already own this book" check (a plain select
-- against purchases where status='success') and the pending-row insert that follows it were two
-- separate, unlocked round trips. Two concurrent calls from the same buyer for the same book —
-- two open tabs, a double-tap Buy, a retried checkout — could both read "not owned yet" before
-- either had inserted its own row, both proceed to a real Paystack checkout, and both succeed:
-- a reader charged twice for one book. purchases has no unique constraint beyond
-- paystack_reference itself, so nothing at the table level caught this.
--
-- The fix: the ownership check and the insert now happen inside one function, under an advisory
-- lock keyed to (buyer_id, book_id) — same pattern every other balance/ownership-sensitive
-- mutation in this schema already uses (create_withdrawal_locked, grant_referral_reward,
-- create_guild_event_entry_locked). A tip has no ownership concept to race (a reader can tip as
-- many times as they like), so the lock and the ownership recheck only apply when kind='book';
-- a tip's insert still goes through this same function for one shared, service-role-only insert
-- path into purchases.
--
-- Deliberately NOT a unique index on (buyer_id, book_id) — that would make paystack-webhook's
-- `update ... where status='pending'` fail outright the moment a second pending row for the same
-- buyer+book transitions toward 'success', and deciding what should happen to that second
-- charge (auto-refund vs. surface to an admin) is a product call, not something to bake into a
-- schema constraint here. This migration only closes the race in the one function that used to
-- let two pending rows for the same already-unowned book both get created in the first place.
--
-- Safe to run anytime; no data changes, no new columns.
-- ============================================================================================

create or replace function create_purchase_locked(
  p_buyer_id uuid,
  p_author_id uuid,
  p_kind text,
  p_book_id text,
  p_reference text,
  p_amount_kobo bigint,
  p_author_amount_kobo bigint
)
returns purchases
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row purchases;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Not authorized.';
  end if;
  if p_kind not in ('book', 'tip') then
    raise exception 'Invalid purchase kind.';
  end if;
  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if p_author_amount_kobo is null or p_author_amount_kobo < 0 then
    raise exception 'Invalid author amount.';
  end if;

  if p_kind = 'book' then
    if p_book_id is null then
      raise exception 'A book purchase requires a book id.';
    end if;

    -- Serializes every concurrent purchase-init attempt by this buyer against this exact book —
    -- the actual fix. Released automatically at the end of this function's transaction.
    perform pg_advisory_xact_lock(hashtext('purchase_init:' || p_buyer_id::text || ':' || p_book_id));

    if exists (
      select 1 from purchases
      where buyer_id = p_buyer_id and book_id = p_book_id and kind = 'book' and status = 'success'
    ) then
      raise exception 'You already own this book — no need to pay again.';
    end if;
  end if;

  insert into purchases (
    paystack_reference, buyer_id, author_id, kind, book_id, amount_kobo, author_amount_kobo, status
  ) values (
    p_reference, p_buyer_id, p_author_id, p_kind, p_book_id, p_amount_kobo, p_author_amount_kobo, 'pending'
  )
  returning * into v_row;

  return v_row;
end;
$$;

revoke all on function create_purchase_locked(uuid, uuid, text, text, text, bigint, bigint) from public;
