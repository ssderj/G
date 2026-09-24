# Naira payments (Paystack) — setup

Inkroot's payment system runs on [Paystack](https://paystack.com), which supports Nigerian
cards, bank transfer, and USSD for collecting payments, and direct bank transfers for paying
authors out. This doc is everything needed to turn it on for a deployment — nothing here runs
automatically, none of it was deployed or tested from this environment (no network access), so
budget time to actually walk through it once against a real (or test-mode) Paystack account.

## What's real vs what this doesn't cover

- Readers can buy a published book, or tip an author, in Naira — charged via Paystack's inline
  checkout popup.
- Authors can save a Nigerian bank account once and reuse it — no re-entering account details on
  every withdrawal, only when adding a different account or removing one.
- Authors can withdraw their available balance (sales + tips, minus Inkroot's platform fee — see
  `PLATFORM_FEE_BPS` in `supabase/functions/_shared/payments.ts`, currently 10%) to their default
  saved account. **Right now this goes through manual review, not an automatic Paystack Transfer**
  — see "Manual withdrawals" below for why and how to switch it back once that's no longer true.
- **Not covered** (unchanged from before): buying more than one book from the Cart happens as
  separate sequential charges, not one combined transaction; Worldbuilding Packs and Guild-only
  listings still aren't purchasable — only books published to the Grand Library are.

## 1. Get a Paystack account

Sign up at [paystack.com](https://dashboard.paystack.com/#/signup). Start in **Test Mode** (the
toggle in the dashboard) and use Paystack's test cards until everything below is verified working
— switch to Live Mode (which requires business verification) only once you're ready to move real
money.

From **Settings → API Keys & Webhooks**, copy the **Secret Key** (`sk_test_...` or `sk_live_...`).
Never put this in `.env` or anywhere client-side — it only ever goes into Supabase's Edge Function
secrets (next step).

## 2. Deploy the database migration

Run `supabase/history/32_migration_naira_payments.sql` once against your Supabase project (SQL
editor, or `supabase db push` if you use migrations that way) — it's already included at the
bottom of the consolidated `supabase/schema.sql` too, so a **fresh** install just needs
`schema.sql` as usual.

## 3. Deploy the Edge Functions

Requires the [Supabase CLI](https://supabase.com/docs/guides/cli). From the project root:

```bash
supabase login
supabase link --project-ref <your-project-ref>

# The Paystack secret key — the one thing that has to be set by hand.
supabase secrets set PAYSTACK_SECRET_KEY=sk_test_xxxxxxxxxxxx

supabase functions deploy paystack-banks
supabase functions deploy paystack-resolve-account
supabase functions deploy paystack-save-bank-account
supabase functions deploy paystack-init-purchase
supabase functions deploy paystack-webhook --no-verify-jwt
supabase functions deploy paystack-withdraw
supabase functions deploy manual-withdraw
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are already available to
every Edge Function automatically — nothing to set for those.

`paystack-webhook` is deployed with `--no-verify-jwt` because Paystack calls it directly, with no
Supabase session — its own security is the HMAC signature check inside the function (see the
`verifySignature` code in `supabase/functions/paystack-webhook/index.ts`), not Supabase's own JWT
check.

## 4. Point Paystack's webhook at your function

In the Paystack dashboard: **Settings → API Keys & Webhooks → Webhook URL**, set it to:

```
https://<your-project-ref>.functions.supabase.co/paystack-webhook
```

This is what actually confirms a payment or withdrawal succeeded — the app's own database rows
only ever flip from `pending` to `success`/`failed` once Paystack calls this URL. Nothing is
marked paid from the browser.

## 5. Test it

In Test Mode, use one of [Paystack's test cards](https://paystack.com/docs/payments/test-payments/)
to buy a paid book or send a tip, and one of their test bank accounts to save a payout account
and request a withdrawal. Check the `purchases` / `withdrawals` tables in Supabase to confirm rows
move from `pending` to `success` after the webhook fires.

## Where the money actually goes

Paystack settles collected payments to your Paystack account's own settlement bank account on
its normal schedule — Inkroot never touches funds directly. An author's "withdrawal" is a
Paystack Transfer *out of your Paystack balance* to their saved bank account, so your Paystack
account needs sufficient balance for withdrawals to succeed (this is a real operational
constraint of running a marketplace this way, not something the code can route around).

**This only applies once your Paystack business is verified** — Transfers specifically require a
registered business with a TIN on file; purchases and tips (money coming in) don't. Until then,
see "Manual withdrawals" below.

## Payout-account cooldown (new bank accounts can't be withdrawn to for 24 hours)

`111_migration_payout_account_cooldown.sql` puts a delay between saving a payout account and
withdrawing to it, so someone who gets into a writer's signed-in session can't add their own bank
account and drain the balance before the real owner notices. It applies to both withdrawal paths —
`create_withdrawal_locked` (Paystack) and `create_manual_withdrawal_locked` (manual) — through one
shared check, so switching `ACTIVE_WITHDRAWAL_METHOD` doesn't change it.

- **Behavior.** A withdrawal to an account whose `bank_accounts.created_at` is inside the window
  fails with: *"This payout account was just added — for your security, withdrawals to a newly
  added account are available after 24 hours."* Balance is untouched and no `withdrawals` row is
  created. Other, older saved accounts stay usable the whole time. Deleting and re-adding an account
  restarts the clock (it's a new row).
- **First-ever exemption.** A user's very first saved account is exempt, so a new writer's first
  legitimate withdrawal isn't blocked. "First-ever" survives deletion: once a user has removed any
  saved account (recorded in `bank_account_removals`), every account they add afterward gets the
  cooldown. A writer who has never saved an account is indistinguishable from a first-time writer,
  so that case stays exempt by design.
- **Changing the window.** It's a singleton row, `payout_security_config.new_account_cooldown_hours`
  (default 24, allowed 0–720; 0 turns the cooldown off). Only a platform admin can read or update it
  through the API; from the SQL editor:
  ```sql
  update payout_security_config set new_account_cooldown_hours = 48, updated_at = now();
  ```
- **Alert to the account owner.** Whenever a payout account is added, or the default changes (via
  `paystack-save-bank-account` *or* the "make default" action), a `payout_account_changed` row is
  written to `notifications` and appears in the owner's Author Inbox under System Announcements,
  live over Realtime. It shows the bank name and the last four digits only, and says whether the
  new account is locked. This is **in-app only** — nothing in this project sends email, so an owner
  who never opens Inkroot won't see it. To also email owners, add a mail provider and send from a
  Database Webhook on `notifications` inserts of that type.

## Inkroot prize reserve (funding Inkroot-hosted event prizes)

`113_migration_inkroot_prize_reserve.sql` stops an Inkroot-hosted event from being created with a
cash prize Inkroot hasn't set aside. Before this, any platform admin could publish an event with
any prize and `settle_guild_event` would later credit the winners' guild treasury with money that
was never funded. Now `create_guild_event` (the `host = 'inkroot'` path) refuses unless the prize
fits inside the **prize reserve**, and takes the prize out of the reserve in the same transaction.

- **What the reserve is.** An append-only ledger, `platform_reserve_kobo`. Available balance =
  top-ups + released prizes − reserved prizes − withdrawals. It is an **accounting control, not a
  bank check**: a top-up is you declaring "I have put this much aside" (in your Paystack balance or
  your bank account). Nothing in the app can verify real money — so only top up what is actually
  there.
- **The reserve starts at zero.** After applying the migration, creating an Inkroot-hosted event
  fails with *"Inkroot's prize reserve can't cover this prize…"* until you top it up.
- **Topping up (operator only).** From the Supabase SQL editor — this is deliberately **not**
  possible from inside the app, so a compromised admin session can't raise its own ceiling:
  ```sql
  select top_up_platform_reserve(50000000, 'Q4 prize pool');   -- amount is in kobo: ₦500,000
  ```
- **Checking the balance and history:**
  ```sql
  select
    sum(case kind when 'top_up' then amount_kobo when 'event_prize_released' then amount_kobo
                  when 'event_prize_reserved' then -amount_kobo when 'withdrawal' then -amount_kobo
                  else 0 end) / 100.0 as available_naira
  from platform_reserve_kobo;

  select created_at, kind, amount_kobo / 100.0 as naira, note from platform_reserve_kobo order by created_at desc;
  ```
  Platform admins can also read the ledger through the API; nobody can write to it that way.
- **Taking money back out.** `select withdraw_from_platform_reserve(<kobo>, '<note>');` — only from
  the unreserved balance; funds committed to open events can't be withdrawn.
- **Lifecycle of a prize.** Created → debited from the reserve (`event_prize_reserved`). Cancelled
  before settlement (`cancel_guild_event` or an admin dispute cancellation) → credited back
  (`event_prize_released`). Settled → the reservation is closed (`event_prize_settled`); nothing
  moves, the money was already set aside. Each event gets at most one of each row.
- **Events that existed before this migration** have no reservation and settle exactly as they did
  (they are not blocked). To see which are still open and unreserved, top up enough to cover them
  and review with:
  ```sql
  select id, title, cash_prize_kobo from guild_events
   where host = 'inkroot' and status = 'open'
     and not exists (select 1 from platform_reserve_kobo r
                     where r.event_id = guild_events.id and r.kind = 'event_prize_reserved');
  ```

## Admin audit log

`114_migration_admin_audit_log.sql` records every admin/financial action in one append-only table,
`admin_audit_log` (who, what, the row's before/after state, the amount, and the reason). Covers:
manual-withdrawal settlement, platform-role revocation, login bans, guild-event approve/reject,
guild-event results approve/reject, and admin force-cancels. Read it from the SQL editor or as an
admin session; rows can't be edited or deleted by anyone. Manual withdrawals also carry
`withdrawals.settled_by` (the admin who marked it paid).

  ```sql
  -- Everything a given admin did in the last 30 days, newest first
  select created_at, action, target_table, target_id, amount_kobo, reason
  from admin_audit_log
  where actor_id = '<admin-user-id>' and created_at > now() - interval '30 days'
  order by created_at desc;
  ```

## Manual withdrawals (while your Paystack business isn't verified yet)

`create_withdrawal_locked`/`paystack-withdraw` (money out, above) need a verified Paystack
business; `paystack-init-purchase`/`paystack-webhook` (money in) don't. So a brand-new Inkroot
deployment can take real payments long before it can pay authors out automatically. Rather than
block withdrawals entirely until that's sorted, `62_migration_manual_withdrawals.sql` adds a
second withdrawal method that never calls Paystack's `/transfer` at all: a writer requests it the
same way, it's checked against the exact same real balance, but a platform admin sends the money
by hand (their own bank) and marks it settled in the app afterward. See that migration's own
comment, and `src/admin/manual-withdrawals-admin.jsx`, for the full mechanics.

**Setup, in addition to steps 1–4 above:**

1. Make your own account a platform admin — from the Supabase SQL editor (this column is
   deliberately never settable from the app itself, by anyone, including another admin — see
   `protect_admin_profile_columns` in `schema.sql`):
   ```sql
   update profiles set is_platform_admin = true where id = '<your-auth-user-id>';
   ```
   This also unlocks the existing Inkroot Events Admin screen, not just this one — same flag.
2. (Optional but recommended) Set up a Telegram bot so you get pinged the moment a request comes
   in, instead of having to keep the admin queue open: message [@BotFather](https://t.me/BotFather)
   to create a bot and get its token, then message your new bot once and fetch
   `https://api.telegram.org/bot<token>/getUpdates` to find your `chat.id`. Then:
   ```bash
   supabase secrets set TELEGRAM_BOT_TOKEN=xxxxxxxxxx
   supabase secrets set TELEGRAM_CHAT_ID=xxxxxxxxxx
   ```
   Withdrawal requests still land in the in-app queue with or without this — Telegram is a
   best-effort push alert on top, never the only way to see one (see `manual-withdraw`'s own
   comment). The alert shows the account number masked to its last 4 digits; the full number is
   only in the in-app queue.
3. In the app: **Author's Hall → ⚑ Manual Withdrawals admin** (only visible once `is_platform_admin`
   is set) to review and settle requests.

**Switching back once your business is verified:** flip `ACTIVE_WITHDRAWAL_METHOD` in
`src/lib/payments.js` from `'manual'` back to `'paystack'`. `create_withdrawal_locked`,
`paystack-withdraw`, and the webhook were never touched by any of this and still work exactly as
they did before — nothing to re-deploy or re-migrate.
