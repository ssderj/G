-- Fixes: schema_phase9.sql's bucket insert had no file_size_limit / allowed_mime_types --
-- nothing server-side stopped an upload beyond the ~1.2MB cap image-utils.jsx enforces client-side
-- (MAX_IMAGE_DATA_URL_BYTES), which only holds for someone going through the app's own upload UI.
-- The anon key plus a valid session is all that's needed to call storage.upload() directly with
-- an arbitrarily large file, or one that isn't an image at all.
--
-- `insert ... on conflict (id) do nothing` in schema_phase9.sql means a fresh install picks up
-- these caps automatically, but does nothing for a bucket row that already exists from an earlier
-- deployment -- this migration is that update, for deployments that already ran the original
-- version of schema_phase9.sql.
--
-- Same values as the fresh-install version: 5MB (a generous multiple of the client's own
-- ~1.2MB ceiling, headroom without being effectively unbounded), and exactly the mime types
-- uploadImageDataUrl (mediaStorage.js) can ever actually produce -- see that migration's/
-- schema_phase9.sql's own comment for why.
--
-- Safe to run more than once: a plain `update`, not additive.

begin;

update storage.buckets
set file_size_limit = 5242880,
    allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'media';

commit;
