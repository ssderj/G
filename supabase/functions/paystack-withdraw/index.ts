// Pays an author out to one of their saved bank accounts. The requested amount is checked
// against the real, server-computed balance and the withdrawal row is created atomically by
// create_withdrawal_locked() (see 50_migration_economy_security_audit.sql) — a client can't
// withdraw more than it's actually owed no matter what it sends, and two concurrent requests
// can't both slip past the balance check the way two separate round trips from this function
// once could.
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
    const { user } = await requireUser(req);
    const { bankAccountId, amountNaira } = await req.json();
    const amountKobo = Math.round(Number(amountNaira) * 100);
    if (!amountKobo || amountKobo < 10000) throw new Error('Minimum withdrawal is ₦100');

    const db = serviceClient();

    const { data: row, error: insertErr } = await db.rpc('create_withdrawal_locked', {
      p_user_id: user.id, p_bank_account_id: bankAccountId, p_amount_kobo: amountKobo,
    }).single();
    if (insertErr) throw insertErr;

    const { data: account, error: acctErr } = await db.from('bank_accounts')
      .select('*').eq('id', bankAccountId).eq('user_id', user.id).single();
    if (acctErr || !account) throw new Error('Saved bank account not found');

    try {
      const transfer = await paystack('/transfer', {
        method: 'POST',
        body: JSON.stringify({
          source: 'balance',
          amount: amountKobo,
          recipient: account.paystack_recipient_code,
          reason: 'Inkroot earnings withdrawal',
          reference: row.id,
        }),
      });
      const { error: codeErr } = await db.from('withdrawals').update({ paystack_transfer_code: transfer.data.transfer_code }).eq('id', row.id);
      if (codeErr) {
        // The transfer is already with Paystack, so this must NOT fail the withdrawal. The webhook
        // also matches on the transfer reference (= row.id), so it still settles correctly.
        console.error('paystack-withdraw: could not store transfer_code', row.id, codeErr.message);
      }
    } catch (transferErr) {
      // Paystack rejected the transfer outright (e.g. insufficient platform balance) — fail the
      // row now rather than leaving it pending forever with no transfer_code for the webhook to
      // ever match against.
      await db.from('withdrawals').update({ status: 'failed', failure_reason: transferErr.message }).eq('id', row.id);
      throw transferErr;
    }

    return jsonResponse({ withdrawal: row });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
