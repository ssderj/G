-- Migration 66: live sync for the Guild Order's shared manuscript.
--
-- Phase 21 (migration 65) made guild_order_chapters/guild_order_passages real but deliberately
-- not live — each device only saw another member's new chapter or passage on its own next
-- fetch. This closes that gap the same way 39_migration_realtime_fireside.sql (folded into
-- schema.sql as the `fireside_posts`/`fireside_reactions` publication lines) did for the
-- Fireside: adding both tables to the supabase_realtime publication so a Postgres Changes
-- subscription can stream inserts/updates as they happen, instead of only on refetch.
--
-- No RLS changes here — Realtime respects the same row-level security policies migration 65
-- already put in place, so a subscriber only ever receives change events for rows they could
-- already SELECT.
alter publication supabase_realtime add table guild_order_chapters;
alter publication supabase_realtime add table guild_order_passages;
