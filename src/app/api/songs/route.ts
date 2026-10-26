import { customAlphabet } from "nanoid";
import { listSongs, sql } from "@/lib/server/db";
import { validAnalysis } from "@/lib/analysis/validate";

const newId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 10);

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get("q") ?? undefined;
  return Response.json(await listSongs(q));
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 4_000_000) return Response.json({ error: "Too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  const title = str(body.title, 200) ?? "Untitled";
  const artist = str(body.artist, 200);
  // youtube, spotify, apple, deezer, upload, record, or the yt-dlp site a web link came from
  const source = typeof body.source === "string" && /^[a-z0-9]{2,24}$/.test(body.source) ? body.source : null;
  const youtubeId = typeof body.youtubeId === "string" && /^[\w-]{11}$/.test(body.youtubeId) ? body.youtubeId : null;
  const sourceUrl = str(body.sourceUrl, 500);
  // page /api/media can fetch the audio from again (links that aren't YouTube)
  const audioUrl = typeof body.audioUrl === "string" && /^https?:\/\//.test(body.audioUrl) ? body.audioUrl.slice(0, 500) : null;
  const songKey = str(body.key, 20);
  if (!source || !validAnalysis(body.analysis)) return Response.json({ error: "Invalid analysis" }, { status: 400 });
  const a = body.analysis;
  const id = newId();
  await sql`insert into songs (id, title, artist, source, source_url, youtube_id, audio_url, duration, bpm, meter, song_key, analysis)
    values (${id}, ${title}, ${artist}, ${source}, ${sourceUrl}, ${youtubeId}, ${audioUrl}, ${a.duration}, ${a.bpm}, ${a.meter}, ${songKey}, ${JSON.stringify(a)})`;
  return Response.json({ id });
}
