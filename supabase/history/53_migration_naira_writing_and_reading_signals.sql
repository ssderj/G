-- Migration 53: real, cheat-resistant signals for the Tier 2 NAIRA_ACHIEVEMENTS that were
-- deliberately left unbuilt in 52_migration_naira_achievement_grants.sql:
--
--   nairaFirstBook, nairaDedicatedWriter, nairaMasterWriter (word-count-based), and
--   nairaReader, nairaLoyal (reading-hours / streak-based).
--
-- Chosen direction (explicitly: cheat-resistance over shipping speed):
--   - Word count: real manuscript content sync + a day-capped credit ledger, NOT a bare
--     client-reported number. See the "why not just trust a number" reasoning below.
--   - Reading: a real server-throttled heartbeat while a book is visibly open, NOT a reuse of
--     the existing "opened today" signal (which can't distinguish 3 hours of reading from 3
--     seconds).
--   - The streak (nairaLoyal) is the union of both: a day counts if either signal fired.
--
-- nairaWelcome is still not in this migration — unchanged from 52's reasoning (motto isn't
-- synced to profiles at all yet).
--
-- ============================================================================================
-- PART 1 — word count, real content in, day-capped credit out
-- ============================================================================================
--
-- The problem restated precisely: a project's chapters live only inside one opaque JSONB blob
-- per project in kv_store (see syncEngine.js/storage.js) — there is no structured, validated
-- manuscript table anywhere. Two sub-problems, two separate fixes:
--
--   1. "Is the reported word count even real?" — fixed by NOT trusting a reported number at
--      all. The trigger below parses kv_store's actual synced value and derives a real word
--      count itself, the same tokenization src/shared-utils/strip-html.jsx's wordCount()/
--      stripHtml() already use (strip tags, collapse whitespace, count tokens) — block-vs-inline
--      tag handling doesn't change a token count, so a single regex pass is equivalent here.
--
--   2. "Can real content still be gamed?" — yes: pasting a finished 50,000-word novel into one
--      chapter and syncing it would derive a perfectly real, perfectly honest word count
--      instantly. Fixed by writing_credit_ledger below: only min(today's real increase, 10,000)
--      ever counts toward the lifetime total, so reaching 50,000 takes at least 5 distinct real
--      calendar days no matter how the underlying total jumped. This is the same "capped,
--      not fully verifiable, but honestly bounded" tradeoff already accepted elsewhere in this
--      schema (Rising Star's diminishing-returns weighting, Guilds on the Rise's floors — see
--      38_migration_rising_star_scoring.sql, 40_migration_guilds_on_rise_scoring.sql) rather
--      than a new kind of compromise invented just for this.
--
-- IMPORTANT — a real quirk of how this app syncs, confirmed against storage.js/syncEngine.js
-- before writing this: storage.set(projectKey(id), JSON.stringify(project)) means the value
-- pushed to kv_store is a JSON-encoded STRING containing the project, not the project object
-- itself — so kv_store.value (jsonb) holds a JSON *string scalar*, double-encoded. The trigger
-- below unwraps that with `value #>> '{}'` (get the string content) before parsing it a second
-- time as jsonb. Skipping this step would make every project row fail to parse silently.
--
-- Also confirmed against project-schema-and-backups.jsx/ink-root.jsx: a project's own JSON blob
-- has NO `id` field of its own — the id lives only in the kv_store KEY (`inkroot:project:<id>`)
-- and the separate local project index. The trigger below derives project_id from NEW.key
-- (stripping the 16-character 'inkroot:project:' prefix), not from inside the payload.

create table if not exists project_word_high_water (
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id text not null,
  word_count bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, project_id)
);

alter table project_word_high_water enable row level security;

create policy "a user reads their own project word counts" on project_word_high_water
  for select using (auth.uid() = user_id);
-- No client insert/update/delete policy — every row is written only by the trigger below, which
-- runs as a security definer function and so isn't subject to this table's RLS at all.

-- Monotonic (greatest-of), deliberately never decreases even if a writer later trims or deletes
-- content — this measures words actually written, ever, not a live document length. Cutting a
-- bad paragraph after writing it shouldn't erase credit for having written it.
create or replace function sync_project_word_high_water()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_project_id text;
  v_data jsonb;
  v_chapters jsonb;
  v_chapter jsonb;
  v_text text;
  v_total bigint := 0;
begin
  if NEW.key !~ '^inkroot:project:' or NEW.deleted or NEW.value is null then
    return NEW;
  end if;
  v_project_id := substring(NEW.key from 17); -- length('inkroot:project:') = 16

  begin
    -- Unwrap the double-encoding described above, then parse the manuscript it actually holds.
    v_data := (NEW.value #>> '{}')::jsonb;
  exception when others then
    return NEW; -- not valid/double-encoded JSON — skip rather than ever fail this writer's sync
  end;

  v_chapters := v_data -> 'chapters';
  if v_chapters is null or jsonb_typeof(v_chapters) <> 'array' then
    return NEW;
  end if;

  for v_chapter in select * from jsonb_array_elements(v_chapters) loop
    v_text := coalesce(v_chapter ->> 'text', '');
    v_text := regexp_replace(v_text, '<[^>]+>', ' ', 'g');
    v_text := regexp_replace(v_text, '&nbsp;', ' ', 'g');
    v_text := trim(regexp_replace(v_text, '\s+', ' ', 'g'));
    if v_text <> '' then
      v_total := v_total + array_length(regexp_split_to_array(v_text, '\s+'), 1);
    end if;
  end loop;

  insert into project_word_high_water (user_id, project_id, word_count, updated_at)
  values (NEW.user_id, v_project_id, v_total, now())
  on conflict (user_id, project_id) do update
    set word_count = greatest(project_word_high_water.word_count, excluded.word_count),
        updated_at = now();

  return NEW;
end;
$$;

drop trigger if exists trg_sync_project_word_high_water on kv_store;
create trigger trg_sync_project_word_high_water
  after insert or update on kv_store
  for each row execute function sync_project_word_high_water();

-- Day-capped lifetime credit. One row per (user, calendar day, UTC) — day N's credited_words is
-- recomputed (not incremented) every time this runs, from the gap between the live total and
-- everything credited on strictly earlier days, so calling it any number of times in one day is
-- idempotent and safe.
create table if not exists writing_credit_ledger (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  credited_words bigint not null default 0,
  primary key (user_id, day)
);

alter table writing_credit_ledger enable row level security;

create policy "a user reads their own writing credit ledger" on writing_credit_ledger
  for select using (auth.uid() = user_id);
-- No client insert/update/delete policy — only sync_writing_credit_ledger() below writes here.

create or replace function sync_writing_credit_ledger()
returns bigint -- lifetime credited total after syncing today's row
language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'utc')::date;
  v_current_total bigint;
  v_prior_total bigint;
  v_today_capped bigint;
begin
  select coalesce(sum(word_count), 0) into v_current_total
  from project_word_high_water where user_id = auth.uid();

  select coalesce(sum(credited_words), 0) into v_prior_total
  from writing_credit_ledger where user_id = auth.uid() and day < v_today;

  v_today_capped := least(greatest(v_current_total - v_prior_total, 0), 10000); -- 10,000 words/day cap

  insert into writing_credit_ledger (user_id, day, credited_words)
  values (auth.uid(), v_today, v_today_capped)
  on conflict (user_id, day) do update set credited_words = excluded.credited_words;

  return v_prior_total + v_today_capped;
end;
$$;

revoke all on function sync_writing_credit_ledger() from public;
grant execute on function sync_writing_credit_ledger() to authenticated;

-- ============================================================================================
-- PART 2 — reading, real heartbeats, server-throttled
-- ============================================================================================
--
-- book_read_events (38_migration_rising_star_scoring.sql) only ever recorded "opened this book
-- today," which can't distinguish a real read from a three-second bounce. This adds actual
-- verified minutes, scoped to published_books only (same scope book_read_events already has —
-- guild_published_books was never part of this signal either, so this isn't a new gap).
--
-- Anti-gaming: record_reading_heartbeat() throttles against ITS OWN clock (a per-user
-- last-heartbeat-at row, checked server-side), never against anything the client claims about
-- elapsed time — so a client calling this faster than once every ~45 seconds simply gets
-- ignored, regardless of what interval it thinks it's using. A daily cap (180 minutes) on top of
-- that bounds worst-case exposure even if every throttled call is scripted rather than a real
-- read — same honest caveat as any heartbeat system in a web client: this bounds the damage, it
-- doesn't make faking a heartbeat impossible for a determined, modified client.

create table if not exists reading_heartbeats_daily (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  minutes integer not null default 0,
  primary key (user_id, day)
);

alter table reading_heartbeats_daily enable row level security;

create policy "a user reads their own reading heartbeat history" on reading_heartbeats_daily
  for select using (auth.uid() = user_id);
-- No client insert/update/delete policy — only record_reading_heartbeat() below writes here.

create table if not exists reading_heartbeat_cursor (
  user_id uuid primary key references auth.users(id) on delete cascade,
  last_heartbeat_at timestamptz not null
);

alter table reading_heartbeat_cursor enable row level security;

create policy "a user reads their own heartbeat cursor" on reading_heartbeat_cursor
  for select using (auth.uid() = user_id);
-- No client insert/update/delete policy — only record_reading_heartbeat() below writes here.

create or replace function record_reading_heartbeat(p_book_id text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_last timestamptz;
  v_today date := (now() at time zone 'utc')::date;
begin
  if is_banned(auth.uid()) then
    return;
  end if;
  -- Same self-read exclusion book_read_events' own insert policy already enforces — an author
  -- can't farm their own book's reading time.
  if exists (select 1 from published_books b where b.id = p_book_id and b.author_id = auth.uid()) then
    return;
  end if;
  if not exists (select 1 from published_books where id = p_book_id) then
    return; -- not a real published book — e.g. a local-only project id, nothing to credit
  end if;

  select last_heartbeat_at into v_last from reading_heartbeat_cursor where user_id = auth.uid();
  if v_last is not null and now() - v_last < interval '45 seconds' then
    return; -- throttled — the server's own clock decides this, not the client's claimed interval
  end if;

  insert into reading_heartbeat_cursor (user_id, last_heartbeat_at)
  values (auth.uid(), now())
  on conflict (user_id) do update set last_heartbeat_at = excluded.last_heartbeat_at;

  insert into reading_heartbeats_daily (user_id, day, minutes)
  values (auth.uid(), v_today, 1)
  on conflict (user_id, day) do update
    set minutes = least(reading_heartbeats_daily.minutes + 1, 180); -- 180 minutes/day cap
end;
$$;

revoke all on function record_reading_heartbeat(text) from public;
grant execute on function record_reading_heartbeat(text) to authenticated;

-- ============================================================================================
-- PART 3 — the streak: a day counts if EITHER real signal fired that day
-- ============================================================================================
--
-- This computes the LONGEST streak ever reached in the caller's full history, not just an
-- in-progress one ending today — a one-time grant (see grant_naira_achievement in migration 52)
-- has to work this way, or a writer who hit 7 days, didn't happen to open the Hall of Legends
-- that exact day, and broke the streak the next day would unfairly lose an achievement they
-- genuinely already earned. Standard "gaps and islands" technique: subtracting each date's row
-- number (ordered) from itself collapses any run of consecutive dates onto the same group key.

create or replace function naira_longest_activity_streak()
returns integer
language sql stable security definer set search_path = public as $$
  with active_days as (
    select day from writing_credit_ledger where user_id = auth.uid() and credited_words > 0
    union
    select day from reading_heartbeats_daily where user_id = auth.uid() and minutes >= 5
  ),
  islands as (
    select day, day - (row_number() over (order by day))::integer as grp
    from active_days
  )
  select coalesce(max(cnt), 0)::integer from (
    select count(*) as cnt from islands group by grp
  ) s;
$$;

revoke all on function naira_longest_activity_streak() from public;
grant execute on function naira_longest_activity_streak() to authenticated;

-- ============================================================================================
-- PART 4 — wire the five signals into the existing Tier 1 machinery from migration 52
-- ============================================================================================
--
-- naira_achievement_current is upgraded from `language sql stable` to `language plpgsql`
-- (dropping the `stable` label) because it now calls sync_writing_credit_ledger(), which writes.
-- The Tier 1 branches are carried over unchanged.
--
-- Product decision made here (flagging it plainly, same as nairaWelcome in migration 52):
-- nairaFirstBook's original desc, "Complete your first manuscript," had no server-checkable
-- signal — the only local candidate is project.completed, a plain boolean the writer can flip
-- for a brand-new, empty project in one tap, which fails the same "trust a client number"
-- problem this whole migration exists to close. Redefined instead as reaching a 30,000-word
-- lifetime credited total (the SAME day-capped, real-content signal nairaDedicatedWriter/
-- nairaMasterWriter use, just a lower threshold, and the same 30,000-word bar
-- nairaFirstPublication already uses to mean "book-length") — current/unlocked still display
-- against its original target of 1 (a single completion, not a running word count) since that's
-- the shape its card in achievements.jsx already renders.

create or replace function naira_achievement_current(p_achievement_id text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  v_result bigint;
begin
  case p_achievement_id
    when 'nairaFirstPurchase' then
      select count(*) into v_result from purchases where buyer_id = auth.uid() and status = 'success';
    when 'nairaBookCollector' then
      select count(*) into v_result from purchases where buyer_id = auth.uid() and status = 'success';
    when 'nairaGrandCollector' then
      select count(*) into v_result from purchases where buyer_id = auth.uid() and status = 'success';
    when 'nairaRookieMerchant' then
      select count(*) into v_result from purchases where author_id = auth.uid() and status = 'success';
    when 'nairaHustler' then
      select count(*) into v_result from purchases where author_id = auth.uid() and status = 'success';
    when 'nairaSeniorMan' then
      select count(*) into v_result from purchases where author_id = auth.uid() and status = 'success';
    when 'nairaFirstPublication' then
      select (case when exists (
        select 1 from published_books where author_id = auth.uid() and word_count >= 30000
        union all
        select 1 from guild_published_books where author_id = auth.uid() and word_count >= 30000
      ) then 1 else 0 end) into v_result;
    when 'nairaFirstBook' then
      select (case when sync_writing_credit_ledger() >= 30000 then 1 else 0 end) into v_result;
    when 'nairaDedicatedWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaMasterWriter' then
      select sync_writing_credit_ledger() into v_result;
    when 'nairaReader' then
      select coalesce(sum(minutes), 0) / 60 into v_result
      from reading_heartbeats_daily where user_id = auth.uid();
    when 'nairaLoyal' then
      select naira_longest_activity_streak() into v_result;
    else
      v_result := null;
  end case;
  return v_result;
end;
$$;

revoke all on function naira_achievement_current(text) from public;
grant execute on function naira_achievement_current(text) to authenticated;

-- grant_naira_achievement (migration 52) — add the five new target/reward pairs. Reward amounts
-- convert NAIRA_ACHIEVEMENTS' nairaReward (Naira) to kobo (x100), same as every Tier 1 entry:
-- nairaFirstBook 500 -> 50000, nairaDedicatedWriter 500 -> 50000, nairaMasterWriter 1000 -> 100000,
-- nairaReader 500 -> 50000, nairaLoyal 1000 -> 100000.
create or replace function grant_naira_achievement(p_achievement_id text)
returns achievement_grants
language plpgsql security definer set search_path = public as $$
declare
  v_row achievement_grants;
  v_target bigint;
  v_reward_kobo bigint;
  v_current bigint;
begin
  select * into v_row from achievement_grants
  where user_id = auth.uid() and achievement_id = p_achievement_id;
  if found then
    return v_row; -- already granted — idempotent, not an error
  end if;

  case p_achievement_id
    when 'nairaFirstPurchase'    then v_target := 1;      v_reward_kobo := 10000;
    when 'nairaBookCollector'    then v_target := 50;      v_reward_kobo := 500000;
    when 'nairaGrandCollector'   then v_target := 100;     v_reward_kobo := 1000000;
    when 'nairaRookieMerchant'   then v_target := 10;      v_reward_kobo := 100000;
    when 'nairaHustler'          then v_target := 50;      v_reward_kobo := 500000;
    when 'nairaSeniorMan'        then v_target := 100;     v_reward_kobo := 1500000;
    when 'nairaFirstPublication' then v_target := 1;       v_reward_kobo := 100000;
    when 'nairaFirstBook'        then v_target := 1;       v_reward_kobo := 50000;
    when 'nairaDedicatedWriter'  then v_target := 50000;   v_reward_kobo := 50000;
    when 'nairaMasterWriter'     then v_target := 100000;  v_reward_kobo := 100000;
    when 'nairaReader'           then v_target := 5;       v_reward_kobo := 50000;
    when 'nairaLoyal'            then v_target := 7;       v_reward_kobo := 100000;
    else
      raise exception 'This achievement has no server-verifiable signal yet.';
  end case;

  perform pg_advisory_xact_lock(hashtext('naira_achievement:' || auth.uid()::text || ':' || p_achievement_id));

  select * into v_row from achievement_grants
  where user_id = auth.uid() and achievement_id = p_achievement_id;
  if found then
    return v_row;
  end if;

  v_current := naira_achievement_current(p_achievement_id);
  if v_current is null or v_current < v_target then
    raise exception 'Achievement not yet earned.';
  end if;

  insert into achievement_grants (user_id, achievement_id, naira_reward_kobo)
  values (auth.uid(), p_achievement_id, v_reward_kobo)
  returning * into v_row;
  return v_row;
end;
$$;

revoke all on function grant_naira_achievement(text) from public;
grant execute on function grant_naira_achievement(text) to authenticated;

-- naira_achievement_progress (migration 52) — extend the id/target arrays with the five new
-- ones. current_count reporting (least(current, target) when locked, target when unlocked) is
-- already generic and needed no changes — every id here reports current in the same units its
-- target is expressed in (see naira_achievement_current above), same as every Tier 1 id already did.
create or replace function naira_achievement_progress()
returns table (achievement_id text, current_count bigint, unlocked boolean)
language plpgsql security definer set search_path = public as $$
declare
  v_id text;
  v_target bigint;
  v_ids text[] := array['nairaFirstPurchase', 'nairaBookCollector', 'nairaGrandCollector',
                         'nairaRookieMerchant', 'nairaHustler', 'nairaSeniorMan', 'nairaFirstPublication',
                         'nairaFirstBook', 'nairaDedicatedWriter', 'nairaMasterWriter', 'nairaReader', 'nairaLoyal'];
  v_targets bigint[] := array[1, 50, 100, 10, 50, 100, 1,
                               1, 50000, 100000, 5, 7];
begin
  for i in 1 .. array_length(v_ids, 1) loop
    v_id := v_ids[i];
    v_target := v_targets[i];
    begin
      perform grant_naira_achievement(v_id);
    exception when others then
      null; -- not eligible yet — expected, not an error worth surfacing here
    end;

    achievement_id := v_id;
    unlocked := exists (select 1 from achievement_grants g where g.user_id = auth.uid() and g.achievement_id = v_id);
    if unlocked then
      current_count := v_target;
    else
      current_count := least(coalesce(naira_achievement_current(v_id), 0), v_target);
    end if;
    return next;
  end loop;
end;
$$;

revoke all on function naira_achievement_progress() from public;
grant execute on function naira_achievement_progress() to authenticated;

-- Safe to run anytime: every new table starts empty, project_word_high_water/writing_credit_ledger
-- only ever populate from here forward (there's no historical manuscript content to backfill —
-- this migration doesn't attempt to derive word counts retroactively from before it existed), and
-- author_balance_kobo() (migration 52) already sums achievement_grants generically — no change
-- needed there for these five to pay out through the exact same withdrawable-balance pipeline.
