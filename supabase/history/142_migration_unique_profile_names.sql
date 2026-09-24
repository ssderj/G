-- ============================================================================================
-- Migration 142 — profile display_name and pen_name are now case-insensitively unique (each
-- column on its own), so nobody can register a name that is EXACTLY someone else's.
--
-- Why: migration 141 blocks reserved (staff-like) names server-side, but nothing stopped a second
-- account from taking the same name as an existing writer — "Jane Austen" next to "Jane Austen"
-- in a Fireside thread, a review, or a Grand Library byline. Until now the only defense was
-- identity-safety.js's findSimilarName() soft warning (client-side, advisory), the verified
-- badge, and the report system. This adds the hard server-side floor for the exact-match case.
--
-- Decision recorded (asked for and chosen explicitly): uniqueness applies to each column
-- SEPARATELY and case-insensitively — no two profiles share a display_name, and no two share a
-- pen_name, ignoring case and leading/trailing spaces. A display_name equal to someone else's
-- pen_name is NOT refused, and neither is one writer's own display_name matching their own
-- pen_name (the usual case). This deliberately supersedes identity-safety.js's older "real
-- people share names, so never hard-block" stance for the exact-match case only; that file's
-- lookalike detection (near-matches: 1nkroot-style substitutions, extra punctuation) is
-- unchanged and stays a client-side soft warning — no new normalization is invented here beyond
-- lower() + btrim(), which is what "case-insensitive" needs to mean anything (otherwise
-- 'Jane Austen ' beats the rule).
--
-- What this adds:
--   1. A pre-flight that ABORTS the migration (changing nothing) if the table already contains
--      duplicates, listing them — creating a unique index over duplicates would fail anyway, and
--      which of two existing accounts keeps a name is a moderation call, not something a
--      migration should decide. See "If it aborts" below.
--   2. Two partial unique indexes, the real, race-proof guarantee:
--        profiles_display_name_lower_unique  on (lower(btrim(display_name)))
--        profiles_pen_name_lower_unique      on (lower(btrim(pen_name)))
--      Both skip null and blank names (any number of writers can have none). The display_name
--      index also skips handle_new_user()'s placeholder 'Writer <8 hex chars>': that seed is
--      only the first 8 hex digits of the user's uuid, so two sign-ups could in principle share
--      one, and a unique index would then make that SIGN-UP fail outright. A placeholder isn't an
--      identity worth protecting, so it is exempt (this also lets the seed stay exactly as it is).
--   3. validate_unique_profile_names() + trigger: the same rule checked up front so the writer
--      gets a readable message instead of Postgres' constraint text. It only exists for the
--      message — the indexes are what actually guarantee uniqueness; a genuine race between two
--      accounts still resolves correctly at the index (the loser sees a generic failure). It
--      raises a plpgsql exception (P0001), which lib/errors.js's sanitizeError passes through
--      as-is; lib/profile.js's syncProfile tags it so ink-root.jsx's saveProfile can show it.
--      Fires on insert, and on update only when that column's value actually changes, so
--      re-sending an unchanged name (syncProfile writes both columns on every save) never trips
--      it, and a writer can change the capitalization of their own name. The check ignores the
--      caller's own row. It does not bypass service_role: the indexes wouldn't either.
--
-- Client note (per-keystroke sync): saveProfile syncs on every keystroke, so while someone types
-- 'Jane Austen' the server briefly sees 'J', 'Ja', 'Jan', 'Jane'... If another writer already
-- holds one of those exact prefixes the sync for that keystroke is refused (the notice appears
-- under the name field, and clears itself as soon as a later keystroke syncs successfully); the
-- server keeps the last accepted value in the meantime. That is inherent to enforcing uniqueness
-- while the field syncs live, and is why the accompanying client change shows the real reason.
--
-- Public-read note: profiles is already readable by everyone ("anyone can read profiles"), so
-- "that name is taken" reveals nothing a reader couldn't already see.
--
-- Safe to run anytime: no rows are modified; it either creates the indexes/trigger or aborts
-- before touching anything (pre-flight). Index creation takes a brief lock on profiles, a small
-- table. Idempotent (if not exists / create or replace / drop-then-create trigger).
--
-- If it aborts: the error lists the colliding names. Find every duplicate with
--   select 'display_name' as col, lower(btrim(display_name)) as name, count(*), array_agg(id)
--     from profiles
--    where display_name is not null and btrim(display_name) <> ''
--      and display_name !~ '^Writer [0-9a-f]{8}$'
--    group by 2 having count(*) > 1
--   union all
--   select 'pen_name', lower(btrim(pen_name)), count(*), array_agg(id)
--     from profiles where pen_name is not null and btrim(pen_name) <> ''
--    group by 2 having count(*) > 1;
-- decide per name which account keeps it (moderation call — the older / verified one, usually),
-- clear or change the others (update profiles set display_name = null where id = '...'), then
-- run this migration again.
-- ============================================================================================

do $$
declare
  v_dupes text;
begin
  select string_agg(format('%s "%s" x%s', d.col, d.name, d.n), '; ' order by d.col, d.name)
    into v_dupes
  from (
    select 'display_name' as col, lower(btrim(display_name)) as name, count(*) as n
      from profiles
     where display_name is not null and btrim(display_name) <> ''
       and display_name !~ '^Writer [0-9a-f]{8}$'
     group by 2 having count(*) > 1
    union all
    select 'pen_name', lower(btrim(pen_name)), count(*)
      from profiles
     where pen_name is not null and btrim(pen_name) <> ''
     group by 2 having count(*) > 1
  ) d;

  if v_dupes is not null then
    raise exception 'Migration 142 aborted, nothing changed: profiles already contain duplicate names (%). Resolve them first — see this migration''s header, "If it aborts".', v_dupes;
  end if;
end;
$$;

create unique index if not exists profiles_display_name_lower_unique
  on profiles (lower(btrim(display_name)))
  where display_name is not null
    and btrim(display_name) <> ''
    and display_name !~ '^Writer [0-9a-f]{8}$';

create unique index if not exists profiles_pen_name_lower_unique
  on profiles (lower(btrim(pen_name)))
  where pen_name is not null
    and btrim(pen_name) <> '';

create or replace function validate_unique_profile_names()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_changed boolean;
  v_pen_changed boolean;
begin
  -- OLD doesn't exist on INSERT (touching old.* there errors), so branch on the operation first.
  if tg_op = 'INSERT' then
    v_display_changed := true;
    v_pen_changed := true;
  else
    v_display_changed := new.display_name is distinct from old.display_name;
    v_pen_changed := new.pen_name is distinct from old.pen_name;
  end if;

  -- Mirrors the display_name index's predicate exactly (non-blank, not a 'Writer <id8>' seed —
  -- on either side of the comparison), so this never refuses something the index would allow.
  if v_display_changed
     and new.display_name is not null
     and btrim(new.display_name) <> ''
     and new.display_name !~ '^Writer [0-9a-f]{8}$'
     and exists (
       select 1 from profiles p
        where p.id <> new.id
          and p.display_name is not null
          and btrim(p.display_name) <> ''
          and p.display_name !~ '^Writer [0-9a-f]{8}$'
          and lower(btrim(p.display_name)) = lower(btrim(new.display_name))
     ) then
    raise exception 'That display name is already taken — please choose another.';
  end if;

  if v_pen_changed
     and new.pen_name is not null
     and btrim(new.pen_name) <> ''
     and exists (
       select 1 from profiles p
        where p.id <> new.id
          and p.pen_name is not null
          and btrim(p.pen_name) <> ''
          and lower(btrim(p.pen_name)) = lower(btrim(new.pen_name))
     ) then
    raise exception 'That pen name is already taken — please choose another.';
  end if;

  return new;
end;
$$;

-- Named so it fires after protect_admin_profile_columns_trigger (and after 141's reserved-name
-- trigger): same-timing triggers run alphabetically, and validate_unique_... sorts after both.
drop trigger if exists validate_unique_profile_names_trigger on profiles;
create trigger validate_unique_profile_names_trigger
  before insert or update of display_name, pen_name on profiles
  for each row execute function validate_unique_profile_names();
