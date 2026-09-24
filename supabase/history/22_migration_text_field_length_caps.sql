-- Adds length caps to every free-text user-input column that had none, plus a non-negative check
-- on published_books.price. kv_store already had an explicit 20MB cap
-- (17_migration_kv_store_value_size_cap.sql) but nothing else did — reviews.body,
-- fireside_posts.body, guild_book_feedback.note, published_books/guild_published_books' title/
-- blurb/subtitle/series_name, content_reports.details, and profiles.pen_name/display_name were
-- all plain unbounded text. content_reports.details in particular already had a 1000-char cap in
-- reports.js, but that was purely client-side and cosmetic — anyone calling the API directly
-- bypassed it entirely; this migration is what actually enforces it.
--
-- **Before running this**: same caveat as 17_migration_kv_store_value_size_cap.sql — adding a
-- CHECK constraint validates every existing row against it, so if any existing row already
-- exceeds these caps, the relevant ALTER TABLE below will fail until that's addressed. Run this
-- first to check across every affected column in one pass:
--
--   select 'published_books.title', id::text from published_books where char_length(title) > 200
--   union all select 'published_books.blurb', id::text from published_books where blurb is not null and char_length(blurb) > 2000
--   union all select 'published_books.price', id::text from published_books where price < 0
--   union all select 'guild_published_books.title', id::text from guild_published_books where char_length(title) > 200
--   union all select 'guild_published_books.subtitle', id::text from guild_published_books where subtitle is not null and char_length(subtitle) > 200
--   union all select 'guild_published_books.series_name', id::text from guild_published_books where series_name is not null and char_length(series_name) > 200
--   union all select 'guild_published_books.blurb', id::text from guild_published_books where blurb is not null and char_length(blurb) > 2000
--   union all select 'reviews.body', id::text from reviews where body is not null and char_length(body) > 4000
--   union all select 'fireside_posts.body', id::text from fireside_posts where char_length(body) > 8000
--   union all select 'guild_book_feedback.note', id::text from guild_book_feedback where note is not null and char_length(note) > 4000
--   union all select 'content_reports.details', id::text from content_reports where details is not null and char_length(details) > 1000
--   union all select 'profiles.pen_name', id::text from profiles where pen_name is not null and char_length(pen_name) > 80
--   union all select 'profiles.display_name', id::text from profiles where display_name is not null and char_length(display_name) > 80;
--
-- If that returns rows, either raise the relevant cap below to fit them, or reach out to that
-- user to ask them to shorten it first — this migration does NOT truncate or delete anything on
-- its own.
--
-- Safe to run anytime once no existing row exceeds these caps; idempotent (each constraint is
-- guarded by an existence check against pg_constraint, since Postgres has no
-- `add constraint if not exists`).

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'published_books_title_length_check') then
    alter table published_books add constraint published_books_title_length_check check (char_length(title) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'published_books_blurb_length_check') then
    alter table published_books add constraint published_books_blurb_length_check check (blurb is null or char_length(blurb) <= 2000);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'published_books_price_nonnegative_check') then
    alter table published_books add constraint published_books_price_nonnegative_check check (price >= 0);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'guild_published_books_title_length_check') then
    alter table guild_published_books add constraint guild_published_books_title_length_check check (char_length(title) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'guild_published_books_subtitle_length_check') then
    alter table guild_published_books add constraint guild_published_books_subtitle_length_check check (subtitle is null or char_length(subtitle) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'guild_published_books_series_name_length_check') then
    alter table guild_published_books add constraint guild_published_books_series_name_length_check check (series_name is null or char_length(series_name) <= 200);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'guild_published_books_blurb_length_check') then
    alter table guild_published_books add constraint guild_published_books_blurb_length_check check (blurb is null or char_length(blurb) <= 2000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'reviews_body_length_check') then
    alter table reviews add constraint reviews_body_length_check check (body is null or char_length(body) <= 4000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'fireside_posts_body_length_check') then
    alter table fireside_posts add constraint fireside_posts_body_length_check check (char_length(body) <= 8000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'guild_book_feedback_note_length_check') then
    alter table guild_book_feedback add constraint guild_book_feedback_note_length_check check (note is null or char_length(note) <= 4000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'content_reports_details_length_check') then
    alter table content_reports add constraint content_reports_details_length_check check (details is null or char_length(details) <= 1000);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'profiles_pen_name_length_check') then
    alter table profiles add constraint profiles_pen_name_length_check check (pen_name is null or char_length(pen_name) <= 80);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'profiles_display_name_length_check') then
    alter table profiles add constraint profiles_display_name_length_check check (display_name is null or char_length(display_name) <= 80);
  end if;
end $$;
