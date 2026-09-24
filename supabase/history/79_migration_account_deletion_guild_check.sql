-- ============================================================================================
-- Migration 79: don't let a Player Guild owner request account deletion without knowing what
-- it does to their guild.
--
-- Correction to the original audit item: the account_deletions header comment (see
-- "Account deletion — 30-day grace period, then a non-destructive purge" above) already
-- documents that purge_expired_account_deletions() does NOT delete the auth.users row — it bans
-- sign-in and anonymizes the profile, but never triggers player_guilds.owner_id's
-- `on delete cascade`. So the guild itself, its treasury, events, and anthologies do NOT get
-- destroyed on purge, contrary to what the audit assumed.
--
-- The real bug is quieter but just as bad: purge deletes the departing owner's OWN
-- player_guild_members row (see purge_expired_account_deletions' "delete from
-- player_guild_members where user_id = rec.user_id") and permanently bans their account, but
-- player_guilds.owner_id is left pointing at that now-permanently-banned account. Nothing in the
-- app can ever change player_guilds.owner_id today (see create_or_get_own_guild's own comment:
-- "no feature does that today") — so the guild is left with an owner who can never sign in
-- again, forever. Every member stays, the treasury/events/anthologies stay, but there is no path
-- back to a working owner: no one can approve events, manage the treasury, or found a
-- replacement (the one-guild-per-owner unique index means even a re-signed-up account can't
-- just make a new one for the same members). Functionally permanent, even though nothing was
-- literally deleted — and, same as the audit found, requested with zero warning to the other
-- members about to inherit an orphaned guild.
--
-- Fix: block requesting deletion while the account owns a Player Guild (is_founder_guild=false;
-- a Founder Guild has no owner_id per player_guilds' own check constraint, so it's never
-- affected either way), unless the request explicitly acknowledges it via the new
-- acknowledges_owned_guild_impact column. There's still no ownership-transfer feature to offer
-- as an alternative — this is the "require an explicit confirmation" branch from the fix
-- tracker, not the "block outright" or "offer a transfer" branches, since neither of those fits
-- what already exists.
-- ============================================================================================

alter table account_deletions add column if not exists acknowledges_owned_guild_impact boolean not null default false;

create or replace function check_account_deletion_guild_impact()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'pending' and not new.acknowledges_owned_guild_impact
     and exists (
       select 1 from player_guilds g
       where g.owner_id = new.user_id and not g.is_founder_guild
     )
  then
    -- A distinct, greppable message (not a generic one) so the client can catch this specific
    -- case and show the guild-specific warning instead of a plain failure — see
    -- src/lib/account-deletion.js's requestAccountDeletion.
    raise exception 'ACCOUNT_DELETION_BLOCKED_OWNS_PLAYER_GUILD';
  end if;
  return new;
end;
$$;

drop trigger if exists check_account_deletion_guild_impact_trigger on account_deletions;
create trigger check_account_deletion_guild_impact_trigger
  before insert or update on account_deletions
  for each row execute function check_account_deletion_guild_impact();
