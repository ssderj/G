import { supabase } from './supabaseClient.js';

// Inkroot supports exactly two sign-in methods: Google and passkeys. Password and magic-link
// auth (supabase.auth.signUp / signInWithPassword / signInWithOtp) were removed — no code path
// in this app calls them, and the corresponding password/OTP email flows should also be
// disabled in the Supabase dashboard under Authentication > Providers so an account can't be
// created or accessed outside these two methods.

// Redirect-based OAuth: Supabase sends the browser to Google, then back to redirectTo with an
// auth code in the URL. supabase-js has detectSessionInUrl on by default, so it exchanges that
// code for a session automatically on load — the existing onAuthChange listener in
// sync-context.jsx picks it up the same way it picks up any other sign-in, no extra wiring
// needed on the receiving end. window.location.origin (not a hardcoded URL) so this resolves
// correctly in dev, preview, and production without per-environment editing. Requires Google to
// be enabled (client ID/secret) in the Supabase dashboard under Authentication > Providers —
// that part can't be done from code.
// Root cause of "Continue with Google does nothing": supabase-js's PKCE flow needs two things
// BEFORE it can even start the redirect — a secure context (crypto.subtle, for the PKCE code
// challenge) and working localStorage (to stash the code verifier so it survives the round trip
// to Google and back). Neither is guaranteed:
//   - crypto.subtle is undefined on any page loaded over plain http other than localhost (e.g. a
//     LAN preview URL opened on a phone), so building the challenge throws immediately.
//   - localStorage.setItem throws in Safari Private Browsing and in several in-app browsers
//     (Instagram/TikTok/Facebook's embedded webview), which sandbox or disable it entirely.
// Either failure happens synchronously inside signInWithOAuth(), before any network request or
// redirect — and since account-sync-control.jsx's onClick handler doesn't await this promise
// chain at the React level the way a thrown (rejected) promise expects, that rejection used to
// vanish as a silent "Uncaught (in promise)" with zero visible UI change: exactly the reported
// symptom. Checking both preconditions up front, with a specific message for each, turns that
// silent failure into an actionable one instead of a caught-but-unexplained generic error.
export async function signInWithGoogle() {
  if (!window.isSecureContext) {
    return {
      data: null,
      error: { message: 'Sign-in with Google requires a secure (https) connection. Try again from the live site rather than this preview link.' },
    };
  }
  try {
    window.localStorage.setItem('__inkroot_storage_check__', '1');
    window.localStorage.removeItem('__inkroot_storage_check__');
  } catch {
    return {
      data: null,
      error: { message: "Your browser is blocking the storage Google sign-in needs — this is common in Private Browsing mode or an app's built-in browser (Instagram, TikTok, etc). Try opening this in Safari or Chrome directly." },
    };
  }
  try {
    return await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    });
  } catch (err) {
    // Anything past the two known preconditions above is genuinely unexpected — logged in full
    // for debugging, but since this catch-all doesn't know what actually threw, there's no way
    // to guarantee err.message is safe to show (unlike a normal Supabase/Postgrest error, this
    // isn't even a recognized shape sanitizeError() knows how to classify), so it always falls
    // back to the generic message rather than passing anything through.
    console.error('Inkroot: signInWithGoogle threw unexpectedly:', err);
    return {
      data: null,
      error: { message: 'Something went wrong starting Google sign-in. Please try again.' },
    };
  }
}

// Sign-in only — no email/phone needed upfront, the authenticator/passkey manager resolves the
// account from the discoverable credential itself. Requires the signed-in user to have already
// registered a passkey (see registerPasskey below), and requires Passkey auth to be turned on
// for the project in the Supabase dashboard under Authentication > Passkeys.
//
// Deliberately NOT wrapped in sanitizeError() here, unlike every other Supabase call in this
// codebase: account-sync-control.jsx's handlePasskeySignIn classifies this error's raw .message
// against a "banned account" pattern before ever displaying anything (mirroring
// sync-context.jsx's equivalent check for the Google-OAuth-redirect case) — sanitizing here would
// destroy that raw text before the classification could run. See that call site for where the
// actual "never show the raw message" guarantee is enforced instead.
export async function signInWithPasskey() {
  return supabase.auth.signInWithPasskey();
}

// Registers a new passkey for the CURRENTLY SIGNED-IN user — Supabase requires an existing,
// confirmed, non-anonymous session to register one (there's no such thing as "sign up with a
// passkey" from a signed-out state). In this app that means: sign in with Google first, then
// register a passkey from the account panel for faster sign-in next time.
export async function registerPasskey() {
  return supabase.auth.registerPasskey();
}

export async function signOut() {
  return supabase.auth.signOut();
}

export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session);
  });
  return () => data.subscription.unsubscribe();
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

