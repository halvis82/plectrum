import { sql } from "@/lib/server/db";
import { validAnalysis } from "@/lib/analysis/validate";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** Anyone can rename a song (public library). The browser that made a song adds its notes once,
 * with the edit key it got when saving the chords. */
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
  if (body.notes !== undefined) {
    if (typeof body.editKey !== "string" || !body.editKey) return Response.json({ error: "Forbidden" }, { status: 403 });
    const [song] = (await sql`select analysis from songs
      where id = ${id} and edit_key = ${body.editKey} and created_at > now() - interval '1 hour'`) as { analysis: unknown }[];
    if (!song) return Response.json({ error: "Forbidden" }, { status: 403 });
    const analysis = { ...(song.analysis as object), notes: body.notes };
    if (!validAnalysis(analysis)) return Response.json({ error: "Invalid notes" }, { status: 400 });
    await sql`update songs set analysis = ${JSON.stringify(analysis)}, edit_key = null, updated_at = now() where id = ${id}`;
    return new Response(null, { status: 204 });
  }
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

/** Deleting needs the admin token (ADMIN_TOKEN env var). */
export async function DELETE(req: Request, ctx: RouteContext<"/api/songs/[id]">) {
  const { id } = await ctx.params;
  const token = process.env.ADMIN_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token) return Response.json({ error: "Forbidden" }, { status: 403 });
  await sql`delete from songs where id = ${id}`;
  return new Response(null, { status: 204 });
}
