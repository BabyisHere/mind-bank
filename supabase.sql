-- Run once in Supabase: SQL Editor > New query > paste > Run.

-- Tasks and journal entries live in one table; `data` holds the content.
create table if not exists public.items (
  id uuid primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  kind text not null check (kind in ('task', 'entry')),
  data jsonb not null,
  updated_at timestamptz not null,
  deleted boolean not null default false,
  synced_at timestamptz not null default now()
);
create index if not exists items_user_synced on public.items (user_id, synced_at);

-- Server clock stamps every write, so devices pull changes without trusting their own clocks.
create or replace function public.items_touch() returns trigger language plpgsql as $$
begin new.synced_at = now(); return new; end $$;
drop trigger if exists items_touch on public.items;
create trigger items_touch before insert or update on public.items for each row execute function public.items_touch();

-- Only you can read or write your rows.
alter table public.items enable row level security;
drop policy if exists "own items" on public.items;
create policy "own items" on public.items for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Private bucket for voice notes and photos, one folder per user id.
insert into storage.buckets (id, name, public) values ('media', 'media', false) on conflict (id) do nothing;
drop policy if exists "own media select" on storage.objects;
drop policy if exists "own media insert" on storage.objects;
drop policy if exists "own media update" on storage.objects;
drop policy if exists "own media delete" on storage.objects;
create policy "own media select" on storage.objects for select to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own media insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own media update" on storage.objects for update to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'media' and (storage.foldername(name))[1] = auth.uid()::text);
