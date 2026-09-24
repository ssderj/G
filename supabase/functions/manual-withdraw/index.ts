// Requests a manual withdrawal — the non-Paystack-Transfer path added by
// 62_migration_manual_withdrawals.sql for while Inkroot's Paystack business isn't yet verified for
// Transfers (that needs a business TIN on file; purchases/tips don't need that tier, only paying
// money OUT does). The request itself is checked against the real, server-computed balance and
// created atomically by create_manual_withdrawal_locked() — identical guarantee to
// paystack-withdraw's create_withdrawal_locked(), just without ever calling Paystack's /transfer.
//
// After the row is created, this also best-effort-pings a Telegram chat so the admin doesn't have
// to keep the Manual Withdrawals admin queue open to notice a new request. A failed or unconfigured
// notification never fails the withdrawal itself — the queue (admin_list_pending_manual_withdrawals)
// is the real source of truth and works with or without Telegram. The message deliberately shows
// only the last 4 digits of the account number: Telegram chats are a third-party channel outside
// Inkroot's access controls, and the full number is already available to admins in that queue.
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
    throw new Error('We couldn’t reach Paystack to complete this. Please try again shortly.');
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
    if (!amountKobo || amountKobo < 10000) throw new Error('Minimum withdrawal is \u20a6100');

    const db = serviceClient();

    const { data: row, error: insertErr } = await db.rpc('create_manual_withdrawal_locked', {
      p_user_id: user.id, p_bank_account_id: bankAccountId, p_amount_kobo: amountKobo,
    }).single();
    if (insertErr) throw insertErr;

    try {
      const token = Deno.env.get('TELEGRAM_BOT_TOKEN');
      const chatId = Deno.env.get('TELEGRAM_CHAT_ID');
      if (token && chatId) {
        const [{ data: account }, { data: profile }] = await Promise.all([
          db.from('bank_accounts').select('bank_name, account_number, account_name').eq('id', bankAccountId).single(),
          db.from('profiles').select('pen_name, display_name').eq('id', user.id).single(),
        ]);
        const writerName = (profile && (profile.pen_name || profile.display_name)) || 'A writer';
        const text = [
          '\uD83D\uDCB8 New manual withdrawal request',
          '',
          `Writer: ${writerName}`,
          `Amount: \u20a6${(amountKobo / 100).toLocaleString('en-NG')}`,
          account ? `Bank: ${account.bank_name} \u2014 \u2022\u2022\u2022\u2022 ${String(account.account_number || '').slice(-4)} (${account.account_name})` : 'Bank: (missing)',
          '',
          'Review it in Inkroot\u2019s Manual Withdrawals admin queue.',
        ].join('\n');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      }
    } catch (notifyErr) {
      // Best-effort only — see the header comment. Logged for the admin's own visibility in the
      // function's logs, never surfaced to the writer and never affects the response below.
      console.error('manual-withdraw: Telegram notification failed', notifyErr);
    }

    return jsonResponse({ withdrawal: row });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
