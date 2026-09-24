// Shared by every paystack-* Edge Function below. Kept in one place so the "how do we call
// Paystack" and "how do we identify who's calling us" logic can't drift between functions —
// every one of them needs both.

import { createClient } from 'jsr:@supabase/supabase-js@2';

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
