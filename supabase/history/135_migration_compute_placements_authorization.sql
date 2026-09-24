-- ============================================================================================
-- Migration 135 — compute_guild_event_placements() had no caller-identity check at all. Its own
-- header comment (migration 121, "7. compute_guild_event_placements") already describes the
-- intended callers: "anyone with a legitimate reason to check: the organizer, a guild
-- authority, or Inkroot." The function body never actually enforced that — the only identity
-- check anywhere in it gates p_exclude_judge_ids (Inkroot-admin-only, for the judge-dispute
-- path), and the grant is a plain `grant execute ... to authenticated`. As shipped, any
-- signed-in user could call compute_guild_event_placements(event_id) for ANY guild's event and
-- force a 'computed' guild_event_results row to be written or overwritten.
--
-- This doesn't move money by itself — approve_guild_event_results() still requires
-- is_guild_treasury_authorized() before settle_guild_event() ever runs, so an outsider can't pay
-- themselves this way. But it's still the wrong caller set for a function that: (a) locks and
-- consumes judge scores (an outsider could trigger a premature computation the moment quorum is
-- technically met, before the guild wants a final read taken), and (b) overwrites any existing
-- 'computed' row's placements/submitted_at, resetting reviewed_by/reviewed_at/settled_at on
-- every call (see the ON CONFLICT clause, unchanged below) — a griefing surface with no
-- authorization gate on it at all.
--
-- Fix: restrict to exactly the three callers the function's own comment already named — the
-- event's organizer, a guild treasury authority (same is_guild_treasury_authorized() check
-- approve_guild_event_results() uses), or an Inkroot admin. Added right after the event is
-- fetched and the host='guild' check, before anything else — same "authorize first" placement
-- every other security-definer function in this schema uses. Nothing else in the function
-- changes; the rest of the body (quorum check, trimmed-mean scoring, placement/share
-- computation, the ON CONFLICT upsert) is byte-for-byte what migration 121 shipped.
--
-- Safe to run anytime: same signature, so the existing grant carries over unchanged.
-- ============================================================================================

create or replace function compute_guild_event_placements(p_event_id uuid, p_exclude_judge_ids uuid[] default '{}')
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_guild_id uuid;
  v_objective guild_event_objective_config%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_assigned_count integer;
  v_quorum integer;
  v_min_scored integer;
  v_max_word_count integer;
  v_escrowed boolean;
  v_pool_bps integer;
  v_placements jsonb;
  v_row guild_event_results%rowtype;
begin
  if p_exclude_judge_ids <> '{}' and not is_inkroot_admin() then
    raise exception 'Only Inkroot can exclude a judge''s scores from a computation.';
  end if;

  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  v_guild_id := v_event.guild_id;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;

  -- Migration 135: the organizer, a guild treasury authority, or Inkroot — see this migration's
  -- header. Matches the caller set migration 121's own comment already described but never
  -- actually enforced.
  if not (
    (v_event.organizer_id is not null and auth.uid() = v_event.organizer_id)
    or is_guild_treasury_authorized(v_guild_id)
    or is_inkroot_admin()
  ) then
    raise exception 'Only this event''s organizer, a guild authority, or Inkroot can compute its placements.';
  end if;

  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before computing placements.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  select * into v_objective from guild_event_objective_config where event_id = p_event_id;
  if not found or not v_objective.locked then
    raise exception 'This event has no locked judging configuration — it cannot be settled.';
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;
  if not v_escrowed then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
    if not found or not v_agreement.locked then
      raise exception 'This event has no locked financial agreement — it cannot be settled.';
    end if;
  end if;
  -- settle_guild_event() requires shares to sum to EXACTLY v_agreement.prize_pool_bps
  -- (non-escrowed) or 10000 (escrowed, paid in full — see its own header). placement_split_bps
  -- sums to 10000 at proposal time (a proportional split of "the prize pool", whatever it turns
  -- out to be) so it's scaled against v_pool_bps below, never used as the final share directly.
  v_pool_bps := case when v_escrowed then 10000 else v_agreement.prize_pool_bps end;

  if not exists (select 1 from guild_event_submissions where event_id = p_event_id) then
    raise exception 'No submissions were received for this event.';
  end if;

  -- ---- Judge quorum check (skipped entirely for a pure-objective event) ----
  if v_objective.weight_bps < 10000 then
    select count(*) into v_assigned_count
    from guild_event_judges where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids);
    if v_assigned_count < 3 then
      raise exception 'Too few judges remain eligible for this event to reach quorum.';
    end if;
    v_quorum := guild_event_judge_quorum(v_assigned_count);

    select min(scored_by) into v_min_scored from (
      select s.id, count(distinct sc.judge_id) as scored_by
      from guild_event_submissions s
      left join guild_event_judge_scores sc
        on sc.submission_id = s.id and sc.judge_id <> all (p_exclude_judge_ids)
      where s.event_id = p_event_id
      group by s.id
    ) counts;
    if v_min_scored is null or v_min_scored < v_quorum then
      raise exception 'Judging quorum not yet met — at least % of % judges must score every entry (lowest so far: %).',
        v_quorum, v_assigned_count, coalesce(v_min_scored, 0);
    end if;
  end if;

  -- ---- Ranked scoring ----
  select max(word_count) into v_max_word_count from guild_event_submissions where event_id = p_event_id;

  with judge_avg as (
    -- Each judge's own average across categories for a submission, first — a judge who scores
    -- three categories doesn't get 3x the weight of one who scores a single overall category.
    select submission_id, judge_id, avg(score) as avg_score
    from guild_event_judge_scores
    where event_id = p_event_id and judge_id <> all (p_exclude_judge_ids)
    group by submission_id, judge_id
  ),
  judge_counts as (
    select submission_id, count(*) as n_judges from judge_avg group by submission_id
  ),
  ranked_judges as (
    select ja.submission_id, ja.avg_score, jc.n_judges,
      row_number() over (partition by ja.submission_id order by ja.avg_score) as rn
    from judge_avg ja join judge_counts jc on jc.submission_id = ja.submission_id
  ),
  trimmed as (
    -- Trimmed mean across judges: drop the single highest and lowest when there are enough
    -- judges to still leave at least 3 in the middle (1 < rn < n_judges), so one outlier score
    -- (bribed, biased, or just careless) can't swing a placement on its own.
    select submission_id,
      case when n_judges >= 5
        then avg(avg_score) filter (where rn > 1 and rn < n_judges)
        else avg(avg_score)
      end as judge_score
    from ranked_judges
    group by submission_id, n_judges
  ),
  objective as (
    select s.id as submission_id,
      case v_objective.metric
        when 'word_count' then
          case when coalesce(v_max_word_count, 0) = 0 then 0
          else round(100.0 * s.word_count / v_max_word_count, 2) end
        when 'on_time_completion' then
          case when v_event.end_date is null or s.submitted_at <= v_event.end_date then 100 else 0 end
        else 0
      end as objective_score
    from guild_event_submissions s
    where s.event_id = p_event_id
  ),
  scored as (
    select s.id as submission_id, s.entrant_id, s.submitted_at,
      coalesce(t.judge_score, 0) as judge_score,
      coalesce(o.objective_score, 0) as objective_score,
      coalesce(t.judge_score, 0) * (10000 - v_objective.weight_bps) / 10000.0
        + coalesce(o.objective_score, 0) * v_objective.weight_bps / 10000.0 as final_score
    from guild_event_submissions s
    left join trimmed t on t.submission_id = s.id
    left join objective o on o.submission_id = s.id
    where s.event_id = p_event_id
      -- Same "winners must be guild members" rule settle_guild_event() has always enforced
      -- (see 42_migration_guild_events.sql) — an outside entrant can compete and be ranked for
      -- the record, but only a member of the hosting guild can actually be paid a placement.
      and exists (select 1 from player_guild_members m where m.guild_id = v_guild_id and m.user_id = s.entrant_id)
  ),
  ranked as (
    select submission_id, entrant_id, final_score, objective_score,
      row_number() over (order by final_score desc, objective_score desc, submitted_at asc) as place
    from scored
  ),
  -- Scale each declared placement_split_bps entry (sums to 10000, "100% of the prize pool")
  -- against v_pool_bps (the actual share_bps total settle_guild_event() requires), floored, so
  -- no rounding can ever push the total over v_pool_bps.
  awarded as (
    select r.place, r.entrant_id,
      (((elem->>'share_bps')::integer * v_pool_bps) / 10000) as raw_share_bps
    from ranked r
    join jsonb_array_elements(v_objective.placement_split_bps) elem
      on (elem->>'place')::integer = r.place
  ),
  final_shares as (
    -- The floor above can leave a few basis points short of v_pool_bps — settle_guild_event()
    -- requires an EXACT match, so the shortfall is added to 1st place (deterministic, declared
    -- up front in this comment, never a discretionary choice at settlement time).
    select place, entrant_id,
      raw_share_bps + case when place = (select min(place) from awarded)
        then v_pool_bps - (select coalesce(sum(raw_share_bps), 0) from awarded)
        else 0
      end as share_bps
    from awarded
  )
  select jsonb_agg(jsonb_build_object(
    'contributor_id', entrant_id, 'place', place, 'share_bps', share_bps
  ) order by place)
  into v_placements
  from final_shares
  where share_bps > 0;

  if v_placements is null or jsonb_array_length(v_placements) = 0 then
    raise exception 'No eligible (guild-member) entrant placed — nothing to settle.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (v_guild_id, p_event_id, v_placements, 'computed', null, now())
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'computed', submitted_by = null, submitted_at = now(),
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function compute_guild_event_placements(uuid, uuid[]) from public;
grant execute on function compute_guild_event_placements(uuid, uuid[]) to authenticated;

-- ============================================================================================
-- Verify after applying:
--   * A signed-in user who is not the event's organizer, not a treasury-authorized officer of
--     the hosting guild, and not an Inkroot admin gets 'Only this event's organizer, a guild
--     authority, or Inkroot can compute its placements.' instead of a computed result.
--   * The organizer, any of the guild's leader/treasurer/officers, and an Inkroot admin can all
--     still call it successfully once the event is completed, judging is locked, and quorum is
--     met — no change in behavior for these three.
--   * p_exclude_judge_ids still requires is_inkroot_admin() on top of the new check (an admin
--     passes both; a guild officer or the organizer passing a non-empty array is still refused
--     by the existing 'Only Inkroot can exclude...' check, unchanged).
-- ============================================================================================
