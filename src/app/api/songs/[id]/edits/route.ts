import { sql } from "@/lib/server/db";
import { validEdits } from "@/lib/edits";
import { canChange, forbidden } from "@/lib/server/access";

/** Saves a song's hand edits (the tab as written, cuts, chords, a scratch song's tempo grid), for its
 * owner or an admin; null puts the song back as heard. */
export async function PUT(req: Request, ctx: RouteContext<"/api/songs/[id]/edits">) {
  const { id } = await ctx.params;
  if (!(await canChange(req, id))) return forbidden();
  const raw = await req.text();
  if (raw.length > 3_000_000) return Response.json({ error: "Too large" }, { status: 413 });
  let edits: unknown;
  try {
    edits = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Bad JSON" }, { status: 400 });
  }
  if (edits !== null && !validEdits(edits)) return Response.json({ error: "Invalid edits" }, { status: 400 });
  const rows = await sql`update songs set edits = ${edits === null ? null : JSON.stringify(edits)}, updated_at = now() where id = ${id} returning updated_at`;
  return rows[0] ? Response.json({ saved: rows[0].updated_at }) : Response.json({ error: "Not found" }, { status: 404 });
}
