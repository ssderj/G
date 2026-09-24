import { currentUser, isSupabaseConfigured, supabase } from './supabaseClient.js';
import { uploadImageDataUrl } from './mediaStorage.js';
import { invoke, koboToNaira, loadPaystackScript } from './payments.js';
import { sanitizeError } from './errors.js';

// Same "compress locally, upload, fall back to the data URL itself on any failure" flow as
// AuthorsHallScreen's avatar upload — see mediaStorage.js's uploadImageDataUrl and
// is_public_media_folder() (extended in 45_migration_guild_event_creation_workflow.sql to allow
// this folder). `dataUrl` is expected to already be compressed (readLocalImageFile in the
// calling component does that, same as every other image upload in this app).
export async function uploadGuildEventCover(dataUrl) {
    return (await uploadImageDataUrl(dataUrl, 'guild-event-covers')) || dataUrl;
}

// ---------- Inkroot Admin (see 43_migration_inkroot_events_admin.sql) ----------
// Gated entirely by shell/ink-root.jsx only ever rendering the admin screen for a confirmed
// admin (profiles.is_platform_admin) — same "the real enforcement is server-side" posture as
// lib/moderation.js's fetchIsModerator. Every function below still re-checks is_inkroot_admin()
// itself regardless of what the client believes.

export async function createInkrootEvent(guildId, title, cashPrizeNaira) {
    const { data, error } = await supabase.rpc('create_guild_event', {
        p_guild_id: guildId, p_title: title, p_host: 'inkroot',
        p_entry_fee_kobo: null, p_cash_prize_kobo: Math.round(cashPrizeNaira * 100),
    }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// Guilds a platform admin can pick from to host a cash-prize event for — player_guilds' own
// select is scoped to owner/members only, so this goes through admin_list_guilds() instead (see
// its own comment on why that's still safe: it never returns invite_code).
export async function adminSearchGuilds(search) {
    const { data, error } = await supabase.rpc('admin_list_guilds', { p_search: search || null });
    if (error) throw sanitizeError(error);
    return data || [];
}

// ---------- Guild Event review queue (see 45_migration_guild_event_creation_workflow.sql) ----------
// Every guild-hosted event a guild owner has submitted and not yet had reviewed. Resolves guild
// names server-side the same way adminSearchGuilds does — an admin isn't a member of every
// guild, so player_guilds' own owner/member-scoped select couldn't otherwise supply them.
export async function fetchPendingGuildEventApprovals() {
    const { data, error } = await supabase.rpc('admin_list_pending_guild_events');
    if (error) throw sanitizeError(error);
    return (data || []).map((row) => ({
        ...row,
        entryFeeNaira: row.entry_fee_kobo != null ? koboToNaira(row.entry_fee_kobo) : null,
    }));
}

export async function approveGuildEvent(eventId) {
    const { data, error } = await supabase.rpc('approve_guild_event', { p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

export async function rejectGuildEvent(eventId, reason) {
    const { data, error } = await supabase.rpc('reject_guild_event', { p_event_id: eventId, p_reason: reason }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// ---------- Guild Events (see 42_migration_guild_events.sql) ----------
// Two funding shapes, both settling into the Guild Treasury the same way an Anthology sale does:
//   host = 'guild'   — the guild itself hosts a competition with a real entry fee anyone signed
//                       in can pay (enterGuildEvent below).
//   host = 'inkroot'  — Inkroot funds a cash prize directly. There is no entry to pay and no
//                       client-callable way to create or settle one (see the migration's
//                       header) — it only ever shows up here as something to read and display.
// Every amount below is Naira for display; the server does every kobo calculation, fee
// application, and share split itself (see distribute_guild_revenue/settle_guild_event) — this
// file never computes a payout, only requests one and reports what the server actually did.

function mapEvent(row) {
    return {
        ...row,
        entryFeeNaira: row.entry_fee_kobo != null ? koboToNaira(row.entry_fee_kobo) : null,
        cashPrizeNaira: row.cash_prize_kobo != null ? koboToNaira(row.cash_prize_kobo) : null,
        // See 108_migration_guild_event_prize_escrow.sql — null unless this guild event has a
        // locked-escrow guaranteed prize on top of its ordinary entry fee.
        guaranteedPrizeNaira: row.guaranteed_prize_kobo != null ? koboToNaira(row.guaranteed_prize_kobo) : null,
    };
}

const EVENT_COLUMNS = 'id, guild_id, host, title, description, rules, event_type, entry_fee_kobo, cash_prize_kobo, '
    + 'participant_limit, prize_structure, guild_share_bps, start_date, end_date, organizer_id, cover_image_url, '
    + 'approval_status, rejection_reason, submitted_at, reviewed_by, reviewed_at, published_at, activated_at, completed_at, '
    + 'status, created_by, created_at, settled_at, guaranteed_prize_kobo, cancelled_at, cancellation_reason, cancelled_by';

// includeAllStatuses: the guild owner's own management view needs every draft/pending/rejected
// row too, not just what's fit to show a reader — see 45_migration_guild_event_creation_workflow.sql's
// header on why approval_status is what actually gates visibility now, not just RLS (RLS still
// allows anyone to read any row here, same "publicly browsable" posture as migration 42's own
// comment, since a non-owner viewer only ever gets these rows filtered client-side).
export async function fetchGuildEvents(guildId, { includeAllStatuses = false } = {}) {
    let query = supabase.from('guild_events').select(EVENT_COLUMNS).eq('guild_id', guildId).order('created_at', { ascending: false });
    if (!includeAllStatuses) query = query.in('approval_status', ['published', 'active', 'completed']);
    const { data, error } = await query;
    if (error) throw sanitizeError(error);
    return (data || []).map(mapEvent);
}

// Removed (see 127_migration_close_guild_event_creation_bypass.sql): this used to call
// create_guild_event() directly with p_host='guild', which put a real-money event straight into
// approval_status='active'/status='open' with none of the draft/review/financial-agreement/
// judging/hosting-fee/escrow checks below. That RPC branch no longer exists server-side — use
// createGuildEventDraft() + submitGuildEventForApproval() instead, same as every current screen
// already does.

// ---------- Public guild-events directory (see 51_migration_public_guild_events_directory.sql) ----------
// Platform-wide "browse every guild's live/upcoming/recent events" read, for a discovery surface
// like Living Universe rather than a single guild's own management view. Same thin,
// honestly-failing wrapper shape as rising-stars.js/book-rankings.js/guild-rankings.js: only
// approved-and-published (or later — published/active/completed) rows ever come back, computed
// entirely server-side, and a failed or signed-out call just returns [] so the caller can fall
// back to a local placeholder instead of erroring.
export async function fetchPublicGuildEvents({ limit } = {}) {
    if (!isSupabaseConfigured) return [];
    try {
        const user = await currentUser();
        if (!user) return []; // list_public_guild_events() is authenticated-only, same as every other real RPC in this app
        const { data, error } = await supabase.rpc('list_public_guild_events', { p_result_limit: limit || null });
        if (error) throw sanitizeError(error);
        return (data || []).map((row) => ({
            id: row.id,
            guildId: row.guild_id,
            guildName: row.guild_name,
            guildCrestUrl: row.guild_crest_url || null,
            host: row.host,
            title: row.title,
            description: row.description || null,
            eventType: row.event_type,
            coverImageUrl: row.cover_image_url || null,
            entryFeeNaira: row.entry_fee_kobo != null ? koboToNaira(row.entry_fee_kobo) : null,
            cashPrizeNaira: row.cash_prize_kobo != null ? koboToNaira(row.cash_prize_kobo) : null,
            participantLimit: row.participant_limit,
            startAt: row.start_date ? new Date(row.start_date).getTime() : null,
            endAt: row.end_date ? new Date(row.end_date).getTime() : null,
            approvalStatus: row.approval_status,
            status: row.status,
            participantCount: row.participant_count || 0,
            // Real, verified prize pool: an Inkroot-funded cash prize is fixed; a guild-hosted
            // event's pool is whatever net_kobo has actually cleared from successful entries so
            // far (see the migration) — never a projection from entry_fee_kobo × turnout.
            prizePoolNaira: row.host === 'inkroot'
                ? (row.cash_prize_kobo != null ? koboToNaira(row.cash_prize_kobo) : 0)
                : koboToNaira(row.collected_net_kobo || 0),
        }));
    } catch {
        return [];
    }
}

// Owner-only — stops new entries into a host='guild' event before settlement.
export async function closeGuildEvent(guildId, eventId) {
    const { data, error } = await supabase.rpc('close_guild_event', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// ---------- Guild Event creation (see 45_migration_guild_event_creation_workflow.sql) ----------
// The full submission form: title, description, rules, event type, entry fee, participant
// limit, prize structure, guild share, start/end date, organizer, cover image. Every new event
// starts life as a draft (approval_status='draft') — nothing here is visible to anyone but the
// guild owner, and nothing is enterable, until it's been through submit -> approve -> publish ->
// activate below. `fields` mirrors what the create/edit form actually collects:
//   { title, description, rules, eventType, entryFeeNaira, participantLimit, prizeStructure,
//     guildSharePct, startDate, endDate, organizerId, coverImageUrl }
// startDate/endDate accept anything `new Date()` understands (a date input's own value is fine);
// prizeStructure is passed through as-is (an array of plain objects) — the server treats it as
// opaque, informational JSON, never as something it enforces (see the migration's own comment).
function toEventRpcArgs(fields) {
    return {
        p_title: (fields.title || '').trim(),
        p_description: fields.description || null,
        p_rules: fields.rules || null,
        p_event_type: fields.eventType || 'other',
        p_entry_fee_kobo: fields.entryFeeNaira ? Math.round(Number(fields.entryFeeNaira) * 100) : null,
        p_participant_limit: fields.participantLimit ? Math.round(Number(fields.participantLimit)) : null,
        p_prize_structure: fields.prizeStructure || [],
        p_guild_share_bps: fields.guildSharePct != null && fields.guildSharePct !== '' ? Math.round(Number(fields.guildSharePct) * 100) : 0,
        p_start_date: fields.startDate ? new Date(fields.startDate).toISOString() : null,
        p_end_date: fields.endDate ? new Date(fields.endDate).toISOString() : null,
        p_organizer_id: fields.organizerId || null,
        p_cover_image_url: fields.coverImageUrl || null,
        // See 108_migration_guild_event_prize_escrow.sql. Declaring this here does not move any
        // money — it only records the promise; depositGuildEventPrizeEscrow below is the actual
        // lock, required before activateGuildEvent will succeed for an event with this set.
        p_guaranteed_prize_kobo: fields.guaranteedPrizeNaira ? Math.round(Number(fields.guaranteedPrizeNaira) * 100) : null,
    };
}

export async function createGuildEventDraft(guildId, fields) {
    const { data, error } = await supabase.rpc('create_guild_event_draft', {
        p_guild_id: guildId, ...toEventRpcArgs(fields),
    }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// Only works while the event is still 'draft' or 'rejected' — see the migration's own comment
// on why editing a rejected event resets it to 'draft' rather than silently re-queuing it.
export async function updateGuildEventDraft(guildId, eventId, fields) {
    const { data, error } = await supabase.rpc('update_guild_event_draft', {
        p_guild_id: guildId, p_event_id: eventId, ...toEventRpcArgs(fields),
    }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// draft/rejected -> pending_approval. The server re-checks that title/entry fee/dates are
// actually filled in before letting this through.
export async function submitGuildEventForApproval(guildId, eventId) {
    const { data, error } = await supabase.rpc('submit_guild_event_for_approval', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// approved -> published. Still not enterable — see activateGuildEvent below.
export async function publishGuildEvent(guildId, eventId) {
    const { data, error } = await supabase.rpc('publish_guild_event', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// published -> active. This is the step that actually opens entries (status -> 'open').
export async function activateGuildEvent(guildId, eventId) {
    const { data, error } = await supabase.rpc('activate_guild_event', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// ---------- Guaranteed prize escrow (see 108_migration_guild_event_prize_escrow.sql) ----------
// Only relevant for a guild event created/edited with a guaranteedPrizeNaira field (see
// toEventRpcArgs above). Takes no amount — the server reads guaranteed_prize_kobo off the event
// row itself, so this can never lock a different amount than what was declared. activateGuildEvent
// above will refuse to open the event for entries until this has succeeded.
export async function depositGuildEventPrizeEscrow(guildId, eventId) {
    const { data, error } = await supabase.rpc('deposit_guild_event_prize_escrow', {
        p_guild_id: guildId, p_event_id: eventId,
    }).single();
    if (error) throw sanitizeError(error);
    return { ...data, amountNaira: koboToNaira(data.amount_kobo) };
}

// Whether this event's guaranteed prize (if any) has already been escrowed — a plain read over
// the same guild_treasury_transactions table fetchGuildTreasuryLedger already reads, scoped down
// to this one event's escrow_event_id row. Returns null if nothing has been escrowed yet (or the
// event has no guaranteed prize at all).
export async function fetchGuildEventEscrowStatus(guildId, eventId) {
    const { data, error } = await supabase.from('guild_treasury_transactions')
        .select('id, amount_kobo, created_at')
        .eq('guild_id', guildId).eq('escrow_event_id', eventId)
        .eq('kind', 'event_prize_escrow').eq('status', 'success')
        .maybeSingle();
    if (error) throw sanitizeError(error);
    return data ? { depositedAt: data.created_at, amountNaira: koboToNaira(data.amount_kobo) } : null;
}

// Owner-only, and only while zero entrants have paid (or have a payment attempt still within the
// same 30-minute window the participant-limit check uses) — see the migration's own comment.
// Once someone has paid, this always fails; there is deliberately no "not enough participants"
// path. Releases any escrowed prize back to the guild treasury automatically.
export async function cancelGuildEvent(guildId, eventId) {
    const { data, error } = await supabase.rpc('cancel_guild_event', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// Inkroot-admin-only — the sole path that can cancel an event after entries exist, for a genuine
// dispute. Does not itself refund any paid entrant; a real Paystack refund still has to be
// processed by hand from Paystack's own dashboard, same as every other refund in this app.
export async function adminCancelGuildEventDispute(eventId, reason) {
    const { data, error } = await supabase.rpc('admin_cancel_guild_event_dispute', {
        p_event_id: eventId, p_reason: reason,
    }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// active -> completed. Stops entries; settling the pool and paying winners is still the
// separate settleGuildEvent call below.
export async function completeGuildEvent(guildId, eventId) {
    const { data, error } = await supabase.rpc('complete_guild_event', { p_guild_id: guildId, p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// The one call that actually moves money — see settle_guild_event in
// 42_migration_guild_events.sql. shares: [{ contributorId, shareBps }, ...], every contributorId
// re-checked server-side as an actual member of this guild before anything is credited. Returns
// the now-settled event; the credits themselves land in guild_treasury_transactions and are
// visible via fetchGuildTreasuryLedger/fetchGuildMemberEarningsTransactions right after this
// resolves.
export async function settleGuildEvent(guildId, eventId, shares) {
    const { data, error } = await supabase.rpc('settle_guild_event', {
        p_guild_id: guildId, p_event_id: eventId,
        p_shares: shares.map((s) => ({ contributor_id: s.contributorId, share_bps: s.shareBps })),
    }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

// Polls this entrant's own guild_event_entries row for `reference` until paystack-webhook flips
// it to success/failed — same "Paystack already confirmed it to the browser, just waiting for
// Inkroot's own record to catch up" reasoning as payments.js's waitForPurchaseSettled.
async function waitForEntrySettled(reference, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { data } = await supabase.from('guild_event_entries').select('status').eq('paystack_reference', reference).single();
        if (data && data.status !== 'pending') return data.status;
        await new Promise((r) => setTimeout(r, 1500));
    }
    return 'pending';
}

// Pays a host='guild' event's entry fee via Paystack, same inline-checkout flow as
// checkoutBook() in payments.js. Returns the final status: 'success' | 'failed' | 'pending'.
export async function enterGuildEvent(eventId) {
    await loadPaystackScript();
    const init = await invoke('paystack-init-event-entry', { eventId });
    const outcome = await new Promise((resolve, reject) => {
        const popup = new window.PaystackPop();
        popup.resumeTransaction(init.accessCode, {
            onSuccess: () => resolve('confirmed'),
            onCancel: () => reject(new Error('Entry cancelled')),
            onError: (err) => reject(new Error(err?.message || 'Payment failed')),
        });
    });
    if (outcome !== 'confirmed') return 'failed';
    return waitForEntrySettled(init.reference);
}

// The signed-in user's own entry status for one event, or null if they haven't tried to enter —
// used to show "Enter — \u20a6X" vs "You're in" vs "Entry pending" without needing a whole list.
// RLS already scopes guild_event_entries reads to the caller's own rows (as an entrant) or, for
// a guild owner, every entrant's rows in their own guild's events — .eq('entrant_id', ...) below
// keeps this specific call to "mine" regardless of which of those the caller happens to be.
export async function fetchMyGuildEventEntry(eventId) {
    const user = await currentUser();
    if (!user) return null;
    const { data, error } = await supabase.from('guild_event_entries')
        .select('id, status, amount_kobo, created_at')
        .eq('event_id', eventId).eq('entrant_id', user.id).maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// ---------- Guild Event hosting fee (see 47_migration_guild_event_hosting_fee.sql) ----------
// A separate, one-time-per-event charge the guild owner pays Inkroot — distinct from
// PLATFORM_FEE_BPS, which is Inkroot's per-entry cut of what readers pay (see
// 42_migration_guild_events.sql). Configurable server-side via set_guild_event_hosting_fee();
// nothing here hardcodes an amount — every figure below is read fresh from the current rate.

// Naira, for display — e.g. "Hosting fee: ₦5,000" on the pre-publish breakdown, before a guild
// owner has committed to paying it.
export async function fetchCurrentGuildEventHostingFeeNaira() {
    const { data, error } = await supabase.rpc('current_guild_event_hosting_fee_kobo');
    if (error) throw sanitizeError(error);
    return data != null ? koboToNaira(data) : null;
}

// Inkroot's per-entry platform cut (PLATFORM_FEE_BPS), as a percentage — sourced from the
// platform-fee-info edge function rather than a second copy of the constant here, so this can
// never quietly drift from what paystack-init-event-entry/paystack-init-purchase actually
// charge (see that function's own comment).
export async function fetchPlatformFeePct() {
    const data = await invoke('platform-fee-info', {});
    return data.platformFeeBps / 100;
}

// This event's own hosting-fee payment record, or null if nothing has been attempted yet — used
// to show "Paid ✓" vs "Pay hosting fee" without re-initiating a charge just to check. Owner-only
// readable (see the migration's RLS), same as fetchMyGuildEventEntry is entrant-only.
export async function fetchGuildEventHostingFeeStatus(eventId) {
    const { data, error } = await supabase.from('guild_event_hosting_fee_payments')
        .select('status, fee_kobo, paid_at').eq('event_id', eventId).maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// Polls this event's own hosting fee payment row until paystack-webhook flips it to
// success/failed — same reasoning as waitForEntrySettled above.
async function waitForHostingFeeSettled(eventId, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const { data } = await supabase.from('guild_event_hosting_fee_payments').select('status').eq('event_id', eventId).single();
        if (data && data.status !== 'pending') return data.status;
        await new Promise((r) => setTimeout(r, 1500));
    }
    return 'pending';
}

// Pays (or, for a currently-configured ₦0 fee, immediately records paid) this event's hosting
// fee. Returns the final status: 'success' | 'failed' | 'pending'.
export async function payGuildEventHostingFee(eventId) {
    await loadPaystackScript();
    const init = await invoke('paystack-init-hosting-fee', { eventId });
    if (!init.requiresPayment) return 'success';
    const outcome = await new Promise((resolve, reject) => {
        const popup = new window.PaystackPop();
        popup.resumeTransaction(init.accessCode, {
            onSuccess: () => resolve('confirmed'),
            onCancel: () => reject(new Error('Payment cancelled')),
            onError: (err) => reject(new Error(err?.message || 'Payment failed')),
        });
    });
    if (outcome !== 'confirmed') return 'failed';
    return waitForHostingFeeSettled(eventId);
}

// ---------- Inkroot Admin: hosting fee pricing (see 47_migration_guild_event_hosting_fee.sql) ----------
export async function adminSetGuildEventHostingFee(feeNaira, note) {
    const { data, error } = await supabase.rpc('set_guild_event_hosting_fee', {
        p_fee_kobo: Math.round(Number(feeNaira) * 100), p_note: note || null,
    }).single();
    if (error) throw sanitizeError(error);
    return { ...data, feeNaira: koboToNaira(data.fee_kobo) };
}

export async function adminFetchGuildEventHostingFeeRates() {
    const { data, error } = await supabase.rpc('admin_list_guild_event_hosting_fee_rates');
    if (error) throw sanitizeError(error);
    return (data || []).map((row) => ({ ...row, feeNaira: koboToNaira(row.fee_kobo) }));
}

// How many of an event's participant_limit slots are already taken — see
// 46_migration_guild_event_entry_count.sql on why this goes through its own RPC rather than a
// direct guild_event_entries select (that table's RLS is entrant/owner-scoped on purpose; this
// exposes only the count, to anyone, so a reader can tell an event is nearly full before trying
// to enter it).
export async function fetchGuildEventEntryCount(eventId) {
    const { data, error } = await supabase.rpc('guild_event_entry_count', { p_event_id: eventId });
    if (error) throw sanitizeError(error);
    return data;
}

// ---------- Guild Event financial agreement (see 48_migration_guild_event_financial_agreement.sql) ----------
// Turns "how entry fees get split" from a planning-only note into a locked, enforced commitment:
// any signed-in person can read it (same broad visibility guild_events itself has) before ever
// paying to enter, the guild owner can only set/change it while the event is still a draft, and
// it's permanently locked the moment the event actually opens for entries. settle_guild_event()
// itself checks it server-side — nothing here is trusted client-side, this is only for display.

// The event's own financial agreement, or null if none has been proposed yet (a draft that
// hasn't reached the money-split step). Readable by anyone signed in (RLS), same as guild_events.
export async function fetchGuildEventFinancialAgreement(eventId) {
    const { data, error } = await supabase.from('guild_event_financial_agreements')
        .select('platform_fee_bps, prize_pool_bps, guild_share_bps, other_allocations, locked, locked_at, revision')
        .eq('event_id', eventId).maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// Owner-only, and only while the event is still draft/rejected — see the migration's own
// comment on why that's the identical window update_guild_event_draft already enforces.
// otherAllocations: [{ label, sharePct }, ...]. platformFeeBps should come from
// fetchPlatformFeePct() (×100) so the snapshot recorded here always reflects Inkroot's real,
// live per-entry cut at the moment the agreement was proposed — never a client-guessed number.
export async function proposeGuildEventFinancialAgreement(guildId, eventId, { prizePoolPct, guildSharePct, otherAllocations, platformFeeBps }) {
    const { data, error } = await supabase.rpc('propose_guild_event_financial_agreement', {
        p_guild_id: guildId,
        p_event_id: eventId,
        p_prize_pool_bps: Math.round(Number(prizePoolPct) * 100),
        p_guild_share_bps: Math.round(Number(guildSharePct) * 100),
        p_other_allocations: (otherAllocations || [])
            .filter((a) => a.label && a.sharePct)
            .map((a) => ({ label: a.label.trim(), bps: Math.round(Number(a.sharePct) * 100) })),
        p_platform_fee_bps: Math.round(Number(platformFeeBps)),
    }).single();
    if (error) throw sanitizeError(error);
    return data;
}

// ---------- Guild Event judging configuration (see 121_migration_guild_event_fair_judging.sql) ----------
// Every host='guild' event needs one of these before activateGuildEvent will let it open for
// entries — placements are computed (objective metric + blind judge panel), never declared by
// the organizer. Same "owner-only, draft/rejected-only, permanently locked at activation"
// window as the financial agreement above, and for the identical reason: an entrant has to be
// able to see how placements will be decided before they ever pay to enter.

// The event's own judging config, or null if none has been proposed yet. Readable by anyone
// signed in (RLS), same as the financial agreement.
export async function fetchGuildEventObjectiveConfig(eventId) {
    const { data, error } = await supabase.from('guild_event_objective_config')
        .select('metric, weight_bps, placement_split_bps, locked, locked_at')
        .eq('event_id', eventId).maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// Owner-only, draft/rejected-only. metric: 'none' | 'word_count' | 'on_time_completion'.
// weightPct is how much of the final placement the objective metric controls (0-100); the rest
// comes from the auto-assigned blind judge panel. weightPct must be 0 when metric is 'none' —
// the server enforces this too, but the form should never let a person submit a combination it
// already knows will be refused. placementSplit: [{ place, sharePct }, ...], must sum to 100.
export async function proposeGuildEventObjectiveConfig(guildId, eventId, { metric, weightPct, placementSplit }) {
    const { data, error } = await supabase.rpc('propose_guild_event_objective_config', {
        p_guild_id: guildId,
        p_event_id: eventId,
        p_metric: metric,
        p_weight_bps: Math.round(Number(weightPct) * 100),
        p_placement_split_bps: (placementSplit || [])
            .filter((r) => r.place && r.sharePct)
            .map((r) => ({ place: Number(r.place), share_bps: Math.round(Number(r.sharePct) * 100) })),
    }).single();
    if (error) throw sanitizeError(error);
    return data;
}

// Pure arithmetic, mirrored from the exact same rounding the server actually uses
// (authorAmountKobo in supabase/functions/_shared/payments.ts: net = round(amount * (10000 -
// feeBps) / 10000), fee = amount - net, never independently rounded) so this display can never
// show a kobo figure that doesn't match what paystack-init-event-entry/settle_guild_event
// actually do. Used both for a prospective entrant's "where does my ₦X go" breakdown and for the
// organizer's own pre-publish review.
// ---------- Guild Event entrant submissions (see 121_migration_guild_event_fair_judging.sql) ----------
// What an entrant is actually judged on — title/word count/content, entrant-owned only. RLS on
// guild_event_submissions has no organizer or guild-owner read policy at all (deliberately —
// see the migration's own comment: the people with a financial stake in the outcome never see
// entrant content directly, only the computed result everyone else sees). Judges read through
// fetch_guild_event_entries_for_judge()'s anonymized labels, never this table directly either.

// The signed-in entrant's own submission for this event, or null if they haven't submitted yet.
export async function fetchMyGuildEventSubmission(eventId) {
    const { data, error } = await supabase.from('guild_event_submissions')
        .select('id, title, word_count, content, submitted_at, updated_at')
        .eq('event_id', eventId).maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// Entrant-only, and only while the event is 'active' with a successful paid entry already on
// file — see submit_guild_event_submission()'s own checks. Upserts, so an entrant can revise
// freely until the event stops accepting entries (approval_status moves off 'active').
export async function submitGuildEventSubmission(eventId, { title, wordCount, content }) {
    const { data, error } = await supabase.rpc('submit_guild_event_submission', {
        p_event_id: eventId,
        p_title: title ? title.trim() : null,
        p_word_count: Math.round(Number(wordCount) || 0),
        p_content: content != null ? content : null,
    }).single();
    if (error) throw sanitizeError(error);
    return data;
}

// ---------- Guild Event judging (see 121_migration_guild_event_fair_judging.sql,
// "4. guild_event_judge_scores") ----------
// A judge is seated automatically at activation (assign_guild_event_judges(), called from
// activate_guild_event()) — never chosen by the hosting guild, and a judge never learns who
// else is on the panel. There is no client-facing read of the panel roster or its size
// (guild_event_judge_panel_size/guild_event_judge_quorum are both revoked from authenticated),
// so nothing here can show "3 of 5 judges done" — only this judge's own scored/unscored count.

// This signed-in user's own seat on this event's panel, or null if they were never assigned —
// the gate a judge screen checks before ever calling fetch_guild_event_entries_for_judge()
// below, using guild_event_judges' own "a judge reads their own assignment" RLS policy (scoped
// to auth.uid() = judge_id, so this can never confirm or deny anyone else's seat).
export async function fetchMyGuildEventJudgeAssignment(eventId) {
    const { data, error } = await supabase.from('guild_event_judges')
        .select('assigned_at').eq('event_id', eventId).eq('judge_id', (await currentUser())?.id || '')
        .maybeSingle();
    if (error) throw sanitizeError(error);
    return data;
}

// Every event this signed-in user currently judges (or has judged), newest assignment first —
// same RLS scoping as above, just without an event_id filter. guild_events itself is publicly
// readable ("anyone can read guild events"), so this can safely join event title/type/dates
// client-side in a second query rather than needing a dedicated RPC.
export async function fetchMyGuildEventJudgeAssignments() {
    const uid = (await currentUser())?.id;
    if (!uid) return [];
    const { data: seats, error } = await supabase.from('guild_event_judges')
        .select('event_id, assigned_at').eq('judge_id', uid).order('assigned_at', { ascending: false });
    if (error) throw sanitizeError(error);
    if (!seats || !seats.length) return [];
    const { data: events, error: evErr } = await supabase.from('guild_events')
        .select('id, title, event_type, approval_status, start_date, end_date')
        .in('id', seats.map((s) => s.event_id));
    if (evErr) throw sanitizeError(evErr);
    const byId = Object.fromEntries((events || []).map((e) => [e.id, e]));
    return seats.map((s) => ({ ...(byId[s.event_id] || { id: s.event_id }), assignedAt: s.assigned_at }));
}

// The anonymized entry list a judge scores from — real entrant identity never reaches the
// client (see fetch_guild_event_entries_for_judge()'s own comment: label is stable per event,
// "Entry 1"/"Entry 2"/... in submission-id order, same for every judge on the panel). Throws
// "You are not an assigned judge for this event." server-side if called by anyone not seated —
// callers should still check fetchMyGuildEventJudgeAssignment() first for a clean gate rather
// than relying on this error.
export async function fetchGuildEventEntriesForJudge(eventId) {
    const { data, error } = await supabase.rpc('fetch_guild_event_entries_for_judge', { p_event_id: eventId });
    if (error) throw sanitizeError(error);
    return (data || []).map((r) => ({
        submissionId: r.submission_id, label: r.label, title: r.title, wordCount: r.word_count, content: r.content,
    }));
}

// This judge's own scores for this event, keyed by submission_id — never another judge's (RLS:
// "a judge reads their own scores"). Used purely for the local "scored X of Y" readout and to
// prefill a score already on file; there is no way to read the panel's aggregate progress.
export async function fetchMyGuildEventJudgeScores(eventId) {
    const uid = (await currentUser())?.id;
    if (!uid) return {};
    const { data, error } = await supabase.from('guild_event_judge_scores')
        .select('submission_id, category, score').eq('event_id', eventId).eq('judge_id', uid);
    if (error) throw sanitizeError(error);
    const bySubmission = {};
    (data || []).forEach((row) => { bySubmission[row.submission_id] = bySubmission[row.submission_id] || {}; bySubmission[row.submission_id][row.category] = row.score; });
    return bySubmission;
}

// Judge-only, assigned-panel-only, upserts — a judge can revise a score any time before this
// event's results move to 'computed'/'approved', at which point the RPC itself refuses with
// "Placements for this event have already been computed — scores are locked." (surfaced as-is;
// callers should show it as a friendly frozen-scores notice rather than a raw error toast).
// category defaults server-side to 'overall' when omitted/blank.
export async function submitGuildEventJudgeScore(eventId, submissionId, category, score) {
    const { data, error } = await supabase.rpc('submit_guild_event_judge_score', {
        p_event_id: eventId, p_submission_id: submissionId, p_category: category || 'overall',
        p_score: Math.round(Number(score) * 100) / 100,
    }).single();
    if (error) throw sanitizeError(error);
    return data;
}

// ---------- Guild Event results: organizer submission + required approval (see
// 49_migration_guild_event_results_approval.sql) ----------
// Sits on top of settleGuildEvent above, which still works unchanged for a guild owner (or any
// authorized role) who wants to declare winners and pay them out in one step. This adds a second,
// delegated path: the event's own organizer proposes placements, and a distinct guild authority
// (Leader/Treasurer/Officer — never the same person who submitted) has to approve before a kobo
// actually moves. Approval is the moment settle_guild_event() itself runs server-side, so every
// duplicate-payout guarantee that already has (advisory lock, one-settlement-ever,
// distribute_guild_revenue's own dedup) applies here too — nothing about how money moves is
// reimplemented in this file.

function mapEventResults(row) {
    if (!row) return row;
    return {
        ...row,
        placements: (row.placements || []).map((p) => ({
            contributorId: p.contributor_id, place: p.place,
            sharePct: p.share_bps != null ? p.share_bps / 100 : null,
        })),
    };
}

// placements: [{ contributorId, place, sharePct }, ...] — organizer-only, and only once the
// event is marked completed (see completeGuildEvent above). Resubmitting after a rejection
// overwrites the same row and puts it back to 'pending_approval'.
export async function submitGuildEventResults(guildId, eventId, placements) {
    const { data, error } = await supabase.rpc('submit_guild_event_results', {
        p_guild_id: guildId, p_event_id: eventId,
        p_placements: placements.map((p) => ({
            contributor_id: p.contributorId, place: Math.round(Number(p.place)),
            share_bps: Math.round(Number(p.sharePct) * 100),
        })),
    }).single();
    if (error) throw sanitizeError(error);
    return mapEventResults(data);
}

// This event's current results proposal, or null if the organizer hasn't submitted one (or
// hasn't submitted one since the last rejection) — RLS scopes reads to the organizer who
// submitted it and to this guild's own authorized roles (see the migration's policies), same
// "server decides who can see it" posture as everything else here.
export async function fetchGuildEventResults(eventId) {
    const { data, error } = await supabase.from('guild_event_results')
        .select('id, guild_id, event_id, placements, status, submitted_by, submitted_at, reviewed_by, reviewed_at, rejection_reason, settled_at')
        .eq('event_id', eventId).maybeSingle();
    if (error) throw sanitizeError(error);
    return mapEventResults(data);
}

// Every results proposal awaiting this guild's review — for an authorized approver's own queue,
// same shape as fetchPendingGuildEventApprovals's Inkroot-side queue above.
export async function fetchPendingGuildEventResults(guildId) {
    const { data, error } = await supabase.from('guild_event_results')
        .select('id, guild_id, event_id, placements, status, submitted_by, submitted_at')
        .eq('guild_id', guildId).eq('status', 'pending_approval').order('submitted_at', { ascending: true });
    if (error) throw sanitizeError(error);
    return (data || []).map(mapEventResults);
}

// The moment results become final — settles the event exactly as settleGuildEvent would, using
// the organizer's own submitted placements. Refuses server-side if the caller isn't an
// authorized guild role, or is the same person who submitted the proposal. Returns the
// now-settled event.
export async function approveGuildEventResults(eventId) {
    const { data, error } = await supabase.rpc('approve_guild_event_results', { p_event_id: eventId }).single();
    if (error) throw sanitizeError(error);
    return mapEvent(data);
}

export async function rejectGuildEventResults(eventId, reason) {
    const { data, error } = await supabase.rpc('reject_guild_event_results', {
        p_event_id: eventId, p_reason: reason || null,
    }).single();
    if (error) throw sanitizeError(error);
    return mapEventResults(data);
}

export function computeEntryFinancialBreakdown(entryFeeKobo, agreement) {
    if (!agreement || entryFeeKobo == null) return null;
    const netKobo = Math.round(entryFeeKobo * (10000 - agreement.platform_fee_bps) / 10000);
    const platformFeeKobo = entryFeeKobo - netKobo;
    const prizePoolKobo = Math.round(netKobo * agreement.prize_pool_bps / 10000);
    const guildShareKobo = Math.round(netKobo * agreement.guild_share_bps / 10000);
    const otherAllocations = (agreement.other_allocations || []).map((a) => ({
        label: a.label,
        pct: a.bps / 100,
        kobo: Math.round(netKobo * a.bps / 10000),
    }));
    return { entryFeeKobo, platformFeeKobo, netKobo, prizePoolKobo, guildShareKobo, otherAllocations };
}
