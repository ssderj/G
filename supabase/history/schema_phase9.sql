-- Phase 9: Storage buckets for user-uploaded images (avatars, guild crests, book covers, and --
-- once Phase 10 starts using this for them -- in-manuscript character portraits, location
-- photos, and map backgrounds), replacing the base64 data URLs previously stored directly in
-- profiles.avatar_url, player_guilds.crest_url, guild_published_books.cover, and (for Phase 10's
-- additions) each project's own kv_store JSON. Those columns/rows are publicly (or, for
-- kv_store, strictly privately-) readable, so every fetch was pulling a several-hundred-KB
-- inline blob with no CDN, no resizing, and no per-object size cap enforced server-side. A row
-- now holds a short URL instead of the image itself.
--
-- Object path convention: <folder>/<user_id>/<filename>, e.g.
-- avatars/3fa85f64-.../1719345678-ab12cd.jpg.
--
-- Two buckets, not one, split by whether the folder is meant to be public:
--   'media'         -- avatars | guild-crests | book-covers. Meant to be public, matching the
--                       (public) columns they replace, so this bucket is created with
--                       `public = true` and gets a public-read policy.
--   'media-private'  -- project-images only. These images belong to a project's own kv_store
--                       row, which is private by default (see schema.sql's RLS), so this bucket
--                       is created with `public = false`. A public bucket in Supabase Storage
--                       serves every object in it through an unauthenticated public route
--                       regardless of any RLS policy on storage.objects -- that route exists
--                       specifically to bypass authorization -- so putting project-images in the
--                       *same* public bucket as the others (as an earlier version of this file
--                       did, gated only by a folder-scoped RLS select policy) never actually
--                       made those images private; RLS on storage.objects doesn't apply to a
--                       public bucket's public route at all. A genuinely non-public bucket is
--                       the only way to make owner-only RLS meaningful here. The app reads this
--                       bucket back via a signed URL (see mediaStorage.js) rather than a public
--                       one. Every write policy still only checks the <user_id> segment, same as
--                       before.
--
-- This file originally shipped as one all-public bucket, then as one bucket with a folder-scoped
-- select policy that looked like it made project-images private but didn't (see the note above).
-- See 12_migration_split_private_media_bucket.sql for moving a deployment that ran either
-- earlier version onto this two-bucket layout, including the one-time object move a plain SQL
-- migration can't do by itself.

-- Size/type caps: nothing server-side enforced either before this line existed -- the ~1.2MB
-- client-side cap in image-utils.jsx (MAX_IMAGE_DATA_URL_BYTES) only holds for someone going
-- through the app's own upload UI; the anon key + a valid session is all that's needed to call
-- storage.upload() directly with an arbitrarily large or non-image file. 5MB is a generous
-- multiple of the client's own ~1.2MB ceiling (headroom for future callers that compress less
-- aggressively) without leaving the cap effectively unbounded. Mime types are capped to exactly
-- what uploadImageDataUrl (mediaStorage.js) can ever actually produce: dataUrlToBlob's mime comes
-- straight from a canvas.toDataURL() call in image-utils.jsx, which is only ever asked for
-- 'image/png' or 'image/jpeg' (see extensionForMime/keepPng in each file) -- 'image/webp' is
-- allowed here too since some browsers honor a webp toDataURL request, but nothing else ever
-- leaves the client.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media', 'media', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('media-private', 'media-private', false, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do nothing;

-- 'media' only ever holds avatars/guild-crests/book-covers (project-images lives in
-- 'media-private' instead -- see the header note above), so read is a blanket "anyone can read
-- the bucket" restricted to those three folders, matching the "anyone can read" reasoning of the
-- profiles/guild_published_books columns these URLs replace.
create policy "anyone can read public media" on storage.objects
  for select using (
    bucket_id = 'media' and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
  );

-- storage.foldername(name) splits an object path into its folder segments (excluding the
-- filename). For '<folder>/<user_id>/<filename>' that's index 2 -- index 1 is <folder> itself.
-- Restricted to the three public folders so a client can't write into 'media' under a
-- 'project-images/' path and land in the wrong (public) bucket for that content.
create policy "a writer uploads their own media" on storage.objects
  for insert with check (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "a writer updates their own media" on storage.objects
  for update using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "a writer deletes their own media" on storage.objects
  for delete using (
    bucket_id = 'media'
    and (storage.foldername(name))[1] in ('avatars', 'guild-crests', 'book-covers')
    and auth.uid()::text = (storage.foldername(name))[2]
  );

-- 'media-private' holds only 'project-images/<user_id>/<filename>'. Unlike 'media', this bucket
-- has `public = false`, so these RLS policies are the *only* way to read/write an object here --
-- there is no public route to bypass them (see the header note above for why that distinction is
-- the whole point of this bucket existing).
create policy "a writer reads their own private media" on storage.objects
  for select using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "a writer uploads their own private media" on storage.objects
  for insert with check (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "a writer updates their own private media" on storage.objects
  for update using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );

create policy "a writer deletes their own private media" on storage.objects
  for delete using (
    bucket_id = 'media-private' and auth.uid()::text = (storage.foldername(name))[2]
  );
