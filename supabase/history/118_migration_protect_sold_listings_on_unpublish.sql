-- Migration 118: unpublishing a sold book (or pack) cut its paying buyers off (production-readiness audit).
--
-- The gap: published_books had an "author deletes own listings" policy, and the client's Unpublish
-- button (lib/library.js unpublishBookRemote, lib/worldbuilding-packs.js unpublishPackRemote) issued
-- a plain DELETE. Three foreign keys then did the damage:
--   * purchases.book_id / purchases.pack_id are `on delete set null`, so every buyer's purchase row
--     stopped pointing at anything;
--   * published_book_content / published_pack_content are `on delete cascade`, so the manuscript (or
--     pack contents) the buyer paid for was erased server-side;
--   * the author keeps the earnings already credited by the webhook.
-- Net effect: a reader who paid could lose the book, permanently, the moment the author unpublished it
-- (and the publishing UI even tells authors to unpublish/republish to change the download setting).
--
-- The fix keeps "Unpublish" working for the author but makes it non-destructive once anyone has paid:
--   1. unpublish_book() / unpublish_pack() (new, security definer, author-only) decide server-side.
--      Nobody has paid            -> the row is deleted, exactly as before.
--      A buyer exists (see below) -> the row is kept and hidden from every public surface, and the
--                                    buyer keeps reading/downloading it.
--      The clients now call these instead of issuing DELETE.
--   2. A BEFORE DELETE trigger on published_books / published_packs refuses to delete a listing that
--      still has such a buyer, so no other path (a stale client, a direct REST call, a future feature)
--      can reintroduce the bug. It stands aside only when the AUTHOR ACCOUNT ITSELF is being removed
--      (the auth.users cascade), which must be allowed to finish.
--   3. "Hidden" is represented so that every existing surface already treats it as not-for-sale:
--        books: published_books.destination = 'unlisted' (a third value). Every public RLS policy and
--               every ranking/discovery function in this schema filters on destination = 'inkroot'
--               (or = 'guild' plus guild membership), so an unlisted book drops out of the Grand
--               Library, search, rankings and guild shelves with no other edit. The author's own read
--               policy and the purchaser content policy are destination-agnostic, so the author and
--               past buyers are unaffected.
--        packs: published_packs.unlisted boolean (packs have no destination column). The single open
--               read policy is replaced by listed / author / buyer policies.
--   4. New SELECT policies let a buyer still read the LISTING row of what they bought (title, price,
--      downloadable flag), because the reader screens look it up. Moderator takedowns still win
--      (removed_by_moderator hides it from buyers too, as it always did for everyone but the author).
--
-- "Has a buyer" = a purchases row with kind 'book' (or 'pack') and status 'success', or a 'pending'
-- one created in the last 24 hours (a checkout in flight). unpublish_*() takes a row lock on the
-- listing before checking, and a purchase insert takes a key-share lock on the same row through its
-- foreign key, so a purchase cannot slip in between the check and the delete. Refunded and failed
-- purchases do not protect a listing (the buyer no longer has a claim).
--
-- Republishing an unlisted book/pack is the ordinary publish upsert: it sets destination back to
-- 'inkroot' / 'guild' (books) or unlisted = false (packs; publishPackRemote now sends this). The
-- existing downloadable lock (lock_downloadable_after_insert) still holds the book's download flag at
-- whatever it was when first published, which is the right outcome once readers have paid under it.
--
-- Edge Functions to redeploy with this migration: paystack-init-purchase, paystack-init-pack-purchase,
-- download-book (an unlisted book/pack can no longer be bought, tipped, or downloaded by non-buyers).
--
-- Not run against a live database from this session. Verify after applying, as service_role / two users:
--   * A, author, has a priced book B with one status='success' book purchase by user R. A calls
--     select unpublish_book('B'): returns 'hidden'; B is gone from fetchDiscoverBooks; R can still read
--     B (published_book_content) and download it; a direct `delete from published_books where id='B'`
--     as A raises "This book has readers who bought it...".
--   * An unsold book: unpublish_book returns 'deleted' and the row is gone.
--   * Republishing B (publishBookRemote upsert, destination 'inkroot') relists it.
--   * Same three checks for a pack with unpublish_pack().
--   * Deleting an author from auth.users (test project only) still succeeds.

-- ---------------------------------------------------------------------------------------------
-- Books
-- ---------------------------------------------------------------------------------------------

alter table published_books drop constraint if exists published_books_destination_check;
alter table published_books add constraint published_books_destination_check
  check (destination in ('guild', 'inkroot', 'unlisted'));

create or replace function book_has_protected_buyers(p_book_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from purchases p
    where p.book_id = p_book_id
      and p.kind = 'book'
      and (p.status = 'success' or (p.status = 'pending' and p.created_at > now() - interval '1 day'))
  );
$$;

revoke all on function book_has_protected_buyers(text) from public;

create or replace function protect_sold_book_from_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The author's own account is being deleted (auth.users cascade): the parent row is already gone
  -- in this transaction, so let the cascade finish. Never true for an ordinary client delete.
  if not exists (select 1 from auth.users u where u.id = old.author_id) then
    return old;
  end if;
  if book_has_protected_buyers(old.id) then
    raise exception 'This book has readers who bought it, so it can''t be deleted. Unpublish it instead: it stays available to the people who paid.'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists published_books_protect_sold_delete on published_books;
create trigger published_books_protect_sold_delete
  before delete on published_books
  for each row execute function protect_sold_book_from_delete();

-- Returns 'deleted' (nobody had paid), 'hidden' (kept for its buyers) or 'none' (no such listing of
-- the caller's, the same silent no-op the old client-side DELETE ... WHERE author_id = me gave).
create or replace function unpublish_book(p_book_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_author uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to unpublish a book.';
  end if;

  -- Row lock first: a concurrent purchase insert (foreign key -> key-share lock on this row) either
  -- commits before we look below or waits until this transaction ends and then fails its FK check.
  select author_id into v_author from published_books where id = p_book_id for update;
  if not found or v_author <> v_uid then
    return 'none';
  end if;

  if book_has_protected_buyers(p_book_id) then
    update published_books set destination = 'unlisted', updated_at = now() where id = p_book_id;
    return 'hidden';
  end if;

  delete from published_books where id = p_book_id;
  return 'deleted';
end;
$$;

revoke all on function unpublish_book(text) from public;
grant execute on function unpublish_book(text) to authenticated;

-- A buyer can still read the listing row of a book they paid for even after it is unlisted (the
-- reader screens look up its price / downloadable flag). Does not apply to a moderator takedown.
drop policy if exists "buyers read listings of books they bought" on published_books;
create policy "buyers read listings of books they bought" on published_books
  for select using (
    not removed_by_moderator
    and exists (
      select 1 from purchases p
      where p.book_id = published_books.id
        and p.kind = 'book'
        and p.buyer_id = auth.uid()
        and p.status = 'success'
    )
  );

-- ---------------------------------------------------------------------------------------------
-- Worldbuilding packs (same defect, same fix)
-- ---------------------------------------------------------------------------------------------

alter table published_packs add column if not exists unlisted boolean not null default false;

create or replace function pack_has_protected_buyers(p_pack_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from purchases p
    where p.pack_id = p_pack_id
      and p.kind = 'pack'
      and (p.status = 'success' or (p.status = 'pending' and p.created_at > now() - interval '1 day'))
  );
$$;

revoke all on function pack_has_protected_buyers(text) from public;

create or replace function protect_sold_pack_from_delete()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from auth.users u where u.id = old.author_id) then
    return old;
  end if;
  if pack_has_protected_buyers(old.id) then
    raise exception 'This pack has people who bought or claimed it, so it can''t be deleted. Unpublish it instead: it stays available to them.'
      using errcode = 'P0001';
  end if;
  return old;
end;
$$;

drop trigger if exists published_packs_protect_sold_delete on published_packs;
create trigger published_packs_protect_sold_delete
  before delete on published_packs
  for each row execute function protect_sold_pack_from_delete();

create or replace function unpublish_pack(p_pack_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_author uuid;
begin
  if v_uid is null then
    raise exception 'Sign in to unpublish a pack.';
  end if;

  select author_id into v_author from published_packs where id = p_pack_id for update;
  if not found or v_author <> v_uid then
    return 'none';
  end if;

  if pack_has_protected_buyers(p_pack_id) then
    update published_packs set unlisted = true, updated_at = now() where id = p_pack_id;
    return 'hidden';
  end if;

  delete from published_packs where id = p_pack_id;
  return 'deleted';
end;
$$;

revoke all on function unpublish_pack(text) from public;
grant execute on function unpublish_pack(text) to authenticated;

-- The one open read policy becomes three permissive ones (ORed together): listed packs are public,
-- an author sees their own (listed or not), a buyer sees the listing of a pack they own.
drop policy if exists "anyone can read published packs" on published_packs;
drop policy if exists "anyone can read listed packs" on published_packs;
drop policy if exists "author reads own pack listings" on published_packs;
drop policy if exists "buyers read listings of packs they own" on published_packs;

create policy "anyone can read listed packs" on published_packs
  for select using (not unlisted);
create policy "author reads own pack listings" on published_packs
  for select using (auth.uid() = author_id);
create policy "buyers read listings of packs they own" on published_packs
  for select using (
    exists (
      select 1 from purchases p
      where p.pack_id = published_packs.id
        and p.kind = 'pack'
        and p.buyer_id = auth.uid()
        and p.status = 'success'
    )
  );
