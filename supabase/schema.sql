create table if not exists public.party_rooms (
  code text primary key,
  state jsonb not null,
  updated_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default timezone('utc', now()) + interval '12 hours'
);

alter table public.party_rooms enable row level security;

create policy "party_rooms_are_public_for_demo"
on public.party_rooms
for all
using (true)
with check (true);

alter publication supabase_realtime add table public.party_rooms;

create index if not exists party_rooms_expires_at_idx on public.party_rooms (expires_at);