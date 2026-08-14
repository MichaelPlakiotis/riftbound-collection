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
