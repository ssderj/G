-- ============================================================================================
-- Test for migration 142 (supabase/history/142_migration_unique_profile_names.sql)
-- — display_name and pen_name are case-insensitively unique, each column on its own.
--
-- How to run: same as supabase/tests/140_ and 141_: scratch/dev database with supabase/schema.sql
-- applied through migration 142, as a role that bypasses RLS (postgres), SQL editor or
-- `psql -f`. One transaction that ROLLS BACK; a failing case raises 'FAIL: ...' and aborts; a
-- clean run ends with 'PASS: ...'. Not for production (inserts, then rolls back, auth.users rows).
-- (This file does not test the migration's own pre-flight abort — that needs pre-existing
-- duplicate rows, which the indexes now prevent; it is a plain aggregate over profiles.)
--
-- Cases:
--   1. same display_name, different case / outer spaces, other account          -> refused (friendly)
--   2. same pen_name, likewise                                                   -> refused (friendly)
--   3. display_name equal to someone else's pen_name (and vice versa)            -> allowed (per column)
--   4. own row: unchanged re-save, recasing own name, display_name = own pen_name -> allowed
--   5. null / blank names on many rows                                           -> allowed
--   6. two 'Writer <8 hex>' placeholder names                                    -> allowed (exempt)
--   7. the indexes themselves, with the friendly trigger switched off            -> refused (23505)
-- ============================================================================================

begin;

create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_user::text, ''), true);
  perform set_config('request.jwt.claims',
    case when p_user is null then '' else json_build_object('sub', p_user, 'role', 'authenticated')::text end, true);
end;
$$;

create function pg_temp.expect_error(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm like p_pattern then
      return;
    end if;
    raise exception 'FAIL: expected an error like "%" but got: %', p_pattern, sqlerrm;
  end;
  raise exception 'FAIL: expected an error like "%" but the call succeeded', p_pattern;
end;
$$;

do $$
declare
  a uuid := gen_random_uuid();
  b uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  v text;
begin
  insert into auth.users (id) values (a), (b), (c);   -- handle_new_user() seeds 'Writer <id8>' for each

  -- Account A takes its names.
  perform pg_temp.act_as(a);
  update profiles set display_name = 'Jane Austen', pen_name = 'J. Austen' where id = a;

  -- 1. display_name collisions from another account: case and outer-space variants.
  perform pg_temp.act_as(b);
  foreach v in array array['Jane Austen', 'jane austen', 'JANE AUSTEN', '  Jane Austen  '] loop
    perform pg_temp.expect_error(format('update profiles set display_name = %L where id = %L', v, b), '%display name is already taken%');
  end loop;
  -- ...also when sent the way syncProfile sends it (every column at once).
  perform pg_temp.expect_error(
    format('update profiles set display_name = %L, pen_name = null, avatar_url = null, updated_at = now() where id = %L', 'jane AUSTEN', b),
    '%display name is already taken%');
  if (select display_name from profiles where id = b) <> 'Writer ' || substr(b::text, 1, 8) then
    raise exception 'FAIL (1): a refused update still changed B''s row';
  end if;

  -- 2. pen_name collisions.
  foreach v in array array['J. Austen', 'j. austen', ' J. AUSTEN '] loop
    perform pg_temp.expect_error(format('update profiles set pen_name = %L where id = %L', v, b), '%pen name is already taken%');
  end loop;

  -- 3. Per column: B may use A's PEN name as its DISPLAY name, and A's DISPLAY name as its PEN name.
  update profiles set display_name = 'J. Austen' where id = b;
  update profiles set pen_name = 'Jane Austen' where id = b;
  -- ...but the reverse of case 1 still holds: A can't take B's display name.
  perform pg_temp.act_as(a);
  perform pg_temp.expect_error(format('update profiles set display_name = %L where id = %L', 'j. austen', a), '%display name is already taken%');

  -- 4. Own row: unchanged re-save, recasing, and display_name = own pen_name (account C).
  update profiles set display_name = 'Jane Austen', pen_name = 'J. Austen', avatar_url = null, updated_at = now() where id = a;
  update profiles set display_name = 'JANE AUSTEN' where id = a;
  perform pg_temp.act_as(c);
  update profiles set pen_name = 'Cee Writer' where id = c;
  update profiles set display_name = 'Cee Writer' where id = c;
  update profiles set display_name = 'Cee Writer', pen_name = 'Cee Writer', updated_at = now() where id = c;

  -- 5. Null / blank names never collide, however many rows have them.
  update profiles set display_name = '', pen_name = null where id = c;
  perform pg_temp.act_as(b);
  update profiles set display_name = '', pen_name = null where id = b;
  perform pg_temp.act_as(a);
  update profiles set display_name = '   ', pen_name = '' where id = a;

  -- 6. handle_new_user()'s placeholder shape is exempt (two sign-ups could share the same 8 hex digits).
  update profiles set display_name = 'Writer 1a2b3c4d' where id = a;
  perform pg_temp.act_as(b);
  update profiles set display_name = 'Writer 1a2b3c4d' where id = b;

  -- 7. The indexes are the real guarantee: switch the friendly trigger off and collide directly.
  alter table profiles disable trigger validate_unique_profile_names_trigger;
  perform pg_temp.act_as(a);
  update profiles set display_name = 'Index Test Name', pen_name = 'Index Test Pen' where id = a;
  perform pg_temp.expect_error(
    format('update profiles set display_name = %L where id = %L', 'index test name', b),
    '%duplicate key value violates unique constraint "profiles_display_name_lower_unique"%');
  perform pg_temp.expect_error(
    format('update profiles set pen_name = %L where id = %L', ' INDEX TEST PEN', b),
    '%duplicate key value violates unique constraint "profiles_pen_name_lower_unique"%');
  alter table profiles enable trigger validate_unique_profile_names_trigger;

  raise notice 'PASS: migration 142 — profile names are unique per column, case-insensitively, without touching blanks, placeholders or own rows';
end;
$$;

rollback;
