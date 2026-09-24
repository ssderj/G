-- Anti-impersonation, piece 3 of 4 (pieces 1-2 were reserved/lookalike names and the verified
-- badge — see shared-utils/identity-safety.js and 24_migration_verified_author_badge.sql).
--
-- Adds 'impersonation' and 'scam' to content_reports' allowed reasons (lib/reports.js's
-- REPORT_REASONS, rendered in shared-ui/report-content-modal.jsx). Before this, someone posing
-- as another author or pushing an off-platform payment scam could only be reported as vague
-- "Other," which gave a moderator nothing to prioritize on — an explicit reason means a report
-- against an impersonator is instantly distinguishable from a copyright complaint in the queue.
--
-- Run this after 24_migration_verified_author_badge.sql. Safe to re-run.

alter table content_reports drop constraint if exists content_reports_reason_check;
alter table content_reports add constraint content_reports_reason_check
  check (reason in ('impersonation', 'scam', 'copyright', 'harassment', 'spam', 'illegal', 'other'));
