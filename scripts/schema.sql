create table if not exists songs (
  id text primary key,
  title text not null,
  artist text,
  source text not null,
  source_url text,
  youtube_id text,
  -- page /api/media can fetch the audio from again (links other than YouTube)
  audio_url text,
  duration real not null,
  bpm real,
  meter smallint,
  song_key text,
  analysis jsonb not null,
  views integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists songs_created_idx on songs (created_at desc);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
