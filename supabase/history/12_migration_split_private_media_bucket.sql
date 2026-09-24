-- Fixes: 09_migration_scope_project_media_private.sql narrowed the 'media' bucket's SELECT
-- policy so 'project-images' reads require auth.uid() to match the uploader -- but 'media' itself
-- was created with `public = true` (schema_phase9.sql). A public bucket serves every object in it
-- through Storage's public route (`/storage/v1/object/public/media/<path>`), which does NOT
-- consult storage.objects RLS at all -- that route exists specifically to skip authorization.
-- RLS on storage.objects only governs the authenticated/signed-URL routes. So the "owner-only"
-- policy on 'project-images' was never actually enforced: any writer's in-manuscript character
-- portraits, location photos, or map backgrounds were (and, until this migration finishes,
-- still are) fetchable by anyone who has or guesses the object path, signed in or not -- the
-- random filename suffix is obscurity, not access control, same as the gap
-- 09_migration_scope_project_media_private.sql thought it had already closed.
--
-- Fix: 'project-images' moves to its own bucket, 'media-private', created with `public = false`.
-- A non-public bucket has no public route at all -- every read genuinely goes through RLS.
-- avatars/guild-crests/book-covers stay in 'media' (public is the correct, intended behavior for
-- those -- they back public-facing UI). 'media' also stops accepting writes under
-- 'project-images/' going forward, so the vulnerable path can't be reopened by a client (or a
-- direct API call) writing there again.
--
-- Path convention is unchanged (still `project-images/<user_id>/<filename>`) -- only the bucket
-- changes -- so this is a bucket move, not a path redesign.
--
-- IMPORTANT -- this migration only fixes where NEW uploads go and closes the write path on the
-- old bucket. It does NOT move any 'project-images' objects that already exist under the old
-- 'media' bucket -- storage.objects only tracks metadata; the underlying bytes live in the
-- storage backend keyed by (bucket, path), and no plain SQL statement can relocate them. Existing
-- objects there remain reachable via the old public route until they are actually moved. See
-- scripts/move-project-images-to-private-bucket.mjs (added alongside this migration) to copy
-- every existing 'project-images' object from 'media' into 'media-private' and remove the old
-- copy -- run that once, with the project's service role key, before (or immediately after)
-- applying this migration. The application code (mediaStorage.js) already treats any
-- 'project-images' path as belonging to 'media-private' when it next signs a URL for it, so once
-- an object has been copied over by that script, refreshProjectImageUrls' normal half-life
-- refresh (see mediaStorage.js) picks up the new, actually-private location automatically -- no
-- per-project manual re-save needed, unlike the previous migration's consequence.
--
-- Safe to run more than once: bucket creation is `on conflict do nothing`, and every policy is
-- dropped before being recreated.

begin;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-private', 'media-private', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- ---------- New bucket: 'media-private' (project-images only, genuinely owner-only) ----------

drop policy if exists "a writer reads their own private media" on storage.objects;
create policy "a writer reads their own private media" on storage.objects
  for select using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer uploads their own private media" on storage.objects;
create policy "a writer uploads their own private media" on storage.objects
  for insert with check (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer updates their own private media" on storage.objects;
create policy "a writer updates their own private media" on storage.objects
  for update using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer deletes their own private media" on storage.objects;
create policy "a writer deletes their own private media" on storage.objects
  for delete using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

-- ---------- Old bucket: 'media' -- drop the (never-actually-enforced) project-images select
-- policy, and stop accepting writes under that folder there so the gap can't reopen ----------

drop policy if exists "a writer reads their own project images" on storage.objects;

drop policy if exists "a writer uploads their own media" on storage.objects;
create policy "a writer uploads their own media" on storage.objects
  for insert with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer updates their own media" on storage.objects;
create policy "a writer updates their own media" on storage.objects
  for update using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer deletes their own media" on storage.objects;
create policy "a writer deletes their own media" on storage.objects
  for delete using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

-- 'anyone can read public media' (avatars/guild-crests/book-covers) is untouched -- still correct.

commit;
