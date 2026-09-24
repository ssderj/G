-- Migration 36: Guild Anthology Revenue Agreements — how an anthology's price actually gets
-- split among its contributors, made explicit, approved, and then frozen.
--
-- The core guarantee this migration is built around: nobody — not the guild owner proposing the
-- split, not Inkroot itself — has any code path that changes a contributor's share without that
-- contributor seeing it happen and re-approving. Two things make that true, not just documented:
--   1. guild_anthology_revenue_shares has NO update policy that lets anyone but the contributor
--      themself touch their own row, and guard_anthology_revenue_share_update() below lets that
--      one path change only approved_at — never share_bps, never whose row it is. There is no
--      escape hatch in that trigger for service_role, an admin flag, or anything else: the ONLY
--      way share_bps ever changes is a full re-propose (see next point), which is visible to
--      everyone, not a quiet edit.
--   2. Every re-propose (propose_anthology_revenue_agreement) deletes and fully regenerates every
--      contributor's share AND resets every approved_at to null, unconditionally — even if a
--      contributor's own number happened not to change. An agreement someone already approved can
--      never end up published with a different number under their name; the only way forward
--      after any edit is everyone approving again.
--
-- Reuses guild_anthologies (owner authority, status machine) and guild_anthology_submissions
-- (the approved contributor set + word counts) exactly as already built in migration 35 — no
-- second contributor list, no duplicated word-count tracking. publish_guild_anthology is
-- extended in place (same pattern author_balance_kobo was extended twice in the Treasury
-- migrations) to require a fully-approved agreement and to lock it at the moment revenue can
-- actually begin — the moment the anthology becomes a live published_books row.

-- ============================================================================================
-- guild_anthology_revenue_agreements — one per anthology. `revision` bumps on every re-propose;
-- that bump is what invalidates every existing approval, since approvals are just a timestamp on
-- the shares row from the LAST propose call — there's no revision number on the shares to compare
-- against because a re-propose always deletes and reinserts them from scratch (see the RPC below).
-- ============================================================================================

create table if not exists guild_anthology_revenue_agreements (
  id uuid primary key default gen_random_uuid(),
  anthology_id uuid not null unique references guild_anthologies(id) on delete cascade,
  split_type text not null check (split_type in ('equal', 'custom', 'contribution')),
  revision integer not null default 1,
  locked boolean not null default false,
  locked_at timestamptz,
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table guild_anthology_revenue_agreements enable row level security;

create policy "guild members read revenue agreements" on guild_anthology_revenue_agreements
  for select using (
    exists (
      select 1 from guild_anthologies a
      join player_guild_members m on m.guild_id = a.guild_id and m.user_id = auth.uid()
      where a.id = guild_anthology_revenue_agreements.anthology_id
    )
  );

-- Deliberately no insert/update/delete policy — exactly guild_treasury_transactions' own stance
-- (see 33_migration_guild_treasury.sql). The only writers are propose_anthology_revenue_
-- agreement() and publish_guild_anthology() below, both security definer.

-- ============================================================================================
-- guild_anthology_revenue_shares — one row per contributor per agreement. share_bps is basis
-- points (10000 = 100%) so an equal three-way split can be exact (3334/3333/3333) without
-- floating point. approved_at is the ONLY column a contributor may ever move themselves, and
-- only while the agreement isn't locked.
-- ============================================================================================

create table if not exists guild_anthology_revenue_shares (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references guild_anthology_revenue_agreements(id) on delete cascade,
  contributor_id uuid not null references auth.users(id) on delete cascade,
  share_bps integer not null check (share_bps >= 0 and share_bps <= 10000),
  approved_at timestamptz,
  unique (agreement_id, contributor_id)
);

alter table guild_anthology_revenue_shares enable row level security;

create policy "guild members read revenue shares" on guild_anthology_revenue_shares
  for select using (
    exists (
      select 1 from guild_anthology_revenue_agreements ag
      join guild_anthologies a on a.id = ag.anthology_id
      join player_guild_members m on m.guild_id = a.guild_id and m.user_id = auth.uid()
      where ag.id = guild_anthology_revenue_shares.agreement_id
    )
  );

-- Row-scoped to the contributor themself; guard_anthology_revenue_share_update() below is what
-- restricts this to *only* approved_at. No policy at all lets the guild owner touch this table —
-- their sole lever is proposing a new revision, which resets every approval, in full view.
create policy "contributor manages their own approval" on guild_anthology_revenue_shares
  for update using (auth.uid() = contributor_id);

-- Deliberately no insert/delete policy — only propose_anthology_revenue_agreement() (security
-- definer) writes rows here, always as a full delete-and-reinsert of the whole set.

create or replace function guard_anthology_revenue_share_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- No bypass of any kind here — not for service_role, not for a trusted-RPC flag. This path may
  -- only ever be a contributor flipping their own approval, and that is the whole point.
  if auth.uid() is null or auth.uid() <> old.contributor_id then
    raise exception 'Not authorized to update this share.';
  end if;
  if new.agreement_id is distinct from old.agreement_id
     or new.contributor_id is distinct from old.contributor_id
     or new.share_bps is distinct from old.share_bps then
    raise exception 'A contributor may only approve or withdraw approval of their own share — never change the number itself.';
  end if;
  if exists (select 1 from guild_anthology_revenue_agreements ag where ag.id = old.agreement_id and ag.locked) then
    raise exception 'This revenue agreement is locked and can no longer be changed.';
  end if;
  return new;
end;
$$;

drop trigger if exists guild_anthology_revenue_share_guard on guild_anthology_revenue_shares;
create trigger guild_anthology_revenue_share_guard
  before update on guild_anthology_revenue_shares
  for each row execute function guard_anthology_revenue_share_update();

-- ============================================================================================
-- propose_anthology_revenue_agreement — owner-only. Always computes shares for every CURRENT
-- approved contributor (from guild_anthology_submissions, the one real source for who's in this
-- anthology) and always wipes every prior approval, whatever the split_type or whether any
-- number actually changed. That's what makes a re-propose safe rather than a backdoor: it can
-- never publish under an approval that was given for a different set of numbers.
-- ============================================================================================

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

  select owner_id into v_owner from player_guilds where id = v_anth.guild_id;
  if v_owner is null or v_owner <> auth.uid() then
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

revoke all on function propose_anthology_revenue_agreement(uuid, text, jsonb) from public;
grant execute on function propose_anthology_revenue_agreement(uuid, text, jsonb) to authenticated;

-- ============================================================================================
-- publish_guild_anthology — extended in place (same table it already wrote to in migration 35;
-- CREATE OR REPLACE keeps the function's identity and grants, only the body changes). Now
-- requires a revenue agreement that covers exactly the current approved contributors and has
-- every one of their approvals, and locks that agreement in the same transaction as the moment
-- it goes live — "once revenue begins" is exactly publish time, since that's the first moment a
-- sale (and therefore any actual revenue) becomes possible.
-- ============================================================================================

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

-- Safe to run anytime: every object here is created with if-not-exists/or-replace, and the only
-- pre-existing function this touches (publish_guild_anthology) keeps its exact signature, so
-- nothing that already calls it needs to change.
