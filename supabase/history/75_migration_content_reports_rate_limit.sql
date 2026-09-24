-- 75_migration_content_reports_rate_limit.sql
--
-- Closes item 5 of the audit: content_reports had no unique constraint on
-- (reporter_id, content_type, content_id) and no rate limit, so a user could file unlimited
-- duplicate reports against the same content, or flood the queue with reports across many
-- different pieces of content in a burst.
--
-- Two layers, same "unconditional guarantee + friendly front door" pairing as
-- 72_migration_player_guild_ownership_cap.sql:
--
--   1. A partial unique index, scoped to `status = 'open'` rather than every row forever — a
--      reporter can't have two open reports for the same content_type/content_id/reporter_id at
--      once, but can file again later if an earlier report was resolved/dismissed and the
--      problem recurs. This is the unconditional guarantee.
--   2. enforce_content_report_rate_limit(), a before-insert trigger checked before the index
--      would ever be hit: raises a clear, catchable duplicate message instead of a raw
--      unique-violation, and separately caps how many reports (on anything) one reporter can
--      file per rolling hour — the index alone doesn't stop a burst of reports against many
--      DIFFERENT pieces of content. 10/hour is a deliberately generous ceiling for a real user
--      moderating in good faith; only meaningful against someone filing far more than that.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs.
--
-- IMPORTANT — run the check below FIRST. If duplicate open reports already exist for the same
-- (reporter_id, content_type, content_id), the unique index cannot be created until they're
-- resolved (e.g. dismiss/resolve all but the newest of each set) — this migration does not
-- collapse existing duplicates itself, that's a moderation decision, not a schema one.
--
--   select reporter_id, content_type, content_id, count(*)
--   from content_reports where status = 'open'
--   group by reporter_id, content_type, content_id having count(*) > 1;

create unique index if not exists content_reports_no_duplicate_open_idx
  on content_reports (reporter_id, content_type, content_id)
  where status = 'open';

create or replace function enforce_content_report_rate_limit()
returns trigger as $$
declare
  v_recent_count integer;
begin
  if exists (
    select 1 from content_reports
    where reporter_id = new.reporter_id
      and content_type = new.content_type
      and content_id = new.content_id
      and status = 'open'
  ) then
    raise exception 'You already have an open report filed for this — no need to file it again.';
  end if;

  select count(*) into v_recent_count
  from content_reports
  where reporter_id = new.reporter_id and created_at > now() - interval '1 hour';
  if v_recent_count >= 10 then
    raise exception 'You''ve filed several reports in the last hour — please wait a bit before filing another.';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists content_reports_rate_limit_trigger on content_reports;
create trigger content_reports_rate_limit_trigger
  before insert on content_reports
  for each row execute function enforce_content_report_rate_limit();
