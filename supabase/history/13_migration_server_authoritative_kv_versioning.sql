-- Fixes: kv_store's `updated_at` was set from a client-supplied value on every write
-- (src/lib/syncEngine.js's pushOutbox: `updated_at: entry.updatedAt`, taken straight from
-- `new Date().toISOString()` on whichever device made the edit), and the sync engine's
-- last-write-wins conflict resolution compared that same client-supplied value against another
-- client-supplied value to decide whose edit survives. Two devices' clocks are never guaranteed
-- to agree -- a device with a clock running even a few minutes fast can push a genuinely older
-- edit that nonetheless carries a *later* timestamp than a real subsequent edit from a
-- correctly-clocked device, silently winning the conflict and discarding the newer edit for good.
-- There was also nothing stopping a client from just sending an arbitrary far-future
-- `updated_at` outright.
--
-- Fix: `updated_at` becomes server-authoritative -- a trigger stamps it with the database's own
-- `now()` on every insert/update, ignoring whatever (if anything) a client sends for that column.
-- A single server clock can't skew relative to itself, so this is safe to keep using for
-- pullRemote()'s incremental "changed since" filter.
--
-- Conflict resolution itself moves off wall-clock time entirely and onto a `version` counter,
-- also server-stamped by the same trigger (starts at 1 on insert, +1 on every update, no client
-- path to set it directly). The sync engine now tracks, per key, the version its last-known local
-- copy was based on (`baseVersion`, replacing the old `updatedAt` in the local outbox -- see
-- src/lib/idb.js/storage.js/syncEngine.js), and pushes via a version-matched conditional update:
-- if the remote version still matches what the local edit was based on, the push proceeds and
-- naturally increments the version; if the remote has since moved (another device pushed first),
-- the push is recognized as a real conflict regardless of either device's clock, and remote wins
-- (pulled locally, matching this table's existing no-per-field-merge behavior) -- same outcome
-- semantics as before, just detected correctly instead of by comparing two untrusted timestamps.
--
-- Existing rows: version defaults to 1, which is consistent with every existing row having been
-- written at least once already (an insert would have started it at 1 under the new trigger too).
--
-- Safe to run more than once: column addition and trigger creation are both guarded.

begin;

alter table kv_store add column if not exists version integer not null default 1;

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

commit;
