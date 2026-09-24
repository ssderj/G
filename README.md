# Inkroot — Phase 1 backend scaffold

> **Merge note:** this build combines two branches of the project — the file structure comes
> from a later pass that split the original single-file `src/App.jsx` into the modular
> `src/{shell,guild,library,writing,worldbuilding,shared-ui,shared-utils}/` layout you see here;
> the feature content (Phases 3–5 below, plus the accompanying schema files and `src/lib/`
> modules) comes from a parallel branch that kept building on the single-file version. Both
> started from the same Phase 1/2 base, so merging just meant carrying the newer guild-social,
> profiles, and player-guild logic into the already-split files rather than re-splitting
> anything. Every touched file was syntax-checked and cross-checked for import/export
> consistency after the merge.

This is a new project, separate from the single `Inkroot-consolidated.html` file — Phase 1 of
adding accounts + cross-device sync, offline-first. I couldn't run or test this scaffold myself
(no network access in the sandbox that built it, so no `npm install`, no real Supabase project to
connect to) — treat it as a solid starting point to run and verify yourself, not verified code.

## What this does

- Keeps everything working **fully offline with no account**, exactly like the original app —
  sync is opt-in, only active once signed in.
- Adds Supabase Auth via Google OAuth and passkeys (see `src/lib/auth.js`) — password and
  magic-link sign-in were removed; there's no code path for either.
- Syncs through a generic key-value table (`kv_store`) that mirrors the app's existing local
  storage keys (`inkroot:project:<id>`, `inkroot:writerProfile`, etc.) — no data model redesign
  needed for this phase.
- Local-first: every read/write hits IndexedDB immediately (via `src/lib/storage.js`, same
  `get/set/delete/list` shape the original app already used). A background sync engine
  (`src/lib/syncEngine.js`) pushes changes to Supabase when online and pulls remote changes
  down, using last-write-wins by timestamp.

## Setup

1. Create a free project at supabase.com.
2. In the SQL editor, run `supabase/schema.sql` once. That's the entire schema — every table,
   RLS policy, trigger, index, Storage bucket, and RPC function this app uses, already at its
   current, fixed-up state. (This used to be nine separate phase files run in order, each one
   layering fixes onto the last — see `supabase/history/README.md` if you want that development
   history; a fresh install doesn't need it.)
3. In Project Settings → API, copy the Project URL and anon public key.
4. `cp .env.example .env.local` and fill in those two values.
5. In the Supabase dashboard, enable the two sign-in methods this app actually uses (and leave
   the rest off — the app no longer has any code path for password or magic-link auth):
   - **Authentication → Providers → Google**: add your Google OAuth client ID/secret.
   - **Authentication → Passkeys**: turn on **Enable Passkey authentication** and fill in the
     Relying Party fields — this is dashboard-only config, not something a SQL file can set.
     Use your real production domain as the Relying Party ID before any user registers a
     passkey — changing it later invalidates every passkey already registered.
6. `npm install`
7. `npm run dev`
8. To turn on real Naira payments (book purchases, tips, and author withdrawals to a saved bank
   account), follow `PAYMENTS.md` — it's a separate setup pass (a Paystack account + deploying
   the Supabase Edge Functions in `supabase/functions/`), not covered by steps 1–7 above.

## Upgrading an existing deployment

If your Supabase project already ran `schema.sql` through `schema_phase7.sql` before the dates
below, run the `migration_*.sql` files once in the SQL editor, **in the numbered order they're
listed below and prefixed with in the `supabase/history/` folder** (`01_...` through `19_...`)
— several
depend on an earlier one having already run (e.g. `11_migration_tighten_guild_update_policies.sql`
requires `founder_guild_members`, added by `08_migration_founder_guild_membership.sql`). Safe to
run even if you're not sure — each one is written to be a no-op (or harmless) on a database that's
already up to date; see each file's own header for specifics.

1. `01_migration_scrub_author_email_fallback.sql` — re-labels any `author_name`/`reviewer_name`
   rows written under the old email fallback (before the client-side fix) across
   `published_books`, `reviews`, `fireside_posts`, `guild_book_feedback`, `guild_published_books`.
2. `02_migration_fix_profile_email_seed.sql` — same fix, for `profiles.display_name`, which was
   seeded server-side by a trigger rather than client-side, so the migration above didn't cover it.
3. `03_migration_restrict_player_guild_invite_code.sql` — closes the public `invite_code` read on
   `player_guilds`.
4. `04_migration_bound_guild_member_stats.sql` — adds abuse ceilings to `guild_member_stats`
   columns.
5. `05_migration_guild_member_stats_membership_fk.sql` — ties `guild_member_stats` rows to an
   actual membership row so leaving a guild removes the stats row too.
6. `06_migration_guard_guild_member_stats_delta.sql` — clamps `guild_member_stats` updates to be
   non-decreasing with a per-write delta cap.
7. `07_migration_add_guild_book_feedback_update_policy.sql` — adds the missing update policy on
   `guild_book_feedback` so a pen name change can propagate to a writer's already-posted feedback
   (see `src/lib/profile.js`'s `propagateDisplayName`); without it, published_books/reviews/
   fireside_posts/guild_published_books already picked up a name change but guild feedback rows
   kept showing the old name.
8. `08_migration_founder_guild_membership.sql` — adds `founder_guild_members` and tightens
   `fireside_posts`/`fireside_reactions`/`guild_book_feedback`/`guild_published_books` to actually
   check Founder Guild membership instead of just "signed in." **Read the comment at the top of
   this file before running it** — existing users backfill their own membership row automatically
   (see Phase 8 below), but only once their client has been updated and has loaded at least once
   while signed in. Must run before #11 below, which depends on `founder_guild_members` existing.
9. `09_migration_scope_project_media_private.sql` — narrows the `media` Storage bucket's
   public-read policy so it no longer covers `project-images` (in-manuscript character portraits,
   location photos, map backgrounds — see Phase 9 below). **Read the comment at the top of this
   file before running it** — any already-uploaded `project-images` object's old public URL stops
   resolving once this runs; the affected image field needs re-saving (with an updated client) to
   get a working signed URL in its place.
10. `10_migration_bound_media_bucket_uploads.sql` — adds a 5MB file-size cap and an
    image-mime-type allowlist to the `media` Storage bucket, closing the gap where nothing
    server-side stopped an upload beyond the client's own ~1.2MB compression cap (see Phase 9
    below). Safe to run anytime; a plain `update` on the bucket row, not additive.
11. `11_migration_tighten_guild_update_policies.sql` — adds a Founder Guild membership re-check to
    `guild_book_feedback`'s and `guild_published_books`' UPDATE policies, matching the check their
    SELECT/INSERT policies already got in Phase 8 (see below). **Requires #8 above to have already
    run** (either as `08_migration_founder_guild_membership.sql` or via `schema_phase8.sql` on a
    fresh install) — it depends on `founder_guild_members` already existing.
12. `12_migration_split_private_media_bucket.sql` — moves `project-images` out of the `media`
    bucket (created `public = true`) into a new `media-private` bucket (`public = false`).
    `09_migration_scope_project_media_private.sql`'s owner-only select policy on `project-images`
    was never actually enforced, because a public bucket serves every object through Storage's
    public route, which does not consult `storage.objects` RLS at all — so any writer's
    in-manuscript images stayed fetchable by anyone with (or guessing) the object path. **Read the
    comment at the top of this file before running it** — it only fixes where *new* uploads go and
    closes the write path on the old bucket; it does not relocate bytes for objects already
    uploaded under the old `media` bucket. Run
    `scripts/move-project-images-to-private-bucket.mjs` (with the project's service role key, never
    from a client) once, before or immediately after applying this migration, to copy existing
    `project-images` objects into `media-private`.
13. `13_migration_server_authoritative_kv_versioning.sql` — makes `kv_store.updated_at` and a new
    `version` column server-stamped by a trigger instead of trusting the client-supplied timestamp
    the sync engine previously wrote. Closes a clock-skew bug: a device with a fast clock could
    push a genuinely older edit that still carried a later timestamp than a real subsequent edit
    from a correctly-clocked device, silently winning the last-write-wins conflict and discarding
    the newer edit for good. Conflict resolution moves onto the new server-issued `version`
    counter — see `src/lib/syncEngine.js`. Safe to run anytime; existing rows default to
    `version = 1`.
14. `14_migration_drop_denormalized_author_names.sql` — drops `author_name`/`reviewer_name` from
    `published_books`, `reviews`, `fireside_posts`, `guild_book_feedback`, and
    `guild_published_books`, now that every reader looks the current name up from `profiles`
    instead (see the addendum below). **Deploy the updated client before running this** — dropping
    a column an older client still selects breaks that client's queries outright, rather than
    failing gracefully the way most of this app's remote calls are designed to.
15. `15_migration_guard_guild_member_stats_insert.sql` — closes a gap in
    `06_migration_guard_guild_member_stats_delta.sql`'s anti-cheat trigger: it only fired on
    UPDATE, so a member who left and rejoined a guild (which deletes and recreates their stats
    row) could push a single INSERT straight to the absolute ceiling, bypassing the per-write
    delta cap entirely. Safe to run anytime; idempotent.
16. `16_migration_guild_book_feedback_uniqueness.sql` — adds the `unique (guild_id, book_id,
    author_id)` constraint `guild_book_feedback` was always missing (unlike `reviews`' own
    `unique (book_id, reviewer_id)`), so a guild member can no longer post unlimited feedback
    rows against the same book. Deduplicates any existing repeat rows (keeping the most recent)
    before adding the constraint — **read the comment at the top of this file first** if you want
    to review what it would remove. Requires the accompanying client change (`addGuildBookFeedback`
    now upserts instead of inserting) to actually stop new duplicates from appearing.
17. `17_migration_kv_store_value_size_cap.sql` — adds a 20MB cap on `kv_store.value`, which
    previously had no size limit at all (unlike the Storage buckets' own 5MB file-size cap).
    **Read the comment at the top of this file before running it** — adding the CHECK constraint
    validates every existing row, so it will fail outright if any writer's project already
    exceeds 20MB; the comment includes a query to check first.
18. `18_migration_published_books_destination_check.sql` — adds `check (destination in ('guild',
    'inkroot'))` to `published_books`, which previously accepted any string. Matches the pattern
    `founder_guild_members.guild_id` already used. Safe to run anytime; idempotent.
19. `19_migration_dedupe_public_media_folder_list.sql` — replaces the literal
    `('avatars', 'guild-crests', 'book-covers')` array, previously copy-pasted across all four of
    the `media` bucket's RLS policies, with a single `is_public_media_folder()` function each
    policy calls instead. Pure refactor — no change in what any policy allows. Safe to run
    anytime; idempotent.

(Migrations 20–36 continue this same numbered, dependency-ordered pattern in
`supabase/history/` — not individually narrated in this list, which stops being actively
maintained here around this point; each later file's own header explains itself. Migration 37 is
narrated below, in its own Phase section, alongside the feature it completes.)

## Conflict resolution — read this before relying on it

Last-write-wins by timestamp is simple and matches the `updatedAt` convention the original app
already used on projects, but it means: if the same key is edited offline on two devices before
either syncs, whichever change has the later timestamp wins outright — the other is discarded,
not merged. Fine for a solo writer moving between their own devices sequentially; would need a
real merge strategy (e.g. per-chapter granularity, or CRDTs) if you ever add simultaneous
multi-device or multi-person editing.

## Migrating the actual app in — done

> **A note on file paths below:** the phase narrative from here down was written incrementally,
> phase by phase, and refers to `supabase/schema_phase2.sql`, `supabase/08_migration_...sql`,
> etc. as they were laid out at the time. Every one of those files now lives under
> `supabase/history/` instead (e.g. `supabase/history/schema_phase2.sql`) — see
> `supabase/history/README.md` for why. The content of each file hasn't changed; only the
> folder has. A fresh install today just runs the consolidated `supabase/schema.sql` — see
> "Setup" above — and can ignore this whole section; it's kept as a record of how the schema got
> to its current state, not as setup instructions.

The ~16,000-line component tree from `Inkroot-consolidated.html` is now in `src/App.jsx`.
What changed in the move:

1. The original inline `<script>` contents are in `src/App.jsx`, exporting a default
   `InkrootApp` component (`NavigationProvider` wrapping `InkRoot`, matching the original
   file's own mount call).
2. The original file's own inline IndexedDB-backed `storage` object — `IDB_DB_NAME`,
   `openInkrootDB`, `idbGet`/`idbSet`/`idbDelete`, the `localStorage` fallback, and the
   one-time migration logic — was **removed entirely**. Every call site (`storage.get(...)`,
   `storage.set(...)`, etc.) is untouched and now resolves to the import from
   `src/lib/storage.js` instead — same shape, now sync-aware.
3. The `<style>` block moved to `src/app.css`, imported directly in `App.jsx`.
4. The CDN `<script src="...react...">` tags are gone — `index.html` no longer loads
   React/ReactDOM from CDN; Vite bundles them from `node_modules` instead. `App.jsx` imports
   `React` as a normal module; every component itself is unchanged, since the app only ever
   called `React.createElement` directly and never used JSX.
5. `main.jsx` mounts `InkrootApp` unconditionally — signed in or not. Sync is opt-in via a
   small floating "Sync" button, not a login gate, so the app behaves exactly like the
   original offline-only version until you choose to sign in.

One thing intentionally left alone: `App.jsx` still has one dynamic `cdnjs.cloudflare.com`
script load (for d3.js, used by a chart). That's a separate, pre-existing lazy-load pattern
unrelated to this migration — fine to leave as-is, or swap for a real `d3` npm dependency later.

I could not run this myself — no network access in the sandbox that built it, so no
`npm install`, no real Supabase project, no actual browser render. Syntax-checked every file
with `node --check` (as a temporary `.mjs` copy for the two JSX-named-but-JSX-free files), but
that only proves the files parse — running `npm install && npm run dev` yourself is the real
test.

## Phase 2 — publishing/reviews — done

Real backend for the parts of the Grand Library that were "Coming Soon" placeholders:

- **`supabase/schema_phase2.sql`** — three new tables layered on top of Phase 1's `kv_store`:
  `published_books` (the public listing — title/blurb/genre/tags/price, publicly readable, only
  the author can write their own), `reviews` (one review per reader per book, publicly
  readable, only the reviewer can write their own), and `follows` (who follows whom). Run this
  in the Supabase SQL editor the same way you ran `schema.sql`.
- **`src/lib/library.js`** — the API: `publishBookRemote`/`unpublishBookRemote`,
  `fetchBookStats`/`fetchAuthorRatingsSummary`, `submitReview`, `follow`/`unfollowAuthor`,
  `fetchFollowers`. Every function checks for a session itself and no-ops gracefully when
  signed out, so nothing here needs the caller to track auth state.
- **Publishing is wired end to end**: `publishBookWithDetails` and `setPublishStatus` in
  `App.jsx` now push (or remove) the public listing after every local publish/unpublish/
  re-publish, fire-and-forget, same non-blocking philosophy as Phase 1's sync engine — a failed
  remote push never blocks or fails the local action.
- **Creator Dashboard's Ratings and Readers tabs are real now**, not Coming Soon panels:
  Ratings shows actual aggregate star ratings and reviews per published book; Readers shows
  actual followers. Each book card's Rating metric also now shows a real number once it has
  reviews.

What's still legitimately out of scope, and why:
- **Readers tab doesn't have traffic sources or page views** — that needs a separate
  events-tracking table, not part of this phase. Said honestly in the tab's own copy rather
  than implied.
- **Follower list shows ids, not names** — Supabase doesn't expose other users' profile data
  through a plain query (`auth.users` isn't publicly readable). Fixing this means mirroring a
  display name onto a small public `profiles` table the next time you touch auth — noted in
  `library.js` where it matters, not silently worked around.
- **Templates, Add-ons, Analytics, Earnings, Withdrawals** are still Coming Soon panels,
  unchanged — Earnings/Withdrawals genuinely need a real payment processor (a much bigger,
  separate decision), and Templates/Add-ons/Analytics are separate features this phase's plan
  never covered.

As with Phase 1, I could not run any of this myself — no Supabase project, no `npm install`, no
real browser. Syntax-checked with `node --check` only.

## Phase 3 — guild social — done

- **`supabase/schema_phase3.sql`** — `fireside_posts` and `fireside_reactions` (Fireside
  discussion board) plus `guild_book_feedback` (Guild Bookshelf reviews), scoped to Founder
  Guilds only — see the schema's own header for why Player Guilds aren't covered here.
  Realtime is enabled on the Fireside tables so a guildmate's post appears without a reload.
- **`src/guild/fireside-board.jsx`** falls back to local-only (`FIRESIDE_KEY`) when there's no
  guildId to post against — still true for Player Guilds after this phase, since they were
  never in scope for it.

## Phase 4 — public profiles — done

- **`supabase/schema_phase4.sql`** — a small public `profiles` table (`pen_name`, `display_name`,
  `avatar_url`), auto-created on signup via a trigger, so `fetchFollowers()` can show names
  instead of raw ids (the gap Phase 2 flagged).
- **`src/lib/profile.js`** — `syncProfile`/`fetchProfileNames`.

## Phase 5 — joinable Player Guilds — done

- **`supabase/schema_phase5.sql`** — `player_guilds` (server-generated `invite_code`) and
  `player_guild_members`, giving player-created guilds the real id and join-by-code flow they
  never had before.
- **`src/lib/player-guild.js`** — `syncPlayerGuild`, `joinPlayerGuildByCode`,
  `leavePlayerGuildRemote`, `fetchPlayerGuildMembers`, `fetchPlayerGuild`.
- Wired into `App.jsx`'s guild-join/leave flow and `guild-hall.jsx`'s `PlayerGuildRoster`.

## Phase 6 — shared Guild Level / XP / Reputation — done

Guild Level, Guild XP, and Guild Reputation (`guild-progression.jsx`) were computed from one
device's own local activity even after Phase 5 gave Player Guilds a real multi-member roster —
so two members of the same guild could see two different Guild Levels. This phase makes those
numbers a real sum across every member, for Player Guilds specifically:

- **`supabase/schema_phase6.sql`** — `guild_member_stats`, one row per (guild, member) holding
  that member's own raw contribution counts (published books, completed quests + their XP,
  writing days, Fireside posts). Read is restricted to fellow guild members (checked against
  `player_guild_members`), and a member can only write their own row, and only for a guild
  they're currently in.
- **`src/lib/guild-progression-remote.js`** — `pushGuildMemberStats` (fire-and-forget, same
  non-blocking philosophy as the rest of the sync layer) and `fetchGuildMemberStats`.
- **`guild-progression.jsx`** gained `sumGuildMemberStats`/`computeSharedGuildXP`/
  `computeSharedGuildProgress`/`computeSharedGuildReputation` — the same formulas as the
  local-only versions, applied to guild-wide totals instead.
- **`home-screen.jsx`** pushes this device's stats and fetches the guild's totals whenever a
  Player Guild is active, and swaps every Level/XP/Reputation call site over to the shared
  numbers once loaded (`resolveGuildProgressAndReputation`), falling back to the honest
  local-only computation while offline, signed out, or before the first fetch resolves.

**Deliberately out of scope, and why:** Founder Guilds are untouched — every *other* member
shown there is still a simulated presence (see `guild-order.jsx`'s HONESTY NOTE), so there's no
real roster to sum yet. Fireside participation for Player Guilds still isn't backed by Supabase
(that was Phase 3's own scope cut) — each member's `fireside_post_count` here is whatever their
device locally tallied, which is honest but not itself a Phase-3-style shared feed; wiring a real
guildId into `FiresideBoard` for Player Guilds is a reasonable next step and would make this
input real too, not just its rollup.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked with `node --check` only.

## Phase 7 — the Guild Bookshelf's shared shelf — done

Phase 3 made feedback on a Guild Bookshelf book real and shared (`guild_book_feedback`), but the
shelf itself still only showed what the current device had published to the guild — every other
guildmate's own publications were flagged "coming soon" in `GuildBookshelf`'s own copy. This
phase closes that gap:

- **`supabase/schema_phase7.sql`** — `guild_published_books`, one row per (guild, book), keyed
  and upserted on `(guild_id, book_id)`. Deliberately its own table rather than widening Phase
  2's `published_books` — that table is intentionally fully public (`for select using (true)`,
  since it also backs the open Grand Library), and a Guild Bookshelf book is meant to stay
  guild-only. Read is "signed in" only, same honesty caveat as `guild_book_feedback` and
  `fireside_posts`: there's still no `guild_members` roster to check real membership against.
- **`src/lib/library-guild.js`** — `publishBookToGuildRemote`, `unpublishBookFromGuildRemote`,
  `fetchGuildPublishedBooks`.
- **`ink-root.jsx`**'s `setPublishStatus` and `publishBookWithDetails` push (or remove) a book's
  guild listing alongside the existing `published_books` push whenever the destination is/isn't
  `'guild'` — fire-and-forget, same non-blocking philosophy as every other remote call in the
  app. Only wired for Founder Guilds (`guildProfile.guildType === 'founder'`), matching Fireside
  and the Bookshelf's own existing `guildId` scoping — Player/Joined guilds have no shared shelf
  yet, same scope cut Phase 3 made.
- **`GuildBookshelf`** now fetches the guild's shared listing when signed in, and merges it with
  the current device's own local list (local wins only for a book that hasn't round-tripped
  remotely yet, so a writer never loses sight of something they just published).

**Deliberately out of scope, and why:** the RLS honesty caveat above (no real membership check)
is unchanged from Phase 3 — closing it for both tables at once, via a real `guild_members`
table, is a reasonable next step once one exists. Player/Joined Guild bookshelves remain
local-only, consistent with every other guild-social feature so far.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 8 — real Founder Guild membership — done

Closes the RLS gap Phases 3 and 7 both flagged in their own comments: `fireside_posts`,
`fireside_reactions`, `guild_book_feedback`, and `guild_published_books` previously only checked
"is signed in," because there was no roster of who'd actually joined which Founder Guild to check
against (Player Guilds got one back in Phase 5; Founder Guilds hadn't, since they're a fixed set
of ten rather than rows in a table). A signed-in writer could previously read or post into a
Founder Guild's Fireside/Bookshelf without ever having joined it.

- **`supabase/schema_phase8.sql`** — a new `founder_guild_members` table (`guild_id` checked
  against the app's fixed ten Founder Guild ids, `user_id`, public read like
  `player_guild_members`), plus tightened select/insert policies on all four tables above so they
  now check actual membership instead of just `auth.uid() is not null`.
- **`src/lib/library-guild.js`** — `syncFounderGuildMembership`/`leaveFounderGuildMembership`,
  the client-side half of this fix: nothing previously told the server which Founder Guild a
  writer had joined at all (`guildProfile.founderGuildId` only ever lived in local storage), so
  the new table would otherwise stay empty and lock every real member out under the tightened
  policies.
- **`ink-root.jsx`**'s `joinFounderGuild`/`leaveCurrentGuild` push/remove membership alongside the
  existing local state change, same fire-and-forget, non-blocking pattern as every other remote
  call in this app. Its Founder-Guild-load effect also backfills membership for any writer who
  joined one before this phase shipped (or while signed out), the moment the app next loads with
  a session.
- **`sync-context.jsx`** does the same backfill right after sign-in — covers a writer who joins a
  Founder Guild while signed out and only signs in afterward, which the load-time backfill above
  wouldn't catch on its own.

**Read `08_migration_founder_guild_membership.sql`'s own header before running it on an existing
deployment** — the tightened policies only recognize a member once their device has pushed a
membership row, which needs the updated client, not just the updated schema.

**Race-condition fix (post-launch):** the backfill above is fire-and-forget, and every
Fireside/Bookshelf read or write is now gated on that same membership row already existing — so a
legitimate member who opened the Fireside moments after app load or sign-in, before the backfill
upsert had actually landed, could see an empty board or have a post rejected, purely on timing.
`src/lib/library-guild.js` now tracks each guild's in-flight `syncFounderGuildMembership` call in
a small module-level map, and every guild-scoped function (`fetchFiresidePosts`,
`postFiresideMessage`, `fetchGuildBookFeedback`, `addGuildBookFeedback`,
`fetchGuildPublishedBooks`, `publishBookToGuildRemote`) awaits that same in-flight promise (if one
is pending for that guild) before running its own request. No call site elsewhere needed to
change — `syncFounderGuildMembership` registers itself in the map internally, so `ink-root.jsx`
and `sync-context.jsx` keep firing it exactly as before.

## Phase 8 addendum — UPDATE policies re-check membership too — done

Closes a smaller gap this phase left open by its own admission: `guild_book_feedback`'s and
`guild_published_books`' UPDATE policies stayed plain author-only (see `schema_phase8.sql`'s
"update/delete stay author-only, unchanged" notes) while every other write on those tables picked
up a Founder Guild membership check. In practice, a writer who'd since left a guild could still
edit the content of their own old feedback row or guild book listing there, inconsistent with
every other write needing active membership.

- **`supabase/schema_phase8.sql`** — updated in place: both tables' UPDATE policies now also
  require an existing `founder_guild_members` row for the caller, same shape as their INSERT
  policies. DELETE stays plain author-only on both — retracting your own feedback, or removing
  your own guild listing (`unpublishBookFromGuildRemote` already does this independent of guild
  membership), doesn't need the same gate as editing content does.
- **`supabase/11_migration_tighten_guild_update_policies.sql`** — the equivalent fix for a
  deployment that already ran the original version of `schema_phase8.sql`. Depends on
  `founder_guild_members` already existing, so run it after Phase 8 (or
  `08_migration_founder_guild_membership.sql`).

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 9 — images out of Postgres, into Storage — done

Fixes the backend architecture review's top finding: avatars, guild crests, and book covers were
being stored as base64 data URLs (up to ~1.2MB each) directly in `profiles.avatar_url`,
`player_guilds.crest_url`, and `guild_published_books.cover` — plain text/jsonb columns, on
tables that are publicly (or guild-)readable. Every profile/crest/cover fetch was pulling the
full image inline, with no CDN, no resizing, and no size cap enforced server-side.

- **`supabase/schema_phase9.sql`** — a public Storage bucket (`media`) with RLS on
  `storage.objects`: anyone can read, but a writer can only upload/update/delete inside their own
  `<folder>/<user_id>/...` path. Purely additive — doesn't touch any existing table — so it's
  also safe to run once on an existing deployment; no separate numbered migration needed for it.
- **`src/lib/mediaStorage.js`** — `uploadImageDataUrl(dataUrl, folder)` uploads an
  already-compressed image to the signed-in writer's folder and returns its public URL, or
  `null` on any failure (signed out, offline, unconfigured, upload error). `deleteUploadedImage`
  best-effort removes a previous upload when it's replaced or cleared.
- **Three call sites updated** — `authors-hall-screen.jsx` (avatar), `home-screen.jsx` (guild
  crest), `form-fields.jsx`'s `CoverPicker` (book cover, which also covers `guild_published_books`
  once a book with a custom cover is published to a guild). Each now uploads to Storage first and
  stores the returned URL; if that fails or the writer is signed out, it falls back to storing the
  data URL exactly as before — image upload keeps working fully offline either way. Each also
  best-effort deletes the old uploaded object on replace/remove.

Deliberately unchanged in this phase: a project's own in-manuscript images (character
portraits, location photos, map backgrounds) still lived inline in the project's JSON in
`kv_store` — extended to those too in Phase 10 below.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 10 — in-manuscript images out of the synced blob too — done

Extends Phase 9 to the review's #2 finding directly: every project is one `kv_store` row holding
its *entire* JSON — chapters, world data, and every embedded image — and `useAutosave` re-pushes
that whole blob (a `SELECT` then an `UPSERT`, no diffing) on every 500ms-debounced edit. A project
with a handful of character portraits, location photos, or map backgrounds could mean multi-MB
round trips on nearly every pause in typing.

This phase doesn't change the sync engine's granularity itself (still one key per project — see
"Conflict resolution" above for why that's a separate, bigger decision) — it goes after what was
actually making that one key large: the embedded images. `ImageAdder` and `ImagePicker` in
`src/shared-ui/ui-primitives.jsx` are the two generic components every image field in the app is
built from (location galleries, character portraits, map backgrounds, house crests/banners,
publishing cover images), so updating them once covers every one of those fields the same way
Phase 9 covered avatar/crest/cover: upload to the same `media` Storage bucket, store the short
URL in the project JSON instead of the data URL, fall back to the data URL when signed out,
offline, or the upload fails. `Settings → Optimize Images` (`optimizeProjectImages` in
`image-utils.jsx`) is unchanged and still useful as-is — it recompresses whatever `data:image`
strings remain embedded (offline-created images that never got a chance to upload, or ones from
before this phase), it just no longer has as much to do for anything created after this ships.

Still out of scope, and why: this shrinks the payload but doesn't change *when* it's sent — every
edit anywhere in a project still re-syncs that project's whole `kv_store` row, images or not. A
very long manuscript's text alone, or a project with many uploaded-but-still-referenced images
(URLs are short, but a project with hundreds of them still adds up), can still make each sync
larger than it needs to be. Real per-chapter or per-section sync keys would fix that properly, but
is a bigger change (touches the outbox/pull-merge logic in `syncEngine.js`, needs its own
migration path for existing `kv_store` rows) — a reasonable future phase if it's still worth it
once this phase is deployed and the actual remaining payload sizes can be measured.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 9 addendum — `project-images` scoped to private — done

Fixes a gap this phase introduced: `media`'s select policy (`schema_phase9.sql`) was a blanket
"anyone can read the bucket," which was the right call for avatars/guild-crests/book-covers (all
meant to be public) but was never revisited once Phase 10 started storing in-manuscript images
(character portraits, location photos, map backgrounds) in that same bucket — images that belong
to a project's own `kv_store` row, which is private by default (see `schema.sql`'s RLS). Any
writer's unpublished draft images were reachable by anyone who obtained the object's URL,
undermining the private-by-default model the rest of the app relies on. Object paths include a
random filename suffix, so this wasn't openly browsable, but that's obscurity, not access
control.

- **`supabase/schema_phase9.sql`** — updated in place (rather than left as a migration-only fix)
  so a fresh install never has a window where `project-images` is public: the select policy is
  now folder-aware — `avatars`/`guild-crests`/`book-covers` stay publicly readable,
  `project-images` is scoped to `auth.uid() = (storage.foldername(name))[2]`, the same owner-only
  shape already used by this table's insert/update/delete policies.
- **`supabase/09_migration_scope_project_media_private.sql`** — the equivalent fix for a
  deployment that already ran the original, all-public version of `schema_phase9.sql`. **Read its
  header
  before running it**: any `project-images` object already embedded in a project via a public URL
  stops resolving once this runs (403 instead of the image) — that's the point, not a bug — and
  needs the affected image field re-saved (with an updated client) to pick up a working signed
  URL in its place.
- **`src/lib/mediaStorage.js`** — `uploadImageDataUrl` now returns a signed URL (180-day TTL) for
  `project-images` instead of a public one, since that folder has no public-read policy to serve
  one from. `isUploadedMediaUrl` and `deleteUploadedImage` recognize both URL shapes. A new
  `getFreshProjectImageUrl` re-signs a `project-images` URL on demand — nothing calls it yet;
  wiring it into project load (refreshing any URL past the halfway point of its TTL) is the
  natural next step, flagged here rather than silently left undone. Until that's wired in, a
  signed URL just needs re-uploading after it expires, same as the migration note above.
- **Avatars/guild-crests/book-covers are unaffected** — same public bucket, same public policy,
  same public URLs as Phase 9 originally shipped.
- **`supabase/10_migration_bound_media_bucket_uploads.sql`** — a second, independent gap in the same
  bucket: `schema_phase9.sql`'s original bucket insert set no `file_size_limit` or
  `allowed_mime_types`, so nothing server-side stopped a request that bypassed the app's own
  upload UI from pushing an oversized or non-image file straight through the Storage API with a
  valid session. Now folded into `schema_phase9.sql`'s bucket insert directly (5MB cap,
  `image/jpeg` | `image/png` | `image/webp` allowlist) for fresh installs; this migration is the
  update-in-place equivalent for a bucket row that already exists from an earlier deployment.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 2/3/7 addendum — author names read from `profiles`, not denormalized — done

Fixes the backend architecture review's other finding: `published_books`, `reviews`,
`fireside_posts`, `guild_book_feedback`, and `guild_published_books` each kept their own
`author_name`/`reviewer_name` column — a copy of the writer's display name, set once at write
time. Keeping five copies of the same fact meant a pen name change (`src/lib/profile.js`'s
`syncProfile`) had to fan out into five separate updates (`propagateDisplayName`) to stay
correct, and each of those five was independently able to fail — best-effort and non-fatal by
design, so a failed one just left a stray old name showing on a past book, review, post, or
guild listing indefinitely, with nothing to retry it later.

- **`schema_phase2.sql`/`schema_phase3.sql`/`schema_phase7.sql`** — updated in place (fresh
  installs never create the columns at all): `published_books.author_name`,
  `reviews.reviewer_name`, `fireside_posts.author_name`, `guild_book_feedback.author_name`, and
  `guild_published_books.author_name` are gone. Every one of these tables already stores the
  writer's id (`author_id`/`reviewer_id`), and `profiles` (Phase 4) is the one place their
  current display name actually lives.
- **`14_migration_drop_denormalized_author_names.sql`** — the equivalent fix for a deployment
  that already ran the original versions of those phase files. **Deploy the updated client
  first** — see the migration's own header for why the order matters here specifically.
- **`src/lib/library.js`/`library-guild.js`** — every write (`publishBookRemote`, `submitReview`,
  `postFiresideMessage`, `addGuildBookFeedback`, `publishBookToGuildRemote`) simply stops sending
  a name. Every read (`fetchBookStats`, `fetchAuthorRatingsSummary`, `fetchFiresidePosts`,
  `fetchGuildBookFeedback`, `fetchGuildPublishedBooks`) now selects the bare id instead of a name
  column, then batches one `fetchProfileNames()` lookup (`src/lib/profile.js`, already used by
  Phase 2's `fetchFollowers`) across every row it just fetched, and merges the current name back
  onto each row under the same field name the UI already reads (`author_name`, `reviewer_name`,
  `author`) — so no UI component needed to change.
- **`src/lib/profile.js`** — `syncProfile` no longer calls `propagateDisplayName` (removed
  entirely). Since nothing keeps its own copy of the name anymore, there's nothing left to keep
  in sync: a pen name change is visible everywhere the instant the one `profiles` row is updated,
  and there's no longer a partial-failure case where some tables show the old name and others
  don't.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 11 — a real Guild Treasury — done

Replaces `GoTreasuryTab`'s "Guild Coin" — a number computed from `guildReputation / 8` and stored
per-device in local `storage`, editable by anyone who edited their own local storage — with a real
Naira treasury for a Player Guild, following the exact server-authoritative pattern
`32_migration_naira_payments.sql` already established for an individual author's balance.

- **`supabase/history/33_migration_guild_treasury.sql`** (already folded into the consolidated
  `supabase/schema.sql` — a fresh install needs nothing extra) — a new `guild_treasury_transactions`
  ledger table, plus `security definer` functions for every balance a Treasury tab needs:
  `guild_treasury_owned_kobo` (the guild's lifetime settled income), `guild_treasury_available_kobo`
  (owned funds minus what's already spent or in flight — what a new spend is actually checked
  against), `guild_treasury_pending_kobo`, and `guild_treasury_member_earnings_kobo` (money held in
  the treasury on behalf of members collectively, reserved for a real source — see below). None of
  these are stored columns; every one is a query over the ledger, so there's nothing that can drift
  out of sync with it. `guild_treasury_summary(guild_id)` bundles all four (plus the caller's own
  held member-earnings) into one round trip.
- **No client insert/update/delete policy on `guild_treasury_transactions` at all** — same posture
  as `purchases`/`withdrawals`. The only two ways a kobo moves are `contribute_to_guild_treasury`
  (a member sends part of their own real, already-earned balance into their guild's purse — checked
  against their actual `author_balance_kobo`, not a client-reported number) and
  `spend_from_guild_treasury` (checked against `player_guilds.owner_id` — the one real,
  server-known authority for a Player Guild today, since Player Guild roles/rungs are still a
  client-side computation with no server counterpart). Both re-derive membership/ownership/balance
  from the database inside the function itself, and both take a `pg_advisory_xact_lock` first so
  two concurrent calls from the same writer or guild can't both pass a balance check that only one
  of them should.
- **`author_balance_kobo` (Phase 32) updated in place** to also subtract a writer's own successful
  contributions — without this, a contributed kobo would still count toward the contributor's own
  withdrawable balance after also landing in the guild's, spendable twice. Same function, same
  signature, still the one place a writer's balance is computed.
- **The ledger separates two independent things**, not four unrelated numbers: *whose* the money is
  (`bucket`: `'guild'` vs `'member'`) and *whether it's settled* (`status`: `pending`/`success`/
  `failed`, mirroring `purchases`/`withdrawals`' own lifecycle for whenever a source that needs to
  wait on async settlement exists). `kind` reserves `anthology_share`/`event_revenue`/
  `release_to_member` for when Anthologies/Guild Events are real enough to write one — nothing
  fabricates a balance from either today, same "reserved, not invented" policy
  `GUILD_REPUTATION_SOURCES` already uses for its own non-live rows.
- **`src/lib/guild-treasury.js`** — the client API: `fetchGuildTreasurySummary`,
  `fetchGuildTreasuryLedger` (the transaction history — RLS alone decides what a caller can see, so
  this is a plain `select`, not a privileged one), `contributeToGuildTreasury`,
  `spendFromGuildTreasury`. Every amount crosses the wire in kobo; every function here formats or
  parses Naira for display, never trusts a balance computed client-side.
- **`GoTreasuryTab` (`guild-order.jsx`)** now branches: a real, signed-in Player Guild
  (`remoteGuildId` set — see `home-screen.jsx`) gets the real treasury (four real balances, a
  contribute form, an owner-only "authorize a spend" form, and real transaction history); anyone
  else (signed out, offline, or a Founder Guild — still a simulated roster, so there's no real
  membership to check a treasury against) sees the original simulated preview unchanged, now
  honestly labeled "Preview only" instead of implying it's the real thing.

**Deliberately out of scope, and why:** `bucket = 'member'` rows and the `anthology_share`/
`event_revenue` credit kinds exist in the schema but nothing writes one yet — Anthologies and Guild
Events are separate, not-yet-built features; wiring their real sale/revenue splits into this same
ledger (rather than a second, parallel one) is the natural next step once either exists. Treasury
spend authorization only checks the real guild owner, not the richer Council/rung hierarchy
`GO_PERMISSIONS` describes — that hierarchy has no server-side counterpart yet (no real guild-roles
table), so enforcing it server-side would mean trusting a client-computed rung. Founder Guild
treasuries aren't real for the same reason Founder Guild `guild_member_stats` aren't (Phase 6): no
real roster to check membership or ownership against yet.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new file with `node --check`.

## Phase 12 — Guild Anthology revenue actually reaches the Treasury — done

Phase 36 (`guild_anthology_revenue_agreements`/`guild_anthology_revenue_shares`) made a
contributor split explicit, approved by name, and locked at publish time — but nothing paid it
out. An anthology sale still flows through the same `purchases` row every solo book uses, and
`author_id` on that row is whoever published the anthology (the guild owner), so a successful
sale's entire post-platform-fee proceeds landed in the owner's own personal balance in full,
regardless of what the locked agreement said. This phase closes that gap.

- **`supabase/history/37_migration_guild_revenue_distribution.sql`** (already folded into the
  consolidated `supabase/schema.sql` — a fresh install needs nothing extra) — two new columns on
  `guild_treasury_transactions` (`source_purchase_id`, `anthology_id`) so a distribution row
  traces back to the exact verified sale that produced it; `distribute_guild_revenue()`, a
  generic engine that takes a guild, an already-fee-applied gross amount, and a set of
  `{contributor_id, share_bps}` shares, and credits each contributor's earnings into the guild
  treasury (`bucket = 'member'`, held in trust — see migration 33's original comment on that
  bucket) plus whatever's left over to the guild's own bucket, using the same largest-remainder
  rounding `propose_anthology_revenue_agreement` already uses so the total always sums exactly;
  and `distribute_anthology_sale_to_treasury()`, a trigger on `purchases` that fires only on the
  genuine pending → success transition and calls the engine above for any sale of a published
  anthology's book. An ordinary solo book sale finds no matching `guild_anthologies` row and is
  completely untouched.
- **All five steps run server-side, inside Postgres, with no client involvement at all**: (1) the
  platform fee is already applied in `purchases.author_amount_kobo` at purchase-init time, before
  a sale can ever reach 'success' — the distribution engine treats that column as its
  authoritative gross figure rather than re-deriving the fee a second time and risking drift from
  `PLATFORM_FEE_BPS`; (2) contributor shares come from the anthology's own locked
  `guild_anthology_revenue_shares` rows, re-read from the database inside the trigger, never
  passed in by a caller; (3) and (4) are the engine's two ledger inserts; (5) each of those
  inserts *is* the permanent ledger record — there's no separate logging step, and
  `guild_treasury_transactions`' existing immutability trigger (migration 33) means neither can
  ever be edited or deleted afterward.
- **`author_balance_kobo()` updated in place** to stop counting an anthology-book purchase toward
  the personal balance of whoever's on that purchases row — that money is distributed through the
  treasury now, and counting it in both places would pay the same sale out twice. A solo book
  purchase has no matching `guild_anthologies` row and is entirely unaffected.
- **Duplicate-processing protection, three independent layers** (see the migration's own header
  for the full reasoning): `paystack-webhook`'s update is already scoped to rows still `pending`,
  so a retried webhook event for an already-settled sale updates nothing and never re-fires the
  trigger; the trigger's own `WHEN` clause only fires on an actual transition, not every update;
  and `distribute_guild_revenue()` itself checks — under an advisory lock keyed to that specific
  purchase — whether any ledger row already references it before writing anything, so even a
  direct, unanticipated call can't pay a sale out twice.
- **A one-time backfill runs as part of the same migration**: any anthology sale that already
  succeeded before this shipped (so its proceeds are already sitting, undistributed, in the
  owner's personal balance) is distributed now, exactly the way a new sale would be. Read the
  migration's own comment on this before running it on a deployment with real past anthology
  sales — the owner's personal balance moves down to reflect only their own contributor share (if
  they had one) once this runs, which is correct but worth knowing to expect.

**Deliberately out of scope, and why:** the distribution engine (`distribute_guild_revenue`) is
intentionally source-agnostic — guild, amount, and a shares list, nothing anthology-specific in
its own signature — so a future Guild Events feature can call it the same way with
`source = 'event_sale'` / `kind = 'event_revenue'`, both already reserved in migration 33's
`guild_treasury_transactions` check constraints, once that feature actually exists. No Guild
Events table, sale flow, or UI is added by this phase — there is still no way to hold or sell
tickets to a Guild Event anywhere in the app; only the treasury-side hook is ready for it.
Likewise, `bucket = 'member'` credits now really happen, but there is still no
`release_to_member` path (also reserved in migration 33) for a contributor to move their held
treasury earnings into their own withdrawable `author_balance_kobo` — they're visible in the
Treasury tab's "your held earnings" figure (`guild_treasury_summary`'s
`member_earnings_mine_kobo`, which needed no changes here since it always read generically over
`bucket = 'member'`), but not yet withdrawable from there. That's the natural next phase once it's
worth building.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Read every touched/new file closely rather than running it; no
`node --check` equivalent exists for SQL in this sandbox, so treat this phase as unverified until
run against a real (or test) Supabase project.

## Phase 13 — Referral reward system audit and fix — done

A full audit of the referral tracking/reward system (`supabase/history/55`–`58_migration_referral_*.sql`,
already folded into `supabase/schema.sql` as of this repo's last update) against ten specific
correctness requirements: signup alone pays ₦0, genuine qualifying activity triggers the correct
reward, rewards are calculated server-side, refunds reverse or invalidate pending rewards, self-
referrals are blocked, duplicate referrals are blocked, rewards can't be claimed twice, referral
balances can't be edited from the client, existing author earnings are unchanged, and the existing
wallet/withdrawal system still works. Eight of ten had nothing to fix. Two real gaps found, both
scoped to refund/reversal correctness — nothing here touches money math, RLS, or the
purchases/withdrawals/bank_accounts tables at all:

- **`reverse_referral_grant()` was uncallable from the client.** `58_migration_..._anti_abuse.sql`
  wrote it to accept either `service_role` or a signed-in moderator as caller, but only ever
  `revoke`d its execute privilege from `public` and never added the matching `grant execute ...
  to authenticated` every other moderator-callable function in this schema has (see
  `admin_set_login_ban()`). The daily `pg_cron` reconciliation sweep was unaffected — it calls
  this function from inside a security-definer function it owns, which executes with the owner's
  privileges regardless — so refunds *were* already being reversed automatically within 24 hours;
  only a moderator's on-demand manual override via the client was dead code. Fixed by adding the
  missing grant.
- **A reversed reward looked identical to a still-valid one on the referrer's own dashboard.**
  `author_balance_kobo()` has always correctly netted out reversals — the real, withdrawable
  balance was never wrong — but `referral_reward_progress()` (the RPC
  `src/library/referral-dashboard.jsx` calls to render "Earned rewards" / "Lifetime referral
  earnings" / each referral's badges) read `naira_reward_kobo` straight off `referral_grants` and
  never checked `referral_grant_reversals`, so a clawed-back reward kept reporting `unlocked =
  true` with its original amount, forever, on the one screen whose job is telling a referrer what
  they've earned.

- **`supabase/history/59_migration_referral_reward_progress_reflects_reversals.sql`** (folded into
  `supabase/schema.sql`) — the grant fix above, plus `referral_reward_progress()` redeclared with
  a new `reversed` column (a plain existence check against `referral_grant_reversals`, same shape
  every other signal function here already uses) and `unlocked` now correctly means "you still
  have this" rather than "this was ever granted." The underlying `referral_grants` row and its
  original amount are still returned either way — nothing is hidden, only correctly labeled.
- **`src/lib/referrals.js`** — `fetchReferralRewardProgress()` now also returns `reversed` per row.
- **`src/library/referral-dashboard.jsx`** — `ReferralHistoryRow` now renders a reversed reward as
  a muted, struck-through "(reversed)" chip instead of an identical-looking gold "+amount" chip;
  the lifetime-earnings and earned-rewards aggregates automatically exclude reversed rewards now
  that `unlocked` is accurate, with no other logic change needed.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked the two touched JS files with `node --check`; read
every line of the new SQL closely rather than running it.

## Phase 14 — the Creator Dashboard's Analytics tab, for real — done

Closes the gap Phase 2's own README flagged as deliberately out of scope back then: "Readers tab
doesn't have traffic sources or page views — that needs a separate events-tracking table, not
part of this phase." This phase is that table, plus the tab.

- **`supabase/history/60_migration_book_view_analytics.sql`** (already folded into the
  consolidated `supabase/schema.sql` — a fresh install needs nothing extra) — a new
  `book_view_events` table (`book_id`, `viewer_id` — null when signed out, `event_type`
  ('detail_view' | 'read_start'), `source`, `created_at`). **No client select/insert/update/delete
  policy at all**, for any role — a raw row ties a specific account (or none) to a specific book
  at a specific timestamp, and nobody but that book's own author has a legitimate reason to see
  that, in aggregate, not as a list of who-viewed-what. Every write goes through
  `record_book_view()` (security definer, granted to both `authenticated` and `anon` — reading a
  free book has never required signing in, so tracking that it was viewed can't require it
  either; dedupes a signed-in viewer's own rapid repeat views within 5 minutes, honestly doesn't
  dedupe anonymous ones since there's no durable identity to dedupe by — see the migration's own
  header for why that's an honest approximate signal, same as any anonymous-traffic count on the
  open web, not an abuse-hardened one). Every read goes through `fetch_book_view_summary()`
  (security definer, author-only — raises `Only this book's own author can view its analytics.`
  for anyone else), which returns total detail views, total read starts, a unique-signed-in-
  viewer count, a breakdown by traffic source, and a 30-day daily trend, all in one round trip —
  same "one summary call, not N" shape `guild_treasury_summary()` already established.
- **`src/lib/analytics.js`** — the client API: `recordBookDetailView`/`recordBookReadStart`
  (fire-and-forget, same non-blocking philosophy as every other remote call in this app — a
  reader opening or reading a book must never wait on this) and `fetchBookViewSummary` (honest
  `null` on signed-out/offline/error, same fallback contract as every other `fetchX` here).
  `BOOK_VIEW_SOURCES` is the fixed set of traffic-source buckets the table's own check constraint
  enforces server-side too, so a typo at a call site is a compile-time reference error rather
  than a silently-dropped RPC call.
- **Every real "a reader looked at or started reading a book" entry point now tags its own
  source**: the Grand Library's featured card, New Releases shelf, Highest Rated shelf, and
  Discover grid; the book detail modal's "Read the full book" (carries the source it was opened
  with, via `GrandLibraryScreen`'s new `selectedBookSource` state); opening a book from the Cart;
  the Author's Hall's public book list and detail modal; and the real Guild Bookshelf
  (`GuildBookshelf` in `guild-book-feedback-modal.jsx`).
- **`CreatorAnalyticsPanel`** (`src/library/grand-library-cards.jsx`) replaces the Analytics tab's
  `CreatorComingSoonPanel` in `creator-dashboard.jsx`. One book at a time (a book selector when a
  writer has published more than one), showing that book's detail views / full reads / unique
  signed-in readers, a traffic-source breakdown, and a 30-day trend — same visual language as
  `CreatorRatingsPanel`'s cards.

**Deliberately out of scope, and why:** no reading-progress tracking (how far into a book someone
got, time spent, page turns) — that needs a durable per-reader reading-position signal this app
doesn't have even locally for someone else's book, a meaningfully bigger scope than "was this
book opened." No Trending shelf or ranking uses this data yet — `ComingSoonShelf`'s "Trending"
placeholder in the Grand Library is untouched; wiring real view counts into a trending score is a
reasonable next step once this phase's data has had time to accumulate. `CreatorBookCard`'s own
"Readers" metric (the Published Books tab, not Analytics) still shows "—" — left alone rather
than silently repurposed to mean something narrower ("readers" there reads as a lifetime/overview
figure; this phase's `uniqueViewers` is scoped to signed-in viewers of one book only, not the
same claim) — wiring that in, if wanted, is a small separate follow-up now that the underlying
data exists.

**Found while building this, unrelated to Analytics, flagged rather than silently fixed:**
`src/guild/guild-library.jsx`'s `GuildLibrary` component appears to be dead code — nothing in
`src/` imports it. The real Guild Bookshelf is `GuildBookshelf` in
`src/guild/guild-book-feedback-modal.jsx` (see Phase 7 above), which is what this phase actually
instrumented. Worth a follow-up to confirm and remove `guild-library.jsx` if it's genuinely
unreachable, rather than left as a second, un-instrumented, unmaintained copy of the same screen.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched/new JS/JSX file with `node --check`;
read every line of the new SQL closely rather than running it.

## Phase 15 — Guild Treasury member-earnings withdrawal — done

Closes the gap Phase 12 flagged as deliberately out of scope: `bucket = 'member'` credits
(an Anthology sale's per-contributor share, held in trust in a guild's treasury —
`guild_treasury_summary()`'s `member_earnings_mine_kobo`) had no way out. `release_to_member` was
reserved in `guild_treasury_transactions`' own `kind` check constraint back in Phase 11 but
nothing ever wrote one, so a contributor's share sat visible but permanently stuck.

- **`supabase/history/41_migration_guild_member_earnings_withdrawal.sql`** (already folded into
  the consolidated `supabase/schema.sql` — a fresh install needs nothing extra) — a two-step
  handoff, not a new payout pipeline: `withdraw_guild_member_earnings()` moves kobo out of the
  caller's own held-in-trust `bucket = 'member'` balance in one guild's treasury and into their
  existing, cross-guild `author_balance_kobo`, instantly and synchronously (pure bookkeeping — no
  bank call, nothing that can fail asynchronously, so it's correct to record as a single
  `'success'` ledger row). Actually reaching a bank account reuses the existing
  `withdrawals`/`paystack-withdraw` pipeline unchanged, the same one every ordinary book-sale
  withdrawal already goes through — deliberately not a second pending/success/failed lifecycle of
  its own, since `guild_treasury_transactions` is append-only (Phase 11) and can no longer support
  one. Every balance checked (`guild_treasury_member_earnings_mine_kobo`,
  `guild_treasury_member_pending_kobo`, `guild_treasury_member_lifetime_kobo`, bundled for the UI
  via `guild_member_earnings_summary()`) is re-derived from `auth.uid()` alone, server-side, inside
  a security-definer function — no argument a client could pass reaches another member's earnings.
  `author_balance_kobo()` updated in place once more to add back any kobo released this way,
  so a release doesn't move money out of the guild bucket into nowhere.
- **`src/lib/guild-treasury.js`** — `fetchGuildMemberEarningsSummary`,
  `fetchGuildMemberEarningsTransactions`, `withdrawGuildMemberEarnings`.
- **`src/guild/guild-member-earnings.jsx`** — `GoMemberEarningsPanel`, rendered inside
  `GoTreasuryTab`'s real (signed-in Player Guild) branch in `guild-order.jsx`, alongside the guild
  treasury itself: available/pending/lifetime earnings, earnings grouped by the anthology or event
  that paid them, a transaction list, and a withdraw flow that shares the same bank-account UI
  (`AddBankAccountModal`/`WithdrawModal`) the Creator Dashboard's own withdrawals already use.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Read every line of the new SQL closely rather than running it.

## Phase 16 — public reviews, wired up (and a real bug found while wiring it) — done

Closed the last genuinely-missing piece of Phase 2's original scope: public reviews from other
readers were always labeled "Coming Soon" in the Grand Library, even though `submitReview()`/
`fetchBookStats()`/`fetchAuthorRatingsSummary()` (`src/lib/library.js`) were fully built back in
Phase 2 — nothing in the UI ever called `submitReview`, and `BookDetailModal` only ever exposed
the separate, genuinely-different private on-device rating.

**A real bug found in the process, not just a missing UI:** `reviews.rating` — present in the
original `schema_phase2.sql`, required by every one of the functions above — is missing from the
consolidated `supabase/schema.sql`, dropped by accident somewhere during the
schema_phase\*.sql → schema.sql fold. Every fresh install (per this README's own Setup section)
runs `schema.sql`, not `schema_phase2.sql`, so on any real deployment `submitReview` has always
failed outright with "column reviews.rating does not exist" — public reviews were never actually
reachable, Coming Soon label or not.

- **`supabase/history/61_migration_reviews_rating_column.sql`** (already folded into the
  consolidated `supabase/schema.sql` — a fresh install needs nothing extra) — restores
  `rating smallint not null check (rating between 1 and 5)` on `reviews`. Defensive rather than
  assuming: adds it nullable first, backfills any existing null (expected to touch zero rows,
  since the column's absence means no insert could ever have succeeded), then tightens to
  `not null` plus the check constraint.
- **`src/library/grand-library-cards.jsx`** — new `PublicReviewsSection` (average rating, the
  full review list with reviewer name/verified badge/relative time, and a write-or-edit-your-own
  review form gated on sign-in via `useSync()`), rendered in `BookDetailModal` in place of the old
  `ComingSoonNotice`. Deliberately kept separate from the existing private "Your rating" section
  above it — one on-device star rating per reader (feeds their own Highest Rated shelf/Featured
  Chronicle pick), one real public review per reader (visible to everyone), never merged into one
  number.
- **Two other stale "Coming Soon" spots fixed nearby, same file:** `BookDetailModal`'s price
  section still said "Purchasing is coming soon" for a priced book, and `CartDrawer`'s own Buy
  button right above it already performs a real Paystack charge (`checkoutBook` — see Phase 12/
  `PAYMENTS.md`, which shipped after this copy was originally written and never came back to
  update it). Replaced with an accurate line pointing at the real Buy action instead.

**Still honestly Coming Soon, unchanged:** `LibraryQuickActions`'s own header comment and the
Discover screen's "purchasing is coming soon" note (`grand-library-screen.jsx`) are the same kind
of stale leftover from before Naira payments shipped — flagged here, not fixed in this phase since
it wasn't in scope; worth a follow-up pass.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked the touched JS/JSX file with `node --check`; read
every line of the new SQL closely rather than running it.

## Phase 17 — manual withdrawals, for while Paystack Transfers aren't available — done

Paystack Transfers (what pays an author out) need a verified business with a TIN on file;
Paystack's inline checkout (what charges a reader) doesn't. Requested directly: keep the existing
Paystack withdrawal path completely intact, but add a second, parallel way for a withdrawal to
actually get paid — a platform admin reviews the request, sends the money by hand, and marks it
settled — so withdrawals can work today, before that verification is done.

- **`supabase/history/62_migration_manual_withdrawals.sql`** (folded into `supabase/schema.sql`)
  — adds `withdrawals.method` (`'paystack' | 'manual'`) and `withdrawals.admin_note`;
  `create_manual_withdrawal_locked` (the manual-path sibling of `create_withdrawal_locked` from
  the Phase economy security audit — identical advisory-lock/balance-check shape, service-role-only
  the same way); and `admin_list_pending_manual_withdrawals`/`admin_settle_manual_withdrawal`,
  gated by the existing `is_inkroot_admin()` flag from the Inkroot Events Admin phase. A manual
  request reserves the writer's balance under the exact same lock key as everything else that
  touches it — Paystack and manual withdrawals can't double-spend against each other.
- **`supabase/functions/manual-withdraw/index.ts`** — the manual-path sibling of
  `paystack-withdraw`, minus any call to Paystack's `/transfer`. Also best-effort pings a Telegram
  chat (`TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` secrets — see `PAYMENTS.md`'s new section) so the
  admin doesn't have to keep the queue open; a missing token or a failed send never blocks the
  withdrawal itself, since the in-app queue is the real source of truth either way.
- **`src/admin/manual-withdrawals-admin.jsx`** — the review queue: mark paid, or reject with a
  reason (which returns the reserved amount to the writer's balance immediately —
  `author_balance_kobo` only ever counts `pending`/`success` withdrawals). Wired in exactly like
  Inkroot Events Admin — a new `⚑ Manual Withdrawals admin` button on `WriterIdentityCard`, gated
  the same way, same `isPlatformAdmin` flag, same server-side re-check regardless of what got the
  screen open.
- **`src/lib/payments.js`** — `requestManualWithdrawal`, `adminFetchPendingManualWithdrawals`,
  `adminSettleManualWithdrawal`, and one new constant, `ACTIVE_WITHDRAWAL_METHOD = 'manual'` — the
  single switch `WithdrawModal` (`creator-dashboard.jsx`, shared by both the Creator Dashboard and
  Guild Member Earnings) checks to decide which Edge Function a withdrawal actually calls. Flip it
  back to `'paystack'` once the business is verified; nothing else changes. Also added an honest
  note to the withdrawal confirmation screen ("reviewed and sent by hand \u2014 not instant") so a
  writer isn't expecting the same turnaround as an automatic transfer.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser, no real Telegram bot to confirm a message actually arrives.
Syntax-checked every touched/new JS/JSX/TS file with `node --check`; read every line of the new
SQL closely rather than running it.

## Phase 18 — stale purchasing copy fixed, and Most Read / Trending wired up for real — done

Closed three more gaps flagged in earlier phases' own "still honestly Coming Soon, unchanged"
notes:

- **The two stale "purchasing is coming soon" spots Phase 16 flagged and left alone** —
  `LibraryQuickActions`'s header comment (`publishing.jsx`) and the Discover screen's own note
  (`grand-library-screen.jsx`) — are fixed. Both now correctly describe the real Paystack-backed
  Buy/Tip flow (`checkoutBook`) instead of claiming it doesn't exist. The Discover screen's note
  also now states the actual reading model plainly (every book is readable in full regardless of
  price; buying supports the author) rather than implying reading itself might one day require a
  purchase — if reading should actually be gated behind purchase for priced books, that's a
  separate, bigger decision (a real access check on `onReadFull`, not a copy fix) and hasn't been
  made here.
- **The Grand Library's Most Read shelf** was a `ComingSoonShelf` despite `fetchMostRead()`
  (`src/lib/book-rankings.js`, `compute_most_read()` — migration 39) already existing and already
  used elsewhere (Living Universe). Wired it into the shelf for real: each ranked id is hydrated
  via `fetchPublishedBookById` (cover/subtitle/price aren't in the ranking row itself), kept in
  its own map rather than merged into the local `books` list so a book by another author still
  resolves correctly when opened. New `most_read` book-view-analytics source (migration 63) so
  these opens are tracked distinctly rather than falling into `direct`.
- **Trending, for the first time anywhere in this app, is real.** Migration 64 adds
  `compute_trending()` — deliberately a lighter, faster-decaying signal than Best Sellers/Most
  Read (a 72-hour lookback with an 18-hour half-life, versus their 90-day/5-day), reading
  `book_view_events` (any visit, signed in or anonymous) rather than a verified-purchase or
  once-daily-capped-read table. Still hard to fake outright: self-views are excluded, and a book
  only qualifies once a minimum number of distinct *signed-in* viewers have looked at it recently
  — anonymous traffic can nudge an already-qualifying book's score a little but can never
  single-handedly manufacture a Trending listing. Wired into both the Grand Library's Trending
  shelf (new `trending` analytics source, same hydration approach as Most Read above) and Living
  Universe's "Trending Now" section, which — unlike every other section on that screen — had been
  showing `useLuTrending()`'s entirely fictional, randomly-jittering simulation without ever
  labeling it as such. It now shows the real ranking when available, with the same simulation as
  an honest fallback (and its own header comment explaining that's all it ever was) when it isn't.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched JS/JSX file with `node --check`;
read every line of the new SQL closely rather than running it.

## Phase 19 — real Members Online presence for Player Guilds — done

Closed the "Presence/online-status tracking for guilds" gap `ARCHITECTURE.md` had flagged as not
implemented since it was first written.

- **`subscribeGuildPresence(guildId, selfName, onSync)`**, new in `src/lib/player-guild.js`, is a
  Supabase Realtime Presence channel keyed `guild-presence:${guildId}` — deliberately not a
  stored/polled `last_seen` column. Presence is session state, not guild data: a writer is online
  for exactly as long as some tab of theirs has the channel's socket open, and Realtime's own
  heartbeat expires their entry the moment that socket closes, so there's nothing to write, poll,
  or let go stale. Signed-out callers get a single `onSync(new Set())` and no channel at all, same
  honesty policy every other `lib/*.js` wrapper follows. No migration — presence channels need no
  table or publication entry, unlike the Fireside's `postgres_changes` subscription.
- **One subscription per guild, shared.** `src/shell/home-screen.jsx` subscribes once (keyed off
  the same `remoteGuildId` that already scopes `guild_member_stats`) and passes the resulting
  `Set` of online user ids down as `onlineCount` to `GuildBanner`'s Members Online plaque and
  `onlineUserIds` to `PlayerGuildRoster`, rather than each opening its own channel for the same
  guild.
- **`computeMembersOnline(guild)`** (`guild-progression.jsx`), a pure function that always
  returned `null`, is removed — presence isn't derivable from a guild record, so it didn't belong
  in that file's guild-in/number-out pattern the way Reputation does.
- **Player Guilds only, honestly.** Founder Guilds have no real `guild_members`-style roster to
  key a channel off of (same limitation `sumGuildMemberStats` already documents), so
  `GuildBanner` still shows "not yet chronicled" there — `onlineCount` is `null` for a Founder
  Guild rather than a fabricated number.
- **`PlayerGuildRoster`'s member pills** now carry a live green/grey dot (same visual language as
  `MemberCard`'s own avatar dot), reflecting the shared presence Set in real time as members'
  tabs open and close.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser, and no second signed-in device to watch a presence dot flip live.
Syntax-checked every touched JS/JSX file with `node --check`.

## Phase 20 — Members Online presence for Founder Guilds too — done

Phase 19 above shipped presence for Player Guilds and left Founder Guilds honestly showing "not
yet chronicled," on the belief they had no real member roster to key a channel off of. That
belief was stale: `founder_guild_members` has held every Founder Guild's real join/leave history
since Phase 8 (`syncFounderGuildMembership`/`leaveFounderGuildMembership` in
`src/lib/library-guild.js`) — it just existed purely as an RLS gate for Fireside/Bookshelf, and
nothing in the UI had ever read it back as an actual member list.

- **`fetchFounderGuildMembers(guildId)`**, new in `src/lib/library-guild.js`, mirrors Phase 5's
  `fetchPlayerGuildMembers` — same profiles-backed name lookup, reading `founder_guild_members`
  instead of `player_guild_members`. No `role` column on that table (every Founder Guild member
  stands equal; only a Player Guild has treasurer/officer distinctions), so rows come back as
  plain membership, not roles.
- **`FounderGuildRoster`**, new in `src/guild/guild-hall.jsx`, is `PlayerGuildRoster`'s Founder
  Guild counterpart. Both now share a `GuildMemberPills` renderer for the actual pill row (green/
  grey presence dot + name) rather than duplicating that JSX, and differ only in which fetch
  function backs them.
- **`home-screen.jsx`'s presence subscription** now keys off a Founder Guild's own id
  (`guildProfile.founderGuildId`) when that's the active guild type, not just the Player-Guild-
  only `remoteGuildId` used for `guild_member_stats` — a separate variable, `presenceGuildId`,
  since `remoteGuildId` staying `null` for Founder Guilds is still correct for that other system
  (no real `guild_member_stats` aggregation for them yet — that limitation is real, not stale).
  Renders `FounderGuildRoster` instead of `PlayerGuildRoster` when `isFounderView`.
- **`GuildBanner`'s Members Online plaque** now gets a real `onlineCount` for both guild types.
- **Not touched, deliberately:** the Guild Order's own roster (`src/guild/guild-order.jsx`) still
  shows a deliberately-labelled simulated cast for a Founder Guild — that's a much larger, separate
  system (roles, a shared manuscript, anthology submissions, Council votes, all attributed to
  simulated other members) than the Guild Hall's own roster/presence gap this closes, and this
  fix doesn't touch it or its own HONESTY NOTE.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser. Syntax-checked every touched JS/JSX file with `node --check`.

## Phase 21 — real roster + real shared manuscript for the Guild Order — done

The Guild Order's own HONESTY NOTE has said since it was written that "swapping the simulated
roster/seed content for real members later only touches goBuildRoster and the `*_SEED`
constants." This phase does that for the Roster and Manuscript tabs, for both guild types —
World Bible, Workshop, Competition, and (Founder Guild only) Anthology/Treasury are untouched and
still simulated, on purpose; see the file's own HONESTY NOTE for the current breakdown.

- **Real roster.** `useGoRealRoster` (new, `guild-order.jsx`) fetches the actual guild membership
  — `fetchFounderGuildMembers`/`fetchPlayerGuildMembers`, the same real fetchers Phase 19/20's
  Guild Hall roster already uses — instead of the deterministic fake NPC cast. Each real member's
  rung is genuinely derived, not copied from the simulated system: a Founder Guild member's from
  their own quality-length published book count via the same public Reputation signal
  AuthorsHallScreen uses for someone else's Hall (`goRealFounderRung`); a Player Guild member's
  from the already-real `owner_id`/`player_guild_members.role` fields
  (`goRealPlayerRung`) — no new schema needed there at all.
- **Real shared manuscript.** New migration 65 adds `guild_order_chapters` (the chapter list —
  title, status, proposer) and `guild_order_passages` (an append-only log of real prose, each
  attributed to whoever actually wrote it — deliberately not one shared mutable `content` field,
  which would silently clobber between two real people editing at once and erase who-wrote-what).
  `src/lib/guild-manuscript.js` is the thin client wrapper; `GoManuscriptTab` is a full rewrite —
  propose a chapter, add a passage, send to review, approve — all real server round-trips now,
  not `state.manuscriptNotes`/`state.manuscriptStatus` written to this device's own local
  `storage` (both keys removed from `goDefaultState`).
- **Approving a chapter has real teeth.** RLS on `guild_order_chapters` lets any real member
  advance a chapter to "in review", but only lets it reach "approved" for someone with genuine
  standing: a Player Guild's owner/treasurer/officer (reusing Phase-16-era
  `player_guild_members.role`, already RLS-authoritative), or a Founder Guild member with at
  least one quality-length (15,000+ word) published book. That bar is deliberately a simple,
  cheap, real SQL check — not a second copy of `author-reputation.jsx`'s full diminishing-returns
  Reputation formula, which would be duplicated business logic that could quietly drift from the
  client's own. Every other write (propose, add a passage, retitle, send to review) just needs
  real membership.
- **Deliberately not real-time.** Unlike the Fireside, nobody sees another member's new chapter or
  passage the instant they post it — the manuscript refetches on open and after your own actions,
  not via a Realtime subscription. Scope was "real," not "live," for this pass.
- **Deliberately inconsistent with the older Anthology/Treasury precedent, on purpose.** Those two
  tabs already had a real/simulated split, but only for a Player Guild — a Founder Guild still
  falls back to `GoAnthologyTabSimulated`/`GoTreasuryTabSimulated` there. Roster and Manuscript
  don't get that fallback: both are real for both guild types unconditionally, so opening either
  tab as, say, the very first real member of a Founder Guild shows an honestly sparse "you're the
  first" / "no chapters yet" state rather than a rich fake one. That's a deliberate continuation
  of Phase 20's own direction (make the Founder Guild side real, not just the Player Guild side),
  not an oversight.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser, and no second signed-in account to actually co-write a chapter
with. Syntax-checked every touched JS/JSX file with `node --check`; read every line of the new SQL
closely rather than running it.

## Phase 22 — live sync for the Guild Order manuscript — done

Phase 21 above made the manuscript real but explicitly not live, on the stated grounds that scope
was "real," not "live," for that pass. This phase closes that gap the same way the Fireside
already works.

- **Migration 66** adds `guild_order_chapters` and `guild_order_passages` to the
  `supabase_realtime` publication — no RLS changes; Realtime respects the same row-level security
  migration 65 already put in place, so a subscriber only ever receives change events for rows
  they could already `select`.
- **`subscribeGuildManuscriptRealtime(guildType, guildId, onChange)`**, new in
  `src/lib/guild-manuscript.js`, mirrors `subscribeFiresideRealtime` (`lib/library-guild.js`)
  closely: a server-side `guild_id=eq.` filter on `guild_order_chapters` (a Founder Guild's fixed
  key and a Player Guild's real uuid can't collide in practice, so a single-column filter is
  enough, same reasoning `fireside_posts`' own filter relies on), and a client-side `chapterIds`
  Set gating the unfiltered `guild_order_passages` stream — passages carry no `guild_id` of their
  own, same situation `fireside_reactions` was already in.
- **`GoManuscriptTab`** subscribes on mount (and whenever `guildType`/`guildId` changes),
  unsubscribing on unmount; any change just calls the tab's existing `reload()` rather than
  patching individual rows in, matching the Fireside's own "cheap to recompute, simpler than
  merging partial payloads" reasoning.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser, and no two signed-in devices open at once to actually watch a
passage appear live on one while typed on the other. Syntax-checked every touched JS/JSX file
with `node --check`; read the new migration closely rather than running it.

## Phase 23 — a real, live Book Discussion Hall — done

`DiscussionHallModal`'s own comment (`grand-library-cards.jsx`) said since it was written: "a
real, working thread of the reader's own posts about a book, kept on this device... honestly
marked as device-local until Inkroot has a shared backend to carry every reader's posts to every
device." This phase is that backend — real and live from the start, unlike the Guild Order
manuscript (Phase 21/22), which shipped real-but-not-live first and got Realtime as a separate
follow-up pass.

- **Migration 67** adds `book_discussion_posts`, modeled closely on `reviews` immediately above
  it in `schema.sql`: `book_id text references published_books(id)` (that table's `id` is text,
  not uuid — it's the app's own local project id), open `select` for anyone, insert/delete gated
  to the post's own author, the same `is_banned()` check `reviews`' insert policy already uses.
  Unlike `reviews` (one row per reader per book, upserted), this is an ongoing conversation — no
  uniqueness constraint, no update policy, a reader can post as many times as they like, same as
  a Fireside post or a Guild Order passage.
- **Live from the start.** `book_discussion_posts` is in the `supabase_realtime` publication in
  the same migration (not a separate follow-up), and `subscribeBookDiscussionRealtime`
  (`src/lib/library.js`) is a straightforward `postgres_changes` filter on `book_id` — simpler
  than the Guild Order manuscript's or the Fireside's own reactions stream, since every post
  already carries the one column needed to filter server-side; there's no join-based second table
  to gate client-side here.
- **`DiscussionHallModal`** is a full rewrite of the same UI — fetch, post, and a live
  subscription that reloads on any change, replacing `state.posts`/`readLibraryDiscussions()`
  entirely. `LIBRARY_DISCUSSIONS_KEY`/`readLibraryDiscussions`/`writeLibraryDiscussions`
  (`publishing.jsx`) are removed.
- **The "Book Discussion Halls" shelf** (`grand-library-screen.jsx`) is real too now, not just the
  modal: `fetchMostDiscussedBooks` ranks by real post count and each id is hydrated via
  `fetchPublishedBookById`, the same ranked-then-hydrate shape Most Read and Trending
  (`book-rankings.js`) already use — deliberately that shape and not a
  `fetchDiscussionCounts(bookIds)`-style local lookup, since this device's own `books` list is
  just its own writer's published catalog (there's no cross-author "browse everyone's books"
  fetch in this app) and Most Read/Trending already establish that a ranked shelf routinely
  surfaces another author's book by id, hydrated on demand, rather than only ever showing books
  already known locally.

As with every earlier phase, I could not run any of this myself — no Supabase project, no
`npm install`, no real browser, and no second signed-in reader to actually watch a post appear
live while typing from a different account. Syntax-checked every touched JS/JSX file with
`node --check`; read the new migration closely rather than running it.

