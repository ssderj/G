-- The list of folders allowed inside the public 'media' bucket ('avatars', 'guild-crests',
-- 'book-covers') was repeated as a literal array in all four of that bucket's RLS policies
-- (select/insert/update/delete) instead of living in one place. That list is security-relevant,
-- not just a convenience — 'media' is a public bucket, so any folder it allows becomes
-- world-readable through Storage's public route regardless of RLS (see the header comment above
-- the bucket definitions) — so four hand-copied literals were four chances for one of them to
-- drift from the others as folders get added or renamed over time.
--
-- Fix: a single `is_public_media_folder(folder text) returns boolean` function, referenced by
-- all four policies instead of each repeating the array. No behavior changes for any existing
-- object or policy decision — this is a pure refactor of how the same four policies are
-- expressed, not a change to what they allow.
--
-- Safe to run anytime; idempotent (`create or replace function` and `drop policy if exists` both
-- tolerate a repeat run).

create or replace function is_public_media_folder(folder text)
returns boolean
language sql
immutable
as $$
  select folder in ('avatars', 'guild-crests', 'book-covers');
$$;

drop policy if exists "anyone can read public media" on storage.objects;
create policy "anyone can read public media" on storage.objects
  for select using (
    bucket_id = 'media' and is_public_media_folder((storage.foldername(name))[1])
  );

drop policy if exists "a writer uploads their own media" on storage.objects;
create policy "a writer uploads their own media" on storage.objects
  for insert with check (
    bucket_id = 'media'
    and is_public_media_folder((storage.foldername(name))[1])
    and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer updates their own media" on storage.objects;
create policy "a writer updates their own media" on storage.objects
  for update using (
    bucket_id = 'media'
    and is_public_media_folder((storage.foldername(name))[1])
    and auth.uid()::text = (storage.foldername(name))[2]
  );

drop policy if exists "a writer deletes their own media" on storage.objects;
create policy "a writer deletes their own media" on storage.objects
  for delete using (
    bucket_id = 'media'
    and is_public_media_folder((storage.foldername(name))[1])
    and auth.uid()::text = (storage.foldername(name))[2]
  );
