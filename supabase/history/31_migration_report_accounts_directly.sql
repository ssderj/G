-- Trust-and-safety follow-up: lets a reader report an account directly (impersonation, a
-- scam-looking name/avatar) even when it hasn't posted anything yet to report individually — see
-- library/author-identity.jsx's PublicIdentityCard for where this is offered (only for a real
-- account, never the local-only Grand Library's name-only "authors" — see that component's
-- comment) and lib/moderation.js's fetchReportedContentPreview for how the moderation queue
-- previews an account report.
--
-- Run this after 30_migration_login_ban_and_device_signal.sql. Safe to re-run.

alter table content_reports drop constraint if exists content_reports_content_type_check;
alter table content_reports add constraint content_reports_content_type_check
  check (content_type in ('published_book', 'guild_published_book', 'fireside_post', 'guild_book_feedback', 'review', 'account'));
