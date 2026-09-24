-- 74_migration_anthology_publish_word_count_floor.sql
--
-- Follow-up to 73_migration_publish_word_count_floor.sql, which that file's own header flagged
-- as a known gap: publish_guild_anthology() inserts into published_books as a security-definer
-- function, bypassing the 5,000-word floor added there. Its own check only ever required a
-- nonzero combined word count ("at least one approved submission is required").
--
-- An anthology is a group project — several contributors' approved submissions combined into
-- one published_books row — so it gets its own, higher floor rather than sharing the solo-author
-- number: 50,000 combined words, via a new min_anthology_publish_word_count() helper (same
-- single-source-of-truth reasoning as min_publish_word_count() in the previous migration).
--
-- Only the currently-live publish_guild_anthology(uuid) — the one requiring a revenue agreement
-- (see supabase/schema.sql's "extended in place" comment above it) — is touched. CREATE OR
-- REPLACE keeps its identity, grants, and every other check as-is; only the word-count check's
-- threshold and message change.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.
--
-- IMPORTANT — run the check below FIRST. Any anthology already published under 50,000 combined
-- words is unaffected (this only gates the *next* publish attempt, not existing rows), but any
-- anthology currently "reviewing" and about to be published will now need to clear the new floor.
--
--   select ga.id, ga.title, ga.guild_id, coalesce(sum(s.word_count), 0) as approved_words
--   from guild_anthologies ga
--   left join guild_anthology_submissions s
--     on s.anthology_id = ga.id and s.review_status = 'approved'
--   where ga.status = 'reviewing'
--   group by ga.id, ga.title, ga.guild_id
--   having coalesce(sum(s.word_count), 0) < 50000;

create or replace function min_anthology_publish_word_count()
returns integer as $$
  select 50000;
$$ language sql immutable;

create or replace function publish_guild_anthology(p_anthology_id uuid)
returns published_books
language plpgsql security definer set search_path = public as $$
declare
  v_anth guild_anthologies%rowtype;
  v_owner uuid;
  v_word_count integer;
  v_book_id text;
  v_book published_books%rowtype;
  v_agreement guild_anthology_revenue_agreements%rowtype;
  v_pending_count integer;
  v_mismatch_count integer;
begin
  select * into v_anth from guild_anthologies where id = p_anthology_id for update;
  if not found then
    raise exception 'Anthology not found.';
  end if;

  if not is_guild_officer(v_anth.guild_id) then
    raise exception 'Only the guild owner can publish this anthology.';
  end if;
  if v_anth.status <> 'reviewing' then
    raise exception 'Close submissions and finish reviewing before publishing.';
  end if;
  if v_anth.published_book_id is not null then
    raise exception 'This anthology has already been published.';
  end if;

  select coalesce(sum(word_count), 0) into v_word_count
  from guild_anthology_submissions where anthology_id = p_anthology_id and review_status = 'approved';
  if v_word_count < min_anthology_publish_word_count() then
    raise exception 'This anthology''s approved submissions total % words — at least % are needed before publishing.', v_word_count, min_anthology_publish_word_count();
  end if;

  select * into v_agreement from guild_anthology_revenue_agreements where anthology_id = p_anthology_id for update;
  if not found then
    raise exception 'Propose a revenue agreement and get every contributor''s approval before publishing.';
  end if;

  -- Guard against the agreement having gone stale — e.g. a submission was approved or rejected
  -- after the agreement was last proposed, so its contributor set no longer matches. Re-proposing
  -- (which always resets approvals) is the only way past this, on purpose: nobody's share should
  -- ever go live for a contributor list that isn't the one they actually approved.
  select count(*) into v_mismatch_count from (
    select contributor_id from (
      select contributor_id from guild_anthology_revenue_shares where agreement_id = v_agreement.id
      union all
      select contributor_id from guild_anthology_submissions
        where anthology_id = p_anthology_id and review_status = 'approved'
    ) all_ids
    group by contributor_id
    having count(*) <> 2
  ) mismatches;
  if v_mismatch_count > 0 then
    raise exception 'The revenue agreement''s contributors no longer match this anthology''s approved submissions — propose it again before publishing.';
  end if;

  select count(*) into v_pending_count
  from guild_anthology_revenue_shares where agreement_id = v_agreement.id and approved_at is null;
  if v_pending_count > 0 then
    raise exception '% contributor(s) still need to approve the revenue agreement before this can be published.', v_pending_count;
  end if;

  v_book_id := 'anthology-' || p_anthology_id::text;

  insert into published_books (id, author_id, title, blurb, cover, price, word_count, destination)
  values (v_book_id, auth.uid(), v_anth.title, v_anth.description, v_anth.cover, v_anth.price, v_word_count, 'guild')
  returning * into v_book;

  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies
    set status = 'published', published_book_id = v_book_id, published_at = now()
    where id = p_anthology_id;

  -- Revenue can begin the moment this row commits (the book is now purchasable) — so the
  -- agreement locks in the same breath, not as a separate later step someone could skip.
  update guild_anthology_revenue_agreements
    set locked = true, locked_at = now()
    where id = v_agreement.id;

  return v_book;
end;
$$;
