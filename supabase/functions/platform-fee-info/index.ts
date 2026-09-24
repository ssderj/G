// Read-only: hands back PLATFORM_FEE_BPS (see _shared/payments.ts) so the client can show
// Inkroot's per-entry platform cut — e.g. in the hosting-fee/revenue breakdown a guild owner
// reviews before publishing an event (see 47_migration_guild_event_hosting_fee.sql) — without a
// second copy of the constant living in the frontend that could drift from what
// paystack-init-event-entry/paystack-init-purchase actually charge. No auth required: this is
// the same number for every event/purchase, not something scoped to a caller.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

// Inlined from supabase/functions/_shared/payments.ts — see paystack-banks/index.ts's header
// comment for why this is duplicated rather than imported.
const PLATFORM_FEE_BPS = 1000; // 10%

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  return jsonResponse({ platformFeeBps: PLATFORM_FEE_BPS });
});
