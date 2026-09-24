// Saves a bank account for withdrawals: re-verifies the account (never trusts an accountName the
// client sends — same reasoning as paystack-resolve-account), creates a Paystack Transfer
// Recipient for it, and stores the result. This is the function that makes "saved bank account"
// real — after this, a withdrawal never needs the account number again, only bank_accounts.id.
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

// Every Nigerian bank Paystack lists, across pages. The list endpoint returns at most 100 per
// request (`perPage` is capped there) and the NGN list is longer than that, so a single call
// silently dropped the tail — those banks then couldn't be chosen in the dropdown, and
// paystack-save-bank-account rejected them as "Unrecognized bank". Follows Paystack's cursor
// (`use_cursor=true`, `meta.next`); if the first page is full but no cursor comes back, falls back
// to `page=2,3,...`. Stops when a page is short, adds nothing new (guards against an API that ignores
// the cursor and repeats a page), or after MAX_PAGES. Rows are de-duplicated by id+code+name.
export async function fetchAllNigerianBanks(): Promise<any[]> {
  const PER_PAGE = 100;
  const MAX_PAGES = 10;
  const all: any[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  let usePageParam = false;
  for (let i = 0; i < MAX_PAGES; i++) {
    const qs = new URLSearchParams({ country: 'nigeria', currency: 'NGN', perPage: String(PER_PAGE) });
    if (usePageParam) {
      qs.set('page', String(i + 1));
    } else {
      qs.set('use_cursor', 'true');
      if (cursor) qs.set('next', cursor);
    }
    const res = await paystack(`/bank?${qs.toString()}`);
    const rows: any[] = Array.isArray(res?.data) ? res.data : [];
    let added = 0;
    for (const b of rows) {
      const key = `${b?.id ?? ''}|${b?.code ?? ''}|${b?.name ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(b);
      added++;
    }
    if (rows.length === 0 || added === 0) break;
    if (usePageParam) {
      if (rows.length < PER_PAGE) break;
      continue;
    }
    const nextCursor = typeof res?.meta?.next === 'string' && res.meta.next ? res.meta.next : null;
    if (nextCursor) { cursor = nextCursor; continue; }
    if (i === 0 && rows.length >= PER_PAGE) { usePageParam = true; continue; }
    break;
  }
  return all;
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

    // Production-readiness audit: this function resolves the same account number -> real account
    // name that paystack-resolve-account does, and returns it in the saved row, but it had no cap
    // at all — so the 10/hour limit on paystack-resolve-account (there specifically to stop this
    // app being used as a free name-lookup oracle) was trivially bypassed by calling this one
    // instead, and every call also minted a real Paystack transfer recipient. It shares that
    // function's counter on purpose (a legitimate add is one resolve plus one save, well inside
    // 10/hour) rather than adding a new action name, which would break saving until the database
    // migration that whitelists it is applied.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'resolve_bank_account',
    });
    if (rlErr) throw new Error(rlErr.message || 'Too many requests — please slow down and try again shortly.');

    const { accountNumber, bankCode, makeDefault } = await req.json();
    if (!/^\d{10}$/.test(accountNumber || '')) throw new Error('Enter a valid 10-digit account number');
    if (!bankCode) throw new Error('Choose a bank');

    // Checked BEFORE the default account is un-defaulted below: bank_accounts is unique on
    // (user_id, bank_code, account_number), so re-adding an account that's already saved used to
    // clear the writer's current default and THEN fail on that constraint — leaving them with no
    // default account, and therefore nowhere to withdraw to, until they picked one again.
    const dbCheck = serviceClient();
    const { data: alreadySaved } = await dbCheck.from('bank_accounts').select('id')
      .eq('user_id', user.id).eq('bank_code', bankCode).eq('account_number', accountNumber).maybeSingle();
    if (alreadySaved) throw new Error("You've already saved this bank account.");

    const resolved = await paystack(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`);
    const accountName = resolved.data.account_name;

    const bank = (await fetchAllNigerianBanks()).find((b: any) => b.code === bankCode);
    if (!bank) throw new Error('Unrecognized bank');

    const recipient = await paystack('/transferrecipient', {
      method: 'POST',
      body: JSON.stringify({
        type: 'nuban',
        name: accountName,
        account_number: accountNumber,
        bank_code: bankCode,
        currency: 'NGN',
      }),
    });

    const db = serviceClient();
    const isFirst = (await db.from('bank_accounts').select('id').eq('user_id', user.id)).data?.length === 0;
    const wantDefault = makeDefault !== false || isFirst;

    // Remembered so a failed insert below (e.g. two saves racing past the check above) can put
    // the writer's previous default back instead of leaving them with none.
    let previousDefaultId: string | null = null;
    if (wantDefault) {
      const { data: prev } = await db.from('bank_accounts').select('id').eq('user_id', user.id).eq('is_default', true).maybeSingle();
      previousDefaultId = prev?.id ?? null;
      await db.from('bank_accounts').update({ is_default: false }).eq('user_id', user.id);
    }

    const { data: row, error } = await db.from('bank_accounts').insert({
      user_id: user.id,
      bank_code: bankCode,
      bank_name: bank.name,
      account_number: accountNumber,
      account_name: accountName,
      paystack_recipient_code: recipient.data.recipient_code,
      is_default: wantDefault,
    }).select().single();
    if (error) {
      if (previousDefaultId) {
        await db.from('bank_accounts').update({ is_default: true }).eq('id', previousDefaultId);
      }
      throw error;
    }

    return jsonResponse({ bankAccount: row });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
