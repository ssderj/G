// Proxies Paystack's bank list so the client never needs the Paystack secret key just to
// populate a "which bank" dropdown when saving an account. Signed-in users only (not because the
// list itself is sensitive, but because there's no reason for it to be callable by someone not
// using the app).
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
    const { client } = await requireUser(req);

    // No cap existed here at all — this is a static list Paystack rarely changes, so it was
    // being re-fetched from Paystack on every call with nothing cached. 30/hour comfortably
    // covers normal use of the bank dropdown while blocking a scripted loop.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'list_banks',
    });
    if (rlErr) throw new Error(rlErr.message || 'Too many requests — please slow down and try again shortly.');

    const banks = (await fetchAllNigerianBanks()).map((b: any) => ({ name: b.name, code: b.code }));
    return jsonResponse({ banks });
  } catch (e) {
    return jsonResponse({ error: sanitizeError(e) }, 400);
  }
});
