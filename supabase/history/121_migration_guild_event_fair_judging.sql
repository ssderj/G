-- ============================================================================================
-- Migration 121 — Guild Event fair judging: replaces the organizer-declares-placements model
-- (49_migration_guild_event_results_approval.sql) with computed placements nobody on the
-- hosting guild's side can hand-pick, for host='guild' events going forward.
--
-- The problem this closes: even after migration 120 required a second, distinct approver,
-- BOTH the organizer proposing placements and the officer approving them are people with a
-- stake in their own guild's payout. Two interested parties agreeing with each other is not an
-- outside check — it just requires collusion between two people instead of one. There has never
-- been anything in this schema that verifies a placement reflects the actual work submitted.
--
-- The fix, confirmed with the app owner: placements are now COMPUTED, not declared.
--   - An objective component (word count / on-time completion), when the event opts into one,
--     scores automatically off data the server already has — no human judgment involved.
--   - A judged component is scored by a panel the server assigns automatically at activation
--     time, drawn from profiles.verified authors who are not members of the hosting guild and
--     not this event's own organizer/creator — the guild never picks who judges it. Judges score
--     blind (entrants are shown to judges as "Entry 1", "Entry 2", ... — never a real name).
--   - compute_guild_event_placements() combines the two into a ranked result and writes it to
--     guild_event_results with a new status, 'computed' — nothing a human typed in.
--   - approve_guild_event_results() is redefined so a 'computed' row only needs a guild
--     authority to confirm the quorum/deadline conditions actually held and trigger settlement —
--     there is no discretionary "approve or reject someone else's proposal" step left for a
--     computed row, because there is nothing left to disagree with.
--   - submit_guild_event_results() (the old organizer-declares-a-number path) now refuses
--     outright for any event that has an objective config on file — which every event drafted
--     after this migration will, since activate_guild_event() below requires one. An event
--     already active/completed before this migration ran has no objective config row and keeps
--     working exactly as it did (49/120's own path, untouched) — this migration does not
--     retroactively reopen or replay any event's results.
--
-- Known, honestly-stated limitation (same posture as 24_migration_verified_author_badge.sql's
-- own comment on why `verified` is manually curated, not self-service): the judge pool is
-- exactly as large as the platform's manually-verified author roster. A young deployment with
-- few verified authors may not have enough eligible, guild-unaffiliated judges to fill a panel —
-- assign_guild_event_judges() refuses activation in that case with a clear count, rather than
-- silently seating an under-sized or guild-affiliated panel. An event can still run pure-
-- objective (weight_bps = 10000) with no judges needed at all if judge availability is the
-- blocker.
--
-- Everything downstream of "what are the placements" is completely unchanged: settle_guild_
-- event()'s advisory locks, one-settlement-ever guarantee, exact-match-to-the-locked-agreement
-- check, member-only-winner check, and distribute_guild_revenue() itself are byte-for-byte as
-- migration 120 left them. This migration only changes what feeds placements in.
-- ============================================================================================

-- ------------------------------------------------------------------------------------------
-- 1. guild_event_objective_config — declared by the owner while the event is still
--    draft/rejected (identical editable window propose_guild_event_financial_agreement already
--    enforces, so the two can never drift out of sync with each other), locked permanently at
--    activation. weight_bps is how much of the final placement the objective metric controls;
--    the rest (10000 - weight_bps) comes from the judge panel. weight_bps = 10000 needs no
--    judges at all; metric = 'none' requires weight_bps = 0 (a pure judge-panel event).
--
--    placement_split_bps is declared here too, for the same reason the financial agreement's
--    percentages are locked before anyone can see who enters: [{"place":1,"share_bps":6000},
--    ...], summing to exactly 10000. It decides how the locked prize_pool_bps (or, for an
--    escrowed event, the full guaranteed prize) is divided among 1st/2nd/3rd/... place once
--    placements are computed. A place beyond what placement_split_bps names gets nothing.
-- ------------------------------------------------------------------------------------------

create table if not exists guild_event_objective_config (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique references guild_events(id) on delete cascade,
  guild_id uuid not null references player_guilds(id) on delete cascade,
  metric text not null default 'none' check (metric in ('none', 'word_count', 'on_time_completion')),
  weight_bps integer not null default 0 check (weight_bps >= 0 and weight_bps <= 10000),
  check (metric <> 'none' or weight_bps = 0),
  placement_split_bps jsonb not null default '[{"place":1,"share_bps":10000}]'::jsonb,
  locked boolean not null default false,
  locked_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table guild_event_objective_config enable row level security;

-- Same broad "anyone signed in" read as the financial agreement — an entrant can see exactly
-- how the placements they're competing for will be decided before they ever pay.
create policy "anyone signed in can read event objective config" on guild_event_objective_config
  for select using (auth.uid() is not null);

create index if not exists guild_event_objective_config_guild_idx
  on guild_event_objective_config (guild_id);

create or replace function guild_event_placement_split_sum(p jsonb)
returns integer
language sql immutable as $$
  select coalesce(sum(coalesce((elem->>'share_bps')::integer, 0)), 0)::integer
  from jsonb_array_elements(coalesce(p, '[]'::jsonb)) elem;
$$;

-- Owner-only, draft/rejected-only — mirrors propose_guild_event_financial_agreement exactly.
create or replace function propose_guild_event_objective_config(
  p_guild_id uuid, p_event_id uuid, p_metric text, p_weight_bps integer, p_placement_split_bps jsonb
)
returns guild_event_objective_config
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_objective_config%rowtype;
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
grant execute on function propose_guild_event_objective_config(uuid, uuid, text, integer, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------
-- 2. guild_event_judges — the panel, assigned automatically (never by the hosting guild).
-- ------------------------------------------------------------------------------------------

create table if not exists guild_event_judges (
  event_id uuid not null references guild_events(id) on delete cascade,
  judge_id uuid not null references auth.users(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (event_id, judge_id)
);

alter table guild_event_judges enable row level security;

-- A judge can confirm their own assignment (row-scoped to auth.uid() = judge_id) — this does
-- NOT let a judge see who else is on the panel with them, deliberately: judges never learn each
-- other's identity, so there's no one for a judge to coordinate a score with even informally.
create policy "an assigned judge reads their own assignment" on guild_event_judges
  for select using (auth.uid() = judge_id);
create policy "inkroot admin reads any event panel" on guild_event_judges
  for select using (is_inkroot_admin());
-- No client insert/update/delete policy — only assign_guild_event_judges() below (security
-- definer, called from activate_guild_event()) ever writes this table. The hosting guild has no
-- write path to this table at all, by construction.

create index if not exists guild_event_judges_judge_idx on guild_event_judges (judge_id, assigned_at desc);

-- One definition, easy to tune. See migration header on why a shortfall refuses rather than
-- seating a smaller/compromised panel.
create or replace function guild_event_judge_panel_size()
returns integer as $$ select 5; $$ language sql immutable;

revoke all on function guild_event_judge_panel_size() from public, anon, authenticated;

-- How many of a judge's most recent 30 days of assignments already exist — a simple
-- anti-concentration cap so one account can't be assigned to every event on the platform.
-- Same "cheap count query" shape as guild_event_entry_count(), just per-judge instead of
-- per-event.
create or replace function guild_event_judge_recent_assignment_count(p_judge_id uuid)
returns integer
language sql stable security definer set search_path = public as $$
  select count(*)::integer from guild_event_judges
  where judge_id = p_judge_id and assigned_at > now() - interval '30 days';
$$;

revoke all on function guild_event_judge_recent_assignment_count(uuid) from public, anon, authenticated;

-- Called only from activate_guild_event() below, for an event whose objective config leaves
-- some weight (< 10000 bps) on the judge panel. Eligible = verified, not banned, not a member
-- of the hosting guild, not this event's organizer or creator, not assigned more than 4 times
-- in the trailing 30 days. Picked at random (order by random()), capped at
-- guild_event_judge_panel_size(); refuses outright below a 3-judge minimum rather than seating
-- a smaller panel silently.
create or replace function assign_guild_event_judges(p_event_id uuid)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_target integer;
  v_seated integer;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;

  if exists (select 1 from guild_event_judges where event_id = p_event_id) then
    return (select count(*)::integer from guild_event_judges where event_id = p_event_id);
  end if;

  v_target := guild_event_judge_panel_size();

  insert into guild_event_judges (event_id, judge_id)
  select p_event_id, p.id
  from profiles p
  where p.verified
    and not is_banned(p.id)
    and p.id <> coalesce(v_event.organizer_id, '00000000-0000-0000-0000-000000000000'::uuid)
    and p.id <> coalesce(v_event.created_by, '00000000-0000-0000-0000-000000000000'::uuid)
    and not exists (
      select 1 from player_guild_members m where m.guild_id = v_event.guild_id and m.user_id = p.id
    )
    and guild_event_judge_recent_assignment_count(p.id) < 5
  order by random()
  limit v_target;

  select count(*) into v_seated from guild_event_judges where event_id = p_event_id;
  if v_seated < 3 then
    delete from guild_event_judges where event_id = p_event_id;
    raise exception 'Not enough eligible, guild-unaffiliated verified judges available (need at least 3, found %). Try a pure objective event instead, or wait for more verified authors on the platform.', v_seated;
  end if;
  return v_seated;
end;
$$;

revoke all on function assign_guild_event_judges(uuid) from public, anon, authenticated;

-- ------------------------------------------------------------------------------------------
-- 3. guild_event_submissions — what an entrant is actually being judged on. Same "content
--    lives with the contributor's own device until submit time" pattern and size cap as
--    guild_anthology_submissions (91_migration_anthology_submission_content.sql) — no
--    manuscript text is copied anywhere ahead of the entrant actually submitting.
-- ------------------------------------------------------------------------------------------

create table if not exists guild_event_submissions (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  entrant_id uuid not null references auth.users(id) on delete cascade,
  title text check (char_length(title) <= 200),
  word_count integer not null default 0 check (word_count >= 0),
  content jsonb,
  check (content is null or octet_length(content::text) <= 20971520),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, entrant_id)
);

alter table guild_event_submissions enable row level security;

-- Entrant-only read/write of their own submission. Deliberately NO guild-owner or organizer
-- read policy here — the people with a financial stake in the outcome never see entrant
-- content directly; they see the computed result, same as everyone else. Judges read through
-- the anonymized function below, never this table directly.
create policy "entrant reads their own event submission" on guild_event_submissions
  for select using (auth.uid() = entrant_id);
create policy "inkroot admin reads any event submission" on guild_event_submissions
  for select using (is_inkroot_admin());
-- No client insert/update policy — see submit_guild_event_submission() below.

create index if not exists guild_event_submissions_event_idx on guild_event_submissions (event_id);

-- Entrant-only, and only while the event is still open for it: must have a successful paid
-- entry, and the event must not yet be past 'active' (completing the event closes submissions,
-- same "status gates the window" posture as every other stage of this pipeline).
create or replace function submit_guild_event_submission(
  p_event_id uuid, p_title text, p_word_count integer, p_content jsonb
)
returns guild_event_submissions
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_row guild_event_submissions%rowtype;
begin
  select * into v_event from guild_events where id = p_event_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events do not take submissions here.';
  end if;
  if v_event.approval_status <> 'active' then
    raise exception 'This event is not currently accepting submissions.';
  end if;
  if not exists (
    select 1 from guild_event_entries
    where event_id = p_event_id and entrant_id = auth.uid() and status = 'success'
  ) then
    raise exception 'Enter this event before submitting your work.';
  end if;
  if p_content is not null and octet_length(p_content::text) > 20971520 then
    raise exception 'Submission is too large (20MB limit).';
  end if;

  insert into guild_event_submissions (event_id, entrant_id, title, word_count, content, submitted_at, updated_at)
  values (p_event_id, auth.uid(), nullif(p_title, ''), coalesce(p_word_count, 0), p_content, now(), now())
  on conflict (event_id, entrant_id) do update set
    title = excluded.title, word_count = excluded.word_count, content = excluded.content, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function submit_guild_event_submission(uuid, text, integer, jsonb) from public;
grant execute on function submit_guild_event_submission(uuid, text, integer, jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------
-- 4. guild_event_judge_scores — blind scoring. A judge never sees entrant_id; scoring goes
--    through fetch_guild_event_entries_for_judge()'s anonymized labels below, and the score
--    submission function re-resolves the label back to a submission_id server-side.
-- ------------------------------------------------------------------------------------------

create table if not exists guild_event_judge_scores (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null references guild_events(id) on delete cascade,
  submission_id uuid not null references guild_event_submissions(id) on delete cascade,
  judge_id uuid not null references auth.users(id) on delete cascade,
  category text not null default 'overall' check (char_length(category) <= 60),
  score numeric(5,2) not null check (score >= 0 and score <= 100),
  submitted_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (submission_id, judge_id, category)
);

alter table guild_event_judge_scores enable row level security;

-- A judge reads/writes only their own scores — never another judge's (no anchoring on a
-- co-judge's number) and never the guild's (no way for the guild to lean on a judge mid-event).
create policy "a judge reads their own scores" on guild_event_judge_scores
  for select using (auth.uid() = judge_id);
create policy "inkroot admin reads any event's scores" on guild_event_judge_scores
  for select using (is_inkroot_admin());
-- No client insert/update policy — see submit_guild_event_judge_score() below.

create index if not exists guild_event_judge_scores_event_idx on guild_event_judge_scores (event_id);

-- The judge-facing entry list: real entrant identity never leaves this function. label is
-- stable per event (same "Entry 1"/"Entry 2"/... for every judge on the panel — anonymity
-- doesn't require per-judge shuffling, only that identity never appears at all).
create or replace function fetch_guild_event_entries_for_judge(p_event_id uuid)
returns table (submission_id uuid, label text, title text, word_count integer, content jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from guild_event_judges where event_id = p_event_id and judge_id = auth.uid()) then
    raise exception 'You are not an assigned judge for this event.';
  end if;
  return query
    select s.id, 'Entry ' || row_number() over (order by s.id), s.title, s.word_count, s.content
    from guild_event_submissions s
    where s.event_id = p_event_id
    order by s.id;
end;
$$;

revoke all on function fetch_guild_event_entries_for_judge(uuid) from public;
grant execute on function fetch_guild_event_entries_for_judge(uuid) to authenticated;

-- Judge-only, assigned-panel-only, submission-must-belong-to-this-event. Upserts, so a judge
-- can revise a score any time before the event's results are computed and approved.
create or replace function submit_guild_event_judge_score(
  p_event_id uuid, p_submission_id uuid, p_category text, p_score numeric
)
returns guild_event_judge_scores
language plpgsql security definer set search_path = public as $$
declare
  v_row guild_event_judge_scores%rowtype;
begin
  if not exists (select 1 from guild_event_judges where event_id = p_event_id and judge_id = auth.uid()) then
    raise exception 'You are not an assigned judge for this event.';
  end if;
  if not exists (select 1 from guild_event_submissions where id = p_submission_id and event_id = p_event_id) then
    raise exception 'That entry is not part of this event.';
  end if;
  if exists (
    select 1 from guild_event_results where event_id = p_event_id and status in ('computed', 'approved')
  ) then
    raise exception 'Placements for this event have already been computed — scores are locked.';
  end if;
  if p_score is null or p_score < 0 or p_score > 100 then
    raise exception 'Score must be between 0 and 100.';
  end if;

  insert into guild_event_judge_scores (event_id, submission_id, judge_id, category, score, submitted_at, updated_at)
  values (p_event_id, p_submission_id, auth.uid(), coalesce(nullif(p_category, ''), 'overall'), p_score, now(), now())
  on conflict (submission_id, judge_id, category) do update set score = excluded.score, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function submit_guild_event_judge_score(uuid, uuid, text, numeric) from public;
grant execute on function submit_guild_event_judge_score(uuid, uuid, text, numeric) to authenticated;

-- ------------------------------------------------------------------------------------------
-- 5. activate_guild_event — extended in place (identity/grants unchanged) to also lock the
--    objective config and assign the judge panel, at the exact same moment the financial
--    agreement locks and the escrow (if any) is checked. A host='guild' event drafted after
--    this migration cannot open for entries without an objective config on file, same "cannot
--    open without X on file" treatment the financial agreement already has.
-- ------------------------------------------------------------------------------------------

create or replace function activate_guild_event(p_guild_id uuid, p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_objective guild_event_objective_config%rowtype;
  v_escrowed boolean;
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

  v_escrowed := v_event.guaranteed_prize_kobo is not null and v_event.guaranteed_prize_kobo > 0;

  if v_event.host = 'guild' and not v_escrowed then
    select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no financial agreement on file — it cannot open for entries.';
    end if;
    if not v_agreement.locked then
      update guild_event_financial_agreements set locked = true, locked_at = now() where id = v_agreement.id;
    end if;
  end if;

  if v_escrowed then
    if not exists (
      select 1 from guild_treasury_transactions
      where escrow_event_id = p_event_id and kind = 'event_prize_escrow' and status = 'success'
    ) then
      raise exception 'Deposit the guaranteed prize into escrow before opening this event for entries.';
    end if;
  end if;

  -- Migration 121: placements are computed, never declared — see this migration's header.
  -- Every host='guild' event must have an objective config on file before it can open, and
  -- gets its judge panel (if the config leaves any weight on judging) assigned right here,
  -- automatically, before a single entrant has paid.
  if v_event.host = 'guild' then
    select * into v_objective from guild_event_objective_config where event_id = p_event_id for update;
    if not found then
      raise exception 'This event has no judging configuration on file — it cannot open for entries.';
    end if;
    if not v_objective.locked then
      update guild_event_objective_config set locked = true, locked_at = now() where id = v_objective.id;
    end if;
    if v_objective.weight_bps < 10000 then
      perform assign_guild_event_judges(p_event_id);
    end if;
  end if;

  update guild_events set approval_status = 'active', activated_at = now(), status = 'open'
  where id = p_event_id
  returning * into v_event;
  return v_event;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 6. guild_event_results — new 'computed' status: a row nobody submitted and nobody can edit,
--    only confirm. compute_guild_event_placements() writes it; approve_guild_event_results()
--    (redefined below) is what actually triggers settlement off it.
-- ------------------------------------------------------------------------------------------

alter table guild_event_results drop constraint if exists guild_event_results_status_check;
alter table guild_event_results add constraint guild_event_results_status_check
  check (status in ('pending_approval', 'approved', 'rejected', 'computed'));

alter table guild_event_results alter column submitted_by drop not null;

-- ------------------------------------------------------------------------------------------
-- 7. compute_guild_event_placements — the core of this migration. Combines the objective
--    metric and the judge panel's (trimmed-mean) scores into a ranked result and writes it as
--    a 'computed' guild_event_results row. Callable repeatedly while pending (each call
--    recomputes from whatever scores exist so far and only succeeds once quorum is met) by
--    anyone with a legitimate reason to check: the organizer, a guild authority, or Inkroot.
--    p_exclude_judge_ids is Inkroot-admin-only — the dispute path (see migration header):
--    excludes a named judge's scores and recomputes, for a confirmed bad-faith judge.
-- ------------------------------------------------------------------------------------------

create or replace function guild_event_judge_quorum(p_assigned_count integer)
returns integer as $$
  select greatest(2, ceil(p_assigned_count * 0.6)::integer);
$$ language sql immutable;

revoke all on function guild_event_judge_quorum(integer) from public, anon, authenticated;

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

-- ------------------------------------------------------------------------------------------
-- 8. submit_guild_event_results — refuses outright once an event has a judging configuration
--    on file (every event drafted after this migration). The old organizer-declares-placements
--    path stays fully working, unmodified below this point, only for an event that predates
--    this migration and therefore has no guild_event_objective_config row.
-- ------------------------------------------------------------------------------------------

create or replace function submit_guild_event_results(p_guild_id uuid, p_event_id uuid, p_placements jsonb)
returns guild_event_results
language plpgsql security definer set search_path = public as $$
declare
  v_event guild_events%rowtype;
  v_agreement guild_event_financial_agreements%rowtype;
  v_row guild_event_results%rowtype;
  v_bad_contributor uuid;
  v_shares_sum integer;
  v_dup_place boolean;
begin
  if exists (select 1 from guild_event_objective_config where event_id = p_event_id) then
    raise exception 'This event uses computed placements — see compute_guild_event_placements(). Organizer-declared results are no longer accepted for it.';
  end if;

  select * into v_event from guild_events where id = p_event_id and guild_id = p_guild_id;
  if not found then
    raise exception 'Guild event not found.';
  end if;
  if v_event.host <> 'guild' then
    raise exception 'Inkroot-hosted events are settled by Inkroot directly.';
  end if;
  if v_event.organizer_id is null or auth.uid() <> v_event.organizer_id then
    raise exception 'Only this event''s organizer can submit its results.';
  end if;
  if v_event.approval_status <> 'completed' then
    raise exception 'Mark the event completed before submitting results.';
  end if;
  if v_event.status = 'settled' then
    raise exception 'This event has already been settled.';
  end if;

  if p_placements is null or jsonb_array_length(p_placements) = 0 then
    raise exception 'Add at least one winner.';
  end if;

  select (p->>'contributor_id')::uuid into v_bad_contributor
  from jsonb_array_elements(p_placements) p
  where not exists (
    select 1 from player_guild_members m
    where m.guild_id = p_guild_id and m.user_id = (p->>'contributor_id')::uuid
  )
  limit 1;
  if v_bad_contributor is not null then
    raise exception 'Every winner must be a member of this guild.';
  end if;

  select exists (
    select 1 from jsonb_array_elements(p_placements) p
    group by (p->>'place')
    having count(*) > 1
  ) into v_dup_place;
  if v_dup_place then
    raise exception 'Each place (1st, 2nd, ...) can only be used once.';
  end if;

  select * into v_agreement from guild_event_financial_agreements where event_id = p_event_id;
  if not found or not v_agreement.locked then
    raise exception 'This event has no locked financial agreement — it cannot be settled.';
  end if;
  select coalesce(sum((p->>'share_bps')::integer), 0) into v_shares_sum
  from jsonb_array_elements(p_placements) p;
  if v_shares_sum <> v_agreement.prize_pool_bps then
    raise exception 'Winner shares must add up to exactly the locked prize pool share — % basis points of the pool, no more and no less.', v_agreement.prize_pool_bps;
  end if;

  select * into v_row from guild_event_results where event_id = p_event_id for update;
  if found and v_row.status = 'approved' then
    raise exception 'Results for this event have already been approved and paid out.';
  end if;

  insert into guild_event_results (guild_id, event_id, placements, status, submitted_by, submitted_at)
  values (p_guild_id, p_event_id, p_placements, 'pending_approval', auth.uid(), now())
  on conflict (event_id) do update set
    placements = excluded.placements, status = 'pending_approval',
    submitted_by = excluded.submitted_by, submitted_at = excluded.submitted_at,
    reviewed_by = null, reviewed_at = null, rejection_reason = null, settled_at = null
  returning * into v_row;
  return v_row;
end;
$$;

-- ------------------------------------------------------------------------------------------
-- 9. approve_guild_event_results — redefined to branch on status. A 'computed' row has no
--    submitter to be distinct from and nothing discretionary to approve: any guild authority
--    confirms the conditions held and triggers settle_guild_event(), unchanged from migration
--    120 in every other respect. A 'pending_approval' (legacy, organizer-submitted) row keeps
--    its exact original four-eyes behavior.
-- ------------------------------------------------------------------------------------------

create or replace function approve_guild_event_results(p_event_id uuid)
returns guild_events
language plpgsql security definer set search_path = public as $$
declare
  v_results guild_event_results%rowtype;
  v_event guild_events%rowtype;
  v_shares jsonb;
begin
  select * into v_results from guild_event_results where event_id = p_event_id for update;
  if not found then
    raise exception 'No results have been computed or submitted for this event yet.';
  end if;
  if v_results.status = 'approved' then
    raise exception 'These results have already been approved.';
  end if;
  if v_results.status not in ('pending_approval', 'computed') then
    raise exception 'These results were rejected — resubmit or recompute before they can be approved.';
  end if;

  if not is_guild_treasury_authorized(v_results.guild_id) then
    raise exception 'Only the guild leader, a treasurer, or an officer can approve event results.';
  end if;
  if v_results.status = 'pending_approval' and auth.uid() = v_results.submitted_by then
    raise exception 'The organizer who submitted these results cannot also approve them.';
  end if;

  select jsonb_agg(jsonb_build_object('contributor_id', p->>'contributor_id', 'share_bps', (p->>'share_bps')::integer))
  into v_shares
  from jsonb_array_elements(v_results.placements) p;

  v_event := settle_guild_event(v_results.guild_id, p_event_id, v_shares);

  update guild_event_results
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now(), settled_at = now()
  where event_id = p_event_id;

  return v_event;
end;
$$;

-- ============================================================================================
-- Verify after applying:
--   * A new draft event has no way to activate without calling
--     propose_guild_event_objective_config() first (activation raises "no judging
--     configuration on file").
--   * An event configured with weight_bps < 10000 gets 3-5 judges auto-assigned on activation,
--     none of them members of the hosting guild, none the organizer/creator; activation raises
--     a clear count if fewer than 3 are eligible.
--   * A judge calling fetch_guild_event_entries_for_judge() sees "Entry N" labels only, never
--     entrant_id, name, or pen name.
--   * compute_guild_event_placements() raises a clear quorum message when fewer than
--     guild_event_judge_quorum() judges have scored every entry, and succeeds once quorum is
--     met, producing a 'computed' guild_event_results row with no submitted_by.
--   * approve_guild_event_results() on a 'computed' row succeeds for any single treasury-
--     authorized officer (no second-party requirement, since nothing was declared by a
--     person) and settles exactly as before — same advisory locks, same one-settlement-ever
--     guarantee, same member-only-winner check.
--   * submit_guild_event_results() refuses with the "uses computed placements" message for any
--     event that has an objective config row; an event predating this migration (no config
--     row) still accepts an organizer-submitted proposal exactly as it did under migration 120.
--   * A non-guild-member's submission is scored (visible to judges, factored into ranking) but
--     never appears in the final placements/payout — matches settle_guild_event()'s existing
--     member-only-winner rule.
-- ============================================================================================
