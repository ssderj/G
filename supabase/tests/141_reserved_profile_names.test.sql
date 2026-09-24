-- ============================================================================================
-- Test for migration 141 (supabase/history/141_migration_profile_reserved_name_trigger.sql)
-- — reserved display_name / pen_name are refused by the database itself.
--
-- How to run: same as supabase/tests/140_...: against a scratch/dev database with
-- supabase/schema.sql applied through migration 141, as a role that bypasses RLS (postgres), in
-- the SQL editor or `psql -f`. One transaction that ROLLS BACK at the end; a failing case raises
-- 'FAIL: ...' and aborts; a clean run ends with 'PASS: ...'. Not for production (inserts, then
-- rolls back, auth.users rows).
--
-- The trigger keys off auth.uid(), so each case first "signs in" by setting the same jwt claims
-- Supabase's API layer would (act_as below); the UPDATE itself is then exactly what
-- supabase.from('profiles').update({ ... }).eq('id', me) runs.
--
-- Cases:
--   1. reserved display_name / pen_name variants, direct UPDATE as the owner   -> refused
--   2. ordinary names, near-misses, null, blank                                 -> allowed
--   3. accented variant ('Ínkroot')                                             -> allowed (documents
--      parity with is_reserved_guild_name(): no accent folding server-side; NOT a claim it's safe)
--   4. INSERT of a profile row with a reserved name (signed in)                 -> refused
--   5. a row that ALREADY holds a reserved name: unrelated columns / unchanged
--      names can still be saved; changing to another reserved name cannot       -> as described
--   6. no signed-in user (SQL editor / service role) may set a reserved name    -> allowed
--
-- Not executed when this file was written (no Postgres available in that session) — run it once
-- against a dev database before relying on it.
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
  u uuid := gen_random_uuid();          -- ordinary signed-in writer
  u_old uuid := gen_random_uuid();      -- already holds a reserved name (set as an operator)
  u_ins uuid := gen_random_uuid();      -- profile row deleted, then re-inserted as the user
  v text;
  v_display text;
  v_pen text;
begin
  insert into auth.users (id) values (u), (u_old), (u_ins);  -- handle_new_user() adds the profiles

  -- 1. Reserved names, on both columns, including the evasions the normalization exists for.
  perform pg_temp.act_as(u);
  foreach v in array array['Inkroot Support', '1nkr00t  suppOrt!', 'ADMIN', 'System', 'Ink-Root Team', 'Official', 'inkroot'] loop
    perform pg_temp.expect_error(format('update profiles set display_name = %L where id = %L', v, u), '%That name isn''t available.%');
    perform pg_temp.expect_error(format('update profiles set pen_name = %L where id = %L', v, u), '%That name isn''t available.%');
  end loop;
  -- ...including the shape syncProfile() actually sends (every column, every save).
  perform pg_temp.expect_error(
    format('update profiles set display_name = %L, pen_name = %L, avatar_url = null, updated_at = now() where id = %L', 'Fine Name', 'Inkroot Support', u),
    '%That name isn''t available.%');
  select display_name, pen_name into v_display, v_pen from profiles where id = u;
  if v_display <> 'Writer ' || substr(u::text, 1, 8) or v_pen is not null then
    raise exception 'FAIL (1): a refused update still changed the row (display_name=%, pen_name=%)', v_display, v_pen;
  end if;

  -- 2. Ordinary and near-miss names, null, blank -> allowed (lookalikes stay a client-side soft warning).
  foreach v in array array['Jane Austen', 'Inkroot Fan', 'Support Group Sam', 'Modesty Blaise', 'Admiral Ackbar'] loop
    execute format('update profiles set display_name = %L, pen_name = %L where id = %L', v, v, u);
  end loop;
  update profiles set pen_name = null where id = u;
  update profiles set display_name = '' where id = u;
  update profiles set display_name = 'Jane Austen', pen_name = 'J. Austen', avatar_url = null, updated_at = now() where id = u;

  -- 3. Accent variant: documents the deliberate parity with is_reserved_guild_name() (no folding).
  update profiles set display_name = 'Ínkroot' where id = u;
  if (select display_name from profiles where id = u) <> 'Ínkroot' then
    raise exception 'FAIL (3): expected the accented variant to pass (guild-check parity); the trigger now folds accents — update this test and the migration header';
  end if;

  -- 4. INSERT path, signed in.
  delete from profiles where id = u_ins;
  perform pg_temp.act_as(u_ins);
  perform pg_temp.expect_error(
    format('insert into profiles (id, display_name) values (%L, %L)', u_ins, 'Inkroot Support'),
    '%That name isn''t available.%');
  perform pg_temp.expect_error(
    format('insert into profiles (id, pen_name) values (%L, %L)', u_ins, 'Staff'),
    '%That name isn''t available.%');
  insert into profiles (id, display_name) values (u_ins, 'Ordinary Writer');
  if not exists (select 1 from profiles where id = u_ins and display_name = 'Ordinary Writer') then
    raise exception 'FAIL (4): an ordinary insert was refused';
  end if;

  -- 5. A row that already holds a reserved name (set by an operator, i.e. with no signed-in user).
  perform pg_temp.act_as(null);
  update profiles set display_name = 'Inkroot Team' where id = u_old;
  perform pg_temp.act_as(u_old);
  update profiles set avatar_url = 'https://example.com/a.png', motto = 'still me', updated_at = now() where id = u_old;
  update profiles set display_name = 'Inkroot Team', pen_name = null where id = u_old;   -- unchanged value re-sent, as syncProfile does
  perform pg_temp.expect_error(
    format('update profiles set display_name = %L where id = %L', 'Inkroot Staff', u_old),
    '%That name isn''t available.%');
  update profiles set display_name = 'Someone Else Entirely' where id = u_old;            -- moving away is fine

  -- 6. No signed-in user (SQL editor / service role): the official account can be named.
  perform pg_temp.act_as(null);
  update profiles set display_name = 'Inkroot Team' where id = u;
  if (select display_name from profiles where id = u) <> 'Inkroot Team' then
    raise exception 'FAIL (6): an operator (no signed-in user) could not set a reserved name';
  end if;

  raise notice 'PASS: migration 141 — reserved profile names are refused for signed-in users, and nothing else changed';
end;
$$;

rollback;
