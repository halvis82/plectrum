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
-- added later: the tab as written by hand, the words with times, the key for adding the notes, and
-- the hash of the owner key (the browser that made the song may change it; see src/lib/server/access.ts)
alter table songs add column if not exists edits jsonb;
alter table songs add column if not exists captions jsonb;
alter table songs add column if not exists edit_key text;
alter table songs add column if not exists owner_hash text;

-- wrong admin passwords, for the rate limit
create table if not exists admin_attempts (ip text not null, at timestamptz not null default now());
create index if not exists admin_attempts_idx on admin_attempts (ip, at);

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
