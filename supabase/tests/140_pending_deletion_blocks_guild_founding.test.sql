-- ============================================================================================
-- Test for migration 140 (supabase/history/140_migration_pending_deletion_blocks_guild_founding.sql)
-- — create_or_get_own_guild() vs. a pending account_deletions row.
--
-- How to run: against a scratch/dev database (a Supabase branch or local stack) that already has
-- supabase/schema.sql applied through migration 140, as a role that bypasses RLS (postgres, in
-- the SQL editor or `psql -f`). Everything happens inside one transaction that ROLLS BACK at the
-- end, so nothing is left behind — but don't point it at production anyway: it inserts (and then
-- rolls back) auth.users rows. A failing case raises 'FAIL: ...' and aborts the script; a clean
-- run ends with 'PASS: ...'.
--
-- Cases (the required behavior for migration 140):
--   1. pending deletion + owner editing their EXISTING guild            -> allowed
--   2. pending deletion + owner, DIFFERENT guild id                     -> refused (existing check)
--   3. pending deletion + no guild yet, founding a new guild            -> refused (new)
--   4. pending deletion + no guild yet, re-entering with the same id    -> refused (new)
--   5. deletion cancelled (row deleted) -> founding/re-entry allowed    -> allowed
--   6. a status = 'cancelled' row never blocks                          -> allowed
--   0. baseline: no deletion row at all                                 -> allowed
--
-- Not executed when this file was written (no Postgres available in that session) — run it
-- once against a dev database before relying on it.
-- ============================================================================================

begin;

-- Impersonates a signed-in caller the way Supabase does: auth.uid() reads the jwt claims.
create function pg_temp.act_as(p_user uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
end;
$$;

-- Runs p_sql and requires it to raise an error whose message matches p_pattern (a LIKE pattern).
-- The failed statement runs in a subtransaction, so it leaves no partial writes behind.
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
  u_owner uuid := gen_random_uuid();     -- already owns a guild when deletion is requested
  u_new uuid := gen_random_uuid();       -- owns no guild when deletion is requested
  u_cancelled uuid := gen_random_uuid(); -- has a status = 'cancelled' row only
  g_owner uuid := gen_random_uuid();
  g_owner_other uuid := gen_random_uuid();
  g_new uuid := gen_random_uuid();
  g_cancelled uuid := gen_random_uuid();
  v_name text;
begin
  insert into auth.users (id) values (u_owner), (u_new), (u_cancelled); -- handle_new_user() adds profiles

  -- 0. Baseline: no deletion row -> founding works exactly as before.
  perform pg_temp.act_as(u_owner);
  perform 1 from create_or_get_own_guild(g_owner, 'Test Guild ' || substr(u_owner::text, 1, 8), null, null);
  if not exists (select 1 from player_guilds where id = g_owner and owner_id = u_owner) then
    raise exception 'FAIL (0): baseline founding with no deletion request did not create the guild';
  end if;

  -- The owner now requests deletion (acknowledging the guild impact, as migration 79 requires).
  insert into account_deletions (user_id, scheduled_purge_at, status, acknowledges_owned_guild_impact)
  values (u_owner, now() + interval '30 days', 'pending', true);

  -- 1. Pending deletion + existing owner editing their own guild (same id) -> allowed.
  perform pg_temp.act_as(u_owner);
  perform 1 from create_or_get_own_guild(g_owner, 'Renamed Guild ' || substr(u_owner::text, 1, 8), 'a motto', null);
  select name into v_name from player_guilds where id = g_owner;
  if v_name is distinct from 'Renamed Guild ' || substr(u_owner::text, 1, 8) then
    raise exception 'FAIL (1): a guild owner with a pending deletion could not edit their existing guild (name is now %)', v_name;
  end if;

  -- 2. Pending deletion + owner trying a DIFFERENT guild id -> refused, and no second guild appears.
  perform pg_temp.expect_error(
    format('select * from create_or_get_own_guild(%L, %L, null, null)', g_owner_other, 'Second Guild ' || substr(u_owner::text, 1, 8)),
    '%already own a Player Guild%');
  if (select count(*) from player_guilds where owner_id = u_owner) <> 1 then
    raise exception 'FAIL (2): a second guild was created for an owner with a pending deletion';
  end if;

  -- 3. Pending deletion + no guild yet, founding a new one -> refused, no guild row created.
  insert into account_deletions (user_id, scheduled_purge_at, status)
  values (u_new, now() + interval '30 days', 'pending');
  perform pg_temp.act_as(u_new);
  perform pg_temp.expect_error(
    format('select * from create_or_get_own_guild(%L, %L, null, null)', g_new, 'New Guild ' || substr(u_new::text, 1, 8)),
    '%account deletion is pending%');
  if exists (select 1 from player_guilds where owner_id = u_new) then
    raise exception 'FAIL (3): a guild was founded while the account had a pending deletion';
  end if;
  if exists (select 1 from player_guild_members where user_id = u_new) then
    raise exception 'FAIL (3): a guild membership row was created while the account had a pending deletion';
  end if;

  -- 4. Same caller retrying with the SAME id (re-entry of a founding that never reached the server).
  perform pg_temp.expect_error(
    format('select * from create_or_get_own_guild(%L, %L, null, null)', g_new, 'New Guild ' || substr(u_new::text, 1, 8)),
    '%account deletion is pending%');
  if exists (select 1 from player_guilds where id = g_new) then
    raise exception 'FAIL (4): re-entering with the same id created the guild during a pending deletion';
  end if;

  -- 5. Deletion cancelled (cancelAccountDeletion() deletes the row) -> founding/re-entry works again.
  delete from account_deletions where user_id = u_new;
  perform pg_temp.act_as(u_new);
  perform 1 from create_or_get_own_guild(g_new, 'New Guild ' || substr(u_new::text, 1, 8), null, null);
  if not exists (select 1 from player_guilds where id = g_new and owner_id = u_new) then
    raise exception 'FAIL (5): founding still refused after the deletion request was cancelled';
  end if;

  -- 6. A row whose status is 'cancelled' (not pending) must not block either.
  insert into account_deletions (user_id, scheduled_purge_at, status)
  values (u_cancelled, now() + interval '30 days', 'cancelled');
  perform pg_temp.act_as(u_cancelled);
  perform 1 from create_or_get_own_guild(g_cancelled, 'Cancelled Guild ' || substr(u_cancelled::text, 1, 8), null, null);
  if not exists (select 1 from player_guilds where id = g_cancelled and owner_id = u_cancelled) then
    raise exception 'FAIL (6): a status = ''cancelled'' account_deletions row blocked founding';
  end if;

  raise notice 'PASS: migration 140 — all create_or_get_own_guild / pending-deletion cases behaved as required';
end;
$$;

rollback;
