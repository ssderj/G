// Starts a real Naira payment to enter a host='guild' Guild Event (see
// 42_migration_guild_events.sql). Same shape as paystack-init-purchase: creates a `pending`
// guild_event_entries row server-side (so the amount/entrant on record can never be something
// the client made up) and returns a Paystack access_code the browser hands to Paystack's own
// inline checkout. Nothing is marked paid here — only paystack-webhook, once Paystack itself
// confirms the charge, does that. There is no equivalent function for host='inkroot' events —
// those have no entry fee and nothing for a reader to pay.
//
// The duplicate-entry check, the participant_limit check, and the row insert itself all happen
// inside create_guild_event_entry_locked() (see 50_migration_economy_security_audit.sql) under
// one advisory lock keyed to the event, so two simultaneous entry attempts — or an entry racing
// this event's own settlement — can't both slip past checks that used to be separate,
// unserialized round trips from this function.
import { createClient } from 'jsr:@supabase/supabase-js@2';

// Inlined from supabase/functions/_shared/payments.ts rather than imported: this function is
// deployed independently and the deploy path used doesn't reliably resolve cross-function
// relative imports. Keep this block identical to _shared/payments.ts if that file changes.
// Shared by every paystack-* Edge Function below. Kept in one place so the "how do we call
// Paystack" and "how do we identify who's calling us" logic can't drift between functions —
// every one of them needs both.


export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Inkroot's cut of a sale/tip, in basis points (250 = 2.5%). Paystack's own transaction fee is
// separate and comes out of what Paystack settles to the platform account, not modelled here —
// this constant only controls the author/platform split of author_amount_kobo written to
// `purchases`. Change this in one place; past rows keep whatever split they were written with
// (see the migration's comment on author_amount_kobo).
export const PLATFORM_FEE_BPS = 1000; // 10%

export function authorAmountKobo(amountKobo: number): number {
  return Math.round(amountKobo * (10000 - PLATFORM_FEE_BPS) / 10000);
}

// A signed-in Supabase client scoped to whoever's JWT called this function — used to read
// `auth.uid()`-scoped rows exactly as the browser would (e.g. "does this bank account belong to
// the caller"). Distinct from the service-role client below, which is what actually writes
// purchases/withdrawals/bank_accounts rows (those tables have no client insert/update policy —
// see the migration).
export function callerClient(req: Request) {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: req.headers.get('Authorization')! } } },
  );
}

export function serviceClient() {
  return createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );
}

const PAYSTACK_BASE = 'https://api.paystack.co';

export async function paystack(path: string, options: RequestInit = {}) {
  const res = await fetch(`${PAYSTACK_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${Deno.env.get('PAYSTACK_SECRET_KEY')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await res.json();
  if (!res.ok || data.status === false) {
    // Paystack's own response text is never shown to the user — it can describe our Paystack
    // account setup, merchant-facing reasons, or other detail that isn't the caller's to see.
    // Logged here (server-side only, no secrets in this payload) for our own debugging; the
    // caller only ever gets a safe, generic message via sanitizeError below.
    console.error('Paystack request failed', { path, status: res.status, body: data });
    throw new Error('We couldn\u2019t reach Paystack to complete this. Please try again shortly.');
  }
  return data;
}

export async function requireUser(req: Request) {
  const client = callerClient(req);
  const { data, error } = await client.auth.getUser();
  if (error || !data.user) throw new Error('Not signed in');
  return { client, user: data.user };
}

// Inlined rather than imported from a shared file: this function is deployed independently
// and the deploy path used doesn't reliably resolve cross-function relative imports.
function sanitizeError(e: any, fallback = 'Something went wrong. Please try again.'): string {
  console.error('Inkroot function error:', e);
  if (!e || typeof e.message !== 'string' || !e.message) return fallback;
  if (e.code === 'P0001') return e.message; // our own raise exception '...'
  // A named SDK error class (PostgrestError, AuthApiError, StorageApiError, FunctionsHttpError,
  // a raw JS runtime error) is backend/SDK detail, not something we wrote -- hide it. A plain
  // `new Error('...')` keeps JS's own default 'Error' name even after code elsewhere adds extra
  // properties to it (e.g. a custom .code), so this is a more reliable signal than .code alone,
  // which doesn't catch Storage/Auth errors the way it catches Postgrest ones. See
  // src/lib/errors.js's client-side twin for the full reasoning.
  const name = typeof e.name === 'string' ? e.name : '';
  if (name && name !== 'Error') return fallback;
  // Defensive fallback for a Postgrest-shaped object with no .name at all -- still catch it by
  // the presence of a .code, same as the original check did.
  const hasCode = typeof e.code === 'string' && e.code.length > 0;
  if (!name && hasCode) return fallback;
  return e.message; // our own throw new Error('...')
}


// A retry replaces a still-'pending' row's paystack_reference (see create_guild_event_entry_locked /
// the hosting-fee upsert below). If the buyer had ALREADY paid against the old reference and only
// the webhook was late, replacing it would make paystack-webhook's later charge.success match
// nothing: money taken, nothing credited, and the retry asks them to pay again. So before a
// reference is replaced, ask Paystack what actually happened to the old one, and fail closed on
// anything ambiguous. A reference Paystack has never heard of (our own /transaction/initialize
// call failed after the row was written) is safe to replace.
async function assertPriorAttemptReplaceable(priorReference: string | null | undefined) {
  if (!priorReference) return;
  let status: string | undefined;
  try {
    const res = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(priorReference)}`, {
      headers: { Authorization: `Bearer ${Deno.env.get('PAYSTACK_SECRET_KEY')}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok && /not found/i.test(String(body?.message || ''))) return; // never registered with Paystack
    if (!res.ok || !body?.data?.status) throw new Error('verify failed');
    status = body.data.status;
  } catch (e) {
    console.error('Could not verify prior payment attempt', priorReference, e);
    throw new Error('We couldn\u2019t confirm your earlier payment attempt yet. Please try again in a minute.');
  }
  if (status === 'success') {
    throw new Error('Your earlier payment already went through and is being confirmed \u2014 no need to pay again. Check back in a moment.');
  }
  if (!['abandoned', 'failed', 'reversed'].includes(status as string)) {
    throw new Error('Your earlier payment is still being processed. Please wait a few minutes before trying again.');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  try {
    const { client, user } = await requireUser(req);

    // No cap existed here at all — each call creates a pending guild_event_entries row and a
    // real Paystack transaction-initialize API call. 20/hour is far above what a real entrant
    // needs (one entry per event, occasionally retried), while blocking a scripted loop.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'init_event_entry',
    });
    if (rlErr) throw new Error(rlErr.message || 'Too many requests — please slow down and try again shortly.');

    const { eventId } = await req.json();

    const db = serviceClient();
    const { data: event, error: eventErr } = await db.from('guild_events')
      .select('id, guild_id, host, title, entry_fee_kobo, status, approval_status, participant_limit').eq('id', eventId).single();
    if (eventErr || !event) throw new Error('Event not found');
    if (event.host !== 'guild') throw new Error('This event has no entry fee to pay');

    // Net of Inkroot's platform fee, using the exact same formula/constant as an ordinary book
    // sale — see authorAmountKobo in _shared/payments.ts. This is what counts toward the
    // event's prize pool at settlement (guild_event_entries.net_kobo), computed once here so it
    // can never drift from what was actually charged.
    const amountKobo = event.entry_fee_kobo;
    const netKobo = authorAmountKobo(amountKobo);

    const { data: authUser } = await db.auth.admin.getUserById(user.id);
    const email = authUser?.user?.email;
    if (!email) throw new Error('Your account has no email on file — cannot start checkout');

    // See assertPriorAttemptReplaceable: never replace a pending entry's reference without first
    // knowing the old checkout didn't actually complete.
    const { data: priorEntry } = await db.from('guild_event_entries')
      .select('status, paystack_reference').eq('event_id', eventId).eq('entrant_id', user.id).maybeSingle();
    if (priorEntry && priorEntry.status === 'pending') {
      await assertPriorAttemptReplaceable(priorEntry.paystack_reference);
    }

    const reference = `inkroot_event_entry_${crypto.randomUUID()}`;

    const { error: insertErr } = await db.rpc('create_guild_event_entry_locked', {
      p_user_id: user.id, p_event_id: eventId, p_paystack_reference: reference,
      p_amount_kobo: amountKobo, p_net_kobo: netKobo,
    });
    if (insertErr) throw insertErr;

    const tx = await paystack('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: 'NGN',
        reference,
        metadata: {
          kind: 'guild_event_entry',
          event_title: event.title,
        },
      }),
    });

    return jsonResponse({
      reference,
      accessCode: tx.data.access_code,
      authorizationUrl: tx.data.authorization_url,
    });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
