-- Fixes: Phase 9's storage bucket select policy was `using (bucket_id = 'media')` -- public read
-- on every object in the bucket, regardless of folder. That's the right call for
-- avatars/guild-crests/book-covers, which are meant to be public. It's not the right call for
-- 'project-images' (character portraits, location photos, map backgrounds), added in Phase 10 --
-- those belong to a project's own JSON in kv_store, which is private by default everywhere else
-- in this app (see schema.sql's RLS). Any writer's unpublished, in-manuscript images were
-- reachable by anyone who obtained the object's URL, defeating the app's own private-by-default
-- model for draft content. Object paths include a random filename suffix, so this wasn't openly
-- browsable, but that's obscurity, not access control.
--
-- Fix: narrow the bucket's select policy to be folder-aware. Public folders (avatars,
-- guild-crests, book-covers) keep public read. 'project-images' becomes owner-only, matching this
-- table's own insert/update/delete policies, which were already scoped to the uploader.
--
-- Consequence for existing data: any 'project-images' object's previously-public URL stops
-- resolving once this runs (the client gets a 403 from Storage instead of the image) -- that's
-- the point, not a bug. The updated client (see mediaStorage.js) reads this folder via a
-- short-lived signed URL instead of a public one going forward. A project whose image fields
-- still hold an old public URL will show a broken image until that field is re-saved (re-picking
-- or re-uploading the same photo triggers a fresh upload + a working signed URL); nothing server
-- side can regenerate a signed URL for a client that hasn't been updated to ask for one.
--
-- Safe to run more than once: policies are dropped before being recreated.
--
-- NOTE, added later: this migration's fix doesn't actually work. 'media' was created with
-- `public = true` (schema_phase9.sql), and a public bucket serves every object in it through an
-- unauthenticated public route that never consults storage.objects RLS at all -- so the
-- folder-scoped select policy below never restricted anything in practice; 'project-images'
-- objects stayed reachable by anyone with the URL the whole time. See
-- 12_migration_split_private_media_bucket.sql for the actual fix (a separate, non-public bucket).
-- This file is kept as-is for history/deployments mid-upgrade; run 12 as well.

begin;

drop policy if exists "anyone can read media" on storage.objects;
drop policy if exists "anyone can read public media" on storage.objects;
drop policy if exists "a writer reads their own project images" on storage.objects;

create policy "anyone can read public media" on storage.objects
  for select using (
    bucket_id = 'media' and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
  );

create policy "a writer reads their own project images" on storage.objects
  for select using (
    bucket_id = 'media' and (storage.foldername(name))[1] = 'project-images'
    and auth.uid()::text = (storage.foldername(name))[2]
  );

commit;
