import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

// Whether real sync/guild/social features can work this session. Checked by callers that want
// to skip a network call entirely rather than let it fail; every other call site already
// catches its own errors, so this alone doesn't need to change much elsewhere.
export const isSupabaseConfigured = !!(url && anonKey);

if (!isSupabaseConfigured) {
  // Warn, don't throw — a throw here happens at module-load time, before React ever renders,
  // which took the entire app down to a blank screen in production when the env vars were
  // missing (see .env.example for what to set). Every real feature behind this client already
  // fails safely on its own (local-only fallback in FiresideBoard/GuildBookFeedbackModal,
  // caught .catch()s in the sync/profile/guild helpers) — the app just needs to finish loading
  // first.
  console.warn(
    'Inkroot: missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY \u2014 running fully offline, no account sync. Copy .env.example to .env.local (or set these in your host\'s project settings) and redeploy to enable sync.'
  );
}

export const supabase = createClient(
  url || 'https://placeholder.supabase.co',
  anonKey || 'placeholder-anon-key',
  // Required to use auth.registerPasskey()/signInWithPasskey() — see src/lib/auth.js. Passkey
  // support in supabase-js is still experimental, hence the explicit opt-in rather than it just
  // being on by default.
  { auth: { experimental: { passkey: true } } }
);

// Shared by every lib module that needs to check "who's signed in, if anyone" before a call
// (profile.js, library.js, library-guild.js, player-guild.js, guild-progression-remote.js) —
// each used to define its own identical local copy of this. Returns null when signed out rather
// than throwing, matching how every caller already used it.
//
// Uses getSession() (reads the session supabase-js already has in memory/localStorage, no
// network call) rather than getUser() (always round-trips to the Auth server to re-verify the
// token). Every one of the ~15 call sites below was paying that round trip just to read
// `user.id` before doing the real work — getSession()'s copy of the user is exactly as trustworthy
// for that: the server-side RLS check on the actual write/read still verifies the JWT itself, so
// nothing here is a security downgrade, just a client-side read of data already in memory.
export async function currentUser() {
  const { data } = await supabase.auth.getSession();
  return data.session?.user || null;
}

