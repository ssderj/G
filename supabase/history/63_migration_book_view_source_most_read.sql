-- Migration 63: Grand Library's "Most Read" shelf (see grand-library-screen.jsx) was a
-- ComingSoonShelf despite fetchMostRead() (src/lib/book-rankings.js, backed by 39_migration_
-- best_sellers_most_read.sql's compute_most_read()) already existing and already wired up
-- elsewhere (Living Universe's own Most Read section). Wiring it into the shelf too means a
-- reader can now open one of those books straight from the Grand Library, same as any other
-- shelf — which needs its own book_view_events source bucket rather than falling into 'direct'
-- and losing the distinction from an actual direct link.
--
-- Widens the check constraint only; no data migration needed since no row has ever used this
-- value before now.

alter table book_view_events drop constraint if exists book_view_events_source_check;
alter table book_view_events add constraint book_view_events_source_check check (source in (
  'featured', 'new_releases', 'top_rated', 'discover', 'cart',
  'author_profile', 'guild_bookshelf', 'most_read', 'direct'
));
