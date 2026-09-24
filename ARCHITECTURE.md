# Inkroot — Architecture Map

> Read this file first, before opening any source file. It exists so a task can be scoped to
> 1–5 files instead of scanning all ~115 `src/` files + ~70 SQL migrations. Update it in the same
> PR/session whenever you add, rename, split, or delete a file — a stale map costs more tokens
> than no map.

## Stack
React 18 + Vite, no router (custom nav stack), Supabase (Postgres + Auth + Storage + Edge
Functions) as the only backend, IndexedDB (via `idb`) as the local-first data store. Paystack for
Naira payments. No TypeScript in `src/` (Edge Functions in `supabase/functions/` are `.ts`).

## How the app is layered
```
main.jsx → src/shell/inkroot-app.jsx → src/shell/ink-root.jsx (InkRoot: top-level state + routing)
                                              │
                    ┌─────────────────────────┼─────────────────────────┐
              shell/home-screen        writing/project-workspace   library/* + guild/*
              (dashboard, nav in)      (the manuscript editor,     (Grand Library, Author's
                                        tabs in writing/            Hall, Guild Hall, Living
                                        project-workspace/*)        Universe — social/public)
```
- **Local-first always.** Every read/write hits IndexedDB immediately via `src/lib/storage.js`.
  Nothing blocks on the network.
- **Sync is opt-in.** Signed-in only. `src/lib/syncEngine.js` pushes/pulls against Supabase's
  `kv_store` table, last-write-wins by a server-stamped `version` column (not a client clock).
- **Social/money features require sign-in** and live behind thin wrapper functions in `src/lib/*`
  that call Supabase directly (RLS-enforced) or an Edge Function for anything Paystack-related.
  Every wrapper fails honestly (returns null/empty, never fakes data) when signed out or offline.

## Directory map

| Path | What lives here |
|---|---|
| `src/shell/` | App shell: top-level state (`ink-root.jsx`), the Home dashboard (`home-screen.jsx`), nav stack + breadcrumbs (`nav-context.jsx`), sync status UI (`sync-context.jsx`, `sync-status-indicator.jsx` — a small red/green online-status dot, rendered Home-only by `home-screen.jsx`, not mounted globally by `inkroot-app.jsx` — `account-sync-control.jsx`, `account-restriction-banner.jsx`), icon set (`ink-icon.jsx`). |
| `src/writing/` | The manuscript editor and everything project-local: `project-workspace.jsx` is the tab shell; each tab's actual content is split into `src/writing/project-workspace/tab-*.jsx` (hub, manuscript, characters, locations, world, maps, timeline, glossary, notes, progress, health, packs, achievements, settings). Also: `chapter-editor.jsx`, `import-export.jsx` + `pdf-import.js`/`pdf-export.js`, `templates.jsx`, `addon-studio.jsx`, `achievements.jsx`, `health-checks.jsx` (broken-mention-link checker), `backup-history-panel.jsx`, `project-schema-and-backups.jsx` (schema version + defaults), `reading-and-sound-settings.jsx`, `coming-soon-notice.jsx` (shared placeholder for not-yet-backed features). |
| `src/worldbuilding/` | Worldbuilding UI used inside the project workspace tabs: `family-graph.jsx`/`family-tree-gallery.jsx`/`relationship-web.jsx` (relationships), `maps-section.jsx`/`interactive-map-frame.jsx`/`location-types.jsx`/`travel-and-distance.jsx` (maps), `book-cover.jsx`, `world-bible-browse-list.jsx`. |
| `src/library/` | Public/social reading side: `grand-library-screen.jsx` + `grand-library-cards.jsx` (browse/buy books, Creator Dashboard's `CreatorAnalyticsPanel`), `authors-hall-screen.jsx` + `author-identity.jsx` + `author-reputation.jsx` (author profiles, follow, reputation), `publishing.jsx` (publish flow + favorites), `creator-dashboard.jsx` (earnings, bank account, withdrawals, analytics), `referral-dashboard.jsx` (Creator Studio referral tab — screen for `src/lib/referrals.js`), `living-universe-screen.jsx` (rankings/discovery hub), `inbox-and-living-universe.jsx` (notifications inbox + feed). |
| `src/guild/` | Founder Guilds (10 fixed lore guilds) and Player Guilds (user-created): `guild-hall.jsx` (also home of `GuildAnthologyShelf` — the real, wired-to-`guild_anthologies` bookshelf shown in the Guild Hall, Player Guilds only), `guild-library.jsx`, `guild-order.jsx` (roles/permissions, roster, the real Manuscript tab, the simulated World Bible/Workshop/Competition/Treasury-fallback tabs, and `GoAnthologyOverviewSimulated` — the simulated Anthology content `guild-anthology.jsx`'s own simulated workspace embeds), `guild-anthology.jsx` (both the real AND simulated Guild Anthology landing page + per-anthology Overview/Manuscript/World Bible workspace the Anthology tab and the Hall's shelf link out to — `GuildAnthologyScreen` routes between them on `remoteGuildId`; both built on `guild-order.jsx`'s `GoManuscriptTab`/`GoWorldBibleTab`/`GoCoverPicker`/`GoAnthologyOverviewSimulated` rather than a second editor or World Bible), `guild-treasury-admin.jsx`, `guild-member-earnings.jsx` (a member's own held earnings in one guild's treasury — view + withdraw to their cross-guild balance; see 41_migration_guild_member_earnings_withdrawal.sql), `guild-progression.jsx`, `guild-reputation-panel.jsx`, `guild-events-*.jsx`/`guild-event-detail-screen.jsx`, `guild-book-feedback-modal.jsx`, `guild-feedback.jsx`, `fireside-board.jsx` (guild chat/posts), `guild-public-profile-screen.jsx`, `guild-building-art.jsx` (SVG art for the 10 guild halls). |
| `src/admin/` | `inkroot-events-admin.jsx` — platform-run event admin screen; `manual-withdrawals-admin.jsx` — reviews/settles manual (non-Paystack-Transfer) withdrawal requests. |
| `src/moderation/` | `moderation-queue.jsx` — content report review screen, backed by `src/lib/moderation.js`. |
| `src/lib/` | All Supabase-talking logic, one concern per file: `auth.js` (Google + passkey only), `storage.js` (IndexedDB), `syncEngine.js`, `supabaseClient.js`, `library.js`/`library-guild.js` (publish/review/follow), `payments.js` + `mediaStorage.js`, `guild-treasury.js`, `guild-anthologies.js`, `guild-events.js`, `guild-progression-remote.js`, `guild-rankings.js`, `rising-stars.js`, `book-rankings.js` (Best Sellers/Most Read), `referrals.js`, `naira-achievements.js`, `moderation.js`, `reports.js`, `profile.js`, `player-guild.js`, `account-deletion.js`, `idb.js`, `analytics.js` (book-view tracking — Creator Dashboard's Analytics tab). **Every ranking/reputation/achievement number is computed server-side in SQL** (see matching migration) — these files are thin honest-failing wrappers, never local computation. |
| `src/shared-ui/` | Reusable presentational components: `ui-primitives.jsx`, `ui-cards.jsx`, `form-fields.jsx`, `icons.jsx`, `image-utils.jsx`, `report-content-modal.jsx`, `messaging-safety-banner.jsx` (anti-impersonation piece 4/4). |
| `src/shared-utils/` | Pure helpers: `storage-keys.jsx`, `identity-safety.js` (anti-impersonation piece 1), `device-signal.js` (piece 6), `sanitize-html.js`, `strip-html.jsx`, `truncate.jsx`, `format-bytes.jsx`, `format-duration.jsx`. |
| `supabase/functions/` | Edge Functions (Deno/TS), mostly Paystack-related: `paystack-init-purchase`, `paystack-init-event-entry`, `paystack-init-hosting-fee`, `paystack-webhook`, `paystack-banks`, `paystack-resolve-account`, `paystack-save-bank-account`, `paystack-withdraw`, `platform-fee-info` (Paystack functions are deployed independently, so `_shared/payments.ts` helpers such as `fetchAllNigerianBanks` are inlined into each function that uses them — keep the copies identical), plus `manual-withdraw` (the non-Paystack-Transfer withdrawal path — see PAYMENTS.md) and `_shared/payments.ts`. |
| `supabase/history/` | Numbered migrations `01_...` → `142_...` + `schema_phase*.sql`, applied in order after the base `supabase/schema.sql` (not included in this map — see its own header/README in that folder for the fixed, current-state schema). |
| `supabase/tests/` | Hand-run SQL test scripts (each runs in a transaction that rolls back), one per migration that has one — currently `140_pending_deletion_blocks_guild_founding.test.sql` `141_reserved_profile_names.test.sql` and `142_unique_profile_names.test.sql`. There is still no automated test runner; see the header of each file for how to run it. |
| `legal/` | `terms-of-service.md`, `privacy-policy.md`. |
| `scripts/` | `move-project-images-to-private-bucket.mjs` — one-off migration script. |

## Where to make common changes
- **A screen's content/UI** → the matching `src/{library,guild,writing,worldbuilding,shell}/*.jsx`. Most files are self-contained; check the top-of-file comment for cross-file dependencies before editing.
- **A project-workspace tab** → `src/writing/project-workspace/tab-<name>.jsx`, not `project-workspace.jsx` itself (that's just the shell).
- **Anything touching Supabase (queries, RPCs, writes)** → the matching `src/lib/*.js`, never inline in a component.
- **A new/changed DB table, column, RLS policy, or SQL function** → add a new numbered file in `supabase/history/`, then fold it into `supabase/schema.sql`; update the matching `src/lib/*.js` wrapper.
- **Payments (Paystack)** → `src/lib/payments.js` (client) + `supabase/functions/paystack-*` (server) + `supabase/functions/_shared/payments.ts` (fee constant, shared logic). See `PAYMENTS.md`.
- **Anti-impersonation / safety** → the 6-piece system spans `shared-utils/identity-safety.js`, `schema.sql`'s `profiles.verified`, `lib/reports.js`, `shared-ui/messaging-safety-banner.jsx`, `lib/profile.js`, `shared-utils/device-signal.js` — check all six before changing any one.
- **Nav/breadcrumbs** → `src/shell/nav-context.jsx` + `src/shell/nav-labels.jsx`.
- **Referrals** → `src/lib/referrals.js` (client) + `src/library/referral-dashboard.jsx` (UI) + `supabase/history/55-58_migration_referral_*.sql` (backend).
- **Guild presence ("Members Online")** → `subscribeGuildPresence` in `src/lib/player-guild.js` (client, no backend/migration involved — it's a Realtime Presence channel, not a table) + the subscription in `src/shell/home-screen.jsx` + `GuildBanner`/`PlayerGuildRoster`/`FounderGuildRoster` in `src/guild/guild-hall.jsx` (UI). Both guild types — `fetchFounderGuildMembers` (`src/lib/library-guild.js`) backs the Founder Guild roster off `founder_guild_members`.
- **Guild Order roster/manuscript** → `src/guild/guild-order.jsx` (`useGoRealRoster`, `GoRosterTab`, `GoManuscriptTab`, `goRealFounderRung`/`goRealPlayerRung`) + `src/lib/guild-manuscript.js` (client, including `subscribeGuildManuscriptRealtime`) + `supabase/history/65_migration_guild_order_manuscript.sql` (`guild_order_chapters`/`guild_order_passages`) + `supabase/history/66_migration_guild_order_manuscript_realtime.sql` (live sync — both tables added to the `supabase_realtime` publication). Both guild types, and live. `GoManuscriptTab`/`GoWorldBibleTab` are also reused as-is by the real Guild Anthology workspace's own Manuscript/World Bible tabs (see below) — the guild's one shared writing desk and lore shelf, not a second copy per anthology. World Bible/Workshop/Competition/Anthology(Founder)/Treasury(Founder) in `guild-order.jsx` are still simulated — don't assume those are real too.
- **Book Discussion Hall** → `src/lib/library.js` (`fetchBookDiscussion`/`postBookDiscussion`/`deleteBookDiscussionPost`/`subscribeBookDiscussionRealtime`/`fetchMostDiscussedBooks`) + `DiscussionHallModal` (`src/library/grand-library-cards.jsx`) + the "Book Discussion Halls" shelf (`src/library/grand-library-screen.jsx`, ranked-then-hydrate-via-`fetchPublishedBookById`, same shape as Most Read/Trending) + `supabase/history/67_migration_book_discussion_hall.sql` (`book_discussion_posts` table + `most_discussed_books()` RPC). Real and live from the start (unlike the Guild Order manuscript, which shipped real-but-not-live first).
- **Guild Anthologies** → `src/lib/guild-anthologies.js` (client) + `src/guild/guild-hall.jsx`'s `GuildAnthologyShelf` (the browse/entry-point bookshelf, rendered in the Guild Hall, real and Player-Guild-only — renders nothing for a Founder Guild) + `src/guild/guild-anthology.jsx`'s `GuildAnthologyScreen` (the shared entry point, routing on `remoteGuildId` to either `GuildAnthologyWorkshop` — the real landing page: anthology list, empty state, Start an Anthology, publish-an-existing-project, plus the per-anthology Overview/Manuscript/World Bible workspace — or `GuildAnthologyWorkshopSimulated` — the SAME landing-page/workspace shell, minus Start/Publish, carrying a Founder Guild's/signed-out/offline session's one deterministic preview anthology instead; both reuse `GoManuscriptTab`/`GoWorldBibleTab`/`GoCoverPicker`/`GoAnthologyOverviewSimulated` from `guild-order.jsx` rather than reinventing any of them) + `supabase/history/35_migration_guild_anthologies.sql` + `36_migration_guild_anthology_revenue_agreements.sql` + `91_migration_anthology_submission_content.sql` (a submission's actual manuscript — `loadProjectManuscriptContent` in `guild-anthology.jsx` reads it from this device's own local project at submit/edit time, the same `storage`/`projectKey` singletons `ink-root.jsx` uses for a solo publish; `publish_guild_anthology()` assembles every approved contributor's into the anthology's one `published_book_content` row, so it's actually readable). Only the real path is backed by `guild_anthologies`; the simulated one is still local-device-only, exactly as it always was — see `GuildAnthologyWorkshopSimulated`'s own header comment for why it doesn't get Start/Publish too.
- **Book-view analytics** → `src/lib/analytics.js` (client, `recordBookDetailView`/`recordBookReadStart`/`fetchBookViewSummary`) + `CreatorAnalyticsPanel` in `src/library/grand-library-cards.jsx` (UI) + `supabase/history/60_migration_book_view_analytics.sql` (backend). A new "a reader looked at/started reading a book" entry point needs its own `recordBookDetailView`/`recordBookReadStart` call, tagged with the closest-matching `BOOK_VIEW_SOURCES` value (add a new one, plus a migration updating `book_view_events`' `source` check constraint, if none fits).

## Not yet implemented (don't assume these exist)
Combined multi-item cart checkout, purchasing Worldbuilding Packs or Guild-only listings.
`src/writing/coming-soon-notice.jsx` is the shared placeholder used everywhere one of these gaps
shows up in the UI — search for its usage before building a feature that assumes the gap is
filled.

The Book Discussion Hall is real now, not device-local — see `book_discussion_posts` (migration
67), `fetchBookDiscussion`/`postBookDiscussion`/`subscribeBookDiscussionRealtime`/
`fetchMostDiscussedBooks` (`src/lib/library.js`), and `DiscussionHallModal`
(`src/library/grand-library-cards.jsx`). Live, via the same Realtime mechanism as the Fireside
and the Guild Order manuscript.

Presence/online-status tracking for guilds is real now, for **both** guild types — see
`subscribeGuildPresence` in `src/lib/player-guild.js` (a Supabase Realtime Presence channel, not a
stored/polled value), subscribed once in `src/shell/home-screen.jsx` and passed down to
`GuildBanner`'s Members Online plaque and `PlayerGuildRoster`/`FounderGuildRoster`'s per-member
dots. A Founder Guild's roster is backed by the real `founder_guild_members` table via
`fetchFounderGuildMembers` (`src/lib/library-guild.js`) — that table existed as an RLS gate since
Phase 8 but was never read back as an actual member list until this fix.

The Guild Order's (`src/guild/guild-order.jsx`) Roster and Manuscript tabs are real now too, for
both guild types — see that file's own HONESTY NOTE for the current, updated breakdown of what's
real vs simulated there. World Bible, Workshop, Competition, and (for a Founder Guild only)
Anthology/Treasury remain deliberately simulated, each still clearly labelled as such in its own
tab.

## Docs in this repo
- `README.md` — end-user setup (Supabase project, env vars, running migrations, enabling auth providers).
- `PAYMENTS.md` — Paystack setup, separate from the base setup above.
- `ARCHITECTURE.md` — this file.
- `CLAUDE.md` — commands, code-style conventions (notably: `React.createElement`, not JSX syntax, everywhere), and backend/migration conventions. Read alongside this file, not instead of it.
- `supabase/history/` — migration history, read only if debugging a specific migration's origin.
