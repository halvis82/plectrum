import { sql } from "@/lib/server/db";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);

/** Anyone can rename a song (public library). */
export async function PATCH(req: Request, ctx: RouteContext<"/api/songs/[id]">) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
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
