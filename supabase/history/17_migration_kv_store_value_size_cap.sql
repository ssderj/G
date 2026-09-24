-- kv_store had no size limit on `value` at all, unlike the Storage buckets further down this
-- file (5MB file-size cap, added by 10_migration_bound_media_bucket_uploads.sql). A kv_store row
-- can legitimately hold an entire project — manuscript text plus, per image-utils.jsx's
-- readLocalImageFile, possibly several ~1.2MB base64 fallback images if a Storage upload ever
-- failed or the writer was offline when adding one — but nothing bounded how large a single row
-- could get beyond that. A buggy or malicious client could push an arbitrarily large `value`
-- with nothing server-side to stop it.
--
-- Fix: cap a single row's `value` at 20MB — a generous multiple of both the Storage buckets' 5MB
-- cap and the client's own ~1.2MB per-image ceiling, enough headroom for a large project with
-- several embedded fallback images plus its own text and metadata. Checked via
-- octet_length(value::text) rather than pg_column_size(value), so this bounds the actual JSON
-- text size the sync engine pushes/pulls over the wire, not whatever TOAST compression happens
-- to shrink it to on disk.
--
-- **Before running this**: adding a CHECK constraint validates every existing row against it, so
-- if any writer already has a project (or other key) over 20MB, this migration will fail outright
-- until that's addressed — it does NOT delete or truncate anything on its own, unlike
-- 16_migration_guild_book_feedback_uniqueness.sql's dedup step, since a kv_store row is a
-- writer's actual manuscript and silently deleting or shrinking it is never the right call. Run
-- the query below first to check:
--
--   select user_id, key, octet_length(value::text) as bytes
--   from kv_store
--   where octet_length(value::text) > 20971520
--   order by bytes desc;
--
-- If that returns rows, either raise the cap below to fit them, or reach out to those writers to
-- ask them to shrink the project first (Settings → Optimize Images re-compresses embedded
-- fallback images in place — see image-utils.jsx's optimizeProjectImages) before you run this.
--
-- Safe to run anytime once no existing row exceeds the cap; idempotent (guarded by an existence
-- check against pg_constraint, since Postgres has no `add constraint if not exists`).

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'kv_store_value_size_check'
  ) then
    alter table kv_store
      add constraint kv_store_value_size_check
      check (octet_length(value::text) <= 20971520);
  end if;
end $$;
