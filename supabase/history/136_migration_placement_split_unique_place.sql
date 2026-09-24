-- ============================================================================================
-- Migration 136 — propose_guild_event_objective_config() validates that placement_split_bps'
-- share_bps values sum to exactly 10000, but never validates that its `place` values are
-- distinct. A guild officer could declare e.g. [{"place":1,"share_bps":5000},
-- {"place":1,"share_bps":5000}] — passes the sum check (10000), looks like "2 winners, 50%
-- each" in the UI, but compute_guild_event_placements()'s join
-- (`on (elem->>'place')::integer = r.place`) matches BOTH rows to the single actual 1st-place
-- finisher: they'd be paid via two separate share lines that together total 100%, and no real
-- 2nd place would ever be paid, regardless of how many people entered or how they ranked. The
-- configured "2 winners" silently collapses to 1 — exactly the "winner count doesn't match the
-- configured event" gap flagged in review. (Two share_bps entries at the SAME place is the only
-- way this can happen: distinct places can never collide in that join, since row_number() in
-- compute_guild_event_placements assigns each ranked entrant exactly one place.)
--
-- Fix: reject a placement_split_bps with a repeated `place` value at proposal time, the same
-- place propose_guild_event_objective_config() already rejects a bad share_bps sum — before an
-- event is ever activated, entered, or judged, rather than leaving it to surface as a silent
-- payout mismatch after judging is already done. Uses the same group-by/having shape migration
-- 134 already used for the duplicate-contributor check in settle_guild_event() and
-- submit_guild_event_results(), applied here to `place` instead of `contributor_id`.
--
-- Nothing downstream changes: compute_guild_event_placements(), settle_guild_event(), and
-- distribute_guild_revenue() are all untouched by this migration. This only closes off a bad
-- config from ever being saved in the first place.
--
-- Safe to run anytime: same signature, so the existing grant carries over unchanged. Does not
-- touch any already-locked guild_event_objective_config row — only takes effect the next time
-- someone calls propose_guild_event_objective_config() (draft/rejected events only, per the
-- function's own existing approval_status gate).
-- ============================================================================================

create or replace function propose_guild_event_objective_config(
  p_guild_id uuid, p_event_id uuid, p_metric text, p_weight_bps integer, p_placement_split_bps jsonb
)
returns guild_event_objective_config
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_objective_config%rowtype;
  v_dup_place boolean;
begin
  if not is_guild_officer(p_guild_id) then
    raise exception 'Only the guild owner can configure how this event is judged.';
  end if;
  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not use this configuration.';
  end if;
  if v_event.approval_status not in ('draft', 'rejected') then
    raise exception 'Judging can only be configured while the event is a draft.';
  end if;

  if p_metric not in ('none', 'word_count', 'on_time_completion') then
    raise exception 'Unknown objective metric.';
  end if;
  if p_metric = 'none' and coalesce(p_weight_bps, 0) <> 0 then
    raise exception 'An objective weight requires an objective metric.';
  end if;
  if p_weight_bps is null or p_weight_bps < 0 or p_weight_bps > 10000 then
    raise exception 'Objective weight must be between 0%% and 100%%.';
  end if;
  if guild_event_placement_split_sum(p_placement_split_bps) <> 10000 then
    raise exception 'Placement shares must add up to exactly 100%%.';
  end if;

  -- Migration 136: each place (1st, 2nd, ...) may only be declared once — see this migration's
  -- header for why a duplicate place silently collapses the configured winner count.
  select exists (
    select 1 from jsonb_array_elements(p_placement_split_bps) elem
    group by (elem->>'place')
    having count(*) > 1
  ) into v_dup_place;
  if v_dup_place then
    raise exception 'Each place (1st, 2nd, ...) can only be declared once in the placement split.';
  end if;

  insert into guild_event_objective_config
    (event_id, guild_id, metric, weight_bps, placement_split_bps, created_by)
  values (p_event_id, p_guild_id, p_metric, p_weight_bps, p_placement_split_bps, auth.uid())
  on conflict (event_id) do update set
    metric = excluded.metric, weight_bps = excluded.weight_bps,
    placement_split_bps = excluded.placement_split_bps, updated_at = now()
  returning * into v_row;
  if v_row.locked then
    raise exception 'This event''s judging configuration is already locked.';
  end if;
  return v_row;
end;
$$;

revoke all on function propose_guild_event_objective_config(uuid, uuid, text, integer, jsonb) from public;

-- ============================================================================================
-- Verify after applying:
--   * propose_guild_event_objective_config() refuses a placement_split_bps with two entries at
--     the same place (e.g. two {"place":1,...} entries) with 'Each place... can only be
--     declared once...', even when their share_bps sum to exactly 10000.
--   * A normal, distinct-places split (e.g. place 1/2/3) is unaffected and saves as before.
--   * An already-locked guild_event_objective_config row from before this migration is
--     untouched — this only gates future calls to propose_guild_event_objective_config(), which
--     is itself only callable while the event is still draft/rejected.
-- ============================================================================================
