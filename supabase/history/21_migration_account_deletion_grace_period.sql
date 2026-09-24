-- Adds a 30-day-grace-period account deletion flow that anonymizes rather than cascades. See the
-- matching block comment in supabase/schema.sql for the full "why" — in short, deleting the
-- auth.users row directly would cascade-delete every review, Fireside post, and guild feedback
-- entry a departed member ever left, ripping holes in other users' guild threads and rating
-- summaries. Run this against an existing deployment that already ran schema.sql (or an earlier
-- phase file) before this section existed.

-- ============================================================================================
-- Account deletion — 30-day grace period, then a non-destructive purge.
--
-- "Delete my account" does NOT delete the auth.users row. Every content table below references
-- auth.users(id) on delete cascade (kv_store, published_books, reviews, fireside_posts,
-- guild_book_feedback, guild_published_books, ...) — actually deleting that row would cascade
-- through every single one of them instantly, ripping a departed member's replies out of guild
-- threads, their reviews out of other authors' rating summaries, their published books out of
-- guilds that promoted them, etc. mid-flight. That's the "breaks app structure" failure mode
-- this is built to avoid.
--
-- Instead: request → 30-day grace period (cancellable) → purge. Purge blocks the account from
-- ever signing in again and permanently removes what's exclusively theirs (private manuscripts,
-- guild memberships, follows), but *anonymizes* rather than deletes anything another user's view
-- depends on — it blanks their public profile and leaves every row they authored in place,
-- attributed to nobody. This isn't a gap in the UI: every place that reads an author's name
-- already falls back to a generic label when the profile is empty (reviewer_name || 'A reader'
-- in grand-library-cards.jsx, f.author ? ... : 'A guildmate' in guild-book-feedback-modal.jsx,
-- etc. — see the "no author_name here, looked up live" comment on publishBookRemote above) so
-- this displays correctly with zero other code changes.
-- ============================================================================================

create table if not exists account_deletions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  scheduled_purge_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending', 'cancelled', 'completed')),
  updated_at timestamptz not null default now()
);

alter table account_deletions enable row level security;

create policy "a user manages their own deletion request" on account_deletions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- SECURITY DEFINER: this needs to touch auth.users and other users' rows aren't otherwise
-- writable by a regular signed-in caller, which is exactly why this can't just be an RLS-scoped
-- client call — it's meant to run only via the pg_cron schedule below, as the table owner, not on
-- demand from the client.
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

-- Requires the pg_cron extension. On Supabase, enable it once via Database > Extensions in the
-- dashboard (or `create extension if not exists pg_cron;` if your project role has permission) —
-- then this schedule call takes effect. Runs daily at 03:00 UTC; re-running
-- purge_expired_account_deletions() is always safe since it only ever touches rows that are
-- still 'pending' and past their scheduled_purge_at.
select cron.schedule('purge-expired-account-deletions', '0 3 * * *', $$select purge_expired_account_deletions();$$);
