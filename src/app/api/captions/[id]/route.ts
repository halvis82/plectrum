import { sql } from "@/lib/server/db";
import { invidiousHosts } from "@/lib/server/youtube-audio";
import { parseVtt, validCaptions, type Captions } from "@/lib/captions";

type Track = { label: string; language_code?: string; languageCode?: string; url: string };

/** The video's own captions, through Invidious: hand-written ones first, auto-generated otherwise. */
async function youtubeCaptions(videoId: string): Promise<Captions | null> {
  for (const host of (await invidiousHosts()).slice(0, 4)) {
    try {
      const r = await fetch(`https://${host}/api/v1/captions/${videoId}`, { signal: AbortSignal.timeout(6000) });
      if (!r.ok) continue;
      const { captions } = (await r.json()) as { captions?: Track[] };
      if (!captions?.length) return null;
      const auto = (t: Track) => /auto-generated|automatic/i.test(t.label);
      const track = captions.find((t) => !auto(t)) ?? captions[0];
      const vtt = await fetch(new URL(track.url, `https://${host}`), { signal: AbortSignal.timeout(8000) }).then((x) => (x.ok ? x.text() : ""));
      const lines = parseVtt(vtt);
      if (lines.length) return { source: "youtube", lang: track.language_code ?? track.languageCode ?? null, lines };
    } catch {}
  }
  return null;
}

/** Words for a song with times: stored ones, else the video's captions (stored once found). */
export async function GET(_req: Request, ctx: RouteContext<"/api/captions/[id]">) {
  const { id } = await ctx.params;
  const [song] = (await sql`select youtube_id, captions from songs where id = ${id}`) as { youtube_id: string | null; captions: Captions | null }[];
  if (!song) return Response.json({ error: "Not found" }, { status: 404 });
  if (song.captions) return Response.json({ captions: song.captions });
  const found = song.youtube_id ? await youtubeCaptions(song.youtube_id) : null;
  if (found) await sql`update songs set captions = ${JSON.stringify(found)} where id = ${id} and captions is null`;
  return Response.json({ captions: found });
}

/** Words transcribed in the browser, kept so nobody has to transcribe this song again. */
export async function POST(req: Request, ctx: RouteContext<"/api/captions/[id]">) {
  const { id } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 1_000_000) return Response.json({ error: "Too large" }, { status: 413 });
  let c: unknown;
  try {
    c = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (!validCaptions(c) || c.source !== "transcribed") return Response.json({ error: "Invalid captions" }, { status: 400 });
  const rows = await sql`update songs set captions = ${JSON.stringify(c)} where id = ${id} and (captions is null or captions->>'source' = 'transcribed') returning id`;
  return rows[0] ? new Response(null, { status: 204 }) : Response.json({ error: "Not saved" }, { status: 409 });
}
