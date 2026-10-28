import { sql } from "@/lib/server/db";
import { validAnalysis } from "@/lib/analysis/validate";
import { canChange, forbidden } from "@/lib/server/access";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** Renaming takes the song's owner or an admin (see access.ts). The browser that made a song adds its
 * notes (and the chords decided with them) once, with the edit key it got when saving the first chords;
 * a song that never got its notes can have them filled in by anyone, once; the owner or an admin can
 * replace them any time. */
export async function PATCH(req: Request, ctx: RouteContext<"/api/songs/[id]">) {
  const { id } = await ctx.params;
  const raw = await req.text();
  if (raw.length > 4_000_000) return Response.json({ error: "Too large" }, { status: 413 });
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (body.analysis !== undefined) {
    // the browser that made the song, within the hour, with its key; or anyone filling in a tab the
    // song never got (a song's tab is never replaced this way)
    const key = typeof body.editKey === "string" ? body.editKey : "";
    const anyTime = await canChange(req, id);
    const [song] = (await sql`select analysis from songs
      where id = ${id} and (${anyTime} or (edit_key = ${key} and created_at > now() - interval '1 hour') or analysis->'notes' is null)`) as { analysis: Record<string, unknown> }[];
    if (!song) return Response.json({ error: "Forbidden" }, { status: 403 });
    // the notes, and the chords decided again with them; timing (beats, duration) stays as saved unless sent
    const u = (body.analysis ?? {}) as Record<string, unknown>;
    // (a tab worked out later comes with its own beats, from the same audio)
    const timing = Array.isArray(u.beats) ? { beats: u.beats, bpm: u.bpm, duration: u.duration } : {};
    const analysis = { ...song.analysis, ...timing, notes: u.notes, chords: u.chords, segments: u.segments, meter: u.meter, downbeat: u.downbeat };
    if (!validAnalysis(analysis)) return Response.json({ error: "Invalid analysis" }, { status: 400 });
    const songKey = typeof body.key === "string" ? body.key.slice(0, 20) : null;
    const a = analysis as { bpm: number; duration: number };
    await sql`update songs set analysis = ${JSON.stringify(analysis)}, song_key = coalesce(${songKey}, song_key), bpm = ${a.bpm}, duration = ${a.duration},
      edit_key = null, updated_at = now() where id = ${id}`;
    return new Response(null, { status: 204 });
  }
  if (!(await canChange(req, id))) return forbidden();
  const title = str(body.title, 200);
  const artist = str(body.artist, 200);
  if (title === "" ) return Response.json({ error: "Title can't be empty" }, { status: 400 });
  const rows = await sql`update songs set
      title = coalesce(${title ?? null}, title),
      artist = case when ${artist === undefined} then artist else nullif(${artist ?? ""}, '') end,
      updated_at = now()
    where id = ${id} returning id, title, artist`;
  return rows[0] ? Response.json(rows[0]) : Response.json({ error: "Not found" }, { status: 404 });
}

/** Deleting takes the song's owner or an admin. */
export async function DELETE(req: Request, ctx: RouteContext<"/api/songs/[id]">) {
  const { id } = await ctx.params;
  if (!(await canChange(req, id))) return forbidden();
  await sql`delete from songs where id = ${id}`;
  return new Response(null, { status: 204 });
}
