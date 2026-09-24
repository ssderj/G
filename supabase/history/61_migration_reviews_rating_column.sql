-- Migration 61: restore reviews.rating, dropped by accident during the schema_phase*.sql ->
-- schema.sql consolidation.
--
-- schema_phase2.sql (the original Phase 2 file, before it was folded into the consolidated
-- schema.sql) created reviews with a `rating smallint not null check (rating between 1 and 5)`
-- column. The consolidated schema.sql's version of the table lost that column somewhere in the
-- fold -- every other reviews column made it across, just not this one. Every piece of client
-- code that ever touched reviews (submitReview/fetchBookStats/fetchAuthorRatingsSummary in
-- src/lib/library.js, and everything downstream of them -- the Creator Dashboard's Ratings tab,
-- the Grand Library's per-book rating display) has been reading and writing a `rating` field the
-- whole time, so on any deployment that ran the consolidated schema.sql as its base (every fresh
-- install per README's own Setup instructions -- schema_phase2.sql is history-only now), every
-- one of those calls has been failing outright with "column reviews.rating does not exist" as
-- soon as it touched the table for real.
--
-- Because the insert has always failed for any real writer's client, there should be zero
-- existing rows in `reviews` on any deployment that only ever ran the consolidated schema.sql --
-- this migration still handles a nonzero table defensively (nullable column first, backfill,
-- then tighten to not null + the check constraint) rather than assuming that.
--
-- Safe to run anytime, including against a deployment with existing (rating-less) rows.

alter table reviews add column if not exists rating smallint;

-- Defensive backfill only -- expected to touch zero rows on any real deployment (see header).
-- A neutral middle value rather than a guess at what the reviewer actually meant.
update reviews set rating = 3 where rating is null;

alter table reviews alter column rating set not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'reviews_rating_check'
  ) then
    alter table reviews add constraint reviews_rating_check check (rating between 1 and 5);
  end if;
end $$;
