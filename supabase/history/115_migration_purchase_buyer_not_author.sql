-- Migration 115: self-purchase / self-tip was only blocked by the calling edge function, not by
-- the database (production audit, Low — defense in depth).
--
-- The gap: paystack-init-purchase rejects `book.author_id === user.id` before calling
-- create_purchase_locked(), but the function itself accepted any buyer/author pair. It is
-- service-role-only, so today the edge function is the only caller — but a second caller (a new
-- edge function, a manual SQL-editor call, a future refactor that drops the check) would let an
-- author buy or tip their own book, which is exactly the wash-trading shape the sales-based
-- achievements and rankings are meant to exclude. Enforcing the rule in the function that
-- actually writes the row means it no longer depends on every caller remembering to.
--
-- What this changes: one added check near the top of create_purchase_locked() — a buyer cannot
-- be the author. Nothing else in the function changed (signature, grants, the double-charge lock,
-- the already-owned check, the insert); the logic is migration 106's, unchanged, plus this
-- guard. The existing edge-function check stays: it gives the friendlier message first and
-- avoids a pointless database round trip.
--
-- Not run against a live database from this session. Verify after applying: as service_role,
-- `select create_purchase_locked('<uid>', '<same uid>', 'tip', null, 'ref1', 10000, 9000)` raises
-- "A buyer cannot purchase or tip their own book."; a normal buyer/author pair still inserts.

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
  -- Migration 115: defense in depth behind paystack-init-purchase's own author check.
  if p_buyer_id = p_author_id then
    raise exception 'A buyer cannot purchase or tip their own book.';
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
    -- closes the double-charge race where two concurrent calls (two tabs, a double-tap Buy)
    -- could both pass the "not already owned" check before either had inserted its own pending
    -- row. Released automatically at the end of this function's transaction.
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
