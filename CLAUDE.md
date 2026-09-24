# CLAUDE.md

Guidance for Claude Code (and any Claude session) working in this repo. Read `ARCHITECTURE.md`
first for the directory/file map and "where to make common changes" — this file covers commands,
conventions, and project-specific gotchas that aren't about file layout.

## Commands
```
npm install
npm run dev       # vite dev server
npm run build     # vite build
npm run preview   # preview a production build
```
No test suite, no linter, no formatter configured in this repo (no `.eslintrc`, no `prettier`
config, no `test` script in `package.json`). Verify changes by reading them carefully and, where
possible, running `npm run dev` — there's no automated safety net.

No `.env.example` is present in this checkout — `src/lib/supabaseClient.js` reads
`VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` from `.env.local` (see `README.md`'s Setup
section for where to get them).

## Code style — read before editing any `.jsx` file
Every component in this repo is written with `React.createElement(...)` calls, **not JSX
syntax** — despite the `.jsx` extension on every file. There is no JSX anywhere in `src/`
(confirmed: zero files use `<Component .../>` syntax). Match this exactly when editing or adding
components — do not introduce JSX syntax into an existing file or a new one; it's a deliberate,
repo-wide convention, not an oversight.

Other conventions to preserve:
- **kebab-case filenames** (`referral-dashboard.jsx`, `guild-treasury-admin.jsx`), one primary
  screen/concern per file, colocated small helper components in the same file rather than a
  fragmented one-component-per-file split.
- **Design tokens, not raw values**: `RADIUS_SCALE`, `SPACE_SCALE`, `TYPE_SCALE` from
  `src/shell/nav-context.jsx` for radius/spacing/font-size. Raw hex colors are used inline
  throughout (there's no color token file yet) — match the existing palette per screen rather
  than inventing new colors.
- **Long, honest header comments.** Files and functions carry comments that explain *why*, not
  just *what* — especially around money, privacy, and eligibility logic — and are often explicit
  about what's deliberately NOT built yet or NOT shown to the user, and why. Match this voice
  when editing those files; don't strip context down to a one-liner.
- **Every `lib/*.js` wrapper fails honestly**: returns `null`/`[]` when signed out or offline,
  never fakes or locally computes a number that should come from the server. Reputation,
  ranking, and achievement figures are computed server-side in SQL — client code is a thin,
  non-blocking wrapper around an RPC or table read, never a local calculation.
- **Reward/fee amounts are deliberately not hardcoded in the UI** where they live in a
  moderator-configurable table (e.g. `referral_reward_config` — see
  `supabase/history/58_migration_referral_reward_limits_and_anti_abuse.sql`). Only *structural*
  qualifying conditions (not tunable amounts) are safe to state as plain text client-side.

## Backend conventions (`supabase/`)
- New schema/RLS/function changes go in a new **numbered** file in `supabase/history/`
  (`NN_migration_description.sql`, next number after the highest existing one), then get folded
  into `supabase/schema.sql`. Never edit an already-applied migration in place.
- Every table that isn't purely public gets RLS enabled with explicit per-action policies. Writes
  that need to check something the caller's own RLS would hide (another user's activity,
  eligibility checks, etc.) go through a `security definer` Postgres function that re-derives the
  result itself — never trust a client-supplied id or amount.
- Idempotency matters: functions like `redeem_referral_code` / `grant_referral_reward` are
  written so a retry or a duplicate call is a safe no-op, not an error — preserve that shape in
  any new grant/redeem-style function.

## Before finishing a task
- If you added, renamed, split, or deleted a file, update the matching line in
  `ARCHITECTURE.md` in the same session — a stale map costs more tokens than no map.
- Don't touch `src/lib/*.js` or `supabase/**` unless the task explicitly asks for a backend
  change — most UI/redesign requests in this repo are front-end-only (see recent history of
  `src/library/referral-dashboard.jsx` for an example of a full UI rework with zero backend
  changes).
