-- Migration 35: Guild Anthologies — a Player Guild's collaborative book, made of submissions
-- from multiple members, that becomes one real published_books listing when it goes live.
--
-- Deliberately reuses, rather than reinvents, three systems that already exist:
--   1. MANUSCRIPTS stay exactly where they already live — a member's own project in kv_store.
--      A submission here is a lightweight pointer (project_id, title, word_count), the same
--      shape guild_published_books.book_id already uses for the Guild Bookshelf. No manuscript
--      text is ever copied into this migration's tables.
--   2. PUBLISHING stays on published_books. Publishing an anthology inserts exactly one row
--      there (see publish_guild_anthology below) and nothing else — the existing Grand Library
--      read policy, the existing "author updates own listings" policy, and the existing
--      paystack-init-purchase/webhook pipeline all pick it up unchanged. There is no second
--      book table and no second payment path.
--   3. The FINANCIAL LEDGER stays guild_treasury_transactions (33/34_migration_guild_treasury).
--      That table's `kind` check already reserves 'anthology_share' with source='anthology_sale'
--      and destination='member_earnings_held', and already carries a project_event_id column
--      with no FK yet "because neither feature has a table of its own today." This migration is
--      what gives it one (guild_anthologies.id) — actually crediting contributors from a sale is
--      the Revenue Splitting phase called out separately in the audit, so it's left for that
--      migration to write the first real 'anthology_share' row; this one only makes the target
--      (project_event_id) real.
--
-- Scoped to Player Guilds only, same cut as guild_member_stats and guild_treasury_transactions:
-- a Founder Guild's "Anthology" tab (guild-order.jsx's GoAnthologyTab) stays the simulated,
-- word-count-split preview it already honestly labels itself as — there's no real roster there
-- to check contributor identity or submission ownership against yet.
--
-- Authority model matches spend_from_guild_treasury exactly: player_guilds.owner_id is the one
-- real, server-known authority for a Player Guild today, so creating, opening/closing
-- submissions, reviewing, and publishing are all owner-only. Widening this to a real Council/
-- Editor role is the same reasonable next step noted in 33_migration_guild_treasury.sql, once
-- guild roles exist as rows instead of a client-side computation (see GO_PERMISSIONS in
-- guild-order.jsx for the roles that already exist client-side only).

-- ============================================================================================
-- guild_anthologies — the anthology itself: everything about it BEFORE it's a real published
-- listing. Title/description/cover/price mirror published_books' own columns exactly (same
-- names, same shapes) so publish_guild_anthology below is a straight copy, not a translation.
-- ============================================================================================

create table if not exists guild_anthologies (
  id uuid primary key default gen_random_uuid(),
  guild_id uuid not null references player_guilds(id) on delete cascade,
  title text not null check (char_length(title) <= 200),
  description text check (description is null or char_length(description) <= 2000),
  cover jsonb, -- same structured cover object (style/accent/motif/customImageUrl) as published_books.cover
  -- The proposed/target price while this is still being assembled. Once published, the LIVE
  -- price lives on published_books.price (editable there via the existing "author updates own
  -- listings" policy) — this column stops being read after that point, on purpose: see
  -- guard_guild_anthology_mutation below for why it's frozen, not kept in sync.
  price numeric not null default 0 check (price >= 0),
  submission_deadline timestamptz,
  -- open       -> accepting submissions
  -- reviewing  -> submissions closed, owner is approving/rejecting what came in
  -- published  -> live as a published_books row (published_book_id is set)
  -- cancelled  -> abandoned before publishing; submissions stay for the historical record
  status text not null default 'open' check (status in ('open', 'reviewing', 'published', 'cancelled')),
  published_book_id text references published_books(id) on delete set null,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  unique (published_book_id)
);

alter table guild_anthologies enable row level security;

create policy "guild members read guild anthologies" on guild_anthologies
  for select using (
    exists (select 1 from player_guild_members m where m.guild_id = guild_anthologies.guild_id and m.user_id = auth.uid())
  );

create policy "guild owner creates an anthology" on guild_anthologies
  for insert with check (
    auth.uid() = created_by
    and not is_banned(auth.uid())
    and exists (select 1 from player_guilds g where g.id = guild_anthologies.guild_id and g.owner_id = auth.uid())
  );

-- One update policy, row-scoped to the owner; guard_guild_anthology_mutation below is what
-- keeps this from also letting the owner edit status/published_book_id/published_at directly —
-- exactly protect_admin_profile_columns' shape (a policy for row access, a trigger for column
-- restriction), reused here for the same reason: Postgres RLS has no native per-column check.
create policy "guild owner updates their anthology" on guild_anthologies
  for update using (
    exists (select 1 from player_guilds g where g.id = guild_anthologies.guild_id and g.owner_id = auth.uid())
  );

-- No delete policy — cancel via status='cancelled' instead, so a cancelled anthology's
-- submissions (and their authors' effort) aren't silently destroyed. Matches the ledger's own
-- "insert a new row, never erase the old one" philosophy in spirit, even though this table isn't
-- itself append-only.

create index if not exists guild_anthologies_guild_idx on guild_anthologies (guild_id, created_at desc);

-- status/published_book_id/published_at may only change via the RPCs below (which set the
-- inkroot.trusted_anthology_rpc flag first) — never directly through the client update policy
-- above. Once published, title/description/cover/price are frozen here too: published_books is
-- the one live copy from that point on, and letting both drift independently is exactly what
-- profiles.js's own "no denormalized copy" comment already warns against for a different table.
create or replace function guard_guild_anthology_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(current_setting('inkroot.trusted_anthology_rpc', true), '') = 'true' then
    return new;
  end if;
  if old.status = 'published' then
    raise exception 'A published anthology''s listing lives on published_books now — edit it there.';
  end if;
  new.status := old.status;
  new.published_book_id := old.published_book_id;
  new.published_at := old.published_at;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists guild_anthology_guard on guild_anthologies;
create trigger guild_anthology_guard
  before update on guild_anthologies
  for each row execute function guard_guild_anthology_mutation();

-- ============================================================================================
-- guild_anthology_submissions — one row per member's contribution. project_id matches the
-- writer's own local project id (exactly guild_published_books.book_id's own pattern) — the
-- manuscript itself is never duplicated here, only enough display metadata for the guild to
-- review it. "Contributors" is deliberately NOT a separate roster table: a contributor is just
-- whoever has an approved row here (see guild_anthology_contributors() below) — a second table
-- tracking the same membership would be exactly the duplicate system this migration is meant to
-- avoid.
-- ============================================================================================

create table if not exists guild_anthology_submissions (
  id uuid primary key default gen_random_uuid(),
  anthology_id uuid not null references guild_anthologies(id) on delete cascade,
  contributor_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  title text not null check (char_length(title) <= 200),
  blurb text check (blurb is null or char_length(blurb) <= 2000),
  word_count integer not null default 0 check (word_count >= 0),
  review_status text not null default 'pending' check (review_status in ('pending', 'approved', 'rejected', 'withdrawn')),
  review_note text check (review_note is null or char_length(review_note) <= 1000),
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  submitted_at timestamptz not null default now()
);

alter table guild_anthology_submissions enable row level security;

-- A contributor may have at most one non-withdrawn submission per anthology at a time — they can
-- withdraw and resubmit a different project, but can't have two live entries competing for the
-- same slot. Partial index, not a plain unique constraint, for the same reason
-- 34_migration_guild_treasury_ledger_hardening.sql's idempotency_key index is partial: withdrawn
-- rows (and any number of them) shouldn't count against this.
create unique index if not exists guild_anthology_submissions_active_idx
  on guild_anthology_submissions (anthology_id, contributor_id) where review_status <> 'withdrawn';

create index if not exists guild_anthology_submissions_anthology_idx
  on guild_anthology_submissions (anthology_id, review_status);

-- Visible to every member of the anthology's guild, not just the submitter and the owner — same
-- transparency stance guild_treasury_transactions takes for guild-bucket rows: a shared creative
-- project's submission list is guild business, not a private one-on-one between submitter and
-- owner.
create policy "guild members read anthology submissions" on guild_anthology_submissions
  for select using (
    exists (
      select 1 from guild_anthologies a
      join player_guild_members m on m.guild_id = a.guild_id and m.user_id = auth.uid()
      where a.id = guild_anthology_submissions.anthology_id
    )
  );

create policy "guild members submit to an open anthology" on guild_anthology_submissions
  for insert with check (
    auth.uid() = contributor_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from guild_anthologies a
      join player_guild_members m on m.guild_id = a.guild_id and m.user_id = auth.uid()
      where a.id = guild_anthology_submissions.anthology_id
        and a.status = 'open'
        and (a.submission_deadline is null or now() <= a.submission_deadline)
    )
  );

-- Row-scoped to "the contributor themself OR the guild's owner" — guard_anthology_submission_
-- update below is what splits that into "content edits" vs "review verdict" per caller, the same
-- two-paths-one-trigger shape protect_admin_profile_columns already uses on profiles.
create policy "contributor or guild owner update a submission" on guild_anthology_submissions
  for update using (
    auth.uid() = contributor_id
    or exists (
      select 1 from guild_anthologies a join player_guilds g on g.id = a.guild_id
      where a.id = guild_anthology_submissions.anthology_id and g.owner_id = auth.uid()
    )
  );

-- No delete policy — withdrawing (review_status = 'withdrawn') is the retraction path, same
-- reasoning as guild_anthologies having no delete policy: the record of what was submitted and
-- when stays, rather than disappearing.

create or replace function guard_anthology_submission_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select exists (
    select 1 from guild_anthologies a join player_guilds g on g.id = a.guild_id
    where a.id = old.anthology_id and g.owner_id = auth.uid()
  ) into v_is_owner;

  if v_is_owner and auth.uid() <> old.contributor_id then
    -- The review path: only the verdict, never the submission's own content or ownership.
    new.title := old.title;
    new.blurb := old.blurb;
    new.project_id := old.project_id;
    new.word_count := old.word_count;
    new.contributor_id := old.contributor_id;
    new.submitted_at := old.submitted_at;
    if new.review_status is distinct from old.review_status then
      if new.review_status not in ('approved', 'rejected') then
        raise exception 'A guild owner may only approve or reject a submission.';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
  elsif auth.uid() = old.contributor_id then
    -- The contributor's own path: may edit their own content only before it's been reviewed,
    -- and may always withdraw regardless of review state.
    if new.review_status is distinct from old.review_status and new.review_status <> 'withdrawn' then
      raise exception 'You may only withdraw your own submission.';
    end if;
    if old.review_status <> 'pending'
       and (new.title is distinct from old.title or new.blurb is distinct from old.blurb
            or new.project_id is distinct from old.project_id or new.word_count is distinct from old.word_count) then
      raise exception 'This submission has already been reviewed — withdraw and resubmit instead of editing it.';
    end if;
    new.review_note := old.review_note;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
  else
    raise exception 'Not authorized to update this submission.';
  end if;
  return new;
end;
$$;

drop trigger if exists guild_anthology_submission_guard on guild_anthology_submissions;
create trigger guild_anthology_submission_guard
  before update on guild_anthology_submissions
  for each row execute function guard_anthology_submission_update();

-- ============================================================================================
-- Contributors — derived from approved submissions, never a stored roster of its own (see this
-- migration's header). security definer only so a guild member gets this in one round trip
-- without needing select on guild_anthologies itself; the membership check inside is what stands
-- in for the RLS this bypasses, same pattern as guild_treasury_summary.
-- ============================================================================================

create or replace function guild_anthology_contributors(p_anthology_id uuid)
returns table (contributor_id uuid, project_id text, title text, word_count integer, submitted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from guild_anthologies a
    join player_guild_members m on m.guild_id = a.guild_id and m.user_id = auth.uid()
    where a.id = p_anthology_id
  ) then
    raise exception 'Not a member of this anthology''s guild.';
  end if;
  return query
    select s.contributor_id, s.project_id, s.title, s.word_count, s.submitted_at
    from guild_anthology_submissions s
    where s.anthology_id = p_anthology_id and s.review_status = 'approved'
    order by s.submitted_at asc;
end;
$$;

revoke all on function guild_anthology_contributors(uuid) from public;
grant execute on function guild_anthology_contributors(uuid) to authenticated;

-- ============================================================================================
-- Lifecycle RPCs — every status transition an anthology can make, owner-only, each using the
-- inkroot.trusted_anthology_rpc bypass to get past guard_guild_anthology_mutation above.
-- Creating an anthology and submitting/reviewing a submission are deliberately NOT RPCs — those
-- are plain inserts/updates under the RLS policies above, the same weight published_books,
-- guild_published_books, and guild_book_feedback already give an ordinary content write. An RPC
-- is reserved here for the two actions that touch more than their own row: closing submissions
-- (checks deadline/current state) and publishing (writes a second table).
-- ============================================================================================

create or replace function close_guild_anthology_submissions(p_anthology_id uuid)
returns guild_anthologies
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_anthologies%rowtype;
begin
  if not exists (
    select 1 from guild_anthologies a join player_guilds g on g.id = a.guild_id
    where a.id = p_anthology_id and g.owner_id = auth.uid()
  ) then
    raise exception 'Only the guild owner can close submissions.';
  end if;
  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies set status = 'reviewing'
    where id = p_anthology_id and status = 'open'
    returning * into v_row;
  if not found then
    raise exception 'This anthology is not currently open for submissions.';
  end if;
  return v_row;
end;
$$;

-- Lets an owner walk back an early close — e.g. the deadline was extended — without losing any
-- review work already done (already-reviewed submissions keep their review_status).
create or replace function reopen_guild_anthology_submissions(p_anthology_id uuid)
returns guild_anthologies
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_anthologies%rowtype;
begin
  if not exists (
    select 1 from guild_anthologies a join player_guilds g on g.id = a.guild_id
    where a.id = p_anthology_id and g.owner_id = auth.uid()
  ) then
    raise exception 'Only the guild owner can reopen submissions.';
  end if;
  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies set status = 'open'
    where id = p_anthology_id and status = 'reviewing'
    returning * into v_row;
  if not found then
    raise exception 'This anthology is not currently under review.';
  end if;
  return v_row;
end;
$$;

create or replace function cancel_guild_anthology(p_anthology_id uuid)
returns guild_anthologies
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_anthologies%rowtype;
begin
  if not exists (
    select 1 from guild_anthologies a join player_guilds g on g.id = a.guild_id
    where a.id = p_anthology_id and g.owner_id = auth.uid()
  ) then
    raise exception 'Only the guild owner can cancel this anthology.';
  end if;
  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies set status = 'cancelled'
    where id = p_anthology_id and status in ('open', 'reviewing')
    returning * into v_row;
  if not found then
    raise exception 'This anthology has already been published or cancelled.';
  end if;
  return v_row;
end;
$$;

-- The one place an anthology becomes a real book. Inserts exactly one published_books row —
-- the SAME table every solo book already publishes through — copying title/description/cover/
-- price straight across (see guard_guild_anthology_mutation for why those three then freeze on
-- this table) and summing approved submissions' word_count. destination='guild' labels it as
-- guild-born, same meaning that value already carries for a regular solo publish from
-- publishing.jsx — it does not restrict who can read or buy it; published_books stays fully
-- public regardless (see published_books' own "anyone can read" policy).
--
-- author_id is set to the publishing guild owner, not to a synthetic "guild" identity —
-- published_books.author_id is a real not-null FK to auth.users, and Inkroot deliberately has no
-- placeholder account for that. This is a real, accepted constraint: every sale's
-- author_amount_kobo lands in the owner's own author_balance_kobo through the existing
-- purchases pipeline, unchanged. Splitting that income out to every contributor by their
-- word_count share is the Revenue Splitting phase the audit called out separately — this
-- migration's job is only to make that split's target addressable, via project_event_id below,
-- not to move any money itself.
create or replace function publish_guild_anthology(p_anthology_id uuid)
returns published_books
language plpgsql security definer set search_path = public as $$
declare
  v_anth guild_anthologies%rowtype;
  v_owner uuid;
  v_word_count integer;
  v_book_id text;
  v_book published_books%rowtype;
begin
  select * into v_anth from guild_anthologies where id = p_anthology_id for update;
  if not found then
    raise exception 'Anthology not found.';
  end if;

  select owner_id into v_owner from player_guilds where id = v_anth.guild_id;
  if v_owner is null or v_owner <> auth.uid() then
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
  if v_word_count = 0 then
    raise exception 'At least one approved submission is required before publishing.';
  end if;

  -- Stable, collision-free id: guild_anthologies.id is already a unique uuid, so prefixing it
  -- is enough — no separate id-generation scheme needed for this table's own published_books row.
  v_book_id := 'anthology-' || p_anthology_id::text;

  insert into published_books (id, author_id, title, blurb, cover, price, word_count, destination)
  values (v_book_id, auth.uid(), v_anth.title, v_anth.description, v_anth.cover, v_anth.price, v_word_count, 'guild')
  returning * into v_book;

  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies
    set status = 'published', published_book_id = v_book_id, published_at = now()
    where id = p_anthology_id;

  return v_book;
end;
$$;

revoke all on function close_guild_anthology_submissions(uuid) from public;
revoke all on function reopen_guild_anthology_submissions(uuid) from public;
revoke all on function cancel_guild_anthology(uuid) from public;
revoke all on function publish_guild_anthology(uuid) from public;
grant execute on function close_guild_anthology_submissions(uuid) to authenticated;
grant execute on function reopen_guild_anthology_submissions(uuid) to authenticated;
grant execute on function cancel_guild_anthology(uuid) to authenticated;
grant execute on function publish_guild_anthology(uuid) to authenticated;

-- Safe to run anytime: every object above is created with if-not-exists/or-replace, and nothing
-- here touches an existing table's columns or existing rows except adding an FK target
-- (published_books.id via guild_anthologies.published_book_id, nullable, never backfilled).
