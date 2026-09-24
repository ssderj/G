-- 76_migration_fireside_post_cooldown.sql
--
-- Closes item 6 of the audit: fireside_posts caps body length at 8000 chars but had no
-- posting-frequency limit, so a member (or a script driving their session) could flood the
-- board with rapid-fire posts and replies — both live in this same table (a reply is just a row
-- with parent_id set), so one cooldown covers both. A lightweight per-author cooldown, checked
-- against the author's own most recent post across every guild — flooding is flooding regardless
-- of which board it lands on.
--
-- pg_advisory_xact_lock, same style as distribute_guild_revenue's own lock (see
-- supabase/schema.sql) — but keyed per-author instead of per-sale, and for a different race:
-- without it, two near-simultaneous insert requests from the same author could both read "no
-- recent post yet" (neither has committed) and both slip through. Locking on the author
-- serializes that check within the same transaction scope, so the second request always sees
-- the first's row.
--
-- 15 seconds is a deliberately light touch — long enough to stop a script firing posts back to
-- back, short enough that no real person typing a reply will ever notice it.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.

create or replace function enforce_fireside_post_cooldown()
returns trigger as $$
declare
  v_last_post_at timestamptz;
  v_cooldown interval := interval '15 seconds';
begin
  perform pg_advisory_xact_lock(hashtext('fireside_post_cooldown:' || new.author_id::text));

  select max(created_at) into v_last_post_at
  from fireside_posts where author_id = new.author_id;

  if v_last_post_at is not null and now() - v_last_post_at < v_cooldown then
    raise exception 'You''re posting too quickly — please wait a few seconds before posting again.';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists fireside_post_cooldown_trigger on fireside_posts;
create trigger fireside_post_cooldown_trigger
  before insert on fireside_posts
  for each row execute function enforce_fireside_post_cooldown();
