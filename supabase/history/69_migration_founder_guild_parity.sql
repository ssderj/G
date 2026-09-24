-- 69_migration_founder_guild_parity.sql
--
-- Gives Founder Guilds a real backend with the same treasury/anthology/event privileges as
-- Player Guilds, using the Inkroot platform admin (profiles.is_platform_admin) as every Founder
-- Guild's officer — per product decision, since a Founder Guild has no single owner the way a
-- Player Guild does. Run this once against an existing database; supabase/schema.sql has the
-- same end state folded in for fresh installs.
--
-- Deliberately NOT touched by this migration (see the reply that shipped it for the full
-- reasoning):
--   * founder_guild_members (roster) — already real, untouched, still the source of truth for
--     who's actually in a Founder Guild.
--   * guild_order_chapters / guild_order_passages (Manuscript/Roster tab) — already real for
--     both guild types, using its own merit-based standing check (published book >= 15k words)
--     instead of an owner/officer check. Left as-is; unrelated to what was asked.
--   * Referral-reward attribution (owner_id = p_referee_id, 4 call sites) — has no sane Founder
--     Guild equivalent since there's no single referee to credit. Stays Player-Guild-only.
--   * World Bible / Workshop / Competition tabs — remain simulated for BOTH guild types (an
--     existing, pre-existing design decision unrelated to Founder-vs-Player parity).

-- ============================================================================================
-- Founder Guild parity — Founder Guilds materialized as real player_guilds rows.
--
-- Until now, everything hanging off player_guilds.id (guild_anthologies, guild_treasury_
-- transactions, guild_events, guild_event_hosting_fee_payments, guild_event_financial_
-- agreements — the entire money-moving side of a guild) only ever pointed at a Player Guild.
-- A Founder Guild (the 10 fixed lore guilds — see FOUNDER_GUILDS in guild-hall.jsx) had no row
-- here at all, so none of that could ever apply to one; its Anthology/Treasury tabs stayed
-- permanently simulated (see guild-order.jsx's HONESTY NOTE / ARCHITECTURE.md).
--
-- Rather than adding a parallel founder_guild_id column to every single one of those tables
-- (doubling every join, every RLS policy, and every RPC signature), this migration gives each
-- of the 10 Founder Guilds one real, fixed-id row in player_guilds itself. Every table and
-- function that already speaks "guild_id uuid references player_guilds(id)" now works for a
-- Founder Guild automatically, with zero further schema changes downstream.
--
-- A Founder Guild row is distinguished by is_founder_guild = true and a stable founder_slug
-- (matching FOUNDER_GUILDS[].id client-side: 'fantasy', 'romance', etc.) instead of an owner_id
-- — nobody personally owns a Founder Guild the way a Player Guild's founder does. Its "officer"
-- authority (treasury spend, revenue agreements, hosting fees — anywhere a Player Guild check
-- would look at owner_id) is delegated instead to whichever profile(s) carry is_platform_admin,
-- by Inkroot's own decision that the platform admin (and anyone they appoint via that same flag)
-- acts as every Founder Guild's officer. See is_guild_officer()/is_guild_member() below — the
-- single place this rule is decided, so every call site listed above agrees with the UI.
--
-- founder_guild_members (membership/roster — already real, see the Guild Presence migration) is
-- deliberately left untouched: it's still the one source of truth for who's actually in a
-- Founder Guild, keyed by the same text slug it always used. is_guild_member() below bridges the
-- two — reading player_guild_members for a Player Guild, founder_guild_members for a Founder
-- Guild — rather than migrating membership rows into player_guild_members, which would have
-- meant reshaping a table (and every trigger/RLS policy already built on it) that already works.
-- ============================================================================================

alter table player_guilds add column if not exists is_founder_guild boolean not null default false;
alter table player_guilds add column if not exists founder_slug text;
alter table player_guilds alter column owner_id drop not null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'player_guilds_owner_xor_founder') then
    alter table player_guilds add constraint player_guilds_owner_xor_founder check (
      (is_founder_guild and owner_id is null and founder_slug is not null)
      or (not is_founder_guild and owner_id is not null and founder_slug is null)
    );
  end if;
end $$;

create unique index if not exists player_guilds_founder_slug_idx on player_guilds (founder_slug)
  where founder_slug is not null;

-- Fixed, deterministic ids — never regenerated — so every reference to one of these 10 rows
-- (client-side and in any future migration) is stable across environments. Order/wording matches
-- FOUNDER_GUILDS in src/guild/guild-hall.jsx exactly; keep both in sync if a guild is ever
-- renamed. invite_code is meaningless for a Founder Guild (always open, never invite-only) but
-- the column is NOT NULL/unique, so each gets a fixed, obviously-synthetic value instead of a
-- random one.
insert into player_guilds (id, name, motto, owner_id, is_founder_guild, founder_slug, invite_code)
values
  ('00000000-f01d-4000-8000-000000000001', 'The Fantasy Guild', 'Where dragons rise and kingdoms are born.', null, true, 'fantasy', 'founder-fantasy'),
  ('00000000-f01d-4000-8000-000000000002', 'The Romance Guild', 'Every heart has a story worth telling.', null, true, 'romance', 'founder-romance'),
  ('00000000-f01d-4000-8000-000000000003', 'The Science Fiction Guild', 'Chart the unknown, one page at a time.', null, true, 'scifi', 'founder-scifi'),
  ('00000000-f01d-4000-8000-000000000004', 'The Historical Guild', 'The past deserves an eloquent witness.', null, true, 'historical', 'founder-historical'),
  ('00000000-f01d-4000-8000-000000000005', 'The Horror Guild', 'Fear is just another kind of honesty.', null, true, 'horror', 'founder-horror'),
  ('00000000-f01d-4000-8000-000000000006', 'The Mystery Guild', 'Every clue leads somewhere.', null, true, 'mystery', 'founder-mystery'),
  ('00000000-f01d-4000-8000-000000000007', 'The Comedy Guild', 'Laughter is the plot twist we all need.', null, true, 'comedy', 'founder-comedy'),
  ('00000000-f01d-4000-8000-000000000008', 'The Worldbuilders Guild', 'Maps, myths, and the bones of new worlds.', null, true, 'worldbuilders', 'founder-worldbuilders'),
  ('00000000-f01d-4000-8000-000000000009', 'The Poetry Guild', 'Say more with less.', null, true, 'poetry', 'founder-poetry'),
  ('00000000-f01d-4000-8000-00000000000a', 'The General Writers Guild', 'For stories that defy a single shelf.', null, true, 'general', 'founder-general')
on conflict (founder_slug) where founder_slug is not null do nothing;

-- The player_guilds select policy (owner-or-member only, to protect invite_code) doesn't cover
-- these — nobody is ever their owner_id, and Founder Guild members are never inserted into
-- player_guild_members. A Founder Guild's existence/name/motto/id isn't sensitive the way an
-- invite_code is (every writer already sees all 10 in FOUNDER_GUILDS client-side), so this is a
-- narrow, public, read-only allowance for exactly the founder rows — never invite_code-bearing
-- Player Guild rows, which stay exactly as restricted as before.
create policy "anyone can read the 10 founder guild rows" on player_guilds
  for select using (is_founder_guild);

-- language plpgsql (not sql) deliberately: its body references profiles.is_platform_admin and
-- is_inkroot_admin(), both defined later in this file (see the Inkroot Admin migration below) —
-- a plpgsql body is only checked at first call, not at CREATE FUNCTION time, so this forward
-- reference is safe as long as both exist by the time schema.sql finishes running, which they do.
--
-- is_guild_member — "is this caller allowed in at all" for a guild_id that could be either kind.
-- Player Guild: real player_guild_members row. Founder Guild: real founder_guild_members row,
-- looked up by the row's founder_slug (founder_guild_members itself is still keyed by that text
-- slug, unchanged by this migration).
create or replace function is_guild_member(p_guild_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    return false;
  end if;
  if v_guild.is_founder_guild then
    return exists (
      select 1 from founder_guild_members m
      where m.guild_id = v_guild.founder_slug and m.user_id = auth.uid()
    );
  end if;
  return exists (
    select 1 from player_guild_members m where m.guild_id = v_guild.id and m.user_id = auth.uid()
  );
end;
$$;

revoke all on function is_guild_member(uuid) from public;
grant execute on function is_guild_member(uuid) to authenticated;

-- is_guild_officer — "is this caller allowed to act with this guild's authority" (approve/spend/
-- publish/host — everywhere a Player Guild check used to be a plain owner_id = auth.uid()).
-- Player Guild: the real owner. Founder Guild: any Inkroot admin (is_platform_admin) — see this
-- migration's own header for why a Founder Guild delegates officer authority that way instead of
-- to a single owner.
create or replace function is_guild_officer(p_guild_id uuid)
returns boolean
language plpgsql stable security definer set search_path = public
as $$
declare
  v_guild player_guilds%rowtype;
begin
  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    return false;
  end if;
  if v_guild.is_founder_guild then
    return is_inkroot_admin() and auth.uid() is not null;
  end if;
  return v_guild.owner_id = auth.uid();
end;
$$;

revoke all on function is_guild_officer(uuid) from public;
grant execute on function is_guild_officer(uuid) to authenticated;


-- Every downstream check that used to be a raw "player_guilds owner_id = auth.uid()" or
-- "player_guild_members membership" lookup now goes through is_guild_member()/is_guild_officer()
-- instead, so it transparently covers a Founder Guild row too. Policies need drop+recreate
-- (no CREATE OR REPLACE POLICY in Postgres); functions are plain CREATE OR REPLACE and safe to
-- rerun as-is.

drop policy if exists "guild members read guild-owned treasury transactions" on guild_treasury_transactions;
create policy "guild members read guild-owned treasury transactions" on guild_treasury_transactions
  for select using (
    bucket = 'guild'
    and is_guild_member(guild_treasury_transactions.guild_id)
  );

drop policy if exists "guild members read guild anthologies" on guild_anthologies;
create policy "guild members read guild anthologies" on guild_anthologies
  for select using (
    is_guild_member(guild_anthologies.guild_id)
  );

drop policy if exists "guild owner creates an anthology" on guild_anthologies;
create policy "guild owner creates an anthology" on guild_anthologies
  for insert with check (
    auth.uid() = created_by
    and not is_banned(auth.uid())
    and is_guild_officer(guild_anthologies.guild_id)
  );

drop policy if exists "guild owner updates their anthology" on guild_anthologies;
create policy "guild owner updates their anthology" on guild_anthologies
  for update using (
    is_guild_officer(guild_anthologies.guild_id)
  );

drop policy if exists "guild members read anthology submissions" on guild_anthology_submissions;
create policy "guild members read anthology submissions" on guild_anthology_submissions
  for select using (
    exists (
      select 1 from guild_anthologies a
      where a.id = guild_anthology_submissions.anthology_id
        and is_guild_member(a.guild_id)
    )
  );

drop policy if exists "guild members submit to an open anthology" on guild_anthology_submissions;
create policy "guild members submit to an open anthology" on guild_anthology_submissions
  for insert with check (
    auth.uid() = contributor_id
    and not is_banned(auth.uid())
    and exists (
      select 1 from guild_anthologies a
      where a.id = guild_anthology_submissions.anthology_id
        and is_guild_member(a.guild_id)
        and a.status = 'open'
        and (a.submission_deadline is null or now() <= a.submission_deadline)
    )
  );

drop policy if exists "contributor or guild owner update a submission" on guild_anthology_submissions;
create policy "contributor or guild owner update a submission" on guild_anthology_submissions
  for update using (
    auth.uid() = contributor_id
    or exists (
      select 1 from guild_anthologies a
      where a.id = guild_anthology_submissions.anthology_id and is_guild_officer(a.guild_id)
    )
  );

drop policy if exists "guild members read revenue agreements" on guild_anthology_revenue_agreements;
create policy "guild members read revenue agreements" on guild_anthology_revenue_agreements
  for select using (
    exists (
      select 1 from guild_anthologies a
      where a.id = guild_anthology_revenue_agreements.anthology_id and is_guild_member(a.guild_id)
    )
  );

drop policy if exists "guild members read revenue shares" on guild_anthology_revenue_shares;
create policy "guild members read revenue shares" on guild_anthology_revenue_shares
  for select using (
    exists (
      select 1 from guild_anthology_revenue_agreements ag
      join guild_anthologies a on a.id = ag.anthology_id
      where ag.id = guild_anthology_revenue_shares.agreement_id and is_guild_member(a.guild_id)
    )
  );

drop policy if exists "guild owner reads entries for their own events" on guild_event_entries;
create policy "guild owner reads entries for their own events" on guild_event_entries
  for select using (
    exists (
      select 1 from guild_events e
      where e.id = guild_event_entries.event_id and is_guild_officer(e.guild_id)
    )
  );

drop policy if exists "guild owner reads their own event hosting fee payments" on guild_event_hosting_fee_payments;
create policy "guild owner reads their own event hosting fee payments" on guild_event_hosting_fee_payments
  for select using (
    is_guild_officer(guild_event_hosting_fee_payments.guild_id)
  );

drop policy if exists "anyone can read the 10 founder guild rows" on player_guilds;
create policy "anyone can read the 10 founder guild rows" on player_guilds
  for select using (is_founder_guild);


-- Functions below are all CREATE OR REPLACE — safe to rerun, no DROP needed.

create or replace function contribute_to_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_note text default null,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_member(p_guild_id) then
    raise exception 'Not a member of this guild.';
  end if;
  -- Serializes concurrent contributions from the same writer so two simultaneous requests can't
  -- both read the same starting balance and together overdraw it.
  perform pg_advisory_xact_lock(hashtext(auth.uid()::text));
  if author_balance_kobo(auth.uid()) < p_amount_kobo then
    raise exception 'That would exceed your available balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'credit', 'contribution', p_amount_kobo, 'NGN', 'member_balance',
     'guild_treasury', p_project_event_id, 'success', p_note, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

create or replace function spend_from_guild_treasury(
  p_guild_id uuid, p_amount_kobo bigint, p_title text,
  p_idempotency_key text default null, p_project_event_id uuid default null
)
returns guild_treasury_transactions
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_treasury_transactions;
begin
  if p_idempotency_key is not null then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
    if found then
      return v_row;
    end if;
  end if;

  if p_amount_kobo is null or p_amount_kobo <= 0 then
    raise exception 'Amount must be positive.';
  end if;
  if not is_guild_treasury_authorized(p_guild_id) then
    raise exception 'Only the guild leader, treasurer, or an officer can authorize a treasury spend.';
  end if;
  if p_amount_kobo >= guild_treasury_multi_approval_threshold_kobo() then
    raise exception 'Withdrawals of this size require multiple approvals — use propose_guild_treasury_spend instead.';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_guild_id::text));
  if guild_treasury_available_kobo(p_guild_id) < p_amount_kobo then
    raise exception 'That would exceed the guild''s available treasury balance.';
  end if;

  insert into guild_treasury_transactions
    (guild_id, bucket, member_id, direction, kind, amount_kobo, currency, source, destination,
     project_event_id, status, title, created_by, idempotency_key)
  values
    (p_guild_id, 'guild', null, 'debit', 'spend', p_amount_kobo, 'NGN', 'guild_treasury',
     'external', p_project_event_id, 'success', p_title, auth.uid(), p_idempotency_key)
  on conflict (idempotency_key) where idempotency_key is not null do nothing
  returning * into v_row;

  if not found then
    select * into v_row from guild_treasury_transactions where idempotency_key = p_idempotency_key;
  end if;
  return v_row;
end;
$$;

create or replace function guild_treasury_role(p_guild_id uuid, p_user_id uuid default auth.uid())
returns text as $$
  select case
    when exists (
      select 1 from player_guilds g
      where g.id = p_guild_id
        and (
          (not g.is_founder_guild and g.owner_id = p_user_id)
          or (g.is_founder_guild and exists (
            select 1 from profiles p where p.id = p_user_id and p.is_platform_admin
          ))
        )
    ) then 'leader'
    else (select m.role from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_user_id)
  end;
$$ language sql stable security definer set search_path = public;

create or replace function set_guild_treasury_role(p_guild_id uuid, p_member_id uuid, p_role text)
returns player_guild_members
language plpgsql security definer set search_path = public as $$
declare
  v_guild player_guilds%rowtype;
  v_row player_guild_members;
begin
  if p_role not in ('treasurer', 'officer', 'member') then
    raise exception 'Role must be treasurer, officer, or member.';
  end if;

  select * into v_guild from player_guilds where id = p_guild_id;
  if not found then
    raise exception 'Guild not found.';
  end if;
  if v_guild.is_founder_guild then
    raise exception 'A Founder Guild has no single leader to delegate Treasurer/Officer roles — every Inkroot admin already carries full authority here.';
  end if;
  if auth.uid() <> v_guild.owner_id then
    raise exception 'Only the guild leader can assign treasury roles.';
  end if;
  if p_member_id = v_guild.owner_id then
    raise exception 'The guild leader''s own role cannot be changed here.';
  end if;

  update player_guild_members set role = p_role
  where guild_id = p_guild_id and user_id = p_member_id
  returning * into v_row;

  if not found then
    raise exception 'That writer is not a member of this guild.';
  end if;
  return v_row;
end;
$$;

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
    select 1 from guild_anthologies a
    where a.id = old.anthology_id and is_guild_officer(a.guild_id)
  ) into v_is_owner;

  if v_is_owner and auth.uid() <> old.contributor_id then
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

create or replace function guild_anthology_contributors(p_anthology_id uuid)
returns table (contributor_id uuid, project_id text, title text, word_count integer, submitted_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (
    select 1 from guild_anthologies a
    where a.id = p_anthology_id and is_guild_member(a.guild_id)
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

create or replace function close_guild_anthology_submissions(p_anthology_id uuid)
returns guild_anthologies
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_anthologies%rowtype;
begin
  if not exists (
    select 1 from guild_anthologies a
    where a.id = p_anthology_id and is_guild_officer(a.guild_id)
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

create or replace function reopen_guild_anthology_submissions(p_anthology_id uuid)
returns guild_anthologies
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_anthologies%rowtype;
begin
  if not exists (
    select 1 from guild_anthologies a
    where a.id = p_anthology_id and is_guild_officer(a.guild_id)
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
    select 1 from guild_anthologies a
    where a.id = p_anthology_id and is_guild_officer(a.guild_id)
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
  if v_word_count = 0 then
    raise exception 'At least one approved submission is required before publishing.';
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

create or replace function propose_anthology_revenue_agreement(
  p_anthology_id uuid,
  p_split_type text,
  p_custom_shares jsonb default null -- required for 'custom': [{"contributor_id": "...", "share_bps": 5000}, ...]
)
returns guild_anthology_revenue_agreements
language plpgsql security definer set search_path = public as $$
declare
  v_anth guild_anthologies%rowtype;
  v_owner uuid;
  v_agreement guild_anthology_revenue_agreements%rowtype;
  v_agreement_exists boolean;
  v_contributor_count integer;
  v_custom_count integer;
  v_custom_sum bigint;
begin
  select * into v_anth from guild_anthologies where id = p_anthology_id for update;
  if not found then
    raise exception 'Anthology not found.';
  end if;

  if not is_guild_officer(v_anth.guild_id) then
    raise exception 'Only the guild owner can propose a revenue agreement.';
  end if;
  if v_anth.status = 'published' then
    raise exception 'This anthology is already published — its revenue agreement is locked.';
  end if;
  if p_split_type not in ('equal', 'custom', 'contribution') then
    raise exception 'Unknown split type.';
  end if;

  select count(*) into v_contributor_count from (
    select distinct contributor_id from guild_anthology_submissions
    where anthology_id = p_anthology_id and review_status = 'approved'
  ) c;
  if v_contributor_count = 0 then
    raise exception 'At least one approved contributor is required before proposing a revenue agreement.';
  end if;

  select * into v_agreement from guild_anthology_revenue_agreements where anthology_id = p_anthology_id for update;
  v_agreement_exists := found;
  if v_agreement_exists and v_agreement.locked then
    raise exception 'This anthology''s revenue agreement is locked and can no longer be changed.';
  end if;

  if p_split_type = 'custom' then
    if p_custom_shares is null then
      raise exception 'Custom shares are required for a custom split.';
    end if;
    select count(*), coalesce(sum((r->>'share_bps')::integer), 0)
      into v_custom_count, v_custom_sum
      from jsonb_array_elements(p_custom_shares) r;
    if v_custom_count <> v_contributor_count then
      raise exception 'Custom shares must name exactly the anthology''s % approved contributor(s) — no more, no fewer.', v_contributor_count;
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_custom_shares) r
      where not exists (
        select 1 from guild_anthology_submissions s
        where s.anthology_id = p_anthology_id and s.review_status = 'approved'
          and s.contributor_id = (r->>'contributor_id')::uuid
      )
    ) then
      raise exception 'Custom shares include someone who isn''t an approved contributor on this anthology.';
    end if;
    if exists (select 1 from jsonb_array_elements(p_custom_shares) r where (r->>'share_bps')::integer < 0) then
      raise exception 'A share cannot be negative.';
    end if;
    if v_custom_sum <> 10000 then
      raise exception 'Custom shares must add up to exactly 100%% of the anthology''s revenue — got %%.', round(v_custom_sum / 100.0, 2);
    end if;
  end if;

  if v_agreement_exists then
    update guild_anthology_revenue_agreements
      set split_type = p_split_type, revision = v_agreement.revision + 1, updated_at = now()
      where id = v_agreement.id
      returning * into v_agreement;
  else
    insert into guild_anthology_revenue_agreements (anthology_id, split_type, revision, created_by)
      values (p_anthology_id, p_split_type, 1, auth.uid())
      returning * into v_agreement;
  end if;

  -- Always start clean: whatever was here before (including anyone's approval) is gone the
  -- moment a new split is proposed, by design — see this migration's header.
  delete from guild_anthology_revenue_shares where agreement_id = v_agreement.id;

  if p_split_type = 'equal' then
    with contributors as (
      select distinct contributor_id from guild_anthology_submissions
      where anthology_id = p_anthology_id and review_status = 'approved'
    ),
    ranked as (
      select contributor_id, row_number() over (order by contributor_id) as rn from contributors
    )
    insert into guild_anthology_revenue_shares (agreement_id, contributor_id, share_bps, approved_at)
    select v_agreement.id, contributor_id,
           -- integer division leaves a remainder of at most (n-1) basis points; hand those out
           -- one apiece, in a fixed order, so the total is always exactly 10000.
           (10000 / v_contributor_count) + case when rn <= (10000 % v_contributor_count) then 1 else 0 end,
           null
    from ranked;

  elsif p_split_type = 'contribution' then
    with words as (
      select s.contributor_id, sum(s.word_count) as words
      from guild_anthology_submissions s
      where s.anthology_id = p_anthology_id and s.review_status = 'approved'
      group by s.contributor_id
    ),
    total as (
      select greatest(sum(words), 1) as total_words from words
    ),
    raw as (
      select w.contributor_id, (w.words::numeric / t.total_words) * 10000 as raw_share
      from words w cross join total t
    ),
    based as (
      select contributor_id, floor(raw_share)::integer as base, raw_share - floor(raw_share) as frac
      from raw
    ),
    ranked as (
      select contributor_id, base, frac,
             row_number() over (order by frac desc, contributor_id) as rn,
             (10000 - sum(base) over ())::integer as remainder
      from based
    )
    -- Largest-remainder method: proportional shares almost never land on whole basis points, so
    -- the leftover after flooring everyone goes to whoever was closest to rounding up, largest
    -- fraction first — the standard way to make a proportional split add up to exactly 100%
    -- without arbitrarily favoring the first row alphabetically.
    insert into guild_anthology_revenue_shares (agreement_id, contributor_id, share_bps, approved_at)
    select v_agreement.id, contributor_id, base + case when rn <= remainder then 1 else 0 end, null
    from ranked;

  else -- custom, already fully validated above
    insert into guild_anthology_revenue_shares (agreement_id, contributor_id, share_bps, approved_at)
    select v_agreement.id, (r->>'contributor_id')::uuid, (r->>'share_bps')::integer, null
    from jsonb_array_elements(p_custom_shares) r;
  end if;

  return v_agreement;
end;
$$;



-- Guild Events / hosting-fee / financial-agreement lifecycle functions — same treatment.

create or replace function create_guild_event(
  p_guild_id uuid, p_title text, p_host text,
  p_entry_fee_kobo bigint default null, p_cash_prize_kobo bigint default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;

  if p_host = 'inkroot' then
    if not is_inkroot_admin() then
      raise exception 'Only an Inkroot admin can host a cash-prize event.';
    end if;
    if p_cash_prize_kobo is null or p_cash_prize_kobo <= 0 then
      raise exception 'An Inkroot-hosted event needs a positive cash prize.';
    end if;
    if p_entry_fee_kobo is not null then
      raise exception 'An Inkroot-hosted event has no entry fee \u2014 it''s funded directly.';
    end if;
    if not exists (select 1 from player_guilds g where g.id = p_guild_id) then
      raise exception 'Guild not found.';
    end if;
    insert into guild_events (guild_id, host, title, cash_prize_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'inkroot', trim(p_title), p_cash_prize_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    return v_row;
  elsif p_host = 'guild' then
    if not is_guild_officer(p_guild_id) then
      raise exception 'Only the guild owner can host a guild event.';
    end if;
    if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
      raise exception 'A guild-hosted event needs a positive entry fee.';
    end if;
    if p_cash_prize_kobo is not null then
      raise exception 'A guild-hosted event funds its own prize from entry fees \u2014 it has no separate cash prize.';
    end if;
    insert into guild_events (guild_id, host, title, entry_fee_kobo, created_by, approval_status, status, published_at, activated_at)
    values (p_guild_id, 'guild', trim(p_title), p_entry_fee_kobo, auth.uid(), 'active', 'open', now(), now())
    returning * into v_row;
    return v_row;
  else
    raise exception 'Unknown event host.';
  end if;
end;
$$;

create or replace function create_guild_event_draft(
  p_guild_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can host a guild event.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  insert into guild_events (
    guild_id, host, title, description, rules, event_type, entry_fee_kobo, participant_limit,
    prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url,
    created_by, approval_status, status
  ) values (
    p_guild_id, 'guild', trim(p_title), nullif(trim(coalesce(p_description, '')), ''),
    nullif(trim(coalesce(p_rules, '')), ''), coalesce(p_event_type, 'other'),
    p_entry_fee_kobo, p_participant_limit, coalesce(p_prize_structure, '[]'::jsonb),
    coalesce(p_guild_share_bps, 0), p_start_date, p_end_date, p_organizer_id, p_cover_image_url,
    auth.uid(), 'draft', 'closed'
  ) returning * into v_row;
  return v_row;
end;
$$;

create or replace function update_guild_event_draft(
  p_guild_id uuid,
  p_event_id uuid,
  p_title text,
  p_description text default null,
  p_rules text default null,
  p_event_type text default 'other',
  p_entry_fee_kobo bigint default null,
  p_participant_limit integer default null,
  p_prize_structure jsonb default '[]'::jsonb,
  p_guild_share_bps integer default 0,
  p_start_date timestamptz default null,
  p_end_date timestamptz default null,
  p_organizer_id uuid default null,
  p_cover_image_url text default null
)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can edit this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Only a draft or rejected event can be edited.';
  end if;
  if p_title is null or length(trim(p_title)) = 0 then
    raise exception 'Give the event a title.';
  end if;
  if p_entry_fee_kobo is null or p_entry_fee_kobo <= 0 then
    raise exception 'A guild-hosted event needs a positive entry fee.';
  end if;
  if p_organizer_id is not null and not exists (
    select 1 from player_guild_members m where m.guild_id = p_guild_id and m.user_id = p_organizer_id
  ) then
    raise exception 'The organizer must be a member of this guild.';
  end if;
  if p_start_date is not null and p_end_date is not null and p_end_date <= p_start_date then
    raise exception 'End date must be after the start date.';
  end if;

  update guild_events set
    title = trim(p_title),
    description = nullif(trim(coalesce(p_description, '')), ''),
    rules = nullif(trim(coalesce(p_rules, '')), ''),
    event_type = coalesce(p_event_type, 'other'),
    entry_fee_kobo = p_entry_fee_kobo,
    participant_limit = p_participant_limit,
    prize_structure = coalesce(p_prize_structure, '[]'::jsonb),
    guild_share_bps = coalesce(p_guild_share_bps, 0),
    start_date = p_start_date,
    end_date = p_end_date,
    organizer_id = p_organizer_id,
    cover_image_url = p_cover_image_url,
    approval_status = 'draft',
    rejection_reason = null,
    reviewed_by = null,
    reviewed_at = null,
    submitted_at = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function submit_guild_event_for_approval(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can submit this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'This event has already been submitted.';
  end if;
  if v_event.title is null or length(trim(v_event.title)) = 0
     or v_event.entry_fee_kobo is null or v_event.start_date is null or v_event.end_date is null then
    raise exception 'Fill in the title, entry fee, and start/end dates before submitting.';
  end if;
  if v_event.host = 'guild' and not exists (
    select 1 from guild_event_financial_agreements a where a.event_id = p_event_id
  ) then
    raise exception 'Set how entry fees will be divided — prize pool, guild share, and any other allocations — before submitting.';
  end if;

  update guild_events set approval_status = 'pending_approval', submitted_at = now(), rejection_reason = null
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function close_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_events;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can close entries for this event.';
  end if;
  update guild_events set status = 'closed'
  where id = p_event_id and guild_id = p_guild_id and status = 'open'
  returning * into v_row;
  if not found then
    raise exception 'Event not found, not yours, or not open.';
  end if;
  return v_row;
end;
$$;

create or replace function publish_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can publish this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'approved' then
    raise exception 'This event needs Inkroot approval before it can be published.';
  end if;
  -- "an approved paid event" — every host='guild' event has a positive entry_fee_kobo by
  -- construction (create_guild_event_draft/update_guild_event_draft both require it), so this
  -- is effectively every guild event; written as an entry_fee_kobo check rather than
  -- unconditionally so a future free-to-enter event type wouldn't need this gate touched.
  if v_event.entry_fee_kobo is not null and not exists (
    select 1 from guild_event_hosting_fee_payments p
    where p.event_id = v_event.id and p.status = 'success'
  ) then
    raise exception 'Pay Inkroot''s hosting fee for this event before publishing it.';
  end if;

  update guild_events set approval_status = 'published', published_at = now()
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can activate this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'published' then
    raise exception 'Publish this event before opening it for entries.';
  end if;

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function complete_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can complete this event.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'Only an active event can be marked completed.';
  end if;

  update guild_events set approval_status = 'completed', completed_at = now(), status = 'closed'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

create or replace function settle_guild_event(p_guild_id uuid, p_event_id uuid, p_shares jsonb)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_gross bigint;
  v_bad_contributor uuid;
  v_agreement guild_event_financial_agreements%rowtype;
  v_shares_sum integer;
begin
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if v_event.host = 'guild' then
    if not is_guild_treasury_authorized(p_guild_id) then
      raise exception 'Only the guild leader, a treasurer, or an officer can settle this event.';
    end if;
  else -- 'inkroot'
    if auth.uid() is not null then
      raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtext('guild_event_settlement:' || p_event_id::text));
  select * into v_event from guild_events where id = p_event_id; -- re-read under the lock
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  select (s->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_shares) s
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (s->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  if v_event.host = 'guild' then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;

    select coalesce(sum((s->>'share_bps')::integer), 0) into v_shares_sum
    from jsonb_array_elements(p_shares) s;
    if v_shares_sum <> v_agreement.prize_pool_bps then
      raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
    end if;

    select coalesce(sum(net_kobo), 0) into v_gross
    from guild_event_entries where event_id = p_event_id and status = 'success';
  else
    v_gross := v_event.cash_prize_kobo;
  end if;

  perform distribute_guild_revenue(
    p_guild_id := p_guild_id,
    p_gross_amount_kobo := v_gross,
    p_shares := p_shares,
    p_kind := 'event_revenue',
    p_source := 'event_sale',
    p_source_purchase_id := null,
    p_anthology_id := null,
    p_project_event_id := p_event_id,
    p_title := 'Guild event — ' || v_event.title
  );

  update guild_events set status = 'settled', settled_at = now() where id = p_event_id;
  select * into v_event from guild_events where id = p_event_id;
  return v_event;
end;
$$;

create or replace function cancel_guild_treasury_spend_request(p_request_id uuid)
returns guild_treasury_spend_requests
language plpgsql security definer set search_path = public as $$
declare
  v_req guild_treasury_spend_requests;
begin
  select * into v_req from guild_treasury_spend_requests where id = p_request_id for update;
  if not found then
    raise exception 'Spend request not found.';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'This spend request has already been decided.';
  end if;
  if auth.uid() <> v_req.requested_by
     and not is_guild_officer(v_req.guild_id) then
    raise exception 'Only the person who proposed this spend, or the guild leader, can cancel it.';
  end if;

  update guild_treasury_spend_requests set status = 'cancelled', decided_at = now()
  where id = p_request_id
  returning * into v_req;
  return v_req;
end;
$$;

create or replace function propose_guild_event_financial_agreement(
  p_guild_id uuid,
  p_event_id uuid,
  p_prize_pool_bps integer,
  p_guild_share_bps integer,
  p_other_allocations jsonb default '[]'::jsonb,
  p_platform_fee_bps integer default null
)
returns guild_event_financial_agreements
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_existing guild_event_financial_agreements%rowtype;
  v_found boolean;
  v_other_sum integer;
  v_row guild_event_financial_agreements;
  v_elem jsonb;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can set this event''s financial structure.';
  end if;

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id for update;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'An Inkroot-hosted prize has no entry fees to divide up — there''s nothing to set here.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'This event''s financial structure can no longer be changed here — edit the event (which resets it to draft for re-review) to change it.';
  end if;

  if p_platform_fee_bps is null or p_platform_fee_bps < 0 or p_platform_fee_bps > 10000 then
    raise exception 'A valid current platform fee is required to record this agreement.';
  end if;
  if p_prize_pool_bps is null or p_prize_pool_bps <= 0 or p_prize_pool_bps > 10000 then
    raise exception 'The prize pool must be a positive share of the pool — participants are paying to compete for something.';
  end if;
  if p_guild_share_bps is null or p_guild_share_bps < 0 or p_guild_share_bps > 10000 then
    raise exception 'The guild share must be between 0%% and 100%%.';
  end if;

  for v_elem in select * from jsonb_array_elements(coalesce(p_other_allocations, '[]'::jsonb)) loop
    if coalesce(trim(v_elem->>'label'), '') = '' then
      raise exception 'Every other allocation needs a label — who or what it''s for.';
    end if;
    if char_length(v_elem->>'label') > 200 then
      raise exception 'An allocation label is too long.';
    end if;
    if (v_elem->>'bps') is null or (v_elem->>'bps')::integer < 0 or (v_elem->>'bps')::integer > 10000 then
      raise exception 'Every other allocation needs a share between 0%% and 100%%.';
    end if;
  end loop;

  v_other_sum := guild_event_other_allocations_bps(p_other_allocations);
  if p_prize_pool_bps + p_guild_share_bps + v_other_sum <> 10000 then
    raise exception 'The prize pool, guild share, and every other allocation must add up to exactly 100%% of the pool — they currently add up to % basis points.', (p_prize_pool_bps + p_guild_share_bps + v_other_sum);
  end if;

  select * into v_existing from guild_event_financial_agreements where event_id = p_event_id for update;
  v_found := found;
  if v_found and v_existing.locked then
    raise exception 'This event''s financial agreement is locked and can no longer be changed.';
  end if;

  if v_found then
    update guild_event_financial_agreements set
      platform_fee_bps = p_platform_fee_bps,
      prize_pool_bps = p_prize_pool_bps,
      guild_share_bps = p_guild_share_bps,
      other_allocations = coalesce(p_other_allocations, '[]'::jsonb),
      revision = v_existing.revision + 1,
      updated_at = now()
    where id = v_existing.id
    returning * into v_row;
  else
    insert into guild_event_financial_agreements
      (event_id, guild_id, platform_fee_bps, prize_pool_bps, guild_share_bps, other_allocations, created_by)
    values
      (p_event_id, p_guild_id, p_platform_fee_bps, p_prize_pool_bps, p_guild_share_bps,
       coalesce(p_other_allocations, '[]'::jsonb), auth.uid())
    returning * into v_row;
  end if;

  return v_row;
end;
$$;


-- admin_list_guilds() now also lists the 10 Founder Guild rows (useful: an Inkroot admin can
-- host a cash-prize event for one the same way they already could for any Player Guild — see
-- lib/guild-events.js's createInkrootEvent). member_count needs its own branch since a Founder
-- Guild's roster lives in founder_guild_members, not player_guild_members.
create or replace function admin_list_guilds(p_search text default null)
returns table (id uuid, name text, owner_id uuid, member_count bigint)
language plpgsql stable security definer set search_path = public as $$
begin
  if not is_inkroot_admin() then
    raise exception 'Only an Inkroot admin can browse every guild.';
  end if;
  return query
    select g.id, g.name, g.owner_id,
           case when g.is_founder_guild
             then (select count(*) from founder_guild_members m where m.guild_id = g.founder_slug)
             else (select count(*) from player_guild_members m where m.guild_id = g.id)
           end as member_count
    from player_guilds g
    where p_search is null or p_search = '' or g.name ilike '%' || p_search || '%'
    order by g.name
    limit 50;
end;
$$;
