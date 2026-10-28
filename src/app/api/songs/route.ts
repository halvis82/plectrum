import { randomBytes } from "crypto";
import { customAlphabet } from "nanoid";
import { listSongs, sql } from "@/lib/server/db";
import { validAnalysis } from "@/lib/analysis/validate";
import { validEdits } from "@/lib/edits";
import { ownerHash } from "@/lib/server/access";

const ALPHABET = "23456789abcdefghjkmnpqrstuvwxyz";
const newId = customAlphabet(ALPHABET, 10);
/** the browser may pick the id, so the song's page can open before it is saved */
const ID_RE = new RegExp(`^[${ALPHABET}]{10}$`);

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
  // a song started from scratch arrives with its tempo grid and an empty tab
  const edits = body.edits === undefined ? null : validEdits(body.edits) ? body.edits : undefined;
  if (edits === undefined) return Response.json({ error: "Invalid edits" }, { status: 400 });
  const id = typeof body.id === "string" && ID_RE.test(body.id) ? body.id : newId();
  // the browser keeps the owner key that lets it change the song later; only its hash is stored
  const owner = typeof body.ownerKey === "string" && body.ownerKey.length >= 20 && body.ownerKey.length <= 100 ? ownerHash(body.ownerKey) : null;
  // the same browser retrying a save that already went through
  const [had] = (await sql`select edit_key from songs where id = ${id}`) as { edit_key: string | null }[];
  if (had) return Response.json({ id, editKey: had.edit_key });
  // songs arrive with their chords first; the browser that made one adds the notes with this key
  const editKey = a.notes ? null : randomBytes(18).toString("base64url");
  if (youtubeId || sourceUrl) {
    // the same link saved before whose notes never arrived (its tab was closed early): replaced by this one
    await sql`delete from songs where (youtube_id = ${youtubeId} or source_url = ${sourceUrl})
      and analysis->'notes' is null and (edit_key is null or created_at < now() - interval '1 hour')`;
  }
  await sql`insert into songs (id, title, artist, source, source_url, youtube_id, audio_url, duration, bpm, meter, song_key, analysis, edit_key, edits, owner_hash)
    values (${id}, ${title}, ${artist}, ${source}, ${sourceUrl}, ${youtubeId}, ${audioUrl}, ${a.duration}, ${a.bpm}, ${a.meter}, ${songKey}, ${JSON.stringify(a)}, ${editKey}, ${edits ? JSON.stringify(edits) : null}, ${owner})`;
  return Response.json({ id, editKey });
}
