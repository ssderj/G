# Inkroot race-condition / double-spend audit (item 8)

Static audit only — same constraint as AUDIT_v20: no network here, so no live Postgres to fire
actual concurrent requests at. What follows is a code-level TOCTOU review of every SQL function
reachable from the nine flows listed, tracing the *final* definition of each (schema.sql
redefines several of these many times across migration history — the last `create or replace`
wins). Two real gaps found; everything else already carries a working guard, cited below so a
future pass doesn't need to re-derive it.

## Fixed in this pass — migration 137

Both open findings below are closed by `supabase/history/137_migration_guild_membership_and_closure_race_fixes.sql` (folded into `supabase/schema.sql`, last word on each of the four functions it touches). Not run against a live database — see "Not exercised" at the bottom for what to verify once it's applied.

## Open findings (now fixed — see above)

| # | Severity | Where | The race | Fix |
|---|----------|-------|----------|-----|
| 1 | Medium | `create_or_get_own_guild`, `join_player_guild_by_code` (schema.sql:18730, 18813) | Both enforce "seated in at most one guild" with a plain `select ... into v_existing` / `exists(...)` check, then insert — no lock. Two concurrent calls for the same user (join guild A + join guild B, or found-a-guild + join-by-code) can both pass the check before either `insert into player_guild_members` commits. Nothing in the schema stops a user having membership rows in two different guilds: the table's PK is `(guild_id, user_id)`, and there is no unique index on `user_id` alone. (Double-*founding* a guild is separately blocked — `player_guilds_owner_id_key` is a real unique index on `owner_id` — so that half of migration 126's "one guild at a time" rule already has a DB backstop; the membership half does not.) | Take a per-user advisory lock (e.g. `hashtext('guild_membership:' || auth.uid()::text)`) at the top of both functions, before the "already seated" check, and re-run that check once the lock is held — same pattern `deposit_guild_event_prize_escrow`'s migration-130 fix and `contribute_to_guild_event_escrow` already use elsewhere in this file. Since both functions would take the same lock key, this also serializes them against each other, not just against themselves. |
| 2 | Low | `complete_guild_event` (schema.sql:6044), `close_ended_guild_events` (schema.sql:19329) | Neither takes the `hashtext('guild_event_entry:' || event_id::text)` advisory lock that `create_guild_event_entry_locked`, `cancel_guild_event`, and `settle_guild_event` all take before touching `guild_events.status`/`approval_status`. A `create_guild_event_entry_locked` call already past its own status check (holding the entry lock, event still `open`/`active`) can commit an entry at the same instant an organizer's `complete_guild_event` — or the hourly `close_ended_guild_events` cron sweep — flips the event to `closed`/`completed`. Not a fund-safety bug (the entry is a legitimately-paid, otherwise-valid row; it just lands a beat after the organizer's intended cutoff), but it's the one asymmetry against the locking convention this codebase otherwise applies consistently to every other state transition on `guild_events`. | Add `perform pg_advisory_xact_lock(hashtext('guild_event_entry:' || p_event_id::text));` as the first statement in `complete_guild_event`. For `close_ended_guild_events`, which closes a batch in one `UPDATE ... WHERE end_date < now()`, either loop per matching event id taking the lock before each row's update, or accept the current behavior as intentional (a closure driven purely by a passed `end_date` is arguably fine to let a millisecond-late in-flight entry through) and just document that choice instead of leaving it silent. |

## Confirmed already race-safe (final definitions, static read)

Per the requested list:

- **Guild creation** — `create_or_get_own_guild`: double-founding blocked at the DB level by
  `player_guilds_owner_id_key` (unique on `owner_id`), independent of finding 1 above.
- **Joining a guild** — `join_player_guild_by_code`: invite-code lookup itself is race-safe
  (idempotent `on conflict (guild_id, user_id) do nothing`); only the cross-guild "one at a time"
  check is open (finding 1).
- **Treasury contribution** — `contribute_to_guild_treasury`: `pg_advisory_xact_lock(hashtext(auth.uid()::text))` before the balance check, so two simultaneous contributions from the same writer can't both read the same starting balance.
- **Escrow funding** — `deposit_guild_event_prize_escrow`: check-then-lock-then-recheck under `pg_advisory_xact_lock(hashtext(guild_id::text))`, backed by the partial unique index `guild_treasury_transactions_one_escrow_per_event` (migration 130's double-escrow-race fix). `contribute_to_guild_event_escrow`: locks both the event (`'guild_event_escrow:' || event_id`) and the contributor (`auth.uid()`) before re-checking the running total against `guaranteed_prize_kobo`, backed by the partial unique index `guild_treasury_transactions_escrow_contributor_idx` (one contribution per event+member).
- **Event entry** — `create_guild_event_entry_locked`: takes `hashtext('guild_event_entry:' || event_id::text)` before re-reading status and the participant-limit count, so two simultaneous entries for the last open slot fully serialize; `unique (event_id, entrant_id)` backs the "one ticket per person" rule at the DB level regardless.
- **Event closure** — `cancel_guild_event` and `settle_guild_event` both take the entry lock before checking/flipping status (see finding 2 for the two closure paths that don't).
- **Result approval** — `approve_guild_event_results`: `select ... for update` on the `guild_event_results` row means a second concurrent approval blocks until the first commits, then sees `status = 'approved'` and is rejected — no double-approval, and it calls into the already-locked `settle_guild_event` rather than duplicating settlement logic.
- **Event settlement** — `settle_guild_event`: takes the entry lock *and* its own `'guild_event_settlement:' || event_id` lock, in that order (documented in migration 120 as closing exactly the cancel-vs-settle double-release race), re-reads status under the lock, and only settles from `active`/`completed`.
- **Withdrawal** — `create_withdrawal_locked` / `create_manual_withdrawal_locked`: per-user advisory lock before the balance check. `admin_settle_manual_withdrawal`: `for update` on the withdrawal row plus a `status <> 'pending'` re-check, so two admins settling the same request can't both apply a result. `withdraw_guild_member_earnings`: same per-user lock key `contribute_to_guild_treasury` uses (deliberately serializes a release against a concurrent contribution from that same member too).
- **Treasury spend / multi-approval** — not in the original nine but adjacent and load-bearing: `spend_from_guild_treasury` and `propose_guild_treasury_spend` both lock the guild before *and after* the rate-limit/idempotency lookups (so a concurrent replay of the same idempotency key is caught post-lock, not just pre-lock); `approve_guild_treasury_spend` locks the specific request row with `for update` before counting approvals, so two simultaneous approvals on a request needing N signatures can't both trigger execution.

## Additional areas checked in the second pass (still static)

- **`compute_guild_event_placements`** (schema.sql:20803) — the "auto-computed results" path
  alongside organizer-submitted ones. `select ... from guild_event_results where event_id = ...
  for update` locks the results row before checking `status = 'approved'`, and the insert uses
  `on conflict (event_id) do update` — so two concurrent recomputes (e.g. the organizer checking
  quorum twice, or a dispute recompute racing a normal one) serialize correctly and can't produce
  two competing rows.
- **`submit_guild_event_judge_score`** (schema.sql:17705) — idempotent
  `on conflict (submission_id, judge_id, category) do update`; a judge double-submitting (or a
  flaky client retrying) updates their own row, never creates a duplicate that could inflate
  quorum counts.
- **`paystack-webhook`** (edge function) — every status transition is a single conditioned
  `UPDATE ... WHERE paystack_reference = X AND status = 'pending'` (or `'success'` for
  refund/dispute events), which Postgres applies atomically per row. A retried or duplicate
  Paystack webhook for the same reference matches zero rows the second time, so `charge.success`,
  `charge.failed`, `transfer.success/failed/reversed`, and `refund.processed` can't double-apply
  regardless of how many times or how close together Paystack fires them. This covers the wire
  side of both event entry and withdrawal.

## Not exercised

Nothing above was run against a live database — there's no Postgres available in this
environment. The two open findings are inferred from reading the code, not from an observed
failure. Before trusting this, it's worth actually firing concurrent requests at 1 and 2 against
a disposable Supabase project (e.g. `pgbench`-style parallel `psql` sessions calling the RPCs
directly, or two Playwright sessions hitting the UI at the same instant) to confirm the double
membership and the late-entry-past-closure actually reproduce as described.
