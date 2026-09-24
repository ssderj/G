# Inkroot — Consolidated Fix Tracker (v12 addendum — prize distribution review)

Findings from a checklist-driven review of the guild-event prize distribution pipeline
(`submit_guild_event_results`, `compute_guild_event_placements`, `approve_guild_event_results`,
`settle_guild_event`, `distribute_guild_revenue`), all fixed additively with no signature
changes — existing grants carry over unchanged.

1. **Duplicate winner slots (migration 134).** Neither the legacy organizer-declared path
   (`submit_guild_event_results`) nor `settle_guild_event` itself checked that the same
   `contributor_id` wasn't listed under two different winner slots — only that each `place`
   number and each declared share of the pool was used once. Not a way to overpay (the bps
   total was still capped), but it let one person be declared, say, both 1st and 2nd place.
   Fixed in both places: `submit_guild_event_results` for an early, friendly rejection, and
   `settle_guild_event` as the authoritative gate covering every caller (computed or
   organizer-submitted). Also added, in the same migration: `admin_settle_inkroot_event()`, a
   missing in-app, audit-logged settlement path for `host='inkroot'` cash-prize events —
   `settle_guild_event`'s own logic already allowed an `is_inkroot_admin()` caller through, but
   its `revoke all ... from authenticated` blocked every client call regardless, so there was no
   way to actually use that path from the app.

2. **No caller-authorization check on `compute_guild_event_placements` (migration 135).** The
   judged-event placement computation had *no* identity check at all — any signed-in user could
   trigger it for any guild's event, force-writing (or overwriting) a `'computed'`
   `guild_event_results` row. The function's own header comment already documented the intended
   caller set — "the organizer, a guild authority, or Inkroot" — it was just never implemented.
   Restricted to exactly those three.

3. **Configured winner count could silently collapse (migration 136).**
   `propose_guild_event_objective_config` validated that `placement_split_bps`'s `share_bps`
   values summed to exactly 10000, but never checked that its `place` values were distinct. Two
   entries at the same place (still summing to 10000) would pass validation but, in
   `compute_guild_event_placements`'s join, both match the single real winner at that place —
   the configured "N winners" quietly pays out as fewer. Now rejected at proposal time, before
   an event is ever activated or judged.

Full detail, rationale, and verification queries:
`supabase/history/134_migration_prize_distribution_hardening.sql`,
`135_migration_compute_placements_authorization.sql`, and
`136_migration_placement_split_unique_place.sql`.

---

# Inkroot — Consolidated Fix Tracker (v11 addendum — contributor-funded escrow)

New capability, not a bug fix: a guild event's `guaranteed_prize_kobo` could previously only be
funded one way — `deposit_guild_event_prize_escrow()` (migration 108) debits the WHOLE amount from
the guild's own pooled treasury in a single lump transaction, with no record of whose money it
was. There was no way to express "Member A is staking ₦30,000 of this prize and Member B is
staking ₦5,000," and no proportional-share accounting to audit for that scenario.

Added `guild_events.funding_mode` (`'treasury'` default = migration 108's existing behavior,
unchanged; `'contributors'` = new) plus:
- `contribute_to_guild_event_escrow()` — a member locks part of their own verified balance into
  one event's prize, capped so the ledger can never exceed `guaranteed_prize_kobo`.
- `guild_event_escrow_contribution_shares()` — derives (never stores) each contributor's
  `share_bps` from the immutable ledger, floor + largest-remainder so shares always sum to
  exactly 10000 bps regardless of how awkward the amounts are (verified against ₦1/₦3/₦7/₦33,333).
- `refund_guild_event_escrow_contributors()` — on cancellation, returns each contributor exactly
  their own `amount_kobo` (no rounding possible — it's just their own integer read back), wired
  into both `cancel_guild_event()` and `admin_cancel_guild_event_dispute()` (migration 132).
- `pay_guild_event_escrow_contributors()` — optional revenue-share payout at settlement, same
  floor + largest-remainder technique applied to the payout pool. **Not yet wired into
  `settle_guild_event()`** — what pool size to share (all of `guild_share_bps`? a fraction?) is a
  product decision the app owner still needs to make; see migration 131 section 8.

**Resolved (migration 133):** the app owner's call on the open settlement question — the
guaranteed prize still goes to winners in full from escrow, entry fees still credit the guild
treasury exactly as before (`settle_guild_event` untouched), and "members share the money" means
`pay_guild_event_escrow_contributors()` is an ordinary officer-authorized treasury spend, split by
contribution share_bps instead of paid to one payee. Fixed a real gap in the first draft of that
function while wiring this in: it credited contributors but never wrote the matching guild-bucket
debit, so `guild_treasury_available_kobo()` never actually went down — the same
ledger-shows-money-as-both-spent-and-available failure mode this whole audit exists to catch.
Now debits under the same advisory lock / re-check-after-lock / rate-limit pattern
`spend_from_guild_treasury()` and `deposit_guild_event_prize_escrow()` already use.

Full detail, rationale, and verification queries: `supabase/history/131_migration_guild_event_contributor_escrow.sql`,
`132_migration_wire_contributor_escrow_refunds.sql`, and
`133_migration_pay_contributors_debits_treasury.sql`. All additive/safe on a database that already
has migrations through 130 — no existing event or function's `'treasury'`-mode behavior changes.

---

# Inkroot — Consolidated Fix Tracker (v10 addendum, final production audit)

Static audit only (no live Supabase/Paystack/build available). Fixed and confirmed:
1. `supabase/schema.sql` (Migration 109 block): the `create or replace function activate_guild_event(...)`
   header line was missing, so a fresh install of schema.sql hit a syntax error. Restored. A scan of
   schema.sql and every history/*.sql file found no other malformed statement.
2. `download-book`: PDF generation threw on any character outside Windows-1252 (Yoruba/Igbo letters,
   the Naira sign, arrows, CJK, emoji) -- reproduced with pdf-lib 1.17.1. Text is now sanitized
   (`makePdfSafe`) before measuring/drawing. EPUB unaffected.
3. `paystack-webhook` / `paystack-withdraw`: transfer.* events matched only on paystack_transfer_code,
   which is written after Paystack's /transfer call returns, so an early webhook (or a failed code
   write) left a withdrawal pending forever. The webhook now also matches the transfer `reference`
   (the withdrawal row id, UUID-validated), and the code-write error is logged.
4. `lib/referrals.js`: a permanently rejected ?ref= code (invalid / self) stayed in localStorage and
   blocked any later valid link from being captured. Now cleared on the server's own (P0001) rejection.

5. `syncEngine.js`/`sync-status-indicator.jsx`: a rejected update no longer blocks the rest of the outbox and pull; the sync dot turns amber when something can't be backed up.
6. `author-identity.jsx`: motto input capped at 140 to match the database.
7. `sync-context.jsx`: removed a double URL-decode that could throw on a failed Google sign-in.

Open / to verify live: bank list uses perPage=100 with no pagination (paystack-banks,
paystack-save-bank-account); `follows` has no self-follow check (follower_id <> followee_id);
`stamp_report_resolution` is security definer without search_path.

---

# Inkroot — Consolidated Fix Tracker (v9)

Same purpose as v1–v8: hand Claude one item's "Prompt for Claude" block at a time in a fresh or
focused session. Verified against source in the current project zip.

**What changed from v8 — a fourth production-readiness audit walked every flow named by the app
owner end to end (Google auth, profile edit, manuscript save/sync, publishing, guild create/join,
following, reading, paid-book access, guild-only access, Paystack success/failed/cancelled,
duplicate webhook, refunds, withdrawals, insufficient balance, duplicate withdrawal, referral
rewards, achievement rewards) plus a deeper follow-on pass specifically re-checking every race
condition in the referral/achievement grant paths and the Founder/Player-guild book-access
unification.** Two confirmed stale-comment bugs were found and fixed (zero logic risk — see
"Fourth pass" below). One confirmed, real issue was found and then built in a same-session
follow-up: the Creator Dashboard's Published Books cards hardcoded Readers/Sales/Earnings to "—"
for every book despite both real backends already existing elsewhere in the app — now wired to
real per-book data via a new, deliberately uncapped `fetchBookSalesSummary()` (see "Fourth pass"
for why the obvious shortcut, reusing the existing 50-row-capped `fetchSalesLedger()`, would have
silently undercounted a high-volume author). Every money-moving and access-gating path this
session re-checked directly against current source (`create_withdrawal_locked`/`create_manual_
withdrawal_locked`, `author_balance_kobo`, the webhook's three handlers, `redeem_referral_code`,
`grant_referral_reward`, `grant_naira_achievement`, `is_guild_book_member`) came back correct — no
new defect found there. **Nothing is open as of this version.**

**What changed from v7 — item 33, a real crash reported directly by the app owner, found and
fixed.** Tapping Publish from the Workshop (Author Studio) blanked the whole app. Root cause:
`PublishingWizard` assumes `project.chapters` is always a real array, but when opened from the
Workshop it's actually fed the lightweight project *index* entry, which never carries `chapters`
— only pre-computed summary fields. Two unguarded `project.chapters.length` reads threw on
render, and with no error boundary anywhere in the app, that uncaught exception unmounted the
entire tree. See "Recently completed, continued (12)" below for the fix, and the same entry for
a broader gap flagged but intentionally not fixed here (no error boundary exists anywhere in this
app — a future crash from any other cause would still blank the screen the same way). **Nothing
else is open as of this version.**

**What changed from v6 — item 31 was already fixed (this document just hadn't caught up), and a
final production audit found one more item (32), now also fixed.** A full end-to-end production
audit re-checked item 31's claim against current source and found `followAuthor`/`unfollowAuthor`
already check `error` and throw, and both call sites already gate the local toggle/count on
success with an `AlertDialog` on failure — the fix this document's own v6 "Still open" section
below describes as a "Prompt for Claude" had, in fact, already been made in the codebase by the
time v6 was written; the tracker simply wasn't updated to say so. Left the v6 section unedited
just below rather than quietly rewritten, so this document's history stays honest about carrying
a wrong "still open" claim for at least one version — same standing lesson this file has called
out twice before (see the correction above "Confirmed solid" near the bottom, and v3's rewrite
note). The same audit found one genuinely new (if minor) issue — **item 32, two cosmetic-but-
misleading gaps, now fixed** — see "Recently completed, continued (11)" below. **Nothing is open
as of this version.**

**What changed from v5 — item 30 is fixed; item 31 is the only thing left open.** Item 30 (a
published Guild Anthology was unreadable/undiscoverable by anyone but its own publisher) is now
closed — see "Recently completed, continued (10)" below. Item 31 (`followAuthor`/`unfollowAuthor`
swallowing errors) was not touched and is still open, with its own "Prompt for Claude" block below.

**What changed from v4 — a final full-system audit found four more issues; two are fixed, two are
still open.** Items 26 and 27 (Player Guild publishing parity, and publishing reliability/
atomicity) were the last items open when v4 was written and are both now done — see "Recently
completed, continued (7)" and "(8)" below. A subsequent full-system audit, run specifically to
check cross-account/cross-device behavior end-to-end rather than any single feature in isolation,
found four more issues: items 28 and 29 (a fresh-install-breaking duplicate RLS policy, and a
moderator-takedown bypass discovered while fixing it) are now closed — see "Recently completed,
continued (9)" below. **Items 30 and 31 are not fixed yet** — see "Still open" below, each with its
own "Prompt for Claude" block.

**What changed from v3 — P4 is now fully closed.** v3 already had item 18 confirmed done (see
below) and item 19 still open at the point it was written; when this session picked the tracker
back up, the zip handed over still listed 19–22 as open in the *PDF* copy of this document (the
PDF hadn't caught up to this in-repo `.md` on item 18 — worth keeping just one canonical copy of
this file going forward, since the PDF/`.md` split is exactly the kind of staleness this
document's own lesson warns about). Re-checking source directly rather than trusting either
copy: item 18 was confirmed already done (migration 83 exists, client wiring is real — matches
what this document already said), and **items 19, 20, 21, and 22 have now all been built and
are done** — see "Recently completed, continued (3)" below for each.

**The lesson driving v3's rewrite, still the standing rule:** every "Confirmed still open" line
in this document is only as good as the pass that last checked it — "Confirmed" means checked
against current source in the session that wrote the line, not carried forward from a prior
version of this document. Two things worth recording from *this* pass specifically, since they're
the same lesson showing up in two new shapes:

- **Item 20 wasn't fully scoped by its own v2/v3 prompt.** The prompt only described a
  purchase/download backend for a pack, which implicitly assumed a reader could already find
  another author's pack to buy. They couldn't — `published_packs` didn't exist at all before this
  session; the Worldbuilding Packs shelf was built from `projects.flatMap(...)`, this device's own
  local `projects` state, so a pack was never visible to anyone but the author who published it,
  on any device. Building only the purchase/download half (as originally scoped) would have shipped
  a Buy button nobody but the author could ever see. The fix built covers both: a real
  `published_packs` directory (mirroring `published_books`/`fetchDiscoverBooks`) *and* the
  purchase/download path the prompt described.
- **Items 21 and 22 both had an open design question in their own prompt text** (purchase step or
  free-to-install/use; moderation gate or not) that genuinely needed the app owner's call, not an
  assumption. Both were answered explicitly before building: addons and templates are
  **free-to-use/install, no purchase step, no `content_reports` moderation gate** (for either —
  the app owner's own call, not an oversight; `published_packs`/`published_pack_content` from item
  20 also has no `content_reports` entry yet, for the same reason: not asked for this session).

---

## Recently completed (removed from active list)

**From the original audit (items 1–11):**
- **Item 1** — Readers cannot read anyone else's published book. `published_book_content` table,
  `publishBookContentRemote`/`fetchPublishedBookContent` in `src/lib/library.js`.
- **Item 2** — Banned users could write to 10 tables. `71_migration_ban_check_insert_policies.sql`
  — `and not is_banned(auth.uid())` added to all 10 insert policies.
- **Item 3** — No server-side cap on Player Guilds per owner. `72_migration_player_guild_
  ownership_cap.sql` — unique index on `owner_id` plus `create_or_get_own_guild()` RPC.
- **Item 4** — No minimum word count to publish. `73_migration_publish_word_count_floor.sql` (and
  `74_migration_anthology_publish_word_count_floor.sql` for the anthology path) — 5,000-word floor
  enforced both client-side and in the insert policy.
- **Item 5** — No rate limit on content reports. `75_migration_content_reports_rate_limit.sql` —
  partial unique index (one open report per reporter/content pair) plus a rate-limit trigger.
- **Item 6** — No rate limit on Fireside posts. `76_migration_fireside_post_cooldown.sql` — a
  per-author cooldown trigger, advisory-locked against the same-instant race.
- **Item 7** — No in-app admin/moderator management. `77_migration_admin_role_revocation.sql` plus
  `src/admin/manage-admins.jsx` — grant/revoke with an audit log; minting a NEW admin deliberately
  stays service-role-only (a considered departure from the original ask — see the migration's own
  header for why "an admin can mint another admin" was rejected as too large a blast radius).
- **Item 8** — Moderators couldn't remove content. `78_migration_moderator_content_removal.sql` —
  soft-hide (`removed_by_moderator`) across `published_books`/`fireside_posts`/`reviews`/
  `guild_book_feedback`/`book_discussion_posts`, with a "Remove content" action wired into
  `src/moderation/moderation-queue.jsx`.
- **Item 9** — Guild owner account deletion silently orphaned the guild. `79_migration_account_
  deletion_guild_check.sql` — corrects the original audit's own premise too (purge never actually
  cascade-deleted the guild; the real bug was a permanently-banned owner left in place — see that
  migration's header).
- **Item 11** — Any member could tag a post "announcement." `80_migration_fireside_announcement_
  officer_gate.sql` — insert policy now matches `notice-board.jsx`'s own officer/admin check.
- **Item 12** — A writer's own Rank showed different numbers on Home vs. Author's Hall. Shared
  `myPublishedCountFor`/`buildLegacyBooksForReputation`/`meaningfulCompletedCountFor` helpers in
  `src/library/author-reputation.jsx`.
- **Item 13** — Public Reputation ignored real follower/review counts. `fetchFollowerCount` +
  reused `fetchAuthorRatingsSummary` in `src/lib/library.js`; `reviewReputationCountsFrom` in
  `author-reputation.jsx`; `rating`/`review` flipped to `live: true`.

**From the P4 pass (items 14, 15, 17):**
- **Item 14** — Living Universe's Guild Events widget was flagged simulated; already wired to
  `fetchPublicGuildEvents` in `living-universe-screen.jsx` (migration 51). Only the stale comments
  describing it as future work needed fixing.
- **Item 15** — Guild Order World Bible tab was fully simulated. New `guild_order_world_entries`
  table (`81_migration_guild_order_world_bible.sql`), new `src/lib/guild-world-bible.js`,
  `GoWorldBibleTab` in `guild-order.jsx` rewritten to fetch/subscribe for real, both call sites in
  `guild-anthology.jsx` updated. Real for both guild types, live via Realtime, same shape as
  Manuscript.
- **Item 17** — Treasury/Anthology were flagged as still-simulated for Founder Guilds; already
  real for both guild types via `69_migration_founder_guild_parity.sql`. No code change needed —
  fixed several stale comments in `guild-order.jsx`/`guild-anthology.jsx` that still claimed
  otherwise, since those are what caused this to look open.
- **Item 16** — Guild Order Council/Voting tab was fully simulated (hardcoded vote-count seeds
  plus only this device's own local vote). New `guild_order_proposals`/`guild_order_votes` tables
  (`82_migration_guild_order_council.sql`, same document/contribution split as Manuscript), new
  `src/lib/guild-order-council.js`, `GoCouncilTab` rewritten to fetch/vote/close for real and
  subscribe live. A proposal can only be closed by whoever opened it — simplest rule, no rung
  re-derivation needed, documented as an MVP choice in the migration itself. Real for both guild
  types, no simulated fallback (Council never had one to begin with — same as Roster).

---

## Recently completed, continued

- **Item 10** — Sync-conflict recovery had a working data layer but no UI. Found the existing
  app-wide event-listener precedent (`src/shell/sync-context.jsx`'s `online` handler) and added a
  matching one for `inkroot:sync-conflict`, loading `listConflictBackups()` both on that event and
  once on mount (a conflict can be backed up during a prior session, before anything's listening).
  New `src/shell/conflict-recovery-control.jsx` — a Home-only pill button (rendered only when
  `conflictBackups.length > 0`, so a writer who's never hit a conflict never sees it) next to
  `AccountSyncControl`, opening a panel listing each backup with Restore/Dismiss. Conflict
  resolution itself (remote still wins) is unchanged — this is purely the missing recovery
  surface `syncEngine.js`'s own comment already flagged as absent.

---

## Recently completed, continued (2)

- **Item 18** — Inbox / notifications entirely local, no real backend. Scope agreed with the app
  owner: real, push-on-write notifications for new follower, new review, Guild Order activity
  (proposal opened, chapter/passage/World Bible entry added), and guild event results posted —
  everything else the Inbox shows (Messages, Sales, Marketplace, Achievements, System, and the
  non-event-driven half of Guild Notifications like invitations/mentions) stays local/seeded, no
  real backend concept exists for those yet. New `notifications` table
  (`83_migration_notifications.sql`), seven trigger functions (one per event; the four Guild
  Order ones share a `notify_guild_order_members()` broadcast helper), live via Realtime — same
  pattern `guild_order_world_entries`/`guild_order_proposals` (81/82) already use. New
  `src/lib/notifications.js` (`fetchNotifications`/`subscribeNotificationsRealtime`).
  `AuthorInboxScreen` now layers real mail on top of local/seeded `INBOX_KEY` state on load and
  live — Reviews is real-only going forward (the fake `rev-*` seed letters retire once a real
  source exists, same honesty call `seedInboxItems()` itself already makes for `hasPublished`);
  Reputation and Guild Notifications layer real items on top of their still-fake seed content,
  since the rest of those categories has no real backend yet.

---

## Recently completed, continued (3)

- **Item 19** — Living Universe's activity Feed was entirely simulated (`useLivingUniverseFeed`
  invented a new fictional entry on a random 14–30s interval, persisted to `LU_FEED_KEY`), no
  real backend concept behind it. Scoped per item 18's own follow-up question: the Feed is a
  public/cross-user view over the same event sources item 18's `notifications` already covers,
  not a second, separate real-time system. New `list_living_universe_feed()` RPC
  (`84_migration_living_universe_public_feed.sql`) pulling from publish/follow/review/guild-join
  events. New `src/lib/living-universe-feed.js`, wired into `useLivingUniverseFeed()` — the local
  generator is demoted to the last-resort empty-state fallback for the `release`/`guild` kinds it
  covers, same pattern `useLuTrending`'s `trendingIsReal` already used for Trending in this same
  screen; kinds with no real backend are left alone.

- **Item 20** — Worldbuilding Pack purchases had no purchase/download backend — and, discovered
  while re-scoping this item against current source (see this document's intro above), no
  *discovery* backend either: `published_packs` didn't exist, so a pack was never visible to
  anyone but its own author, on any device. Both gaps closed together in
  `85_migration_worldbuilding_pack_discovery_and_purchase.sql`:
  - `published_packs` — the missing directory (mirrors `published_books`'/`fetchDiscoverBooks`'
    RLS shape: anyone reads, author owns writes). `grand-library-screen.jsx`'s `publishedPacks`
    now sources from a real `fetchDiscoverPacks()` instead of local-only `projects.flatMap(...)`.
  - `published_pack_content` — full gated content, mirroring `published_book_content`'s single-
    jsonb-blob shape **but gated by purchase**, per the app owner's explicit call: unlike a book
    (free to read by design; Buy/tip there is support, not a paywall), a pack's Buy button is its
    only gate, so an ungated mirror would leave nothing to sell.
  - `purchases.kind` extended with `'pack'`, new `pack_id` column, `amount_kobo`'s check loosened
    from `> 0` to `>= 0` — needed because a free pack (price 0) still gets a durable `$0`
    purchases row, per the app owner's call for audit-trail consistency with every other purchase
    kind; Paystack itself won't process a zero-amount charge, so `paystack-init-pack-purchase`
    writes that row directly, `success`, with no Paystack call, for a free pack.
  - New `src/lib/worldbuilding-packs.js` (publish/unpublish/discover/access-check/content-fetch),
    `checkoutPack` added to `src/lib/payments.js`, `WorldbuildingPackDetailModal`'s old
    `ComingSoonNotice` replaced with a real Buy-or-Download section (download saves the full
    content as a JSON file — the literal word the original prompt used, not a merge into the
    buyer's own project, which would be a separate, larger feature).

- **Item 21** — Addon marketplace was fully device-local (`readAddons`/`writeAddons` in
  `localStorage`, not even synced across one writer's own devices), no sharing backend. Per the
  app owner's call: **free-to-install, no purchase step, no `content_reports` content_type.**
  New `published_addons` table (`86_migration_addon_marketplace.sql`), simpler than
  `published_packs` since an addon isn't project-scoped and has no gated-content split (its
  `contains` manifest *is* the public listing). New `src/lib/addon-marketplace.js`
  (publish/unpublish/discover). `addon-data.jsx`'s `emptyAddon()` gained `marketplaceStatus`/
  `publishedAt` — deliberately separate from the existing `status` field, which only ever meant
  "is this addon finished," never "is it shared." `addon-studio.jsx`'s old `ComingSoonNotice`
  replaced with a real `AddonMarketplaceBrowser` (browse → "Add to My Addons" installs the
  manifest locally, after which the existing per-project Install toggle works unchanged) plus a
  `MarketplaceToggle` (Share/Unshare) on each of your own addon cards.

- **Item 22** — Template sharing was fully device-local (`readTemplates`/`writeTemplates`), no
  sharing backend. Per the app owner's call: **free-to-use, no purchase step, no
  `content_reports` content_type** — same as item 21. New `published_templates` table
  (`87_migration_template_marketplace.sql`), following `published_addons`' own pattern almost
  exactly; one difference — a template's fields vary by `type` (book/chapter/character/
  worldbuilding), so they're kept in one `payload` jsonb column rather than fixed columns, same
  "manifest, not fixed shape" reasoning `published_addons.contains` already uses. New
  `src/lib/template-marketplace.js`. `templates.jsx`'s `emptyTemplate()` gained the same
  `marketplaceStatus`/`publishedAt` pair item 21 added to addons; its old `ComingSoonNotice` (and
  the file's own header comment, which was stale in exactly the way this document's intro
  describes — "needs a shared backend Inkroot doesn't have yet," when it now does) replaced with
  a `TemplateMarketplaceBrowser` + `MarketplaceToggle`, mirroring item 21's addon UI.

**Caveat covering items 19–22 together:** built and syntax-checked against the current source in
this session, but not run against a live Supabase instance or a real `vite build` — this
environment has neither network access for `supabase db push` / `npm install` nor a bundler.
Treat as ready-for-review, not deploy-tested. Recommended before shipping: apply migrations 84–87,
run a real build, and manually walk publish → browse as a second account → buy/add → download/
install for each of the Pack, Addon, and Template marketplaces.

---

## Recently completed, continued (4)

- **Item 23 — release blocker, found in a pre-launch audit, not the P4 pass.** Paid-book
  manuscript access was enforced only in React, not at the database. `published_book_content`'s
  original policy (`anyone can read published book content`, `using (true)`) predates this
  document's own "money-moving paths ... confirmed solid" line below — that line was wrong for
  this one table and stayed wrong across v1–v4 because nobody re-checked the RLS itself, only the
  app's own reading UI (`checkBookReadAccess`/`openReaderBook`, both correct). A direct
  `supabase.from('published_book_content').select(...)` call, or the Grand Library's own "Peek at
  the opening" sample loader (which fetched the FULL manuscript and truncated client-side), could
  pull any priced book's complete text for free, purchase or not.
  `89_migration_paid_book_content_access.sql` closes it: the open policy is replaced with three
  narrower ones (author-owns / price<=0 / verified `purchases` row, same three conditions
  `checkBookReadAccess` already used client-side, now also enforced at the table) — and a new
  `published_book_samples` table + `sync_published_book_sample()` trigger gives the sample
  feature a small, always-public, author-uncontrolled preview to read instead, so a priced book's
  "peek at the opening" still works without reopening the same hole. New
  `fetchPublishedBookSample` (`src/lib/library.js`); `BookDetailModal`'s `loadSample`
  (`grand-library-cards.jsx`) now calls that instead of `fetchPublishedBookContent` for every
  reader who isn't the book's own device. `checkBookReadAccess`/`openReaderBook` themselves were
  already correct and are unchanged.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–22) — apply migration 89 (or re-run `schema.sql` on a fresh install) and
  manually verify: a free book still reads in full for anyone; a priced book reads for its author
  and for a buyer with a real `success` purchase row; a priced book denies everyone else while
  still showing a sample; direct REST/SQL access to `published_book_content` for a priced,
  unpurchased book returns no row.

---

## Recently completed, continued (5)

- **Item 24 — release blocker, found in the same pre-launch audit as item 23.** Guild privacy:
  a book published specifically to a Guild (destination = 'guild') was, and still is by default,
  discoverable and fully readable through `published_books`/`published_book_content`'s own open
  policies — the exact same shape of hole item 23 closed for a priced book, just triggered by
  *destination* instead of *price*. `publishBookWithDetails` (`ink-root.jsx`) writes every
  publish, guild-destined or not, into both tables; their "anyone can read" policies (`using
  (true)`) never checked `destination`, so a guild-only book's listing and entire manuscript were
  world-readable to anyone with the anon key — the app's own Discover/Author's-Hall queries
  filtering to `destination = 'inkroot'` (`lib/library.js`) is a UI filter, not a permission
  boundary. `90_migration_guild_book_privacy.sql` closes it: `published_books`' open select
  policy is replaced with four narrower ones (Grand Library books public, author reads own,
  verified Founder Guild members read their own guild's listings via `guild_published_books` +
  `founder_guild_members`, moderators read all — same OR-together shape item 23's migration used);
  `published_book_content`'s "free book content is public" policy (89) is narrowed to
  `destination = 'inkroot'` and a matching guild-members policy added; `published_book_samples`
  gets the identical treatment, since its "peek" excerpt is derived straight from
  `published_book_content` and was just as open. No client code changes — `checkBookReadAccess`/
  `fetchPublishedBookContent`/`openReaderBook` already fail toward "book unavailable" when a
  lookup comes back empty, which is exactly what a non-member now gets. Player-Guild-destined
  books (which never get a `guild_published_books` row — see that table's own header on Player
  Guild bookshelves being local-only/no shared-shelf feature) end up author-only-readable, which
  is strictly more correct than the fully-public hole they had before, not a feature regression.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–23) — apply migration 90 (or re-run `schema.sql` on a fresh install) and
  manually verify: a Grand-Library book is unaffected; a Founder Guild member can still open a
  book on their own Guild Bookshelf and a non-member/signed-out reader cannot (direct REST/SQL
  included); the book's own author can always read/edit it from any device.

---

## Recently completed, continued (6)

- **Item 25 — release blocker, found in the same pre-launch audit as items 23–24.** A published
  Guild Anthology had no actual content behind it: `publish_guild_anthology()` inserted exactly
  one `published_books` listing row and nothing else, so every anthology hit the same "book has
  no content mirror" hole item 23's own migration (70) closed for a solo book — except here it
  was never closed at all, for any reader, including the guild owner who published it. Root
  cause was `guild_anthology_submissions`' own original design (migration 35): a submission was
  always a lightweight pointer (`project_id`, title, word count) to a contributor's manuscript,
  which otherwise lives solely in that contributor's own private, device-local `kv_store` — a
  security-definer publish function has no way to read another user's local project, so there
  was never any real prose to assemble a `published_book_content` row FROM.
  `91_migration_anthology_submission_content.sql` closes it: `guild_anthology_submissions` gets
  its own `content` column (chapters only, same 20MB cap as `published_book_content`'s own),
  filled by the contributor's own device at submit/edit time — `loadProjectManuscriptContent` in
  `guild-anthology.jsx` reads it via the same `storage`/`projectKey` singletons `ink-root.jsx`
  already uses for a solo book's own publish, not a new prop threaded down from anywhere.
  `guard_anthology_submission_update()` protects `content` with the exact same "frozen once
  reviewed, invisible to the reviewer's own update path" rule its three siblings already had.
  `publish_guild_anthology()` now refuses to publish while any approved submission is still
  missing content (with a clear, count-based message — see the migration's own header for why an
  already-`reviewing` anthology could have some), then assembles every approved contributor's
  content, in submission order, into the anthology's one `published_book_content` row — a short
  byline section per contributor followed by their own chapters, using the exact
  `chapters: [{id,title,text}]` shape `PublishedBookReader` already renders, so no reader-side
  code needed to change. `submitToAnthology`/`updateOwnSubmission` (`src/lib/guild-anthologies.js`)
  gained an optional `content` parameter; all three places the UI calls `submitToAnthology`
  (Quick Submit, the in-workspace "Submit your work" picker, and the "bring in one of your
  projects" seed flow on Create) now load and pass it, and saving an edit to a pending submission
  re-reads the project fresh (rather than reusing whatever was attached at first submit) so a
  contributor who keeps writing while their entry sits pending doesn't publish stale text — a
  failed local read on that path leaves the previously-attached content alone rather than wiping
  it to null.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–24) — apply migration 91 (or re-run `schema.sql` on a fresh install) and
  manually verify: submitting a new project to an open anthology attaches its chapters; a
  contributor without content attached (or a pre-migration submission) blocks Publish with the
  named-count message above; publishing with every approved contributor's content present
  produces a `published_book_content` row that opens and reads correctly — cover, one shared
  title/author line, each contributor's byline section, and their actual chapter text — from a
  second account, a signed-out session, and direct REST/SQL.

---

## Still open

Nothing. Items 23, 24, and 25 (found outside the P4 pass, in the same pre-launch audit), item 27
(found in a final production-readiness pass), items 28/29 (found in a final full-system audit
after item 27), item 30 (found in that same audit), item 31 (see the correction just below — it
was actually already fixed by the time this "Still open" entry was written), and item 32 (found
in a later full production audit, see "Recently completed, continued (11)") are all closed.

**Correction to item 31 below, made in the v7 pass:** the "Prompt for Claude" this section used
to carry described `followAuthor`/`unfollowAuthor` (`src/lib/library.js`, ~lines 349 and 412) as
returning the raw Supabase query builder without checking `error`, and their call sites in
`src/library/authors-hall-screen.jsx` and `src/library/grand-library-screen.jsx` as optimistically
updating local state before confirming success. Re-checked directly against source in the v7 pass:
**this was already fixed.** Both functions check `error` and throw; both call sites only flip the
local "Following" toggle/follower count after the call resolves, and show an `AlertDialog` on
failure. Left the original wording just below rather than deleted, so this document's history
stays honest about having carried a stale "still open" claim across at least one version — same
lesson as the correction above "Confirmed solid" near the bottom of this file.

- ~~**Item 31 — reliability gap, same bug class as item 27, just never applied here.**~~
  ~~`followAuthor`/`unfollowAuthor` (`src/lib/library.js`, ~lines 347 and 408) return the raw~~
  ~~Supabase query builder without checking `error` — the same pattern item 27 fixed everywhere in~~
  ~~the publishing path. Their only callers, in `src/library/authors-hall-screen.jsx` (~line 137) and~~
  ~~`src/library/grand-library-screen.jsx` (~line 62), do `.then(() => setFollowerCount(...))`, which~~
  ~~optimistically updates the local "Following" toggle and follower count on anything that resolves~~
  ~~— including a silently-denied RLS write or any other database-level error. A user could see~~
  ~~"Following" and an incremented count locally while nothing was actually written to the `follows`~~
  ~~table, meaning the follow won't be there on reload or on another device. Not a security hole —~~
  ~~the underlying `follows` row genuinely wasn't written either way — but it's a real~~
  ~~cross-device-consistency bug for the exact feature item 4 of the last audit asked about.~~ **(Not
  accurate as of v7 — see the correction above. Kept struck through, not deleted, per this
  document's own honesty policy about superseded claims.)**

---

## Recently completed, continued (10)

- **Item 30 — release blocker, found in the same final full-system audit as items 28/29.**
  `publish_guild_anthology()` correctly assembled every approved contributor's real content and
  inserted atomically into `published_books` + `published_book_content` with `destination =
  'guild'`, but never inserted the matching row into `guild_published_books`. Every guild-scoped
  read policy on `published_books`/`published_book_content` (migrations 90 and 92) resolves who's
  allowed to see a `'guild'` destination book by joining through `guild_published_books`; with no
  row there, only the book's own `author_id` (the officer who ran Publish) and moderators could see
  it under RLS. Concretely: it never appeared on the Guild Bookshelf
  (`fetchGuildPublishedBooks`/`src/lib/library-guild.js` only ever queries `guild_published_books`),
  and every other guild member — including every contributor who helped write it — hit "book
  unavailable" trying to open it. A published anthology delivered a readable book to exactly one
  person: whoever clicked Publish.
  Fixed with a new `93_migration_anthology_guild_shelf.sql` — a fresh `create or replace` of
  `publish_guild_anthology()` with one added insert into `guild_published_books` (same
  transaction, same atomicity guarantee the rest of the function already had), plus a one-time
  backfill for any anthology that was already published under the old buggy function before this
  migration existed. **Shipped as a new migration, not an edit to migration 91's own file** — unlike
  item 28's duplicate-policy bug (which threw a hard error, so no deployment could have gotten past
  it), this bug never errored, so a real deployment could already have successfully applied
  migration 91 exactly as originally written; editing that file after the fact wouldn't reach such
  a deployment, only a fresh `create or replace` shipped as a new migration does.
  `guild_anthologies.guild_id` has a hard foreign key to `player_guilds(id)`, so an anthology's
  guild is always a Player Guild, never a Founder Guild slug — the new insert uses the same
  `::text` cast `guild_published_books`'s own "player guild members ..." policies (migration 92)
  already use, not the Founder Guild ones. Also fixed three pieces of copy in
  `src/guild/guild-anthology.jsx` that all stemmed from the same misunderstanding — the anthology
  explainer text, the "Live in the Grand Library" status label, and the "Publish to the Grand
  Library" button — all claimed an anthology publishes to the Grand Library, which it never does
  (`destination` is always `'guild'`); all three now correctly say "Guild Bookshelf".
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–29) — manually verify: publishing a Guild Anthology creates a
  `guild_published_books` row alongside the `published_books`/`published_book_content` rows, the
  anthology appears on the Guild Bookshelf, and a guild member who isn't the publishing officer
  (a contributor, or any other member) can actually open and read it.

---

## Recently completed, continued (9)

- **Item 28 — release blocker, found in a final full-system audit. `schema.sql` (and the
  original `90_migration_guild_book_privacy.sql`) could not run against a fresh/existing
  database: `CREATE POLICY "moderators read all published books" ON published_books` was
  declared twice with no `DROP POLICY IF EXISTS` before the second declaration** (migration 78
  created it first; migration 90 re-declared the exact same name and definition, apparently
  without realizing it already existed). Postgres rejects a duplicate policy name outright, so
  applying `schema.sql` top-to-bottom on a fresh install — or applying the numbered migrations in
  order against a database that had already run migration 78 — aborted at that exact statement,
  silently skipping every migration after it: the rest of migration 90 (guild book privacy) and
  all of 91/92 (anthology content, Player Guild publishing) never took effect. Fixed by removing
  the redundant `CREATE POLICY` (byte-identical to the one migration 78 already created — zero
  behavior change) from `schema.sql` and from `90_migration_guild_book_privacy.sql`, replacing it
  with a comment explaining why nothing is declared there. Re-ran a full duplicate-policy scan
  across the entire consolidated `schema.sql` after the fix: this was the only instance.

- **Item 29 — found while fixing item 28, in the same policy block. Moderator-removed books
  silently became readable again the moment migration 90 applied.** Before migration 90,
  `published_books` had one read policy — `"anyone can read published books"` — that correctly
  gated on `not removed_by_moderator or auth.uid() = author_id` (migration 78). Migration 90
  dropped that single policy and replaced it with four narrower ones (Grand Library / author /
  Founder Guild member / moderator), plus a fifth from migration 92 (Player Guild member) — but
  none of the three non-author, non-moderator replacements carried the `removed_by_moderator`
  check forward. The moderation `removed_by_moderator` flag stayed correctly recorded and
  enforceable elsewhere (reviews, fireside_posts, guild_book_feedback, book_discussion_posts all
  still checked it correctly — this was isolated to `published_books`), but a book a moderator had
  taken down was fully public again via `"anyone can read grand library books"` (destination =
  'inkroot') or fully guild-visible again via either guild-member policy, the instant this
  migration ran. Fixed by adding `and not removed_by_moderator` to `"anyone can read grand library
  books"`, `"guild members read their guild's book listings"`, and `"player guild members read
  their guild's book listings"`, in `schema.sql` and in the original `90_migration_guild_book_
  privacy.sql`/`92_migration_player_guild_book_publishing.sql` files. The author's own listing
  policy and the moderator policy are deliberately left unconditional (same "author sees their own
  removed content" carve-out every other moderated table uses, and moderators need to see removed
  content by definition). `published_book_content`/`published_book_samples` needed no matching
  edit: their own policies join back to `published_books` via a subquery, and a subquery runs
  under the querying user's own RLS on the table it reads — so a row `published_books` now hides
  from a non-author/non-moderator is automatically invisible to those subqueries too.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–27) — manually verify: a moderator-removed Grand Library or Guild book
  returns no row to a logged-out session, a different regular reader, or a fellow guild member,
  while the book's own author and any moderator can still see it.

---

## Recently completed, continued (7)

- **Item 26 — release blocker, found in a follow-on pre-launch pass.** Player Guild books: the
  ordinary-book-to-Guild publishing path only ever worked for Founder Guilds.
  `publishBookWithDetails`/`setPublishStatus` (`ink-root.jsx`) pushed a `guild_published_books`
  row only when `guildProfile.guildType === 'founder'`, even though the Publishing Wizard itself
  (`writerGuildName`/`guildAvailableForTarget` in `publishing.jsx`) already offered "Guild" as a
  destination to a self-founded ('player') or joined ('joined') Player Guild writer too. Combined
  with item 24's own migration (90) locking `published_books`/`published_book_content` down to
  real guild members for `destination:'guild'`, a Player Guild's own book ended up
  author-only-readable — published to nowhere any other guildmate could actually see, silently.
  `92_migration_player_guild_book_publishing.sql` closes it using the exact same
  membership-checked, OR-together permissive-policy architecture the Founder Guild path already
  used (no parallel table, no new columns) — sibling policies checking `player_guild_members`
  instead of `founder_guild_members`, added to `guild_published_books` (select/insert/update),
  `guild_book_feedback` (select/insert/update — needed so a Player Guild's feedback thread doesn't
  silently break once its shelf is real), and `published_books`/`published_book_content`/
  `published_book_samples` (select), mirroring migration 90's own Founder Guild policies exactly.
  New `activeBookshelfGuildId()` helper in `ink-root.jsx` resolves the correct guild id (a Founder
  Guild's fixed slug, or a Player/Joined Guild's real `player_guilds.id`) for both publish call
  sites; `GuildBookshelf`'s `guildId` prop in `home-screen.jsx` now uses the same real id for a
  Player/Joined guild instead of `null`. Small related fix along the way: `project-workspace.jsx`'s
  own `writerGuildName` derivation fell through to the Founder branch (always null) for a
  `'joined'` member, showing the generic "my guild" fallback instead of the real joined guild's
  name — brought in line with `home-screen.jsx`'s own three-way derivation.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–25) — apply migration 92 (or re-run `schema.sql` on a fresh install) and
  manually verify: a Player Guild owner publishing a book with "Guild" as the destination shows up
  on their own Hall's Bookshelf; a second account that joins that same Player Guild by invite code
  can see, open, and leave feedback on it from their own Guild Hall; a signed-out session and a
  non-member (including someone seated in a *different* Player Guild or a Founder Guild) get "book
  unavailable"; the book's own author can always read/edit it regardless of guild.

---

## Recently completed, continued (8)

- **Item 27 — release blocker, found in a final production-readiness pass. Publishing
  reliability: a book/pack could show "Published" without actually being published, or be
  published-with-no-content forever.** Three compounding bugs, all in the publish/unpublish path:
  (1) both of Author Studio's quick-action functions (`setPublishStatus`/`setPackPublishStatus`
  in `ink-root.jsx`) and its Wizard-driven ones (`publishBookWithDetails`/`publishPackWithDetails`)
  wrote the local `publishStatus` — what the UI actually reads to show "Published" — *before* the
  remote listing/content/guild-shelf pushes even ran, which were themselves fired as
  non-blocking, uncaught promises (`.catch(e => console.warn(...))`); (2) `lib/library.js`,
  `lib/library-guild.js`, and `lib/worldbuilding-packs.js`'s own mutation functions returned the
  Supabase query builder directly, which *resolves* (never rejects) to `{ data, error }` on an
  ordinary database error (RLS denial, constraint violation), so even the `.catch()` that existed
  could never fire for a real failure, only a dropped connection; (3) worse, publishing from
  *inside* a project's own Settings tab or Publishing Hub (`project-workspace.jsx`'s
  `handleSetPublishStatus`/`handleWizardPublishBook`/`handleSetPackPublishStatus`/
  `handleWizardPublishPack`) made **no remote call at all** — purely a local `update()` — so a
  book published from that screen could show "Published" to its own author while being entirely
  invisible to Supabase, forever, on every other device. Combined with (1)/(2), a listing could
  also succeed while its content mirror failed, leaving a book that's discoverable in the Grand
  Library/Guild Bookshelf but permanently empty/broken for every reader but the author — the
  literal half-published book this item was written to prevent.
  Fixed with a new `lib/publish-flow.js` (`publishBookRemoteFlow`/`unpublishBookRemoteFlow`/
  `publishPackRemoteFlow`/`unpublishPackRemoteFlow`), used by **both** publishing entry points now:
  it awaits the listing write, then the content write, and rolls the listing back (delete) if the
  content write fails or silently no-ops from a dropped session — so a listing is never left
  standing with no content behind it. The Guild Bookshelf mirror stays deliberately best-effort
  and non-blocking (a failure there leaves the book correctly listed and fully readable via the
  two tables the app's own read paths actually check, just not yet mirrored onto the shared shelf
  row — a retryable inconsistency, not a half-published book). Every mutation in `library.js`/
  `library-guild.js`/`worldbuilding-packs.js` now explicitly checks `error` and throws, closing
  gap (2). All four `ink-root.jsx` functions and all four `project-workspace.jsx` handlers now
  await this flow and only write the local `publishStatus` once it resolves; `project-workspace.jsx`
  gained the `writerProfile` and `activeBookshelfGuildId` props it never had (needed to build the
  same content payload Author Studio already could), closing gap (3) entirely rather than papering
  over it. `PublishingWizard` (`publishing.jsx`) gained the same idle/publishing/error state
  `TipAuthorModal` already used elsewhere in the same file — the Confirm step now shows
  "Publishing…", stays open and shows the real error on failure instead of closing immediately
  regardless of outcome, and disables Back/Close while a publish is in flight. The two quick-action
  entry points that have no wizard around them (`setPublishStatus`/`setPackPublishStatus` in
  `ink-root.jsx`, and their `project-workspace.jsx` equivalents) show a new shared `AlertDialog`
  (`shared-ui/ui-primitives.jsx`) on failure instead of only a `console.warn`. Content-payload
  building (`buildPublishedBookContent`/`buildPublishedPackContent`) was pulled out of
  `ink-root.jsx` into a new `lib/publish-content.js` so both entry points build the exact same
  shape instead of each keeping a private copy that could drift.
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as items 19–26) — manually verify: publishing a book from both Author Studio and from
  inside the project's own Settings/Publishing Hub actually creates rows in both `published_books`
  and `published_book_content` (not just one); simulating a `published_book_content` failure (e.g.
  a temporary RLS/constraint break) leaves no orphaned `published_books` row behind and shows the
  error in the Wizard or the AlertDialog rather than a false "Published"; unpublishing while
  offline/signed-out still works locally exactly as before; a Worldbuilding Pack goes through the
  same checks with `published_packs`/`published_pack_content`.

---

## Recently completed, continued (11)

- **Item 32 — two cosmetic-but-misleading gaps found in a final production audit, after item 31
  was confirmed already fixed (see the correction above).** Neither is a security or data bug;
  both are the same "stale claim outliving the fix it describes" pattern this document's own
  standing lesson (see v3's rewrite note near the top) already warns about — just found in
  in-app comments and UI copy instead of in this tracker.

  1. **Stale "no payment processor yet" / "reviews show as Coming Soon" comments.**
     `src/library/publishing.jsx` (the Grand Library header comment, the Personal Ratings
     section, and the Cart section) and `src/library/grand-library-screen.jsx` (the Cart's own
     inline comment) all still described pricing as non-chargeable, the Cart as a dead-end local
     queue, and public reviews as not yet built — all false as of the current codebase: Paystack
     checkout (`lib/payments.js`'s `checkoutBook`, the `paystack-*` Edge Functions), the Cart's
     real "Proceed to Checkout" path, and real public reviews (`submitReview`/`fetchBookStats` in
     `lib/library.js`, wired into `BookDetailModal`) all already exist and work — nothing in the
     actual behavior was wrong, only the comments describing it. Fixed by rewriting all four
     comment blocks to describe what the code actually does, with pointers to the real
     implementation instead of a "not built yet" disclaimer.
  2. **Orphaned Creator Dashboard tabs.** `src/library/creator-dashboard.jsx`'s "Templates" and
     "Add-ons" tabs rendered a flat `CreatorComingSoonPanel` even though the Template and Addon
     Marketplaces themselves (items 21 and 22) have been real and live for a while — just with no
     entry point on this particular screen. A writer who only ever checked their Creator Dashboard
     had no way to know sharing was already possible from a project's own Publishing Hub. Fixed
     with two new panels, `CreatorTemplatesPanel`/`CreatorAddonsPanel`, that read this device's
     real local templates/addons (`readTemplates`/`readAddons`) and reuse the exact same
     `MarketplaceToggle` share/unshare action `templates.jsx`/`addon-studio.jsx` already use
     (exported from both, not duplicated), so sharing from the dashboard and sharing from a
     project's Publishing Hub write the same `published_templates`/`published_addons` row. Kept
     deliberately read-only beyond that toggle — creating, editing, and installing a template or
     addon still needs a specific project's context (`update`), which this global,
     all-projects dashboard doesn't have; that CRUD stays in the Publishing Hub, same as before.
     `CreatorComingSoonPanel` itself was left in place in `grand-library-cards.jsx` (unused now,
     but harmless, and removing an exported component is a separate cleanup call from fixing what
     it was hiding).

  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as every other item in this document) — manually verify: the Creator Dashboard's
  Templates and Add-ons tabs show this account's real local templates/addons (including ones
  created from inside a project's Publishing Hub), the Share/Unshare button there actually
  flips the matching row in `published_templates`/`published_addons` (check from a second
  account that a newly-shared item now appears in that account's own Marketplace browser), and
  that toggling from the Dashboard and toggling from the Publishing Hub for the *same* item stay
  in sync (share from one, refresh the other, it should show shared there too).

---

## Confirmed solid — no action needed (context, don't re-audit)

**Correction to the line below, made when item 23 was fixed:** "RLS read-side coverage" was NOT
actually solid for `published_book_content` — see item 23 above for the real gap and the fix.
Left the original line unedited just below, rather than quietly rewritten, so this document's own
history stays honest about having carried a wrong "confirmed solid" claim across four versions —
matches this document's own standing lesson (see the top of this file) about what "Confirmed"
is supposed to mean.

Unchanged from v1–v3 — money-moving paths, RLS read-side coverage, the reporting flow up to
moderation removal (fully closed by item 8), media uploads, offline sync conflict *detection*
(resolution's UI half was item 10), anthology revenue splits, ban evasion, PDF import/export,
Health Checks, the guild event payout pipeline, and the realtime coverage note — larger again
after this session, since World Bible (item 15), Guild Order Council (item 16), Inbox
notifications (item 18), and the Living Universe Feed (item 19) each added their own live-push
source alongside the original five.

**New, not yet covered by any moderation/reporting path** (worth its own item if wanted, not
built this session since it wasn't asked for): `published_packs`/`published_pack_content`
(item 20), `published_addons` (item 21), and `published_templates` (item 22) have no
`content_reports` `content_type` entry. All three were an explicit app-owner call to skip for
this pass, not an oversight — flagging here so a future audit doesn't have to rediscover it.

---

## Recently completed, continued (12)

- **Item 33 — reported by the app owner as "the app goes blank when I tap Publish from the
  Workshop"; root cause found and fixed.** Not a backend issue — Supabase/RLS/Paystack were
  never involved. `PublishingWizard` (`src/library/publishing.jsx`) is opened from two different
  places with two different shapes of `project`: from a project's own Settings/Publishing Hub
  (`project-workspace.jsx`), it's the full loaded project, `chapters` included. From Author
  Studio / the Workshop (`grand-library-screen.jsx`'s `openPublishWizard`, fed by
  `CreatorDashboard`'s `projects` prop), `project` is the lightweight project *index* entry —
  deliberately summary-only (`useMetaReport` in `project-schema-and-backups.jsx` mirrors
  `wordCount`/`chapterCount`/etc. onto it precisely so the Grand Library/Author Studio never has
  to load a project's full manuscript just to list it) — it has no `chapters` array at all. Two
  spots in the Wizard's render (the Step 1 format summary, and the Step 4 confirm card's Series
  pill) read `project.chapters.length` directly, unguarded. Opened from the Workshop for any
  completed project, Step 1 renders immediately on mount and throws `TypeError: Cannot read
  properties of undefined (reading 'length')` — and since **no error boundary exists anywhere in
  this app** (`grep -rl componentDidCatch/ErrorBoundary src/` returns nothing), React 18 unmounts
  the whole tree on an uncaught render error with nothing left to show: the blank screen the app
  owner saw. A second, quieter bug shared the same cause: `bookWordCount` was recomputed from
  `(project.chapters || []).reduce(...)`, which silently evaluated to 0 for the same
  index-entry case — so even before hitting the crash, a genuinely long, ready-to-publish book
  opened from the Workshop would have shown "This manuscript is 0 words — publishing needs at
  least 30,000" and refused to continue, every single time.
  Fixed by making the three derived values (`bookWordCount`, and a new `bookChapterCount`) check
  `Array.isArray(project.chapters)` first: when real chapters are present (the Settings/Publishing
  Hub case), behavior is byte-for-byte unchanged from before; when they aren't (the Workshop/
  Author Studio case), it now falls back to the index's own already-accurate `project.wordCount`/
  `project.chapterCount` mirrors instead of treating a missing array as zero. Both former
  `project.chapters.length` call sites now read `bookChapterCount`.
  **Broader gap flagged, not fixed here** (out of scope for a report about one specific crash):
  this app has no error boundary at all, anywhere — the *specific* crash above is fixed, but any
  future uncaught render exception, from any cause, will still blank the entire app with nothing
  shown to the reader/writer and no way to recover short of a full reload. Worth a top-level
  `ErrorBoundary` around the app root (and arguably one around `PublishingWizard`/other modals
  specifically) as its own follow-up item if wanted.
  **Not run against a live instance from this session** (no network/browser access here) —
  manually verify: tapping Publish from the Workshop on a completed, well-over-the-word-floor
  project now opens the Wizard normally instead of blanking the screen, Step 1's "This project
  currently has N chapters" line shows the correct real count, and choosing Serialized Story
  format still shows the correct episode count on the Step 4 confirm card. Also verify the
  Settings/Publishing Hub's own Publish flow (which always had real `chapters`) is unchanged.

## Final production-readiness audit (static review — nothing here was run against a live Supabase/Paystack)

Fixed in this pass (each verified by reading the code path, not by running it):

- **Publish review step showed a `$` price** (`src/library/publishing.jsx`, Step 4) — now `formatLibraryPrice` (Naira).
- **Worldbuilding pack prices showed `$`** (`formatPackPrice` in `src/library/grand-library-cards.jsx`) — now `formatNaira`.
- **No error boundary** (`src/main.jsx`) — one small `AppErrorBoundary` (reload button) around the whole tree, so a render exception no longer blanks the app (the item-33 crash class).
- **Guild members hit a "buy it from the Grand Library" wall on a priced Guild book** (`checkBookReadAccess` in `src/lib/library.js`) — a Guild-destination book is now gated by membership (already enforced server-side by RLS and `download-book`), not by a purchase.
- **`reconcile_referral_grants()` could never run from pg_cron** — its `auth.role()` guard is NULL outside an API request. Migration `102_migration_reconcile_referral_grants_cron_guard.sql` (also folded into `schema.sql`). Verify on the live project with the `cron.job_run_details` query in that file.
- **Achievement signals counted free packs and tips as "purchases"/"sales"** (`naira_achievement_current`) — zero-cost farming of withdrawable Naira. Migration `103_migration_achievement_signals_paid_books_only.sql` (also folded into `schema.sql`).

Found, NOT changed (needs a decision or is low-risk): paid-purchase wash trading between two accounts still earns achievement rewards (no holding period / same-device check like referrals have); `inkroot_official_badge_earned()` accepts a free pack as "has bought a book"; a buyer of a Guild book who later leaves the Guild can read it online but not download it; the last ~1s of typing has no `pagehide`/`visibilitychange` flush; `schema.sql`'s mid-file "NOTE ON THIS FILE'S STATUS" comment is stale (the file does contain every migration through 103).

Second pass of the same audit — also fixed:

- **Cancelled/abandoned event-entry payment locked the entrant out permanently** — `create_guild_event_entry_locked` now re-uses the entrant's own `pending` entry for a retry, pending entries stop counting toward `participant_limit` after 30 minutes, and the Guild Events card offers "Try payment again" (`src/guild/guild-events-panel.jsx`). Migration `104_migration_event_entry_retry_after_abandoned_payment.sql` (also folded into `schema.sql`).
- **`paystack-save-bank-account` had no rate limit** (an account-name lookup oracle that bypassed the cap on `paystack-resolve-account`, and minted a Paystack recipient per call) — now shares the `resolve_bank_account` counter. It also **cleared the writer's default account before failing on a duplicate save**; it now checks for a duplicate first and restores the previous default if the insert fails. Redeploy that Edge Function.
- **A ₦0 (or refund-negative) balance rendered as "Free"** on the earnings panel, referral dashboard and guild member earnings — new `formatNairaBalance` in `src/lib/payments.js`.

### Third pass of the production-readiness audit (static review — still nothing run against live Supabase/Paystack/Google)

Fixed in this pass:

- **Anyone could join any Player Guild without its invite code** — `player_guild_members` kept the insert policy "a writer joins on their own behalf" (schema_phase5, re-created by migration 71) while its select policy is `using (true)`, so every guild id was readable and self-insertable through PostgREST. Membership gates guild-only book content and exposes `invite_code`. Migration `105_migration_close_player_guild_join_and_hijack.sql` drops the policy (the client never inserts there; `join_player_guild_by_code`/`create_or_get_own_guild` are security definer). **Critical.**
- **Guild hijack via `create_or_get_own_guild`** — `on conflict (id) do update` had no owner check, so passing another guild's id overwrote its name/motto/crest and made the caller a member. Same migration 105 (refuses an id owned by someone else; conflict update is owner-scoped). **High.**
- **A retry could orphan a real event-entry / hosting-fee payment** — replacing a pending row's Paystack reference meant a late `charge.success` for the old reference matched nothing. `paystack-init-event-entry` and `paystack-init-hosting-fee` now verify the old reference with Paystack first (refuse if paid or in flight or unverifiable; allow if abandoned/failed/reversed/never registered). **Redeploy both functions.** The "reference not found → replaceable" branch keys off Paystack's error message text and is unverified against a live account.
- **Manual withdrawal success toast said "should arrive shortly"** — now says a day or two when `ACTIVE_WITHDRAWAL_METHOD` is `'manual'` (`creator-dashboard.jsx`).

Found, NOT changed: two tabs can pay for the same book (no unique success index; a unique index would make the webhook fail — needs a design call); moderator-removed paid books stay readable by purchasers and downloadable via `download-book` (service role); no handler for a dispute later resolved in the merchant's favor; a sync push rejected by the 20 MB `kv_store` cap is only `console.warn`'d and the green dot means "signed in", not "synced"; `player_guild_members` is still world-readable (rosters use it).

### Fourth pass of the production-readiness audit (static review — flows walked against source: Google auth, profile edit, manuscript save/sync, publishing, guild create/join, following, reading, paid-book access, guild-only access, Paystack success/failed/cancelled, duplicate webhook, refunds, withdrawals, insufficient balance, duplicate withdrawal, referral rewards, achievement rewards)

Every money-moving and access-control path re-checked directly against current `schema.sql`/Edge Function source (not re-trusted from this document) came back correct: `create_withdrawal_locked`/`create_manual_withdrawal_locked` share one advisory-lock key with every other balance-affecting RPC and re-check `author_balance_kobo()` after acquiring it, so a genuine double-submit or an over-balance request both fail correctly; `author_balance_kobo()` nets pending+success withdrawals, guild treasury contributions/releases, achievement grants, and referral grants/reversals in one place; the webhook's three event handlers (`charge.success`/`transfer.success`/`transfer.failed`+`transfer.reversed`/`refund.processed`+`charge.dispute.create`) are all status-guarded (`.eq('status','pending')` or `'success'`), so a Paystack retry or a genuinely duplicate delivery is a safe no-op, never a double-credit; a refund correctly revokes read/download access the next time `checkBookReadAccess`/`download-book` re-checks (`purchases.status` moves off `'success'`); migration 105's guild-join/hijack fix and migration 103's achievement-signal fix are both present in `schema.sql`, not just their own migration file. No new defect found in any of these paths.

Two confirmed, fixed in this pass (both comment-only, zero logic risk):
- **`src/library/grand-library-cards.jsx`'s `CartDrawer` header comment** claimed "checking out can't actually charge anyone until Inkroot has a payment processor" — false; the same file's own `handleCheckout` already calls the real `checkoutBook()`/Paystack flow. Same stale-claim pattern item 32 fixed in `publishing.jsx`/`grand-library-screen.jsx`, missed in this file. Reworded to describe the real, working checkout.
- **`src/shell/inkroot-app.jsx`'s header comment** pointed at "the TODO comment there" in `main.jsx` for how this file gets mounted — `main.jsx` no longer has any such TODO; it already imports and mounts this file's export (via `App.jsx`) directly, wrapped in its own error boundary. Reworded to state the current, already-finished wiring instead of pointing at a step that's done.

One confirmed, **NOT fixed in this pass — needs deliberate wiring, not a one-line change:**
- **`CreatorBookCard` (`src/library/grand-library-cards.jsx`, rendered by `CreatorDashboard`'s Published Books tab) hardcodes `"Readers"`, `"Sales"`, and `"Earnings"` to `"—"` for every published book, unconditionally**, with a comment claiming they "need page-view tracking and a payment processor respectively, neither of which is part of this phase." Both now exist and are used elsewhere in this same codebase: `fetchBookViewSummary(bookId)` (`src/lib/analytics.js`, backing `CreatorAnalyticsPanel`) has real per-book view/read-start counts, and `fetchSalesLedger()` (`src/lib/payments.js`, already imported into `creator-dashboard.jsx` for the Earnings tab) has every `purchases` row with `book_id`/`amount_kobo`/`author_amount_kobo`/`status`, groupable per book for real Sales (count of `status:'success'`, `kind:'book'` rows) and Earnings (`sum(author_amount_kobo)` for the same). Only `Rating` on this same card is already wired to real data (`fetchBookStats`) — Readers/Sales/Earnings were simply never connected the same way, even though nothing blocks it now. **Exact fix:** in `CreatorDashboard`, fetch `fetchSalesLedger()` once for the whole Published Books tab (not per-card) and reduce it into a `Map<book_id, {sales, earningsKobo}>`; call `fetchBookViewSummary(project.id)` per published card the same way this card already calls `fetchBookStats` in its own `useEffect` (or lift it into the same effect); pass both down as props and replace the three hardcoded `"—"` values in `CreatorBookCard` with the real numbers (falling back to `"—"` only while loading or when a published book genuinely has zero of something). Not applied here because it touches a shared list-fetch (`fetchSalesLedger`) whose call site and loading/error states need to be designed against this component's existing per-card `useEffect` pattern, and this environment has no way to run/build the app to verify the wiring — a real fix, but one that should be built and manually verified (Published Books tab shows real numbers matching the Earnings tab's own ledger for the same account) rather than guessed at blind.

**Everything else in "Still open"/"Found, NOT changed" above was re-confirmed as still accurate and still open** — nothing in this pass changed their status.

**Follow-on pass, same session — race conditions specifically, in the referral/achievement grant paths and guild-book access unification.** Re-checked with the specific goal of finding a double-grant or a bypassable lock, not just a wrong balance:

- `redeem_referral_code()` — self-referral is blocked; the "two tabs finish sign-in at once" race is closed by a unique constraint on `referrals.referee_id` (`on conflict (referee_id) do nothing`, then re-read), which is the right tool here since there's nothing to compute under a lock beyond the insert itself. No issue.
- `grant_referral_reward()` — idempotent per (referral, kind); a duplicate-device check runs before any lock; **two** advisory locks are taken (per referral+kind, and per-referrer for the lifetime cap) so a concurrent grant for a *different* kind belonging to the same referrer can't race the lifetime-cap read; a per-grant ceiling and a lifetime ceiling (netted against past reversals) both apply after the signal check. This is the most heavily-guarded function in the schema and no race or bypass was found.
- `grant_naira_achievement()` — idempotent per (user, achievement); locked per (user, achievement) before the signal re-check; the official-badge prerequisite is re-checked, not cached. No issue.
- `is_guild_book_member()` — correctly ORs Founder-guild membership and Player-guild membership (with the `::text` cast the Player-guild-parity migration needed for `player_guild_members.guild_id`), and this same function backs both `paystack-init-purchase`'s guild-purchase gate and `download-book`'s guild-download gate — so guild-only access is genuinely unified across both guild types at every entry point that matters, not just the read path.

No new defect found in this follow-on pass. The reader/sales/earnings wiring gap above remains the one open item from this session.

**Built and closed in a same-session follow-up — the reader/sales/earnings wiring gap above.**

- New `fetchBookSalesSummary()` in `src/lib/payments.js` — a dedicated, uncapped, author-scoped query (`purchases` where `author_id = auth.uid()`, `kind = 'book'`, `status = 'success'`, no `.limit()`), aggregated client-side into `{ [bookId]: { sales, earningsKobo } }`. Deliberately not built from the existing `fetchSalesLedger()`, which is intentionally capped at the 50 most recent purchases account-wide for its own job (the Earnings tab's recent-activity ledger) — reusing it here would have silently undercounted an author with more than 50 lifetime purchases. `purchases`' own RLS ("author reads sales of their own work") already permits the full, uncapped read.
- `CreatorDashboard` (`src/library/creator-dashboard.jsx`) fetches this **once** for the whole Published Books tab (not once per card), re-fetching only when the published-book count changes, and passes the resulting map down as a new `salesByBook` prop.
- `CreatorBookCard` (`src/library/grand-library-cards.jsx`) now wires all three previously-hardcoded metrics to real data: **Readers** from `fetchBookViewSummary(project.id)`'s `uniqueViewers` (already used elsewhere on this same dashboard by `CreatorAnalyticsPanel`, so the two numbers agree for the same book), **Sales** and **Earnings** from the new `salesByBook` map (via `formatNairaBalance`/`koboToNaira`, the same ₦0-safe formatter the Earnings/Withdrawals panels already use, so a book with zero sales shows a real "0"/"₦0" instead of "—" or the old, wrong-looking "Free"). "—" is still shown while the relevant fetch hasn't resolved yet or has failed, same honest-loading-state convention every other panel on this dashboard already follows; a genuinely-zero count only ever shows once its fetch has actually succeeded.
- Verified every edited file (`src/lib/payments.js`, `src/library/creator-dashboard.jsx`, `src/library/grand-library-cards.jsx`) parses cleanly with `node --check` against every other file in `src/`, so this pass isn't relying on static review alone the way most of this document's other items had to. **Still not run against a live Supabase project from this session** (no network access here) — manually verify: the Creator Dashboard's Published Books tab shows real, non-dash Readers/Sales/Earnings numbers for a published book with activity, "0"/"₦0" (not "—") for a published book with genuinely none, "—" only while first loading, and the per-book Sales/Earnings totals agree with the sum of that book's own rows in the Earnings tab's ledger.

---

## Fifth pass of the production-readiness audit (static review — still nothing run against live Supabase/Paystack/Google)

- **Item 34 — confirmed and fixed: a double-charge race in `paystack-init-purchase`.** The
  "already own this book" check (a plain `select ... status='success'`) and the pending-row
  `insert` that followed it were two separate, unlocked round trips. Two concurrent calls from
  the same buyer for the same book (two open tabs, a double-tap Buy) could both read "not owned
  yet" before either had inserted its own row, both open a real Paystack checkout, and both
  succeed — a reader charged twice for one book. `purchases` has no unique constraint beyond
  `paystack_reference` itself, so nothing at the table level caught this.
  Fixed with `106_migration_purchase_init_race_lock.sql` (folded into `schema.sql`): a new
  `create_purchase_locked()` function does the ownership recheck and the insert atomically, under
  `pg_advisory_xact_lock(hashtext('purchase_init:' || buyer_id || ':' || book_id))` — same pattern
  every other balance/ownership-sensitive mutation in this schema already uses
  (`create_withdrawal_locked`, `grant_referral_reward`, `create_guild_event_entry_locked`).
  `paystack-init-purchase/index.ts` now calls this RPC instead of doing its own
  select-then-insert; the lock and ownership recheck only apply for `kind='book'` (a tip has no
  ownership concept to race). Service-role-only, same as its siblings.
  **Deliberately NOT a unique index on `(buyer_id, book_id)`** — that would make
  `paystack-webhook`'s `update ... where status='pending'` fail outright the moment a second
  pending row for the same buyer+book transitions toward `'success'`, and deciding what happens
  to that second charge (auto-refund vs. surface to an admin) is a product call this pass didn't
  make. This fix only closes the race that let two such pending rows exist in the first place for
  an otherwise-still-unowned book; it does not add a hard database-level guarantee against the
  rarer case of two *already-in-flight* Paystack checkouts both being completed by the buyer
  after the lock window (each call still serializes and rechecks ownership, so the second call
  during the same request only fails if the first has already reached `'success'` by the time the
  second's lock is acquired — a genuine simultaneous double-complete of two already-open
  checkout windows is outside what a lock on *initiation* can prevent, and is the scenario the
  unique-index-plus-webhook-design-decision above would be needed for).
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as every other item in this document) — redeploy `paystack-init-purchase`, apply
  migration 106 (or re-run `schema.sql` on a fresh install), and manually verify: a single normal
  purchase still succeeds exactly as before; firing two `paystack-init-purchase` calls for the
  same buyer+book back to back returns a normal pending row for the first and, if a `'success'`
  row already exists by the time the second's lock is acquired, `"You already own this book —
  no need to pay again."` for the second; a tip is unaffected (no lock, no ownership check, as
  before).

- **Item 35 — confirmed and fixed: achievement "wash trading" between accounts sharing a
  device signal.** `naira_achievement_current()`'s six purchase-based signals (buyer-side
  `nairaFirstPurchase`/`nairaBookCollector`/`nairaGrandCollector`, seller-side
  `nairaRookieMerchant`/`nairaHustler`/`nairaSeniorMan`) counted any `status='success'` purchase
  with no check that the buyer and seller were genuinely different people — two accounts
  controlled by the same person could buy each other's books back and forth purely to farm
  these signals, then convert the count into real, withdrawable Naira via
  `grant_naira_achievement()` → `achievement_grants` → `author_balance_kobo()`. The referral
  system already had this exact protection (`referral_devices_linked()`, checked before
  `grant_referral_reward()` pays anything); achievements never reused it.
  Fixed with `107_migration_achievement_wash_trading_device_check.sql` (folded into
  `schema.sql`): a new, achievement/referral-agnostic `accounts_share_device_signal(a, b)`
  function (same join over `device_signals` `referral_devices_linked` already uses, kept as its
  own function so neither feature depends on the other's naming) is now required to be `false`
  between the buyer and seller before a purchase counts toward any of the six signals above.
  Same soft-correlation posture the referral system's version already has — a real household or
  library-computer sharing a device isn't blocked from ever transacting, but a single person's
  own two accounts, once both have signed in from the same device at any point, can no longer
  pay each other for achievement credit.
  **Deliberately not retroactive** — a previously-granted achievement is not clawed back by this
  migration; `grant_naira_achievement()`'s idempotent lookup means an achievement already granted
  before this shipped stays granted (same posture as every other grant function in this schema —
  reversing an already-paid grant that turns out to have been wash-traded is a moderator action,
  mirroring `reverse_referral_grant()`, not something a schema migration does by itself).
  **Not run against a live Supabase instance from this session** (no network access here, same
  caveat as every other item in this document) — apply migration 107 (or re-run `schema.sql` on
  a fresh install) and manually verify: two accounts that have never shared a device can still
  buy from each other and see the purchase count toward `nairaFirstPurchase`/
  `nairaRookieMerchant` etc. as before; two accounts that have both signed in from the same
  device/browser at any point no longer see a purchase between them move either side's
  achievement signal, even though the purchase itself still succeeds normally and still pays the
  seller's real `purchases.author_amount_kobo` (this fix only touches achievement counting, not
  the underlying sale).

- **Item 36 — confirmed and fixed: no `charge.failed` handling in `paystack-webhook`.** A
  cancelled Paystack checkout popup or an outright-declined charge previously left its `pending`
  row untouched forever — there was no `charge.failed` branch in the webhook at all. Harmless for
  a book purchase/tip specifically (`paystack-init-purchase` has never checked for an existing
  pending row before creating a fresh one on retry, so a reader was never locked out — this was a
  data-hygiene gap, permanently-dead `pending` rows with no way to tell "abandoned" from
  "still mid-checkout" apart), but for a guild event entry or hosting-fee payment it meant a
  cancelled attempt kept counting toward `participant_limit` for the full 30-minute abandonment
  window (migration 104) instead of being marked failed — and freeing that slot — the instant
  Paystack actually told us the charge failed.
  Fixed in `supabase/functions/paystack-webhook/index.ts`: a new `charge.failed` branch,
  status-guarded exactly like every other branch here (`.eq('status', 'pending')` — an
  already-`'success'`/`'failed'`/`'refunded'` row is never touched), sets the matching row across
  `purchases`, `guild_event_entries`, and `guild_event_hosting_fee_payments` to `'failed'`. Same
  "safe to run all three, whichever table doesn't match just updates zero rows" reasoning
  `charge.success` already relies on. No schema/migration change needed — `'failed'` is already
  a valid status on all three tables (`purchases_status_check`,
  `guild_event_entries_status_check`, and the hosting-fee table's own check all already include
  it).
  **Not run against a live Supabase instance from this session** (no network access here) —
  redeploy `paystack-webhook` and manually verify: cancelling a Paystack checkout popup for a
  book purchase, a guild event entry, and a guild hosting-fee payment each now flips that row to
  `'failed'` (visible immediately, not just after the 30-minute event-entry timeout); a
  subsequent retry for a book/tip still works exactly as before (a fresh pending row, unaffected
  by the old failed one); a `charge.success` event for a *different, still-valid* reference is
  unaffected by this change.

- **Item 37 — confirmed and fixed: stale "file incomplete" comment in `schema.sql`.** A large
  comment block partway through the file (originally right after `grant_naira_achievement`)
  claimed the live database had migrations "well beyond this point" that were "applied directly
  and never folded back into this consolidated file," and that the file was "NOT currently a
  complete fresh-install script on its own." That was already false when it was written — the
  file plainly contains every migration through 103 below that comment — and stayed false
  through 104-107 being added the same consolidated way. Left as-is, this would mislead a future
  developer (or a future Claude session) into thinking a fresh install needs extra manual
  migrations it doesn't, or into not trusting `schema.sql` as the source of truth it actually is.
  Fixed by rewriting the block in `supabase/schema.sql` to state the file's actual, current
  status (complete through migration 107) and to explicitly flag that the old claim was already
  inaccurate rather than silently deleting it — same "correct a wrong claim visibly, don't just
  quietly fix it" convention this tracker document itself uses (see the "Confirmed still open"
  standing rule and the correction above item 31). No functional change — comment only, no SQL
  logic touched.

---

## Feature: locked-escrow guaranteed prizes for Player Guild events (108_migration_guild_event_prize_escrow.sql)

Built at the app owner's explicit request, with these confirmed rules (not inferred):
- Founder Guilds still cannot host events at all — untouched.
- A Player Guild that promises a fixed prize on a guild-hosted event must deposit the full amount
  into a locked escrow before the event can open for entries.
- Entry fees go into the guild's ordinary Event Revenue Pool (plain treasury credit); the
  escrowed prize is paid out separately at settlement — the two pools never mix (app owner's
  explicit answer).
- Cancellation is refused outright the instant one entrant has paid (or has a payment still
  in flight within the same 30-minute window `create_guild_event_entry_locked`'s own
  participant-limit count already uses) — there is deliberately no "not enough participants"
  cancellation path. The one exception, also per the app owner: an Inkroot admin
  (`is_inkroot_admin()`) can force-cancel for a genuine dispute even after entries exist —
  `admin_cancel_guild_event_dispute()` — which releases the escrow but does not itself refund any
  entrant (this app has never called Paystack's refund API directly; that still happens by hand
  from Paystack's dashboard, same as every other refund here).

Design decisions made while implementing, in order of how much they change actual payout math —
flagged here rather than left implicit, since none of them were stated in so many words:
- **The escrowed prize is still split via the event's existing, unchanged
  `guild_event_financial_agreements` row** (`prize_pool_bps`/`guild_share_bps`/
  `other_allocations`, still required to sum to exactly 10000, still locked at activation) — only
  what funds `v_gross` changes (the escrow amount instead of the live entry-fee sum). This reuses
  every existing validation/locking guarantee that system already had rather than inventing a
  parallel one. If the intent was actually "100% of the escrowed amount goes to winners, no guild
  cut skimmed from the prize itself" (since the guild already gets its cut from the entry-fee
  pool separately), that's a real, different design and would need `settle_guild_event`'s
  escrowed branch changed to require `v_shares_sum = 10000` instead of `= prize_pool_bps`. Left
  as the more conservative, structure-preserving choice — flag if wrong.
- **A critical landmine avoided, not a design choice**: `distribute_guild_revenue()` dedups by
  `project_event_id` alone — ANY existing `guild_treasury_transactions` row with that
  `project_event_id` blocks it from ever running for that event again, regardless of kind. The
  escrow lock/release rows therefore use a NEW, separate `escrow_event_id` column, never
  `project_event_id` — tagging them with `project_event_id` (the "obvious" choice) would have
  permanently blocked the event's own `settle_guild_event()` call before it ever ran, since the
  escrow row is written at activation time, long before settlement. Traced this by reading
  `distribute_guild_revenue`'s actual dedup query, not by inspection of its comment alone.
- **Large prizes (≥ ₦100,000, the existing multi-approval threshold) are refused outright** by
  `deposit_guild_event_prize_escrow`, same as `spend_from_guild_treasury` already refuses a large
  ordinary spend — this migration does not build a multi-approval path for large guaranteed
  prizes; it directs the caller to get the spend approved through the guild's existing
  multi-approval flow and "contact Inkroot to link it to this event," which is not itself
  implemented. A guild wanting a guaranteed prize ≥ ₦100,000 cannot actually do so through this
  feature yet.
- **`cancel_guild_event` is gated by `is_guild_officer`, not `is_guild_treasury_authorized`**,
  even though it can release treasury funds — matching the existing lifecycle-function
  convention (`activate_guild_event`/`publish_guild_event`/`complete_guild_event` are all
  `is_guild_officer`-gated), on the reasoning that the officer who could create and fund the
  event is already trusted to unwind it. `deposit_guild_event_prize_escrow` itself still requires
  the stronger `is_guild_treasury_authorized` check, matching `spend_from_guild_treasury`.
- **A subtle lock-key bug in the EXISTING codebase, worked around rather than fixed here**:
  `create_guild_event_entry_locked`'s own comment claims it shares a lock key with
  `settle_guild_event`, but the literal strings differ (`'guild_event_entry:<id>'` vs
  `'guild_event_settlement:<id>'`) — they do NOT actually serialize against each other. Not
  touched (out of scope for this feature), but `cancel_guild_event`/
  `admin_cancel_guild_event_dispute` deliberately lock on the literal string
  `create_guild_event_entry_locked` actually uses, not what its comment claims, so cancellation
  genuinely can't race a concurrent entry attempt. Worth a real audit pass on its own later.

**Not implemented in this pass**: the guild-events-panel.jsx UI (declaring a guaranteed prize on
the create/edit form, an escrow-deposit button, hiding the cancel action once entries exist,
surfacing the admin dispute-cancel action). The backend (`schema.sql` migration 108) and the
client data layer (`src/lib/guild-events.js`: `guaranteedPrizeNaira` on `toEventRpcArgs`/
`mapEvent`, `depositGuildEventPrizeEscrow`, `cancelGuildEvent`, `adminCancelGuildEventDispute`)
are both done and are what actually enforce every rule above server-side — the UI is a
follow-up, left undone here rather than making blind edits to a 900-line JSX file with no way to
render or test it in this session.

**Not run against a live Supabase instance from this session** (no network access here, same
caveat as every other item in this document) — apply migration 108 (or re-run `schema.sql`
fresh) and manually verify the full lifecycle: declare a guaranteed prize on a draft, confirm
`activate_guild_event` refuses until `depositGuildEventPrizeEscrow` succeeds, confirm an entrant
paying blocks `cancelGuildEvent` immediately, confirm `admin_cancel_guild_event_dispute` still
works after that with a reason and releases the escrow, and confirm `settle_guild_event` pays
winners from the escrow while entry fees land in the treasury as a separate
`event_entry_revenue` credit.

---

## Correction to the escrow feature above: escrowed prize pays winners in full (109_migration_escrowed_prize_pays_winners_in_full.sql)

App owner's own follow-up: if a guild puts up a guaranteed prize, the full amount goes to the
declared winners — the financial agreement's `prize_pool_bps`/`guild_share_bps` split (designed
to divide variable, uncommitted entry-fee revenue) had no business also skimming a cut off a
fixed amount the guild explicitly set aside as the prize, especially since the guild already
gets 100% of collected entry fees separately as Event Revenue Pool income (migration 108's
`event_entry_revenue` credit).

Fixed: an escrowed event (`guaranteed_prize_kobo` set) no longer requires or checks a
`guild_event_financial_agreements` row at all — `activate_guild_event` skips that requirement
for an escrowed event (same "nothing to split, nothing to declare" posture `host='inkroot'`
events have always had), and `settle_guild_event` now requires declared winner shares to sum to
exactly 10000 (100%) for an escrowed event, funding the full payout from escrow with zero
guild-share leftover. A non-escrowed `host='guild'` event is completely untouched — still
requires and validates against its locked financial agreement exactly as it always has.

**Not run against a live Supabase instance from this session** — apply migration 109 (or re-run
`schema.sql` fresh) and verify: an escrowed event's `activate_guild_event` no longer requires a
proposed financial agreement; `settle_guild_event` for an escrowed event rejects any winner-share
total other than exactly 10000 and pays that full amount out with no residual guild credit from
the escrow itself (the guild still separately receives the `event_entry_revenue` credit for
whatever entry fees came in, unchanged from migration 108); a non-escrowed event's settlement is
byte-for-byte the same as before either migration.

---
---

## Audit finding (Critical): Naira achievement grants had no reversal path (110_migration_achievement_grant_reversals.sql)

A refund or chargeback after an achievement payout left the reward withdrawable forever:
`achievement_grants` is append-only and `grant_naira_achievement()` is a one-time claim, so "buy N
books → hit the target → get paid → refund" (or the seller-side mirror) kept the Naira.
Referral rewards closed this in migrations 58/59; achievements never got the same treatment.

Fixed by mirroring the referral shape: `achievement_grant_reversals` (append-only, unique per
grant, owner-read-only RLS, no client write policy); `reverse_achievement_grant()` (service_role
or moderator, idempotent, per-grant advisory lock); `reconcile_naira_achievements()` (daily
04:30 UTC via pg_cron, staggered from the 04:00 referral sweep, with migration 102's cron guard
built in from the start); and `author_balance_kobo()` now subtracts reversed achievement grants.
The six purchase-based signals were extracted into `naira_purchase_signal(user, id,
include_refunded)` so the sweep can evaluate an explicit user; `naira_achievement_current()`
calls it, so there is still one definition of each signal. `naira_achievement_progress()` gained
a `reversed` column and `unlocked` is now false once reversed (same fix as migration 59's
`referral_reward_progress()`); `src/lib/naira-achievements.js` is unchanged and keeps working.

**Deliberately refund-driven only, not retroactive for rule changes.** The sweep reverses a grant
only when `count(success + refunded) >= target` and `count(success) < target`. Grants that would
fail today's stricter signals for other reasons (pre-103 free packs/tips, pre-107 same-device
purchases) are NOT reversed — migrations 103 and 107 both explicitly chose not to claw those back.
A reversed grant is permanent (no re-earning by re-buying). Only the six purchase-based ids are
swept; a moderator can reverse any grant by hand via `reverse_achievement_grant()`.

**Not run against a live Supabase instance from this session** (no Postgres available here) —
apply migration 110 (or re-run `schema.sql` fresh) and verify: mark a purchase behind a granted
achievement `refunded` and run `select reconcile_naira_achievements();` as postgres → one row in
`achievement_grant_reversals`, `author_balance_kobo()` drops by the reward, the Hall of Legends
shows it locked with `reversed = true`; a second run reverses nothing; the cron job appears in
`cron.job` and `cron.job_run_details` shows success after its first 04:30 UTC run.

---
---

## Audit finding (High): no friction between saving a payout account and withdrawing to it (111_migration_payout_account_cooldown.sql)

A session hijacker could add their own bank account, make it default, and withdraw the whole
balance within a minute. Fixed: `create_withdrawal_locked()` and `create_manual_withdrawal_locked()`
now call one shared check, `assert_bank_account_cooldown_elapsed()`, and refuse a withdrawal to an
account whose `bank_accounts.created_at` is inside a configurable window (default 24h,
`payout_security_config.new_account_cooldown_hours`, platform-admin-only, 0 = off). A user's
first-ever saved account is exempt; because `bank_accounts` allows client-side DELETE, "first-ever"
is backed by `bank_account_removals` (delete-trigger, no client access) so deleting the victim's
account and re-adding another can't be used to claim the exemption.

The owner is alerted on every add and every default change via a `payout_account_changed` row in
`notifications` (a trigger on `bank_accounts`, so it also covers `set_default_bank_account()`, which
never touches `paystack-save-bank-account`). Last four digits only. `inbox-and-living-universe.jsx`
gained the small type → System Announcements mapping needed to display it (an unmapped type is
silently dropped by the Inbox). `set_default_bank_account()` now no-ops when the target is already
default, to avoid a false alert. Also revokes anon/authenticated EXECUTE on migration 110's
`naira_purchase_signal()`, which takes an arbitrary user id.

**Not built: email.** No mail provider exists in this repo and Supabase Auth's admin API can't send
arbitrary messages, so the alert is in-app only (documented in `PAYMENTS.md`). **Not run against a
live Supabase instance from this session** — apply migration 111 and verify: add a second account
and try to withdraw to it (blocked, exact message above); withdraw to the older account (works);
first-ever account withdraws immediately; delete-then-re-add gets the cooldown; the alert shows in
the Inbox for an add and for a default change, and not for re-selecting the current default.

---
---

## Audit finding (High): guild treasury spends had no velocity limits; admins implied Founder Guild treasury authority (112_migration_guild_treasury_spend_limits.sql)

`spend_from_guild_treasury()` only refused amounts at/above the ₦100,000 multi-approval threshold,
so one authorizer (or a compromised session) could drain a treasury with repeated sub-threshold
spends. Fixed with (1) a per-guild limit of 5 spend/propose calls per 24h and (2) a rolling 24h cap
of ₦300,000 on *direct* spends per guild, computed from `guild_treasury_transactions` under the
guild's existing advisory lock. Spends executed through `approve_guild_treasury_spend()` don't
count toward the cap (excluded via `guild_treasury_spend_requests.transaction_id`, not the
client-supplied idempotency key). `propose_guild_treasury_spend()` now also accepts an
under-threshold amount when it wouldn't fit the remaining direct allowance, and
`SpendModal` retries as a proposal on that specific error, so a capped guild isn't dead-ended.

The per-guild counter is deliberately **not** an action on the client-callable
`check_and_bump_rate_limit()`: a guild-id argument there would let any signed-in user burn another
guild's quota. It lives in `guild_rate_limits` behind `check_and_bump_guild_rate_limit()`, which no
client role can execute.

New `profiles.is_founder_guild_treasurer`, locked like `is_platform_admin` in
`protect_admin_profile_columns()`; `guild_treasury_role()`'s Founder Guild branch now requires it
instead of `is_platform_admin`. **Action required after applying:** no one holds the flag yet, so
the Founder Guild treasury fails closed (can't be spent from or approved against) until you run
`update profiles set is_founder_guild_treasurer = true where id = '<user-id>';` (or
`... where is_platform_admin;` to keep today's behavior). The flag is independent of admin status
(revoking admin does not clear it) and has no in-app grant/revoke, same as `is_platform_admin`.

**Not run against a live Supabase instance from this session** — apply migration 112 and verify: the
6th spend call in 24h is refused; a 5th cumulative ₦-amount pushing direct spends past ₦300,000 is
refused while a multi-approved spend doesn't count toward it; concurrent spends can't both pass;
an admin without the flag gets "Only the guild leader…" on the Founder Guild; setting the flag on
own profile from a client session has no effect.

---
---

## Audit finding (High): Inkroot-hosted event prizes had no funding check (113_migration_inkroot_prize_reserve.sql)

`create_guild_event()`'s `host='inkroot'` branch only checked the caller was an admin and the prize
positive, so an admin (or compromised admin session) could publish an unfundable prize and
`settle_guild_event()` would credit the winners' guild treasury with money that was never set
aside. Fixed with `platform_reserve_kobo`, an append-only ledger (update/delete blocked by trigger)
of Inkroot's declared prize reserve. Creating an Inkroot event now requires the prize to fit the
available reserve and debits it in the same transaction under a dedicated advisory lock; both
cancel paths (`cancel_guild_event`, `admin_cancel_guild_event_dispute`) release it; settlement
closes the reservation (`event_prize_settled`). `top_up_platform_reserve()` /
`withdraw_from_platform_reserve()` are SQL-editor/service-role only (guarded by `session_user`, so
no app session can call them) — an admin session that could top up its own reserve would make the
check meaningless. Documented in `PAYMENTS.md`.

**It's an accounting control, not proof of real funds:** a top-up is the operator's declaration.
**The reserve starts at zero, so creating an Inkroot event fails until an operator tops it up.**
Inkroot events created before this migration have no reservation and settle unchanged (blocking
them would stop already-announced prizes being paid); `PAYMENTS.md` has a query listing the open,
unreserved ones. **Not run against a live Supabase instance from this session** — apply migration
113 and verify: creating an event with an empty reserve fails with the reserve message; after a
top-up it succeeds and `platform_reserve_kobo` shows an `event_prize_reserved` row; a second event
exceeding the remainder fails; cancelling releases; settling adds `event_prize_settled`; calling
`top_up_platform_reserve` from a signed-in client session returns "Not authorized."

---
---

## Audit finding (Medium): no central audit trail for admin/financial actions (114_migration_admin_audit_log.sql)

The admin security-definer functions did their work and returned with nothing recording who did
what — e.g. `admin_settle_manual_withdrawal()` overwrote the row with no record of which admin
marked a real transfer as sent, and `admin_set_login_ban()` recorded no actor at all. Fixed with
`admin_audit_log` (append-only, update/delete blocked by trigger; `is_inkroot_admin()`-only
SELECT; no client write policy) written only through `record_admin_action()`, an internal
security-definer helper (execute revoked from every client role) that always stamps
`actor_id = auth.uid()`. Now logged, with before/after state: `admin_settle_manual_withdrawal`
(+ `amount_kobo`, note), `admin_revoke_platform_role`, `admin_set_login_ban`,
`approve_guild_event` / `reject_guild_event`, `approve_guild_event_results` /
`reject_guild_event_results` (+ amount distributed), and — beyond the audit's minimum list —
`admin_cancel_guild_event_dispute` (+ escrow/reserve released), since it also moves money. Also adds
`withdrawals.settled_by`, stamped by `admin_settle_manual_withdrawal()`.

`actor_id` / `target_id` have no foreign keys on purpose (an `ON DELETE SET NULL` would need to
update a log row when an account is deleted, which the immutability trigger forbids). Not
audited: reserve top-up/withdraw, hosting-fee changes, referral/achievement reversals — each
already has its own append-only ledger. **Not run against a live Supabase instance from this
session** — apply migration 114 and verify: settling a manual withdrawal adds an
`admin_audit_log` row with your id as `actor_id`, the before/after rows and `amount_kobo`, and sets
`withdrawals.settled_by`; `update`/`delete` on the log fails; a non-admin reads zero rows;
`select record_admin_action('x','y',null)` from a client session is refused.

---
---

## Audit finding (Medium): guild-book purchase vs. membership inconsistency (`download-book`, `paystack-init-purchase`)

`download-book` treated a guild-destination book as membership-gated (no `purchases` check), while
`paystack-init-purchase` let a Guild member start a paid `kind='book'` checkout for one — a
payment that unlocks nothing. Resolved to **model (a): guild books are free for members**, because
every other path already works that way: `published_book_content`'s read policies (migrations
90/92), `checkBookReadAccess()` (treats a guild book as price 0), `download-book`, and the
publishing wizard's note that Guild-only listings aren't sold in the Grand Library. So the fix is
in `paystack-init-purchase` only: `kind='book'` on a guild-destination book is now refused with a
clear message (after the existing non-member check), while `kind='tip'` still works for members.
`download-book` behavior is unchanged; both files' comments now describe the one model. No
migration. **Not deployed or run from this session** — redeploy `paystack-init-purchase` and
`download-book`, then verify: a member calling `kind='book'` on a guild book gets the "free for
Guild members" error; a member `kind='tip'` still reaches checkout; a non-member still gets "not a
member"; Grand Library book purchases are unaffected.

---
---

## Audit finding (Low): full bank account number sent to Telegram (`manual-withdraw`)

The manual-withdrawal Telegram alert included the writer's full account number. It now shows only
the last 4 digits (`•••• 4417`); bank name and account name are unchanged, and the full number
stays available to admins in the in-app Manual Withdrawals queue. **Not deployed or run from this
session** — redeploy `manual-withdraw` and verify a new request's Telegram message is masked.

---
---

## Audit finding (Low): buyer ≠ author only enforced by the edge function (115_migration_purchase_buyer_not_author.sql)

`create_purchase_locked()` accepted any buyer/author pair; only `paystack-init-purchase` checked
they differed. Added `if p_buyer_id = p_author_id then raise exception 'A buyer cannot purchase or
tip their own book.'` near the top of the function, so the rule holds for any caller. Otherwise
migration 106's body unchanged; the edge function's own (friendlier) check stays. **Not run against
a live Supabase instance from this session** — apply migration 115 and verify a same-id buyer/author
call as service_role raises that message while a normal pair still inserts.

---
---

## Owner request: large guild event escrows were impossible (116_migration_guild_event_escrow_limit.sql)

`deposit_guild_event_prize_escrow()` refused any guaranteed prize ≥ ₦100,000 (the shared
multi-approval threshold) pointing at a multi-approval flow that can't be linked to an event, so
larger prizes couldn't be escrowed at all. Escrow now has its own ceiling, `guild_event_escrow_max_kobo()`
= ₦5,000,000; the shared threshold and the 24h direct-spend cap are untouched. **Trade-off:**
₦100,000–₦5,000,000 escrows are now single-authorizer (bounded by available balance and the
ceiling). **Not run against a live Supabase instance from this session** — apply migration 116 and
verify a ₦1,000,000 prize escrows, ₦5,000,001 is refused with the "at most ₦5,000,000" message.

---
---

## Production-readiness audit (static review) — confirmed issues fixed

Reviewed by reading code and SQL only; nothing was run against a live Supabase/Paystack.
1. **Banned account could join a Player Guild** (Medium) — `join_player_guild_by_code()` lacked the
   `is_banned` check the dropped direct-insert policy had. Fixed in
   `117_migration_join_guild_banned_check.sql`.
2. **Moderator-removed book could still be bought** (Medium) — `paystack-init-purchase` runs as the
   service role and never checked `removed_by_moderator`. Now refuses with "Book not found".
3. **Moderator-removed book could still be downloaded** (Medium) — same gap in `download-book`
   (author still allowed). Fixed.
Redeploy `paystack-init-purchase` and `download-book`; apply migration 117.

---
---

## Audit finding (High for buyer trust): unpublishing a sold book or pack cut buyers off (118_migration_protect_sold_listings_on_unpublish.sql)

`published_books`/`published_packs` allowed the author to DELETE their own listing. `purchases.book_id`/
`pack_id` are `on delete set null` and `published_book_content`/`published_pack_content` cascade, so
paying buyers lost the book/pack for good while the author kept the earnings. Now: the Unpublish button
calls `unpublish_book()` / `unpublish_pack()`, which delete when nobody has paid and otherwise HIDE the
listing (books: `destination = 'unlisted'`; packs: `unlisted = true`) so buyers keep reading/downloading;
a `BEFORE DELETE` trigger on both tables blocks any other delete of a listing with a paying (or
in-flight, <24h pending) buyer, standing aside only when the author's `auth.users` row is itself being
deleted; buyers get a SELECT policy on the listing row of what they own. `paystack-init-purchase`,
`paystack-init-pack-purchase` and `download-book` treat an unlisted item as not found for non-buyers.
`publishPackRemoteFlow` no longer rolls back (takes down) an already-live pack when a re-publish fails.
A sold book's download flag stays locked (existing trigger) — the publishing wizard copy says so.
**Not run against a live Supabase instance from this session** — apply migration 118, redeploy the three
Edge Functions, and run the verification steps in the migration's header. Addons/templates are not sold
through `purchases`, so they are unaffected.

---
---

## Audit finding (Low): bank list capped at 100 (`paystack-banks`, `paystack-save-bank-account`)

Both functions asked Paystack for `perPage=100` once, so banks past the first 100 could not be chosen or
saved ("Unrecognized bank"). Both now use `fetchAllNigerianBanks()` (cursor pagination via
`use_cursor=true` / `meta.next`, page-number fallback, repeat-page and 10-page guards). Unit-tested against a
mocked Paystack (257 banks; cursor, page-only and cursor-ignoring behaviours) — **not run against the
real Paystack API**. Redeploy both functions.

---
---

## Audit finding (Low): self-follow allowed at the API (119_migration_follows_no_self_follow.sql)

`follows` had no `follower_id <> followee_id` check. Migration 119 deletes any existing self-follow rows and
adds `follows_no_self`. **Not run against a live database** — apply and verify a self-insert fails.

---
---

## Audit items closed with no change

`stamp_report_resolution` search_path — already pinned by migration 96 (`schema.sql` `alter function
stamp_report_resolution() set search_path = public`); a scan of all 143 security-definer functions found none
without a pinned search_path. `record_book_view` granted to `anon` — intentional and hardened (input
whitelist, per-viewer and anonymous throttles, table privileges revoked, trending weights anonymous views low
and requires 2+ signed-in viewers).

## Audit finding (Medium): deposit_guild_event_prize_escrow missing entry/settlement locks (138_migration_deposit_escrow_event_locks.sql)

`deposit_guild_event_prize_escrow()` only took the guild-level advisory lock, not the per-event
entry/settlement locks migration 120 introduced and that `cancel_guild_event`,
`admin_cancel_guild_event_dispute`, and `settle_guild_event` already take. A deposit and a
`cancel_guild_event` racing on the same event could leave the treasury debited into escrow for an
event that's already cancelled, with nothing to release it. Fixed by taking the same
entry-then-settlement locks, in the same order, before the existing guild-level lock. **Not run
against a live database** — apply migration 138 and verify per its header.

---
---

## Audit finding (Medium): anthology custom-split duplicate-contributor gap (139_migration_anthology_custom_split_dup_check.sql)

`propose_anthology_revenue_agreement()`'s custom-split branch had the same gap migrations 134/136
already closed elsewhere: a guild officer could name one approved contributor twice while omitting
a different one, and every existing check (headcount, membership, sum-to-10000) still passed,
silently zeroing the omitted contributor's share. Fixed with the same
`group by contributor_id having count(*) > 1` check migration 134 uses in `settle_guild_event`.
**Not run against a live database** — apply migration 139 and verify per its header.

---
---

## Audit finding (Low): guild name/motto inputs missing maxLength

`GuildBanner`'s name and motto `<input>` elements (`guild-hall.jsx`) had no `maxLength`, while
`create_or_get_own_guild()` caps them at 60/200 chars (migration 126) — reproducing the same bug
already fixed once for the writer's own profile motto field. Added `maxLength: 60` (name) and
`maxLength: 200` (motto). No migration needed.

---
---

## Audit finding (Medium): pending account deletion didn't block founding a guild (140_migration_pending_deletion_blocks_guild_founding.sql)

Migration 79 checks guild ownership only when the `account_deletions` row is written, and
`purge_expired_account_deletions()` never re-checks — so an account could request deletion while
guild-less, found a guild inside the 30-day window, and have it orphaned on day 30 (owner's
membership deleted, account banned, `owner_id` left pointing at it). Fixed with option (a):
`create_or_get_own_guild()` now refuses while the caller has a `status = 'pending'` deletion row,
but ONLY when the caller owns no guild yet — the same RPC is the upsert behind every edit of an
existing guild, so an owner with a pending deletion can still edit theirs. Founding, and
re-entering with a local id that never synced, are refused; cancelling the deletion (or a
`'cancelled'` row) lifts it. `purge_expired_account_deletions()` is unchanged (option (b) not
taken). Known gap, same as migration 79's own check: no lock against a deletion *request* landing
at the same instant as a founding. Test script:
`supabase/tests/140_pending_deletion_blocks_guild_founding.test.sql`. **Not run against a live
database** — apply migration 140, then run that script and confirm it ends with `PASS`.

---
---

## Audit finding (Low): sync-status indicator couldn't tell "signed in" from "actually online"

`SyncStatusIndicator` (`src/shell/sync-status-indicator.jsx`) drove its green "Online — syncing" state
from `!!session` alone, so a signed-in writer who lost wifi or switched on flight mode kept seeing green
while nothing synced. Two changes:

1. **Indicator:** added a fourth, distinct state — a muted grey dot (`#9C9280`, same size/glow pattern as
   the other three) with the tooltip "Signed in, but this device is offline — changes are saved here and
   will sync when you're back online" — driven by `navigator.onLine` plus window `online`/`offline`
   listeners inside the indicator itself. Precedence: signed out (red) > signed-in-but-offline (grey) >
   rejected (amber) > online (green). `sync-context.jsx` is untouched; its existing `online`-event retry
   already flushes the outbox on reconnect.
2. **`pushOutbox()` (`src/lib/syncEngine.js`) — empty-code network errors are now transient.** supabase-js
   *returns* network failures (`{ data: null, error }` with an empty `code`) instead of throwing, and
   `pushOutbox` dropped the error from its first lookup, so offline `remote` came back null, was misread as
   "never synced," and the key went into the insert branch — where any code other than `23505` (including
   `''`) called `noteRejected`, flagging a lost connection as "rejected by the server / item may be too
   large." Now: a code-less error on the lookup, or on the insert, throws (`sanitizeError`) so the pass
   aborts, the outbox is kept, and `runSync`'s existing catch retries on the next trigger — the same rule
   the update branch already applied. An error that carries a real SQLSTATE behaves exactly as before
   (`23505` = race, left for the next pass; anything else = rejected).

No migration. **Known limit, by design:** `navigator.onLine === true` only means the device has *a*
connection, so a captive portal or server-side outage still reads green (though it no longer produces a
false amber). **Verified** (mocked supabase/idb harness, not the real client): offline-with-pending-write no
longer marks the key rejected or attempts an insert (fails before the change, passes after), and the
23514 / 23505 / success paths behave as before. **Not run in a browser or against a live database** — verify
with devtools "Offline" while signed in with a pending write: the dot turns grey (never amber), and returns
to green after going back online once the outbox flushes.

---
---

## Audit finding (Medium): reserved profile names only blocked client-side (141_migration_profile_reserved_name_trigger.sql)

`isReservedName()` (`identity-safety.js`) only ran inside `saveProfile` before `syncProfile`, which is a plain
`profiles.update({ display_name, pen_name, ... })` under the `auth.uid() = id` RLS policy — so a direct API
call could set `display_name: 'Inkroot Support'` and impersonate staff. Migration 126 did this for guild
names and deferred profiles. Fixed with a `before insert or update of display_name, pen_name` trigger
(`validate_reserved_profile_names`) that raises `That name isn't available.` for a reserved name. It reuses
`is_reserved_guild_name()` from migration 126 directly (one SQL reserved list, already identical to
`RESERVED_NAMES` in `identity-safety.js`) — nothing invented. Matches the guild implementation on purpose:
**no accent folding** (so `Ínkroot` passes server-side, as it already does for guild names), and **no
lookalike check** (`findSimilarName` stays a client-side soft warning, unchanged). On UPDATE it only objects
when the name actually *changes*, so a writer already holding a reserved name can still save other fields;
null/blank names pass; callers with no signed-in user (SQL editor, service role, cron) are exempt so the
real Inkroot account can be named by an operator; the trigger's name makes it fire after
`protect_admin_profile_columns_trigger`. No existing row is touched; the migration header has a diagnostic
query for profiles already holding a reserved name. Test: `supabase/tests/141_reserved_profile_names.test.sql`.
**Not run against a live database** — apply migration 141, run that script, confirm it ends with `PASS`.

Companion change for the same finding (unique names): see the next entry (migration 142).

---
---

## Audit finding (Medium): profile names weren't unique — impersonation by exact copy (142_migration_unique_profile_names.sql)

Requested as part of finding 5: enforce server-side uniqueness for public profile names. Chosen
scope: `display_name` and `pen_name` are each **case-insensitively unique on their own column** (compared
as `lower(btrim(...))`; a display_name equal to someone else's pen_name is allowed). Lookalike detection
is unchanged — still the client-side soft warning in `identity-safety.js` — and no new normalization was
invented beyond lower/trim. Pieces: (1) a pre-flight that **aborts the migration, changing nothing,** if
duplicates already exist (it lists them; which account keeps a name is a moderation decision; the header
has the diagnostic query); (2) partial unique indexes `profiles_display_name_lower_unique` /
`profiles_pen_name_lower_unique` (null/blank excluded; the display_name one also excludes
`handle_new_user()`'s `Writer <8 hex>` placeholder, so a chance collision on that seed can't make a
*sign-up* fail); (3) `validate_unique_profile_names` trigger giving a readable P0001 message ("That
display name is already taken — please choose another.") ahead of the index — fires on insert and only on
a real change, ignores the caller's own row, mirrors the index predicate exactly. Client: `syncProfile`
tags a P0001 as `PROFILE_NAME_REJECTED` and `saveProfile` shows that message instead of the generic
notice (also covers 141's reserved-name message); one comment added to `identity-safety.js`, no behavior
change there. **Judgment calls:** lower + btrim as the comparison (so `Jane Austen ` can't dodge it);
the placeholder exemption; abort-don't-auto-resolve for existing duplicates. **Known consequence:**
`saveProfile` syncs every keystroke, so a typed prefix that equals someone else's exact name is refused
for that keystroke (the notice clears on the next accepted one; the server keeps the last accepted
value meanwhile). It also deliberately overrides `identity-safety.js`'s old "real people share names"
stance for exact matches — the trade-off is first-come name squatting; the verified badge and report
flow are still the remedy for that. Test: `supabase/tests/142_unique_profile_names.test.sql`.
**Not run against a live database** — apply migrations 141 and 142 (142 will stop and list any existing
duplicate names first), then run the tests and confirm each ends with `PASS`.

---
---
