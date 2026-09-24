-- ============================================================================================
-- Migration 139 — propose_anthology_revenue_agreement()'s custom-split branch had the same
-- "same person named more than once while headcount still matches" gap migrations 134 and 136
-- already closed for guild-event winner slots and placement splits.
--
-- Validation before this migration was: count(*) of named shares equals the anthology's approved
-- contributor count, every named contributor_id is actually an approved contributor, no share is
-- negative, and the shares sum to exactly 10000 bps. None of those required the named
-- contributor_ids to be DISTINCT. A guild officer could submit a custom split naming one approved
-- contributor twice and omitting a different approved contributor: headcount still matches (same
-- number of entries), every entry still names a real approved contributor, and the shares can
-- still sum to exactly 10000 — every existing check passes, and the omitted contributor is left
-- with no row in guild_anthology_revenue_shares at all, while the doubly-named one receives both
-- entries' worth.
--
-- Fix: same shape as migration 134's fix in settle_guild_event() — a
-- `group by contributor_id having count(*) > 1` check, added right after the "not an approved
-- contributor" check and before the sum check.
--
-- Safe to run anytime: same signature, same grants; the only new behavior is rejecting a custom
-- split that names the same contributor more than once, which was never a valid split anyway.
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
  v_dup_contributor boolean;
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
    -- Migration 139: the same contributor cannot occupy more than one entry in a custom split —
    -- see this migration's header for the omitted-contributor bug this closes.
    select exists (
      select 1 from jsonb_array_elements(p_custom_shares) r
      group by (r->>'contributor_id')::uuid
      having count(*) > 1
    ) into v_dup_contributor;
    if v_dup_contributor then
      raise exception 'The same contributor cannot be given more than one custom share.';
    end if;
    if exists (select 1 from jsonb_array_elements(p_custom_shares) r where (r->>'share_bps')::integer < 0) then
      raise exception 'A share cannot be negative.';
    end if;
    if v_custom_sum <> 10000 then
      raise exception 'Custom shares must add up to exactly 10000 basis points (100%%) — got % basis points.', v_custom_sum;
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
