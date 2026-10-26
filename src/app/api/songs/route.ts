import { customAlphabet } from "nanoid";
import { listSongs, sql } from "@/lib/server/db";
import { validAnalysis } from "@/lib/analysis/validate";

const newId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 10);
const SOURCES = ["youtube", "spotify", "upload", "record", "tab"];

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
  const source = SOURCES.includes(body.source as string) ? (body.source as string) : null;
  const youtubeId = typeof body.youtubeId === "string" && /^[\w-]{11}$/.test(body.youtubeId) ? body.youtubeId : null;
  const sourceUrl = str(body.sourceUrl, 500);
  const songKey = str(body.key, 20);
  if (!source || !validAnalysis(body.analysis)) return Response.json({ error: "Invalid analysis" }, { status: 400 });
  const a = body.analysis;
  const id = newId();
  await sql`insert into songs (id, title, artist, source, source_url, youtube_id, duration, bpm, meter, song_key, analysis)
    values (${id}, ${title}, ${artist}, ${source}, ${sourceUrl}, ${youtubeId}, ${a.duration}, ${a.bpm}, ${a.meter}, ${songKey}, ${JSON.stringify(a)})`;
  return Response.json({ id });
}
