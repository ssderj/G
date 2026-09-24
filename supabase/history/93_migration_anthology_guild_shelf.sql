-- Migration 93: Guild Anthology publish now actually reaches the guild it was written for
-- (fix-tracker item 30, found in a final full-system audit).
--
-- The bug: publish_guild_anthology() (migration 35, extended by 36/37/48/69/73/74/91) correctly
-- assembles every approved contributor's real content and inserts atomically into published_books
-- + published_book_content with destination:'guild' — but never inserted the matching row into
-- guild_published_books. Every guild-scoped read policy on published_books/published_book_content
-- (migrations 90 and 92) resolves who's allowed to see a 'guild' destination book by joining
-- through guild_published_books; with no row there, only the book's own author_id (the officer who
-- ran Publish) and moderators could ever see it under RLS. Concretely: it never appeared on the
-- Guild Bookshelf (fetchGuildPublishedBooks in lib/library-guild.js only ever queries
-- guild_published_books), and every other guild member — including every contributor who wrote
-- part of it — hit "book unavailable" trying to open it. A published anthology delivered a
-- readable book to exactly one person: whoever clicked Publish.
--
-- Shipped as a fresh `create or replace`, not an edit to migration 91's own file, because this bug
-- doesn't error — unlike the migration-90 duplicate-policy bug (fix-tracker item 28), a deployment
-- could already have successfully applied migration 91 exactly as originally written. Editing that
-- file after the fact would do nothing for a database that already ran it; this migration is the
-- one that actually reaches it, going forward, regardless of whether migration 91 was applied
-- before or after this fix existed.
--
-- The fix adds exactly one insert, in the same function, same transaction, right after the
-- published_book_content insert it was always meant to sit beside — the listing, the manuscript,
-- and now the guild shelf row either all land together or none do, same atomicity guarantee the
-- rest of this function already had. guild_anthologies.guild_id has a hard foreign key to
-- player_guilds(id) (migration 35), so an anthology's guild is always a Player Guild, never a
-- Founder Guild slug — hence the ::text cast below, matching guild_published_books' own "player
-- guild members ..." policies (migration 92) rather than the Founder Guild ones.
--
-- Full function body restated (not a partial diff) since `create or replace function` always
-- needs the complete definition — this is byte-identical to migration 91's version with exactly
-- one new insert added, nothing else changed.
create or replace function publish_guild_anthology(p_anthology_id uuid)
returns published_books
language plpgsql security definer set search_path = public as $$
declare
  v_anth guild_anthologies%rowtype;
  v_word_count integer;
  v_book_id text;
  v_book published_books%rowtype;
  v_agreement guild_anthology_revenue_agreements%rowtype;
  v_pending_count integer;
  v_mismatch_count integer;
  v_missing_content_count integer;
  v_guild_name text;
  v_chapters jsonb := '[]'::jsonb;
  v_sub record;
  v_author_name text;
  v_chap jsonb;
begin
  select * into v_anth from guild_anthologies where id = p_anthology_id for update;
  if not found then
    raise exception 'Anthology not found.';
  end if;

  if not is_guild_officer(v_anth.guild_id) then
    raise exception 'Only the guild owner can publish this anthology.';
  end if;
  if v_anth.status <> 'reviewing' then
    raise exception 'Close submissions and finish reviewing before publishing.';
  end if;
  if v_anth.published_book_id is not null then
    raise exception 'This anthology has already been published.';
  end if;

  select coalesce(sum(word_count), 0) into v_word_count
  from guild_anthology_submissions where anthology_id = p_anthology_id and review_status = 'approved';
  if v_word_count < min_anthology_publish_word_count() then
    raise exception 'This anthology''s approved submissions total % words — at least % are needed before publishing.', v_word_count, min_anthology_publish_word_count();
  end if;

  select count(*) into v_missing_content_count
  from guild_anthology_submissions
  where anthology_id = p_anthology_id and review_status = 'approved' and content is null;
  if v_missing_content_count > 0 then
    raise exception '% approved contributor(s) haven''t attached their manuscript yet — ask them to open "Submit your work" again (or Edit their entry) before publishing.', v_missing_content_count;
  end if;

  select * into v_agreement from guild_anthology_revenue_agreements where anthology_id = p_anthology_id for update;
  if not found then
    raise exception 'Propose a revenue agreement and get every contributor''s approval before publishing.';
  end if;

  select count(*) into v_mismatch_count from (
    select contributor_id from (
      select contributor_id from guild_anthology_revenue_shares where agreement_id = v_agreement.id
      union all
      select contributor_id from guild_anthology_submissions
        where anthology_id = p_anthology_id and review_status = 'approved'
    ) all_ids
    group by contributor_id
    having count(*) <> 2
  ) mismatches;
  if v_mismatch_count > 0 then
    raise exception 'The revenue agreement''s contributors no longer match this anthology''s approved submissions — propose it again before publishing.';
  end if;

  select count(*) into v_pending_count
  from guild_anthology_revenue_shares where agreement_id = v_agreement.id and approved_at is null;
  if v_pending_count > 0 then
    raise exception '% contributor(s) still need to approve the revenue agreement before this can be published.', v_pending_count;
  end if;

  select g.name into v_guild_name from player_guilds g where g.id = v_anth.guild_id;

  for v_sub in
    select s.id, s.contributor_id, s.title, s.blurb, s.content
    from guild_anthology_submissions s
    where s.anthology_id = p_anthology_id and s.review_status = 'approved'
    order by s.submitted_at asc
  loop
    select coalesce(p.pen_name, p.display_name) into v_author_name from profiles p where p.id = v_sub.contributor_id;
    if v_author_name is null then
      v_author_name := 'Writer ' || substr(v_sub.contributor_id::text, 1, 8);
    end if;

    v_chapters := v_chapters || jsonb_build_array(jsonb_build_object(
      'id', 'section-' || v_sub.id::text,
      'title', v_sub.title,
      'text', '<p><em>By ' || v_author_name || '</em></p>'
        || case when v_sub.blurb is not null and v_sub.blurb <> '' then '<p>' || v_sub.blurb || '</p>' else '' end
    ));

    for v_chap in select * from jsonb_array_elements(coalesce(v_sub.content -> 'chapters', '[]'::jsonb))
    loop
      v_chapters := v_chapters || jsonb_build_array(jsonb_build_object(
        'id', v_sub.id::text || '-' || coalesce(v_chap ->> 'id', gen_random_uuid()::text),
        'title', coalesce(v_chap ->> 'title', ''),
        'text', coalesce(v_chap ->> 'text', '')
      ));
    end loop;
  end loop;

  v_book_id := 'anthology-' || p_anthology_id::text;

  insert into published_books (id, author_id, title, blurb, cover, price, word_count, destination)
  values (v_book_id, auth.uid(), v_anth.title, v_anth.description, v_anth.cover, v_anth.price, v_word_count, 'guild')
  returning * into v_book;

  insert into published_book_content (book_id, content)
  values (v_book_id, jsonb_build_object(
    'title', v_anth.title,
    'subtitle', null,
    'seriesName', null,
    'author', coalesce(v_guild_name, 'The Guild') || ' — a Guild Anthology',
    'cover', v_anth.cover,
    'storyFormat', 'book',
    'chapters', v_chapters
  ))
  on conflict (book_id) do update set content = excluded.content;

  -- The actual fix (see this migration's header): without this insert, the anthology's
  -- listing+content rows above were the only place it existed — readable by its own author_id
  -- and moderators only, invisible to the Guild Bookshelf and to every other guild member,
  -- including its own contributors.
  insert into guild_published_books (guild_id, book_id, author_id, title, cover, blurb, word_count, story_format, published_at)
  values (v_anth.guild_id::text, v_book_id, auth.uid(), v_anth.title, v_anth.cover, v_anth.description, v_word_count, 'book', now())
  on conflict (guild_id, book_id) do update set
    title = excluded.title, cover = excluded.cover, blurb = excluded.blurb,
    word_count = excluded.word_count, updated_at = now();

  perform set_config('inkroot.trusted_anthology_rpc', 'true', true);
  update guild_anthologies
    set status = 'published', published_book_id = v_book_id, published_at = now()
    where id = p_anthology_id;

  update guild_anthology_revenue_agreements
    set locked = true, locked_at = now()
    where id = v_agreement.id;

  return v_book;
end;
$$;

-- Backfill: heal any anthology that was already published before this migration existed — it
-- would have a published_books/published_book_content pair but no guild_published_books row.
-- Safe to run any number of times (plain insert-if-missing, no destructive update), and a no-op
-- on a database where nothing has been published through the old buggy function yet.
insert into guild_published_books (guild_id, book_id, author_id, title, cover, blurb, word_count, story_format, published_at)
select a.guild_id::text, b.id, b.author_id, b.title, b.cover, b.blurb, b.word_count, 'book', b.published_at
from guild_anthologies a
join published_books b on b.id = a.published_book_id
where a.published_book_id is not null
on conflict (guild_id, book_id) do nothing;
