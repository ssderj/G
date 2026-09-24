-- Migration 83: a real backend for the Author Inbox (fix-tracker item 18).
--
-- src/library/inbox-and-living-universe.jsx's Inbox has always been entirely local — every
-- letter across all eight categories is either sample seed data (seedInboxItems()) or, for
-- Guild Events specifically, nothing at all. This migration is the scoped slice of that agreed
-- with the app owner: push-on-write notifications (same Realtime-table pattern
-- guild_order_world_entries/guild_order_proposals already use — see 81/82 above) for exactly
-- seven real events:
--   1. new_follower              — someone follows you                    (follows insert)
--   2. new_review                — someone reviews one of your books      (reviews insert)
--   3. guild_order_proposal_opened      — a Council proposal opens in your guild
--   4. guild_order_chapter_added        — a Manuscript chapter is proposed in your guild
--   5. guild_order_passage_added        — a passage is added to your guild's Manuscript
--   6. guild_order_world_entry_added    — a World Bible entry is added in your guild
--   7. guild_event_result_posted        — your guild event results were approved/settled
--
-- Everything else the Inbox shows (reader Messages, Sales, Marketplace, Achievements, System,
-- and the non-event-driven half of Guild Notifications like invitations/mentions) has no real
-- backend concept yet and is deliberately left alone — those are items 19/21/22 and the
-- Achievements/System notice board, not this one. This migration only ever INSERTs; it never
-- reads or modifies any table this fix-tracker has already closed.
--
-- Delivery is push-on-write, not pull-on-open: each source event's own trigger writes directly
-- into `notifications` in the same transaction as the row that caused it, and the table rides
-- the existing supabase_realtime publication so a signed-in device's Inbox can subscribe live
-- instead of only seeing new mail on its next open (see src/lib/notifications.js).
--
-- A Guild Order event is normally broadcast to every OTHER real member of the guild it happened
-- in (matching how Council/Manuscript/World Bible themselves already work) — reused as one
-- helper, notify_guild_order_members(), instead of repeating the founder/player membership
-- branch four times. guild_event_result_posted is different on purpose: it's not a guild-wide
-- broadcast, it's addressed to just the specific contributors named in that settlement's own
-- placements, which is who the payout actually concerns.

-- ============================================================================================
-- 1. notifications — one row per (recipient, event). actor_id is nullable because a settled
--    event's placements don't reduce to one single "who did this" person; payload carries
--    whatever type-specific ids/labels the client needs to render and link back to the source
--    (book id, guild type/id, proposal/chapter/entry id and title, place/share_bps, etc.) without
--    a second round-trip for the common case.
-- ============================================================================================

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in (
    'new_follower', 'new_review',
    'guild_order_proposal_opened', 'guild_order_chapter_added',
    'guild_order_passage_added', 'guild_order_world_entry_added',
    'guild_event_result_posted'
  )),
  actor_id uuid references auth.users(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table notifications enable row level security;

create policy "a writer reads their own notifications" on notifications
  for select using (auth.uid() = recipient_id);
-- Deliberately no insert/update/delete policy for authenticated — every row here is written
-- only by the trigger functions below (security definer), same reasoning as follow_events'/
-- book_publish_events' own "no insert policy, trigger-only" comment (migration 37, folded into
-- schema.sql above): a client can't backdate or spoof its own mail.

create index if not exists notifications_recipient_idx on notifications (recipient_id, created_at desc);

alter publication supabase_realtime add table notifications;

-- ============================================================================================
-- 2. New follower (follows insert) — mirrors log_follow_event()'s own self-follow guard.
-- ============================================================================================

create or replace function notify_new_follower()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.follower_id = new.followee_id then
    return new;
  end if;
  insert into notifications (recipient_id, type, actor_id, payload)
  values (new.followee_id, 'new_follower', new.follower_id, '{}'::jsonb);
  return new;
end;
$$;

drop trigger if exists follows_notify on follows;
create trigger follows_notify
  after insert on follows
  for each row execute function notify_new_follower();

-- ============================================================================================
-- 3. New review (reviews insert only — an edited rating via the existing update policy doesn't
--    re-notify, since it isn't a new review). Looks the book's author up server-side rather than
--    trusting a client-supplied recipient, same reasoning as every other trigger here.
-- ============================================================================================

create or replace function notify_new_review()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_author uuid;
begin
  select author_id into v_author from published_books where id = new.book_id;
  if v_author is null or v_author = new.reviewer_id then
    return new; -- book gone, or (defensively) a self-review somehow slipping past the app's own UI
  end if;
  insert into notifications (recipient_id, type, actor_id, payload)
  values (v_author, 'new_review', new.reviewer_id,
    jsonb_build_object('book_id', new.book_id, 'rating', new.rating, 'review_id', new.id));
  return new;
end;
$$;

drop trigger if exists reviews_notify on reviews;
create trigger reviews_notify
  after insert on reviews
  for each row execute function notify_new_review();

-- ============================================================================================
-- 4. Shared Guild Order broadcast helper — every real member of (guild_type, guild_id) except
--    the actor. Founder Guild membership is founder_guild_members(guild_id text, user_id); Player
--    Guild membership is player_guild_members(guild_id uuid, user_id) — and per
--    create_or_get_own_guild()'s own comment above, the owner is always folded into
--    player_guild_members as a member row too, so no separate owner_id branch is needed here the
--    way some SELECT policies defensively repeat one.
-- ============================================================================================

create or replace function notify_guild_order_members(p_guild_type text, p_guild_id text, p_actor_id uuid, p_type text, p_payload jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_guild_type = 'founder' then
    insert into notifications (recipient_id, type, actor_id, payload)
    select m.user_id, p_type, p_actor_id, p_payload
    from founder_guild_members m
    where m.guild_id = p_guild_id and m.user_id <> p_actor_id;
  elsif p_guild_type = 'player' then
    insert into notifications (recipient_id, type, actor_id, payload)
    select m.user_id, p_type, p_actor_id, p_payload
    from player_guild_members m
    where m.guild_id = p_guild_id::uuid and m.user_id <> p_actor_id;
  end if;
end;
$$;

-- ---- 4a. Council: a proposal opens (guild_order_proposals insert) ----

create or replace function notify_guild_order_proposal_opened()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_guild_order_members(new.guild_type, new.guild_id, new.opened_by,
    'guild_order_proposal_opened',
    jsonb_build_object('guild_type', new.guild_type, 'guild_id', new.guild_id, 'proposal_id', new.id, 'title', new.title));
  return new;
end;
$$;

drop trigger if exists guild_order_proposals_notify on guild_order_proposals;
create trigger guild_order_proposals_notify
  after insert on guild_order_proposals
  for each row execute function notify_guild_order_proposal_opened();

-- ---- 4b. Manuscript: a chapter is proposed (guild_order_chapters insert) ----

create or replace function notify_guild_order_chapter_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_guild_order_members(new.guild_type, new.guild_id, new.proposed_by,
    'guild_order_chapter_added',
    jsonb_build_object('guild_type', new.guild_type, 'guild_id', new.guild_id, 'chapter_id', new.id, 'title', new.title));
  return new;
end;
$$;

drop trigger if exists guild_order_chapters_notify on guild_order_chapters;
create trigger guild_order_chapters_notify
  after insert on guild_order_chapters
  for each row execute function notify_guild_order_chapter_added();

-- ---- 4c. Manuscript: a passage is added (guild_order_passages insert) — passages don't carry
--          guild_type/guild_id directly, so this looks its parent chapter up first, same join
--          subscribeGuildManuscriptRealtime's own client-side passage handling already needs. ----

create or replace function notify_guild_order_passage_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_chapter guild_order_chapters%rowtype;
begin
  select * into v_chapter from guild_order_chapters where id = new.chapter_id;
  if not found then
    return new;
  end if;
  perform notify_guild_order_members(v_chapter.guild_type, v_chapter.guild_id, new.author_id,
    'guild_order_passage_added',
    jsonb_build_object('guild_type', v_chapter.guild_type, 'guild_id', v_chapter.guild_id,
      'chapter_id', v_chapter.id, 'chapter_title', v_chapter.title, 'passage_id', new.id));
  return new;
end;
$$;

drop trigger if exists guild_order_passages_notify on guild_order_passages;
create trigger guild_order_passages_notify
  after insert on guild_order_passages
  for each row execute function notify_guild_order_passage_added();

-- ---- 4d. World Bible: an entry is added (guild_order_world_entries insert) ----

create or replace function notify_guild_order_world_entry_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_guild_order_members(new.guild_type, new.guild_id, new.author_id,
    'guild_order_world_entry_added',
    jsonb_build_object('guild_type', new.guild_type, 'guild_id', new.guild_id, 'entry_id', new.id,
      'title', new.title, 'category', new.category));
  return new;
end;
$$;

drop trigger if exists guild_order_world_entries_notify on guild_order_world_entries;
create trigger guild_order_world_entries_notify
  after insert on guild_order_world_entries
  for each row execute function notify_guild_order_world_entry_added();

-- ============================================================================================
-- 5. Guild event results posted (guild_event_results update, status -> 'approved') — the moment
--    approve_guild_event_results() sets status='approved'/settled_at=now() above, i.e. the real
--    "results are final and paid" moment, not the organizer's earlier pending submission. Unlike
--    the four Guild Order events above this isn't a guild-wide broadcast: it's addressed to just
--    the contributors named in that settlement's own placements (the same contributor_id/place/
--    share_bps shape settle_guild_event() itself consumes), since a payout notice is personal,
--    not guild news. guild_event_results.guild_id is always a Player Guild (see that table's own
--    FK) so there's no founder/player branch to make here.
-- ============================================================================================

create or replace function notify_guild_event_result_posted()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    insert into notifications (recipient_id, type, actor_id, payload)
    select (p->>'contributor_id')::uuid, 'guild_event_result_posted', new.reviewed_by,
      jsonb_build_object('guild_id', new.guild_id, 'event_id', new.event_id,
        'place', (p->>'place')::int, 'share_bps', (p->>'share_bps')::int)
    from jsonb_array_elements(new.placements) p
    where (p->>'contributor_id')::uuid is not null;
  end if;
  return new;
end;
$$;

drop trigger if exists guild_event_results_notify on guild_event_results;
create trigger guild_event_results_notify
  after update on guild_event_results
  for each row execute function notify_guild_event_result_posted();
