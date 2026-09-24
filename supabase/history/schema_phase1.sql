-- Phase 1: a generic key-value sync table mirroring the app's existing local storage keys
-- (e.g. 'inkroot:project:<id>', 'inkroot:writerProfile', 'inkroot:achievements', ...). This
-- lets every existing storage.get/set/delete call in the app sync without redesigning the
-- data model yet. Phase 2/3 introduce proper relational tables (published_books, reviews,
-- guilds, ...) alongside this one, once specific features need real queries across users.
--
-- `version` and `updated_at` are both server-authoritative -- see the stamp_kv_store trigger
-- below. Neither column is ever set from a client-supplied value: the trigger overwrites
-- whatever a client sends (including omitting them entirely) with its own now() and an
-- incremented counter. This is what src/lib/syncEngine.js's conflict resolution (last-write-wins)
-- is actually keyed on -- see that file's own comments for why a wall-clock `updated_at` set by
-- whichever device happens to be pushing can't be trusted for that on its own (clock skew between
-- devices means an older edit from a fast-clocked device can incorrectly "win"), while a single
-- server-side counter, incremented by the one database every device pushes through, can't skew.
create table if not exists kv_store (
  user_id uuid not null references auth.users(id) on delete cascade,
  key text not null,
  value jsonb,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  deleted boolean not null default false,
  primary key (user_id, key)
);

-- Row Level Security: every writer can only ever read/write their own rows. Critical since
-- this table holds everyone's private manuscripts.
alter table kv_store enable row level security;

create policy "select own rows" on kv_store
  for select using (auth.uid() = user_id);

create policy "insert own rows" on kv_store
  for insert with check (auth.uid() = user_id);

create policy "update own rows" on kv_store
  for update using (auth.uid() = user_id);

create policy "delete own rows" on kv_store
  for delete using (auth.uid() = user_id);

-- Supports the sync engine's incremental pull (see src/lib/syncEngine.js: pullRemote()),
-- which only asks for rows changed since the last successful sync rather than the whole table.
create index if not exists kv_store_user_updated_idx on kv_store (user_id, updated_at);

-- Forces version/updated_at to be server-authoritative on every write, regardless of what a
-- client sends for those columns (a plain insert/upsert from supabase-js simply omits them now --
-- see syncEngine.js -- but the trigger would override them even if a client tried to set them
-- directly, which also closes off a client spoofing its own version number to win every future
-- conflict). version starts at 1 on insert and increments by exactly 1 on every update; there is
-- no path for a client to set it to an arbitrary number.
create or replace function stamp_kv_store()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    new.version := 1;
  else
    new.version := old.version + 1;
  end if;
  return new;
end;
$$;

drop trigger if exists kv_store_stamp on kv_store;
create trigger kv_store_stamp
  before insert or update on kv_store
  for each row execute function stamp_kv_store();
