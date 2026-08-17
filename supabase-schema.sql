-- Run this once in your Supabase project: Dashboard → SQL Editor → New query →
-- paste → Run. It is safe to run again; every statement guards itself.
--
-- One row per user holding the whole collection as JSON. That mirrors how the
-- app already thinks about the data — `collection` in app.js is a single object
-- keyed by card id — so there is no translation layer between browser and
-- database. A row-per-card schema would be more "correct" relationally and buy
-- nothing here: a collection is a couple of thousand small entries that are
-- always read and written together.

create table if not exists public.collections (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Without this, the anon key could read every row in the table. With it,
-- Postgres filters every query by the signed-in user before it returns anything.
alter table public.collections enable row level security;

-- auth.uid() is the id of whoever's token made the request; it is null for an
-- anonymous caller, so these policies deny by default.
drop policy if exists "read own collection"   on public.collections;
drop policy if exists "insert own collection" on public.collections;
drop policy if exists "update own collection" on public.collections;
drop policy if exists "delete own collection" on public.collections;

create policy "read own collection"
  on public.collections for select
  using (auth.uid() = user_id);

create policy "insert own collection"
  on public.collections for insert
  with check (auth.uid() = user_id);

-- `using` decides which rows you may target; `with check` stops you rewriting
-- user_id to someone else's id on the way out.
create policy "update own collection"
  on public.collections for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own collection"
  on public.collections for delete
  using (auth.uid() = user_id);

-- The client sends updated_at with each write, but a trigger means the column
-- stays honest even if a write forgets it — the app compares timestamps to
-- decide whether another device has newer data.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists collections_touch_updated_at on public.collections;
create trigger collections_touch_updated_at
  before update on public.collections
  for each row execute function public.touch_updated_at();


-- ===========================================================================
-- Public profiles
-- ===========================================================================
--
-- A profile is a handle and a switch. With the switch off an account is exactly
-- as private as it was before this table existed; with it on, other *signed-in*
-- collectors can find the handle and read the collection behind it.
--
-- The handle is the point of the table. An email address is the one piece of
-- identity every account already has, and it is precisely the piece nobody
-- should have to publish to be listed — so the name other players see is one
-- the owner chooses, and no email ever leaves auth.users.

create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  handle     text        not null,
  is_public  boolean     not null default false,
  updated_at timestamptz not null default now(),
  -- Letters, digits, dash and underscore, 3–20 characters. Narrow on purpose:
  -- a handle goes in a shareable ?u= link and gets compared by eye against
  -- other handles, and neither survives spaces or lookalike punctuation well.
  constraint profiles_handle_shape check (handle ~ '^[A-Za-z0-9_-]{3,20}$')
);

-- Case-insensitively unique: "Karra" and "karra" read as the same person, so
-- they must not be two accounts. The index does the enforcing, which also makes
-- the case-insensitive lookup the ?u= link needs an index scan.
create unique index if not exists profiles_handle_key
  on public.profiles (lower(handle));

alter table public.profiles enable row level security;

drop policy if exists "read visible profiles" on public.profiles;
drop policy if exists "insert own profile"    on public.profiles;
drop policy if exists "update own profile"    on public.profiles;
drop policy if exists "delete own profile"    on public.profiles;

-- Your own row always, plus every public one — but only once you are signed in
-- yourself. auth.uid() is null for an anonymous caller, so a visitor without an
-- account sees no profiles at all, not even the public ones.
create policy "read visible profiles"
  on public.profiles for select
  using (auth.uid() = user_id or (is_public and auth.uid() is not null));

create policy "insert own profile"
  on public.profiles for insert
  with check (auth.uid() = user_id);

create policy "update own profile"
  on public.profiles for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "delete own profile"
  on public.profiles for delete
  using (auth.uid() = user_id);

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
  before update on public.profiles
  for each row execute function public.touch_updated_at();


-- ---------------------------------------------------------------------------
-- Reading someone else's collection
-- ---------------------------------------------------------------------------
--
-- `security definer` means this runs as its owner rather than as the caller, so
-- the check answers the same way no matter who is asking. A policy that instead
-- sub-queried profiles directly would be filtered by *that* table's policies as
-- well, which is both slower and a well-known way to end up with two policies
-- quietly depending on each other.
create or replace function public.is_public_collector(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p where p.user_id = uid and p.is_public
  );
$$;

-- Granted to anon as well as authenticated even though anonymous callers are
-- turned away by the policy below: Postgres is free to evaluate the two halves
-- of an AND in either order, and a missing EXECUTE grant would surface as a
-- permission error rather than as an empty result.
grant execute on function public.is_public_collector(uuid) to anon, authenticated;

-- Additive. Multiple permissive SELECT policies are OR-ed together, so this
-- widens the read side without touching "read own collection" — and the write
-- policies are untouched, which is what keeps a public collection read-only to
-- everyone but its owner.
drop policy if exists "read public collections" on public.collections;
create policy "read public collections"
  on public.collections for select
  using (auth.uid() is not null and public.is_public_collector(user_id));


-- ---------------------------------------------------------------------------
-- The collector list
-- ---------------------------------------------------------------------------
--
-- Browsing wants a name and a rough size per collector, and nothing else. That
-- could be denormalised onto profiles and refreshed on every sync, but a count
-- that the client writes is a count that can be wrong; counting in the view
-- keeps one copy of the truth, and the browse list stays a single small query
-- instead of downloading every public collection to measure it.

-- Collections are written by a sanitising client, so q and f are always numbers
-- — but a policy or a view that assumes it would break for *everyone* the first
-- time somebody wrote a string there by hand. This reads as zero instead.
create or replace function public.jsonb_count(v jsonb)
returns numeric
language sql
immutable
as $$
  select case when jsonb_typeof(v) = 'number' then v::text::numeric else 0 end;
$$;

grant execute on function public.jsonb_count(jsonb) to anon, authenticated;

-- `security_invoker` (Postgres 15+) makes the view read with the caller's
-- permissions, so both tables' policies still apply through it. Without it a
-- view would run as its owner and hand out rows RLS was meant to withhold.
drop view if exists public.public_collectors;
create view public.public_collectors
with (security_invoker = true) as
select
  p.user_id,
  p.handle,
  c.updated_at as collection_updated_at,
  coalesce((
    select count(*) from jsonb_each(c.data) e
    where public.jsonb_count(e.value -> 'q') + public.jsonb_count(e.value -> 'f') > 0
  ), 0) as unique_cards,
  coalesce((
    select sum(public.jsonb_count(e.value -> 'q') + public.jsonb_count(e.value -> 'f'))
    from jsonb_each(c.data) e
  ), 0) as total_copies
from public.profiles p
-- Left join: an account can go public before it has ever synced a card, and it
-- should still be listed rather than silently missing.
left join public.collections c on c.user_id = p.user_id
where p.is_public;

grant select on public.public_collectors to authenticated;
