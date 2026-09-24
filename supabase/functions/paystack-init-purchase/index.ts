// Starts a real Naira payment: either buying a published book, or tipping its author directly.
// Creates a `pending` purchases row (server-side, so the amount/author on record can never be
// something the client made up) and returns a Paystack access_code the browser hands to
// Paystack's own inline checkout. Nothing is marked paid here — only paystack-webhook, once
// Paystack itself confirms the charge, does that.
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

    // No cap existed here at all — each call creates a pending `purchases` row and a real
    // Paystack transaction-initialize API call. 20/hour is well above what a real buyer/tipper
    // ever needs in one sitting, while blocking a scripted loop from piling up pending rows and
    // Paystack API traffic.
    const { error: rlErr } = await client.rpc('check_and_bump_rate_limit', {
      p_action: 'init_purchase',
    });
    if (rlErr) throw new Error(rlErr.message || 'Too many requests — please slow down and try again shortly.');

    const { kind, bookId, amountNaira } = await req.json();
    if (!['book', 'tip'].includes(kind)) throw new Error('Invalid purchase kind');

    const db = serviceClient();
    const { data: book, error: bookErr } = await db.from('published_books')
      .select('id, author_id, price, title, destination, removed_by_moderator').eq('id', bookId).single();
    if (bookErr || !book) throw new Error('Book not found');
    // This function runs as the service role, so published_books' RLS (which hides a
    // moderator-removed book) doesn't apply here — without this check, a takedown stopped the
    // listing showing but a buyer with the book id could still be charged for it.
    if (book.removed_by_moderator) throw new Error('Book not found');
    // Migration 118: an author who unpublishes a book that already has paying readers doesn't
    // delete it (that would cut those readers off) — it is kept as destination = 'unlisted', hidden
    // from every public surface. Same reasoning as the removed_by_moderator check just above: this
    // function bypasses RLS, so without this a stale link could still start a purchase or tip.
    if (book.destination === 'unlisted') throw new Error('Book not found');
    if (book.author_id === user.id) throw new Error("You can't buy or tip your own book");

    if (book.destination === 'guild') {
      // Guild-book model, resolved (audit finding: this file and download-book/index.ts used to
      // describe two different models): a guild-destination book is MEMBERSHIP-gated, never
      // purchase-gated. Being a member of the book's Guild is what grants reading (see
      // published_book_content's read policies, migrations 90/92, and lib/library.js's
      // checkBookReadAccess, which treats a guild book as price 0) and downloading (download-book
      // checks the same is_guild_book_member() and never looks at `purchases` for a guild book).
      // Guild-only listings aren't sold in the Grand Library at all.
      //
      // Two rules follow, both enforced below:
      //   1. Only a member can start a checkout for one — this function runs as the service role
      //      and bypasses published_books' RLS, so without the check a stranger could open a real
      //      Paystack checkout for a book they can't even see (leaking its existence and price)
      //      and pay for something they could never read or download.
      //   2. kind='book' is refused for one, even for a member. The publishing wizard still lets a
      //      guild book carry a price, but a purchase can't unlock anything a member doesn't
      //      already have, so charging for it would take real money for nothing. Tipping the
      //      author (kind='tip') is the supported way to pay for a guild book and is unaffected.
      const { data: isMember } = await db.rpc('is_guild_book_member', {
        p_book_id: bookId,
        p_user_id: user.id,
      });
      if (!isMember) throw new Error("You're not a member of this book's Guild");
      if (kind === 'book') {
        throw new Error("This is a Guild book — it's free for Guild members, so there's nothing to buy. You can send the author a tip instead.");
      }
    }

    let amountKobo: number;
    if (kind === 'book') {
      if (!book.price || book.price <= 0) throw new Error('This book is free — no payment needed');
      // The "already own this book" check used to happen here, as its own unlocked round trip
      // before the insert below — which left a race open: two concurrent calls (two tabs, a
      // double-tap Buy) could both read "not owned yet" before either had inserted its own
      // pending row, letting a reader be charged twice for one book. That check now happens
      // inside create_purchase_locked itself, under an advisory lock keyed to this buyer+book,
      // so it can no longer be raced. See migration 106 for the full reasoning.
      amountKobo = Math.round(book.price * 100);
    } else {
      const naira = Number(amountNaira);
      if (!naira || naira < 100) throw new Error('Minimum tip is ₦100');
      amountKobo = Math.round(naira * 100);
    }

    const { data: authorProfile } = await db.from('profiles').select('display_name').eq('id', book.author_id).single();

    const { data: authUser } = await db.auth.admin.getUserById(user.id);
    const email = authUser?.user?.email;
    if (!email) throw new Error('Your account has no email on file — cannot start checkout');

    const reference = `inkroot_${kind}_${crypto.randomUUID()}`;

    // create_purchase_locked does the ownership recheck (book kind only) and the insert
    // atomically, under a lock keyed to this buyer+book — see migration 106. A tip has no
    // ownership concept to race, so it just goes through the same insert path unlocked.
    const { error: insertErr } = await db.rpc('create_purchase_locked', {
      p_buyer_id: user.id,
      p_author_id: book.author_id,
      p_kind: kind,
      p_book_id: kind === 'book' ? book.id : null,
      p_reference: reference,
      p_amount_kobo: amountKobo,
      p_author_amount_kobo: authorAmountKobo(amountKobo),
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
          kind,
          book_title: book.title,
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
