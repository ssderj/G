// Starts a real Naira payment for a Worldbuilding Pack (fix-tracker item 20). Mirrors
// paystack-init-purchase's 'book' path closely, with one deliberate difference: a free pack
// (price 0) still needs a durable purchases row (the app owner's own call — same audit-trail
// consistency every other purchase kind gets), but Paystack itself won't process a zero-amount
// charge — so a free pack's row is written directly as `success` here, with no Paystack call at
// all, rather than ever reaching the popup.
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


Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  try {
    const { client, user } = await requireUser(req);

    // No cap existed here at all — each call inserts a `purchases` row (free packs go straight
    // to status='success' with no Paystack call needed) plus, for paid packs, a real Paystack
    // transaction-initialize API call. 20/hour is well above what a real buyer needs while
    // blocking a scripted loop.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'init_pack_purchase',
    });
    if (rlErr) throw new Error(rlErr.message || 'Too many requests — please slow down and try again shortly.');

    const { packId } = await req.json();

    const db = serviceClient();
    const { data: pack, error: packErr } = await db.from('published_packs')
      .select('id, author_id, price, title, unlisted').eq('id', packId).single();
    if (packErr || !pack) throw new Error('Pack not found');
    // Migration 118: an unpublished pack that already has owners is kept, hidden (unlisted = true),
    // rather than deleted. This function bypasses RLS, so without this check a stale link could
    // still sell or "claim" a pack that is no longer offered.
    if (pack.unlisted) throw new Error('Pack not found');
    if (pack.author_id === user.id) throw new Error("You can't buy your own pack");

    const reference = `inkroot_pack_${crypto.randomUUID()}`;
    const priceNaira = typeof pack.price === 'number' ? pack.price : 0;

    if (!priceNaira || priceNaira <= 0) {
      // Free pack: record it as a $0 purchases row, already settled — this is also what grants
      // download access, since published_pack_content's own RLS checks for exactly this
      // (buyer_id, pack_id, status = 'success') row, free or paid alike.
      const { error: insertErr } = await db.from('purchases').insert({
        paystack_reference: reference,
        buyer_id: user.id,
        author_id: pack.author_id,
        kind: 'pack',
        pack_id: pack.id,
        amount_kobo: 0,
        author_amount_kobo: 0,
        status: 'success',
        paid_at: new Date().toISOString(),
      });
      if (insertErr) throw insertErr;
      return jsonResponse({ reference, free: true });
    }

    const amountKobo = Math.round(priceNaira * 100);

    const { data: authorProfile } = await db.from('profiles').select('display_name').eq('id', pack.author_id).single();

    const { data: authUser } = await db.auth.admin.getUserById(user.id);
    const email = authUser?.user?.email;
    if (!email) throw new Error('Your account has no email on file — cannot start checkout');

    const { error: insertErr } = await db.from('purchases').insert({
      paystack_reference: reference,
      buyer_id: user.id,
      author_id: pack.author_id,
      kind: 'pack',
      pack_id: pack.id,
      amount_kobo: amountKobo,
      author_amount_kobo: authorAmountKobo(amountKobo),
      status: 'pending',
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
          kind: 'pack',
          pack_title: pack.title,
          author_name: authorProfile?.display_name || 'this writer',
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
