# supabase/history/

This is the original, phase-by-phase development record: `schema_phase1.sql` (originally just
`schema.sql`) through `schema_phase9.sql`, plus every `NN_migration_*.sql` file written to
upgrade a deployment that had already run an earlier phase.

**A fresh install doesn't need anything in this folder.** Run `supabase/schema.sql` instead —
it's the same end state as running every file in here in order, consolidated into one file, one
run. This folder exists for two reasons only:

1. **You already have a live Inkroot deployment** that ran these phase files before the
   consolidated `schema.sql` existed. Don't run the consolidated file against it — it will
   collide with tables you already have. Keep applying `NN_migration_*.sql` files here in
   numbered order instead, exactly as before. See the main `README.md`'s "Upgrading an existing
   deployment" section.
2. **You want the "why"** behind a specific policy or column — several files here (especially
   `08_migration_founder_guild_membership.sql`, `12_migration_split_private_media_bucket.sql`,
   and `13_migration_server_authoritative_kv_versioning.sql`) document a real bug that was found
   and fixed, in more narrative detail than the consolidated `schema.sql`'s comments carry
   forward. If you're wondering "why does this policy check membership twice" or "why does this
   bucket exist," the migration that introduced it is usually the fastest answer.

Once every live deployment has been fully migrated through `23_migration_...sql` at least once,
this folder stops being load-bearing for anything except reason #2 above.
