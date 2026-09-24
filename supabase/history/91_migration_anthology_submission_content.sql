-- 91_migration_anthology_submission_content.sql
--
-- Release blocker: a published Guild Anthology's `published_book_content` row was never
-- written, so a reader opening one from the Grand Library or a Guild Bookshelf hit the exact
-- "Opening book…" hang 70_migration_published_book_content.sql fixed for solo books — except
-- here publish_guild_anthology() itself never wrote the row in the first place, for any reader
-- including the guild owner who published it.
--
-- Root cause, per 35_migration_guild_anthologies.sql's own header: "MANUSCRIPTS stay exactly
-- where they already live — a member's own project in kv_store. A submission here is a
-- lightweight pointer (project_id, title, word_count) ... No manuscript text is ever copied
-- into this migration's tables." That was a deliberate, reasonable cut for the submissions/
-- review/revenue-split phases — but it means publish_guild_anthology(), a security-definer
-- function with no access to any contributor's private kv_store, had no actual prose anywhere
-- to assemble a published_book_content row FROM. A pointer to a project only the contributor's
-- own device can read is not something the server can turn into a readable book.
--
-- Fix, in the same spirit as 70's own mirror pattern (a book's real content already leaves
-- kv_store and rides along at publish time, via publishBookContentRemote/buildPublishedBookContent
-- in ink-root.jsx): guild_anthology_submissions gets its own `content` column, filled by the
-- contributor's own device (the only place their manuscript text actually is) at submit/edit
-- time — same shape buildPublishedBookContent already sends for a solo book, just chapters only
-- (title/blurb/word_count already have their own columns here). publish_guild_anthology() then
-- assembles every approved contributor's content into one published_book_content row: a short
-- byline section per contributor (so a reader can tell whose work they're reading, since the
-- anthology has one shared title/cover/author line) followed by that contributor's own chapters,
-- in submission order.
--
-- Run this once against an existing database; supabase/schema.sql has the same end state folded
-- in for fresh installs (into the original guild_anthology_submissions table definition, the
-- guard_anthology_submission_update() trigger, and publish_guild_anthology() itself — not a
-- second copy of any of the three, matching how 74's word-count-floor change was folded into
-- publish_guild_anthology() in place rather than appended).
--
-- IMPORTANT — any anthology already sitting in 'reviewing' (submissions closed, not yet
-- published) has approved submissions with content = null, since they were submitted before
-- this migration existed. publish_guild_anthology() below refuses to publish while any approved
-- submission is missing content, with a clear message naming the count, rather than silently
-- publishing a book with some contributors' sections blank — the fix is for that contributor to
-- open "Submit your work" again (or Edit on their existing entry, once the app is updated) so
-- their manuscript text attaches. Nothing already published is touched or affected.

alter table guild_anthology_submissions
  add column if not exists content jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'guild_anthology_submissions_content_size_check'
  ) then
    alter table guild_anthology_submissions
      add constraint guild_anthology_submissions_content_size_check
      check (content is null or octet_length(content::text) <= 20971520);
  end if;
end $$;

-- guard_anthology_submission_update() — extended in place (CREATE OR REPLACE keeps its identity
-- and grants; only the body changes) so `content` gets exactly the same protection its three
-- siblings (title/blurb/word_count) already have: a guild owner reviewing a submission can only
-- ever change review_status/review_note, never the contributor's own words, and a contributor
-- can only edit their own content before it's been reviewed — same "withdraw and resubmit
-- instead of editing it" rule as the others, so nobody's approved manuscript can change quietly
-- out from under a revenue agreement that was approved against a specific submitted word count.
create or replace function guard_anthology_submission_update()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_owner boolean;
begin
  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  select exists (
    select 1 from guild_anthologies a
    where a.id = old.anthology_id and is_guild_officer(a.guild_id)
  ) into v_is_owner;

  if v_is_owner and auth.uid() <> old.contributor_id then
    new.title := old.title;
    new.blurb := old.blurb;
    new.project_id := old.project_id;
    new.word_count := old.word_count;
    new.content := old.content;
    new.contributor_id := old.contributor_id;
    new.submitted_at := old.submitted_at;
    if new.review_status is distinct from old.review_status then
      if new.review_status not in ('approved', 'rejected') then
        raise exception 'A guild owner may only approve or reject a submission.';
      end if;
      new.reviewed_by := auth.uid();
      new.reviewed_at := now();
    end if;
  elsif auth.uid() = old.contributor_id then
    if new.review_status is distinct from old.review_status and new.review_status <> 'withdrawn' then
      raise exception 'You may only withdraw your own submission.';
    end if;
    if old.review_status <> 'pending'
       and (new.title is distinct from old.title or new.blurb is distinct from old.blurb
            or new.project_id is distinct from old.project_id or new.word_count is distinct from old.word_count
            or new.content is distinct from old.content) then
      raise exception 'This submission has already been reviewed — withdraw and resubmit instead of editing it.';
    end if;
    new.review_note := old.review_note;
    new.reviewed_by := old.reviewed_by;
    new.reviewed_at := old.reviewed_at;
  else
    raise exception 'Not authorized to update this submission.';
  end if;
  return new;
end;
$$;

-- publish_guild_anthology() — extended in place again (same function CREATE OR REPLACE has
-- already touched twice: 36 added the revenue-agreement gate, 74 added the word-count floor).
-- Every existing check keeps its exact behavior; the only addition is the new missing-content
-- guard and, once the published_books row exists, actually writing published_book_content.
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

  -- New: every approved contributor's actual manuscript text has to be here before this can
  -- become a real, readable book — see this migration's own header for why a submission could
  -- reach 'approved' with content still null (submitted before this migration existed).
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

  -- Assemble the actual manuscript, one approved contributor at a time in submission order —
  -- same "chapters: [{id,title,text}]" shape buildPublishedBookContent (ink-root.jsx) already
  -- sends for a solo book, so PublishedBookReader renders an anthology with no changes of its
  -- own. Each contributor's entry opens with a short byline section (their own submission title
  -- plus "By <name>", since the book itself has one shared title/cover/author line and would
  -- otherwise give a reader no way to tell whose work they're reading) followed by their actual
  -- chapters, unmodified.
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

  -- The actual fix: without this insert, published_books above is the only row an anthology
  -- ever got — a listing with no content mirror behind it, same hole 70_migration_published_
  -- book_content.sql closed for a solo book, just never closed for this path.
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
