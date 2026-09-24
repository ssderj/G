-- Migration 87: a real sharing backend for Templates (fix-tracker item 22).
--
-- Same gap, same fix shape as migration 86 (Addons, item 21): templates.jsx's readTemplates/
-- writeTemplates is a flat, device-only localStorage list with no discovery or sharing backend
-- at all. Applying a template to your own current project already worked; there was no way to
-- publish one for another writer to find and use. `published_templates` below follows
-- published_addons' own pattern almost exactly — same reasoning for the same simplifications
-- (no project scoping, no gated-content split, free-to-use, no purchases integration, no
-- content_reports content_type — all the app owner's own call on this item too, same as item
-- 21). One difference from published_addons: a template's shape varies by `type` (book/chapter/
-- character/worldbuilding — see TEMPLATE_TYPES), so its type-specific fields are kept in one
-- `payload` jsonb column rather than one column per possible field, the same "manifest, not
-- fixed columns" reasoning published_addons.contains already uses for its own varying shape.

create table if not exists published_templates (
  id text primary key,
  author_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('book', 'chapter', 'character', 'worldbuilding')),
  name text not null check (char_length(name) <= 200),
  payload jsonb not null default '{}'::jsonb,
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same defensive cap as published_addons.contains — a template's payload is a handful of
  -- short text fields, nowhere near this bound in ordinary use.
  check (octet_length(payload::text) <= 1048576)
);

alter table published_templates enable row level security;

create policy "anyone can read published templates" on published_templates
  for select using (true);
create policy "author creates own template listings" on published_templates
  for insert with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author updates own template listings" on published_templates
  for update using (auth.uid() = author_id and not is_banned(auth.uid()))
  with check (auth.uid() = author_id and not is_banned(auth.uid()));
create policy "author deletes own template listings" on published_templates
  for delete using (auth.uid() = author_id);

create index if not exists published_templates_author_idx on published_templates (author_id);

create or replace function stamp_published_templates()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists published_templates_stamp on published_templates;
create trigger published_templates_stamp
  before insert or update on published_templates
  for each row execute function stamp_published_templates();
