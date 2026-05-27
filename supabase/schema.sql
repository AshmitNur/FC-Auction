create table if not exists public.fc26_app_state (
  key text primary key,
  state jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.fc26_players (
  id text primary key,
  rank integer not null,
  name text not null,
  overall_rating integer not null,
  position text,
  club text,
  nation text,
  gender text,
  player jsonb not null,
  updated_at timestamptz not null default now()
);

create index if not exists fc26_players_rating_rank_idx
  on public.fc26_players (overall_rating desc, rank asc);

alter table public.fc26_app_state enable row level security;
alter table public.fc26_players enable row level security;

drop policy if exists "fc26_players_read" on public.fc26_players;
create policy "fc26_players_read"
  on public.fc26_players
  for select
  to anon, authenticated
  using (true);

grant usage on schema public to anon, authenticated;
grant select on public.fc26_players to anon, authenticated;

-- The LAN server should write through SUPABASE_SERVICE_ROLE_KEY.
-- Do not expose that key in frontend code or commit it to git.
