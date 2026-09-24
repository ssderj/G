// Every lib/*.js function that hits Supabase used to do `if (error) throw error;` and let
// whatever Postgrest/Auth/Storage/Functions/network gave back propagate straight up to a UI
// component's `catch (e) { setError(e.message || 'fallback') }`. Since a raw error's .message is
// almost always truthy, that `|| 'fallback'` essentially never fired — the backend's own error
// text (constraint names, column names, RLS policy text, SQL error detail) was what readers
// actually saw. sanitizeError() is the fix: call it at the point an error is thrown (`throw
// sanitizeError(error)` instead of `throw error`) so nothing downstream has to change — every one
// of those existing `e.message || 'fallback'` call sites becomes safe automatically, because
// `e.message` is never unsafe text by the time it gets there.
//
// Two kinds of error pass through untouched, everything else becomes the generic fallback:
//   1. A plpgsql `raise exception '...'` from one of our own database functions (see
//      supabase/schema.sql) surfaces with Postgres code P0001 and a message we deliberately wrote
//      to be shown (e.g. "Only the guild owner can settle this event"). Checked first, since it
//      overrides everything below regardless of what shape the error otherwise has.
//   2. A plain `new Error('...')` written directly in our own code — safe by construction, since
//      it's our own text, not something a database or network layer handed back. Distinguished by
//      `.name`, not `.code`: every supabase-js error class (PostgrestError, AuthApiError,
//      AuthRetryableFetchError, StorageApiError, FunctionsHttpError, and so on — the SDK's own
//      docs confirm Auth/Storage/Functions errors all follow the same shape as Postgrest's) sets
//      a distinctive `.name`, and so does a raw JS runtime error (TypeError's "Failed to fetch",
//      say) — a plain `new Error(...)` is the one thing that keeps JS's own default 'Error' name,
//      even after our own code adds extra properties to it afterward (see account-deletion.js's
//      `blocked.code = 'OWNS_PLAYER_GUILD'`, which must still show its own .message here). A
//      `.code` check alone used to be the only signal, which is exactly what let a StorageError
//      or AuthError slip through unsanitized — neither reliably carries a `.code` the way a
//      Postgrest error does, but both carry a `.name` that gives them away.
export function sanitizeError(error, fallback = 'Something went wrong. Please try again.') {
  // Logged for real debugging — this is the only place the original ever gets seen, and it never
  // leaves this device.
  if (error) console.error('Inkroot:', error);
  if (!error || typeof error.message !== 'string' || !error.message) return new Error(fallback);

  if (error.code === 'P0001') return new Error(error.message); // our own raise exception '...'

  const name = typeof error.name === 'string' ? error.name : '';
  if (name && name !== 'Error') return new Error(fallback); // a named SDK/runtime error class

  // Defensive fallback for the unlikely case of a Postgrest-shaped object with no .name at all
  // (older/alternate error shapes, a hand-rolled object literal from somewhere unexpected) —
  // still catch it by the presence of a .code, same as the original check did.
  const hasCode = typeof error.code === 'string' && error.code.length > 0;
  if (!name && hasCode) return new Error(fallback);

  return new Error(error.message); // our own throw new Error('...')
}
