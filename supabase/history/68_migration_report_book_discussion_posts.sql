-- Trust-and-safety follow-up to migration 67 (Book Discussion Hall): the Discussion Hall shipped
-- with no way to report an abusive post — content_reports' own content_type check (tightened
-- most recently by migration 31) never included book_discussion_posts, so there was nothing for
-- a moderator's report to point at even if the client offered the button. This adds it.
--
-- See src/shared-ui/report-content-modal.jsx's ReportButton (now offered on each Discussion Hall
-- post via contentType: 'book_discussion_post') and lib/moderation.js's
-- fetchReportedContentPreview (now handles this case the same way it already handles
-- 'fireside_post'/'guild_book_feedback' — a short text preview plus the author's id/name).
--
-- Run this after 67_migration_book_discussion_hall.sql. Safe to re-run.

alter table content_reports drop constraint if exists content_reports_content_type_check;
alter table content_reports add constraint content_reports_content_type_check
  check (content_type in ('published_book', 'guild_published_book', 'fireside_post', 'guild_book_feedback', 'review', 'account', 'book_discussion_post'));
