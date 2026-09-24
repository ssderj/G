-- Fixes a real gap in 21_migration_account_deletion_grace_period.sql's purge function: it cleaned
-- up kv_store, guild memberships, and follows, but never touched Supabase Storage. A deleted
-- account's uploaded avatar, guild crest, book cover, or private project images were left on disk
-- indefinitely — undermining the deletion the Privacy Policy promises. This replaces the whole
-- function (create or replace, so re-running this is always safe) with one that also deletes
-- every storage.objects row the purged user ever owned, across both the 'media' and
-- 'media-private' buckets.
--
-- Run this after 21_migration_account_deletion_grace_period.sql on any deployment that already
-- applied it.

create or replace function purge_expired_account_deletions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  rec record;
begin
  for rec in
    select user_id from account_deletions
    where status = 'pending' and scheduled_purge_at <= now()
  loop
    -- Blank the public-facing profile rather than deleting the row. See the block comment above
    -- for why every reader of this data already handles an empty name gracefully.
    update profiles
    set pen_name = null, display_name = null, avatar_url = null, updated_at = now()
    where id = rec.user_id;

    -- Delete what's exclusively this person's own and doesn't leave a hole in anyone else's
    -- experience: their private manuscripts, their guild memberships (so they stop appearing in
    -- member lists — a guild's aggregate stats settling lower afterward is expected, not a
    -- "hole," the same as any member leaving normally), and their follow relationships.
    delete from kv_store where user_id = rec.user_id;
    delete from founder_guild_members where user_id = rec.user_id;
    delete from player_guild_members where user_id = rec.user_id;
    delete from follows where follower_id = rec.user_id or followee_id = rec.user_id;

    -- Deletes every object this person ever uploaded, across both buckets — avatars,
    -- guild-crests, book-covers ('media') and project-images ('media-private'). Every object in
    -- both buckets is stored at '<folder>/<user_id>/<filename>' (see is_public_media_folder's
    -- comment above), so (storage.foldername(name))[2] is the owner's user id regardless of
    -- which folder or bucket it's in — one condition covers all of it.
    delete from storage.objects
    where bucket_id in ('media', 'media-private')
      and (storage.foldername(name))[2] = rec.user_id::text;

    -- Block sign-in permanently. banned_until is the same field Supabase Auth's own Admin API
    -- (auth.admin.updateUserById with ban_duration) writes — setting it directly here avoids
    -- needing a separate service-role backend just for this one scheduled step.
    --
    -- Important limitation, straight from Supabase's own docs (Managing User Data): deleting a
    -- session does NOT retroactively invalidate an access token (JWT) that's already been
    -- issued — that token keeps working for the rest of its own lifetime regardless. What this
    -- DOES do: blocks all future sign-ins (banned_until) and blocks that session from being
    -- refreshed into a new token once the current one expires. The residual risk — a
    -- still-valid access token issued shortly before purge, usable for up to your project's JWT
    -- expiry window (Auth settings, default 1 hour) — is low here specifically because purge
    -- already deleted this person's private data and guild memberships in the statements above,
    -- so there's very little left for a lingering token to do. If you need the harder guarantee
    -- of immediate revocation, Supabase's documented approach is to validate the session_id JWT
    -- claim against auth.sessions on sensitive operations, or to shorten the JWT expiry —
    -- neither of which this app currently does.
    update auth.users set banned_until = 'infinity' where id = rec.user_id;
    delete from auth.sessions where user_id = rec.user_id;
    delete from auth.refresh_tokens where user_id = rec.user_id::text;

    update account_deletions set status = 'completed', updated_at = now() where user_id = rec.user_id;
  end loop;
end;
$$;
