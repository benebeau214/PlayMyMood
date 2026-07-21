create extension if not exists pgcrypto;

create type genre_enum as enum (
  'kpop','pop','edm','rock','jazz','trot','rnb','ballad','hiphop'
);

create type emotion_enum as enum (
  '행복한','신나는','설레는','기쁜','뿌듯한','감동한','편안한','후련한','만족한',
  '짜릿한','안도감','그리운','아련한','뭉클한','우울한','외로운','속상한','허무한',
  '피곤한','짜증난','화난','불안한','괴로운'
);

create table cover_styles (
  id smallserial primary key,
  code text unique not null,
  label text not null,
  sample_image_url text
);
alter table cover_styles enable row level security;
create policy cover_styles_public_read on cover_styles for select using (true);

create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  spotify_id text unique not null,
  display_name text,
  onboarding_completed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table profiles enable row level security;
create policy profiles_owner_all on profiles
  for all using (auth.uid() = id) with check (auth.uid() = id);

create table user_preferences (
  user_id uuid primary key references profiles(id) on delete cascade,
  era text not null check (era in ('2020s','2010s','2000s','pre_2000s')),
  genres genre_enum[] not null default '{}',
  fame_preference numeric(3,2) not null check (fame_preference between 0.00 and 1.00),
  cover_style_id smallint references cover_styles(id),
  updated_at timestamptz not null default now()
);
alter table user_preferences enable row level security;
create policy user_preferences_owner_all on user_preferences
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table daily_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  logged_at timestamptz not null default now(),
  log_date date generated always as ((logged_at at time zone 'Asia/Seoul')::date) stored,
  photo_path text not null,
  caption text,
  emotions emotion_enum[] not null check (array_length(emotions, 1) between 1 and 9),
  emotion_scores jsonb,
  mood_label text,
  situation text,
  image_context text,
  cover_prompt text
);
create index daily_logs_user_id_log_date_idx on daily_logs (user_id, log_date);
create index daily_logs_user_id_logged_at_idx on daily_logs (user_id, logged_at);
alter table daily_logs enable row level security;
create policy daily_logs_owner_all on daily_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table tracks (
  id uuid primary key default gen_random_uuid(),
  log_id uuid unique not null references daily_logs(id) on delete cascade,
  recco_track_id text,
  title text,
  artists text[],
  spotify_url text,
  duration_ms integer,
  popularity smallint,
  audio_features jsonb,
  fit_reason text,
  created_at timestamptz not null default now()
);
alter table tracks enable row level security;
create policy tracks_owner_all on tracks
  for all
  using (exists (select 1 from daily_logs d where d.id = tracks.log_id and d.user_id = auth.uid()))
  with check (exists (select 1 from daily_logs d where d.id = tracks.log_id and d.user_id = auth.uid()));

create table playlists (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  playlist_date date not null,
  title text not null,
  description text,
  cover_image_path text,
  created_at timestamptz not null default now(),
  unique (user_id, playlist_date)
);
alter table playlists enable row level security;
create policy playlists_owner_all on playlists
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
