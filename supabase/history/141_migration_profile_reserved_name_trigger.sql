-- ============================================================================================
-- Migration 141 — reserved profile names (display_name / pen_name) were only blocked client-side.
--
-- src/shared-utils/identity-safety.js's isReservedName() stops a writer saving a name that reads
-- as Inkroot itself or one of its roles ("Inkroot Support", "Admin", "Moderator", "System", ...)
-- — but only inside saveProfile (shell/ink-root.jsx), before it calls syncProfile
-- (lib/profile.js), which is a plain supabase.from('profiles').update({ display_name, pen_name,
-- ... }). The profiles RLS policy ("a user updates their own profile", auth.uid() = id) has no
-- opinion about what those columns contain, so a direct API call skips the check entirely:
--   supabase.from('profiles').update({ display_name: 'Inkroot Support' }).eq('id', myId)
-- succeeds, and that name is then shown next to their Fireside posts, reviews, guild messages
-- and published books — exactly the "pose as support and ask for payment outside the app" attack
-- the reserved list exists to stop. Migration 126 built the equivalent server-side protection for
-- guild names (is_reserved_guild_name(), called inside create_or_get_own_guild()) and explicitly
-- deferred the profile-name equivalent; this is that equivalent.
--
-- Fix: a before insert / before update trigger on profiles that raises 'That name isn''t
-- available.' (the same wording migration 126 uses for guilds) when display_name or pen_name is
-- a reserved name. It reuses is_reserved_guild_name() from migration 126 directly rather than
-- copying its list, so there is exactly one reserved-name list in SQL — the one that already
-- matches identity-safety.js's RESERVED_NAMES entry for entry (inkroot, inkrootsupport,
-- inkrootstaff, inkrootteam, inkrootofficial, inkrootadmin, inkrootmoderator, inkrootmod,
-- inkrootsecurity, inkroothelp, support, staff, admin, administrator, moderator, mod, official,
-- system, inkrootteamofficial) and uses the same normalization (lowercase, the 0/1/3/4/5/7/@/$
-- look-alike substitutions, everything that isn't a-z or 0-9 dropped). Nothing new is invented.
--
-- Deliberately the same as the guild check, including what it does NOT do:
--   * No accent folding. identity-safety.js strips accents (NFD) before matching; the SQL
--     normalization from migration 126 does not (that would need the `unaccent` extension, which
--     this schema doesn't otherwise depend on), so an accented variant such as 'Ínkroot' is caught
--     by the client check but not by this one — the same gap the guild-name check already has.
--     Kept identical on purpose so guild and profile names behave the same way; closing it for
--     both at once would be a separate change.
--   * No lookalike-name check. findSimilarName() compares a name against existing PUBLISHED
--     authors' names and is a soft warning by design (real people share names — see
--     identity-safety.js's header); a hard, server-side block would contradict that. It stays
--     client-only and unchanged.
--
-- Scope of the trigger — it is meant to be invisible to everything except a reserved name:
--   * Only display_name / pen_name are examined, and on UPDATE only when the value actually
--     CHANGES (is distinct from old.*). syncProfile writes both columns on every save, so a
--     writer who already holds a reserved name (set before this migration) can still save their
--     motto or avatar — the trigger only objects to setting a reserved name, not to keeping one.
--     (`update of display_name, pen_name` narrows when it fires; the is-distinct-from check is
--     what actually decides.) null / empty names always pass — the purge cron and moderators clear
--     names that way.
--   * Callers with no signed-in end user (auth.uid() is null — the service role, the Supabase SQL
--     editor, cron) and service_role itself are exempt, the same way
--     protect_admin_profile_columns() exempts service_role. That is the only way an operator can
--     ever give the genuine Inkroot account an official name; end users always arrive with a JWT.
--   * The trigger is named so it fires AFTER protect_admin_profile_columns_trigger (Postgres runs
--     same-timing triggers alphabetically): when a moderator edits someone else's row, that
--     trigger first reverts the moderator's name changes, so this one sees the reverted value.
--   * handle_new_user()'s 'Writer <id8>' seed is not a reserved name, so sign-up is unaffected.
--
-- Safe to run anytime: adds one function and one trigger; no table, column, policy or data change,
-- and no existing row is touched or re-validated. Profiles that already hold a reserved name
-- keep it until the writer (or an operator) changes it; to find them:
--   select id, display_name, pen_name from profiles
--   where is_reserved_guild_name(display_name) or is_reserved_guild_name(pen_name);
-- ============================================================================================

create or replace function validate_reserved_profile_names()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_display_changed boolean;
  v_pen_changed boolean;
begin
  if auth.uid() is null or coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  -- OLD doesn't exist on INSERT (touching old.* there errors), so branch on the operation
  -- first instead of folding both cases into one boolean expression.
  if tg_op = 'INSERT' then
    v_display_changed := true;
    v_pen_changed := true;
  else
    v_display_changed := new.display_name is distinct from old.display_name;
    v_pen_changed := new.pen_name is distinct from old.pen_name;
  end if;

  if v_display_changed and is_reserved_guild_name(new.display_name) then
    raise exception 'That name isn''t available.';
  end if;

  if v_pen_changed and is_reserved_guild_name(new.pen_name) then
    raise exception 'That name isn''t available.';
  end if;

  return new;
end;
$$;

drop trigger if exists validate_reserved_profile_names_trigger on profiles;
create trigger validate_reserved_profile_names_trigger
  before insert or update of display_name, pen_name on profiles
  for each row execute function validate_reserved_profile_names();
