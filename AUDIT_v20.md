# Inkroot production-readiness audit (v19 -> v20)

Static audit only: no network, Postgres, npm build or live Paystack/Supabase was available. Every change
below was syntax-checked (all edited JS/JSX parse; every SQL file passes a statement scanner) and, where
noted, unit-tested with a local harness; none has been run against a deployed project.

## Fixed in v20 (all the open items from v19)
| # | Severity | Where | What broke | Fix |
|---|----------|-------|-----------|-----|
| 8 | High (buyer trust) | published_books / published_packs, unpublishBookRemote / unpublishPackRemote | Unpublish did a real DELETE. purchases.book_id / pack_id are `on delete set null` and the content tables cascade, so paying buyers permanently lost what they bought while the author kept the earnings. Packs had the identical defect (not in the v19 list). | Migration 118: `unpublish_book()` / `unpublish_pack()` delete only when nobody has paid, otherwise hide (books `destination='unlisted'`, packs `unlisted=true`); BEFORE DELETE triggers block any other delete of a listing with a paying or in-flight (<24h pending) buyer, standing aside only when the author's auth.users row itself is being deleted; buyers get a SELECT policy on the listing of what they own. Every existing public policy and ranking already filters on destination 'inkroot'/'guild', so an unlisted book drops out of them with no other edit. Client shows a "taken off sale" notice; failed re-publish of a live pack no longer takes it down. download-book, paystack-init-purchase, paystack-init-pack-purchase refuse an unlisted item for non-buyers. Redeploy those three functions. |
| 9 | Low-Medium (unverified against live Paystack) | paystack-banks, paystack-save-bank-account | Single `perPage=100` request; banks past 100 could not be chosen or saved ("Unrecognized bank"). | `fetchAllNigerianBanks()` follows Paystack's cursor (`use_cursor=true`, `meta.next`), falls back to `page=N`, stops on a short page / repeat page / 10 pages. Mock-tested with 257 banks in cursor, page-only and cursor-ignoring modes. The three inlined copies are identical. Redeploy both functions. |
| 10 | Low | follows | No `follower_id <> followee_id` check; API self-follow added +1 to an author's follower count. | Migration 119 deletes any existing self-follows and adds `follows_no_self`. |

Migrations 118 and 119 are folded into supabase/schema.sql (status note updated to 119).

## Closed with no change
- `stamp_report_resolution` search_path: already pinned by migration 96 (`alter function ... set search_path = public`, schema.sql ~line 12658), so the v19 item was stale. A scan of all 143 security-definer functions found none without a pinned search_path.
- `record_book_view` granted to anon: confirmed intentional. Input whitelist, per-viewer and anonymous throttles, direct table privileges revoked, and trending weights anonymous views at 0.15 and needs 2+ signed-in viewers.

## To apply
1. Run migrations 118 and 119 (existing deployment) — or the updated schema.sql on a fresh project.
2. Redeploy: `paystack-init-purchase`, `paystack-init-pack-purchase`, `download-book`, `paystack-banks`, `paystack-save-bank-account`, plus the v19 set (`paystack-webhook`, `paystack-withdraw`) if not yet done.
3. Verify (steps are in the header of migration 118): a sold book unpublishes to 'hidden' and its buyer can still read and download it; an unsold one is deleted; a direct DELETE of a sold listing is refused; republishing relists it; same for a pack; deleting an author in a test project still works. Then check the live Paystack NGN bank count and that a bank beyond the first 100 can be saved. Then a self-insert into follows fails.

## Fixed in v19 (carried forward)
| # | Severity | Where | What broke | Fix |
|---|----------|-------|-----------|-----|
| 1 | Critical (fresh install only) | supabase/schema.sql (Migration 109 block, ~line 14245) | `create or replace function activate_guild_event(...)` header line was missing, leaving a bare `returns guild_events ...` = SQL syntax error, so schema.sql could not be applied to a new project. history/109 was intact, so migrated databases were unaffected. | Restored the header line. A statement scanner now finds no malformed statement in schema.sql or any history/*.sql. |
| 2 | Medium | supabase/functions/download-book/index.ts (buildPdf) | pdf-lib StandardFonts are WinAnsi-only; any book with e.g. Yoruba/Igbo letters, the Naira sign, arrows, CJK or emoji made PDF download throw. Reproduced on pdf-lib 1.17.1 (original fails, patched produces a valid PDF). | `makePdfSafe()` maps unencodable characters (strip accents, N for the Naira sign, "->", else "?") before measuring/drawing. EPUB unchanged. |
| 3 | Medium (Paystack-transfer path only; ACTIVE_WITHDRAWAL_METHOD is currently 'manual') | paystack-webhook (transfer.*), paystack-withdraw | Webhook matched withdrawals only by paystack_transfer_code, which is written after the /transfer call returns and whose write result was ignored; an early webhook or failed write matched zero rows, returned 200, and left the withdrawal pending (failed transfers never refunded the balance). | Webhook also matches `id = data.reference` (the withdrawal uuid), only when it is a valid UUID (a non-UUID would cause a Postgres error and an endless Paystack retry loop) and transfer_code is sanitised for the filter; paystack-withdraw now logs a failed code write instead of ignoring it. Filter builder unit-tested. Redeploy `paystack-webhook`, `paystack-withdraw`, `download-book`. |
| 4 | Low | src/lib/referrals.js (redeemPendingReferralCode) | A permanently rejected ?ref= code (unknown code, or the user's own) stayed in localStorage forever and, because capture is "first link wins", blocked any later valid referral link on that device from being stored. | The stored code is now cleared when the server rejects it with its own P0001 error; network/other failures still keep it for retry. |
| 5 | Medium | src/lib/syncEngine.js (pushOutbox), src/shell/sync-status-indicator.jsx | On an UPDATE to an existing kv_store row, any server error threw and aborted the whole push pass. One row the server keeps rejecting (e.g. a project over the 20MB cap, code 23514) blocked every key sorted after it, and because runSync pushes before pulling, the device also stopped receiving changes from other devices. The insert branch already skipped such a key. Separately, rejections were only a console.warn and the sync dot stayed green ("Online - syncing"), so a writer could believe a manuscript was backed up when it was not. | An update error that carries a SQLSTATE/PostgREST code now skips that key (as the insert branch does) and records it; code-less errors (network, gateway 5xx) still abort the pass. The dot turns amber with an honest tooltip while any key is rejected; it clears when the key later pushes, on sign-out, or on account switch. Syntax-checked only, not exercised against a live database. |
| 6 | Low | src/library/author-identity.jsx | The motto input had no maxLength but profiles.motto is capped at 140. Past 140 characters every keystroke's profile sync failed (one UPDATE carries name, pen name, avatar and motto together), so nothing else saved either until the motto was shortened. | Added maxLength: 140, matching the name/pen-name fields' existing 80. |
| 7 | Low | src/shell/sync-context.jsx (OAuth error effect) | URLSearchParams.get() already decodes the value; the code decoded it again with decodeURIComponent, which throws URIError on a literal "%". Reproduced in Node. Uncaught inside an effect, that blanks the app on a failed Google sign-in whose error text contains a "%". | Removed the second decode. |


## Verified clean (static)
Parse of every src file; all imports/exports resolve; all 82 rpc() calls match SQL signatures; all table/column
references exist; RLS enabled on all 74 tables and client operations have matching policies; webhook HMAC +
status-guarded idempotency (duplicate charge.success/failed/refund events are no-ops); withdrawal advisory
lock + balance re-check, payout-account cooldown, purchase double-charge lock; paid / free / guild-only content
RLS; checkout cancel/error handling; WithdrawModal in-flight guard.

## Reviewed in the second pass
Google sign-in return handling, profile editing (client and profiles constraints), manuscript save path (storage.js, idb.js, the
whole of syncEngine.js, editor debounce/flush), guild founding/joining client code, guild event entry payment function, and the
referral reward signal functions. Findings 5-7 came from this pass. Nothing else confirmed.

## Still not reviewed
Guild event hosting-fee payment and settle_guild_event/escrow SQL beyond the entry path, the treasury spend-approval SQL,
Guild Order/Anthology screens, moderation, and account deletion (only its purge function was read, for the effect of migration 118).
Nothing has been run against a live project.
