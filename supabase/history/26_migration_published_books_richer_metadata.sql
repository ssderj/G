-- Real-author-accounts follow-up: extends published_books with the same display metadata
-- guild_published_books already carries (subtitle, series_name, cover, word_count), so
-- fetchPublishedBooksByAuthor (lib/library.js) can return a real author's books as full display
-- cards — see library/authors-hall-screen.jsx's publicBooks — instead of a plain
-- title/blurb/genre stub. Nothing before the real-author-accounts work (lib/profile.js's
-- fetchPublicProfile) needed a full remote copy of a book's display metadata for a DIFFERENT
-- device to render, which is why published_books didn't carry these originally.
--
-- Run this after 25_migration_report_reasons_impersonation_scam.sql. Safe to re-run.

alter table published_books add column if not exists subtitle text check (subtitle is null or char_length(subtitle) <= 200);
alter table published_books add column if not exists series_name text check (series_name is null or char_length(series_name) <= 200);
alter table published_books add column if not exists cover jsonb; -- the structured cover object (style/accent/motif/customImageUrl), not a URL
alter table published_books add column if not exists word_count integer default 0;
