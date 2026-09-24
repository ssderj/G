// One-time data move for 12_migration_split_private_media_bucket.sql.
//
// That migration creates the new 'media-private' bucket and its RLS policies, and stops the old
// 'media' bucket from accepting new 'project-images/' writes -- but it can't move any
// 'project-images' objects that were already uploaded to 'media' before this fix. storage.objects
// is only a metadata table; the actual bytes live in the storage backend keyed by (bucket, path),
// and no SQL statement can relocate them. This script does that move using the Storage API
// instead: download each existing 'project-images' object from 'media', upload it to the same
// path in 'media-private', verify the copy, then remove the original from 'media'.
//
// Run this ONCE, after applying 12_migration_split_private_media_bucket.sql. Safe to re-run --
// it skips any path that no longer exists in 'media' (already moved) and is idempotent per
// object (upload uses upsert so a re-run overwrites rather than duplicating).
//
// Requires the project's SERVICE ROLE key (not the anon key) -- listing/reading every writer's
// objects and writing into another writer's folder needs to bypass RLS, which only a service
// role key can do. Never commit this key or run this script from a client. Usage:
//
//   SUPABASE_URL=https://your-project.supabase.co \
//   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key \
//   node scripts/move-project-images-to-private-bucket.mjs
//
// After this finishes, existing projects heal themselves automatically the next time each is
// opened: getFreshProjectImageUrl (src/lib/mediaStorage.js) always signs 'project-images' paths
// against 'media-private', so the next half-life refresh picks up the moved object and patches
// the project's stored URL via applyImageUrlPatches -- no manual per-project re-save needed.

import { createClient } from '@supabase/supabase-js';

const SOURCE_BUCKET = 'media';
const DEST_BUCKET = 'media-private';
const FOLDER = 'project-images';
const PAGE_SIZE = 100;

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running this script.');
  process.exit(1);
}

const supabase = createClient(url, serviceKey);

// Storage's list() is per-folder, not recursive, so this walks one level (project-images/<uid>/)
// at a time: first list the user-id subfolders under project-images/, then list each one's files.
async function listAllObjectPaths() {
  const paths = [];
  let userOffset = 0;
  for (;;) {
    const { data: userFolders, error } = await supabase.storage
      .from(SOURCE_BUCKET)
      .list(FOLDER, { limit: PAGE_SIZE, offset: userOffset });
    if (error) throw error;
    if (!userFolders || userFolders.length === 0) break;

    for (const entry of userFolders) {
      // A real subfolder (a user id) has no id/metadata of its own in the listing; a file does.
      if (entry.id) continue; // stray file directly under project-images/ -- shouldn't happen, skip
      const userId = entry.name;
      let fileOffset = 0;
      for (;;) {
        const { data: files, error: fileErr } = await supabase.storage
          .from(SOURCE_BUCKET)
          .list(`${FOLDER}/${userId}`, { limit: PAGE_SIZE, offset: fileOffset });
        if (fileErr) throw fileErr;
        if (!files || files.length === 0) break;
        for (const f of files) {
          if (f.id) paths.push(`${FOLDER}/${userId}/${f.name}`);
        }
        if (files.length < PAGE_SIZE) break;
        fileOffset += PAGE_SIZE;
      }
    }

    if (userFolders.length < PAGE_SIZE) break;
    userOffset += PAGE_SIZE;
  }
  return paths;
}

async function movePath(path) {
  const { data: fileData, error: downloadErr } = await supabase.storage.from(SOURCE_BUCKET).download(path);
  if (downloadErr) {
    console.warn(`  skip (download failed): ${path}`, downloadErr.message);
    return false;
  }

  const { error: uploadErr } = await supabase.storage.from(DEST_BUCKET).upload(path, fileData, {
    contentType: fileData.type || 'application/octet-stream',
    upsert: true,
  });
  if (uploadErr) {
    console.warn(`  skip (upload to ${DEST_BUCKET} failed): ${path}`, uploadErr.message);
    return false;
  }

  const { error: removeErr } = await supabase.storage.from(SOURCE_BUCKET).remove([path]);
  if (removeErr) {
    // Copy already succeeded -- leaving the old copy in place is safe (just untidy), so warn
    // rather than treat this as a failed move.
    console.warn(`  copied but failed to remove original: ${path}`, removeErr.message);
  }
  return true;
}

async function main() {
  console.log(`Listing existing '${FOLDER}' objects in '${SOURCE_BUCKET}'...`);
  const paths = await listAllObjectPaths();
  console.log(`Found ${paths.length} object(s) to move.`);

  let moved = 0;
  for (const path of paths) {
    const ok = await movePath(path);
    if (ok) moved += 1;
  }

  console.log(`Done. Moved ${moved}/${paths.length} object(s) to '${DEST_BUCKET}'.`);
  if (moved < paths.length) {
    console.log('Re-run this script to retry any that were skipped above.');
  }
}

main().catch((e) => {
  console.error('Move failed:', e);
  process.exit(1);
});
