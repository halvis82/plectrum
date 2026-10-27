import "server-only";
import { neon } from "@neondatabase/serverless";
import type { Analysis } from "@/lib/analysis/analyze";
import type { Edits } from "@/lib/edits";
import type { Captions } from "@/lib/captions";

export const sql = neon(process.env.DATABASE_URL!);

export type SongSummary = {
  id: string;
  title: string;
  artist: string | null;
  source: string;
  youtube_id: string | null;
  duration: number;
  bpm: number | null;
  song_key: string | null;
  created_at: string;
};

export type Song = SongSummary & {
  source_url: string | null;
  audio_url: string | null;
  meter: number | null;
  analysis: Analysis;
  views: number;
  edits: Edits | null;
  captions: Captions | null;
  updated_at: string | null;
};

export async function listSongs(q?: string, limit = 60): Promise<SongSummary[]> {
  const pattern = q ? `%${q.replace(/[%_\\]/g, (c) => "\\" + c)}%` : null;
  return (await sql`
    select id, title, artist, source, youtube_id, duration, bpm, song_key, created_at
    from songs
    where ${pattern}::text is null or title ilike ${pattern} or artist ilike ${pattern}
    order by created_at desc
    limit ${limit}`) as SongSummary[];
}

export async function getSong(id: string): Promise<Song | null> {
  const rows = (await sql`update songs set views = views + 1 where id = ${id}
    returning id, title, artist, source, source_url, youtube_id, audio_url, duration, bpm, meter, song_key, analysis, views, created_at, updated_at, edits, captions`) as Song[];
  return rows[0] ?? null;
}

/** A library song made from the same video or page with the note models (note rows with string
 * probabilities),
 * so a repeated link opens it instead of analyzing the song again. */
export async function findExisting(youtubeId: string | null, sourceUrl: string | null): Promise<string | null> {
  if (!youtubeId && !sourceUrl) return null;
  const rows = (await sql`
    select id from songs
    where (youtube_id = ${youtubeId} or source_url = ${sourceUrl} or audio_url = ${sourceUrl})
      and jsonb_array_length(analysis->'notes'->0) >= 10
    order by created_at desc
    limit 1`) as { id: string }[];
  return rows[0]?.id ?? null;
}
