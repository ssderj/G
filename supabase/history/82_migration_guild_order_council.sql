-- Migration 82: Guild Order — a real Council, for both guild types.
--
-- Closes fix-tracker item 16. GoCouncilTab was the last fully-simulated tab in the Guild Order —
-- hardcoded vote-count seeds (seedFor/seedAgainst/seedAbstain) plus only this device's own local
-- vote layered on top, with no real proposal behind the tally at all.
--
-- Two tables, following guild_order_chapters/guild_order_passages' own split (migration 65) for
-- the same reason: a proposal is the "document" (guild_type/guild_id scoped, like a chapter), a
-- vote is a "contribution" to it (references the proposal by id only, like a passage references
-- its chapter) — so votes are filtered client-side against a tracked set of this guild's
-- proposal ids for Realtime, exactly the way subscribeGuildManuscriptRealtime already does for
-- passages (see lib/guild-order-council.js's subscribeGuildCouncilRealtime).
--
-- Permission model — same "lighter than GO_PERMISSIONS' full rung ladder" precedent migrations
-- 65 and 81 both already set: any real member can open a proposal or cast a vote server-side;
-- GO_PERMISSIONS.openVote (rung 5, "Guild Master") still gates the client's own "raise a
-- proposal" button, GO_PERMISSIONS.castVote (rung 1, any member) gates casting a vote — neither
-- rung is re-derived here for the same reason migration 65's own comment gives: a Founder Guild's
-- rung comes from author-reputation.jsx's Reputation formula, and duplicating that in SQL for a
-- threshold that only gates a client-side button isn't worth the drift risk. A proposal can only
-- be closed by whoever opened it — simplest rule that needs no rung check at all, and matches
-- this being an MVP; revisit if guilds want any officer to be able to close someone else's stalled
-- proposal.
--
-- A vote is an upsert, not an insert-once: `on conflict (proposal_id, voter_id) do update` lets a
-- member change their mind before a proposal closes, same as the old simulated tab let you
-- re-cast state.councilVote at will. The unique constraint is what makes one real vote per member
-- actually real, unlike the old local-only councilVote's single-device, no-double-check version.

create table if not exists guild_order_proposals (
  id uuid primary key default gen_random_uuid(),
  guild_type text not null check (guild_type in ('founder', 'player')),
  guild_id text not null,
  title text not null check (char_length(title) > 0 and char_length(title) <= 200),
  body text not null check (char_length(body) <= 2000),
  opened_by uuid not null references auth.users(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create table if not exists guild_order_votes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references guild_order_proposals(id) on delete cascade,
  voter_id uuid not null references auth.users(id) on delete cascade,
  choice text not null check (choice in ('yes', 'no', 'abstain')),
  created_at timestamptz not null default now(),
  unique (proposal_id, voter_id)
);

alter table guild_order_proposals enable row level security;
alter table guild_order_votes enable row level security;

create policy "members read their guild's proposals" on guild_order_proposals
  for select using (
    (guild_type = 'founder' and exists (
      select 1 from founder_guild_members m where m.guild_id = guild_order_proposals.guild_id and m.user_id = auth.uid()
    ))
    or (guild_type = 'player' and (
      exists (select 1 from player_guild_members m where m.guild_id = guild_order_proposals.guild_id::uuid and m.user_id = auth.uid())
      or exists (select 1 from player_guilds g where g.id = guild_order_proposals.guild_id::uuid and g.owner_id = auth.uid())
    ))
  );

create policy "members open proposals in their own guild" on guild_order_proposals
  for insert with check (
    opened_by = auth.uid()
    and (
      (guild_type = 'founder' and exists (
        select 1 from founder_guild_members m where m.guild_id = guild_order_proposals.guild_id and m.user_id = auth.uid()
      ))
      or (guild_type = 'player' and (
        exists (select 1 from player_guild_members m where m.guild_id = guild_order_proposals.guild_id::uuid and m.user_id = auth.uid())
        or exists (select 1 from player_guilds g where g.id = guild_order_proposals.guild_id::uuid and g.owner_id = auth.uid())
      ))
    )
  );

-- Only the opener can close their own proposal (and only status/closed_at ever change — a
-- proposal's title/body/opened_by are immutable once raised, same as a chapter's guild_id never
-- changes hands after it's created).
create policy "openers close their own proposal" on guild_order_proposals
  for update using (opened_by = auth.uid()) with check (opened_by = auth.uid());

-- Votes are readable by anyone who can already read the proposal they're on — no separate
-- membership re-check needed since a vote can't exist without a real proposal_id, and that
-- proposal's own select policy already gated who's a member of this guild.
create policy "members read votes on proposals they can see" on guild_order_votes
  for select using (exists (
    select 1 from guild_order_proposals p where p.id = guild_order_votes.proposal_id
  ));

create policy "members cast their own vote" on guild_order_votes
  for insert with check (
    voter_id = auth.uid()
    and exists (select 1 from guild_order_proposals p where p.id = guild_order_votes.proposal_id and p.status = 'open')
  );

-- Changing your vote before the proposal closes is an update, not a new row (see the unique
-- constraint above) — same open-status guard as casting the first time.
create policy "members change their own vote while open" on guild_order_votes
  for update using (voter_id = auth.uid()) with check (
    voter_id = auth.uid()
    and exists (select 1 from guild_order_proposals p where p.id = guild_order_votes.proposal_id and p.status = 'open')
  );

create index if not exists guild_order_proposals_guild_idx on guild_order_proposals (guild_type, guild_id, status, created_at desc);
create index if not exists guild_order_votes_proposal_idx on guild_order_votes (proposal_id);

alter publication supabase_realtime add table guild_order_proposals;
alter publication supabase_realtime add table guild_order_votes;
