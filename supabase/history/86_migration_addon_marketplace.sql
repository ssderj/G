-- Migration 86: a real sharing backend for Addons (fix-tracker item 21).
--
-- Addons (src/writing/addon-data.jsx) have always been a flat, device-only list in
-- localStorage (readAddons/writeAddons) — not even synced across one writer's own devices via
-- the app's `storage` layer (see storage.js), let alone shared with anyone else. Authoring an
-- addon and installing it into your own projects already worked; there was no way to publish
-- one for another writer to find and add. `published_addons` below is that missing directory,
-- following packSummaryForIndex's Worldbuilding Pack pattern per the fix-tracker item's own
-- instruction, simplified where a Pack's own complexity doesn't apply here:
--
--   - No project scoping / composite id: a Worldbuilding Pack lives inside a specific project
--     (hence published_packs' "<projectId>:<packKey>" id and project_id/pack_key columns); an
--     addon is a standalone, device-global manifest with its own id already, so this table just
--     uses that id directly as its primary key, same reasoning published_books' own id column
--     comment already gives for reusing a local id instead of inventing a mapping layer.
--   - No separate gated-content table: a Pack needed published_pack_content split out from
--     published_packs because a pack's full entries are the thing being sold and had to stay
--     behind a purchase check (see migration 85's header). An addon's `contains` manifest IS its
--     public listing — there's no teaser/full-content split to make here.
--   - Free-to-install, no purchases integration, and no content_reports content_type — both by
--     the app owner's own call on this item, not an oversight. If either is wanted later, this
--     table is the same shape published_packs already used for both — no rework needed to add
--     them, just a follow-up migration.
--
-- `contains` (worldCategories + healthRules) is copied in full at publish time, same "declarative
-- manifest, not code" posture addon-data.jsx's own top comment already describes — nothing here
-- executes anything, it's read the same way installedAddonManifests() already reads a local
-- addon's `contains` today.

create table if not exists published_addons (
  id text primary key,
  author_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(name) <= 200),
  icon text,
  description text check (description is null or char_length(description) <= 2000),
  category text,
  version text,
  manifest_version integer not null default 1,
  contains jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same defensive cap reasoning as published_book_content/published_pack_content's own —
  -- bound against an unbounded/malicious payload, sized generously above what a real manifest
  -- (a handful of world-category and health-rule definitions) ever needs.
  check (octet_length(contains::text) <= 1048576)
);

alter table published_addons enable row level security;

create policy "anyone can read published addons" on published_addons
  for select using (true);
create policy "author creates own addon listings" on published_addons
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author updates own addon listings" on published_addons
  for update using (auth.uid() = author_id and not is_banned(auth.uid()))
  with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author deletes own addon listings" on published_addons
  for delete using (auth.uid() = author_id);

create index if not exists published_addons_author_idx on published_addons (author_id);

create or replace function stamp_published_addons()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists published_addons_stamp on published_addons;
create trigger published_addons_stamp
  before insert or update on published_addons
  for each row execute function stamp_published_addons();
