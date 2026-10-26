import { findSong, resolveLink } from "@/lib/server/resolve";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    // ?title=&artist=&duration=&url=: a song named by a page whose own audio is copy-protected
    const title = sp.get("title")?.slice(0, 200);
    if (title) {
      const meta = { title, artist: sp.get("artist")?.slice(0, 200) || null, duration: Number(sp.get("duration")) || null };
      return Response.json(await findSong(meta, (sp.get("url") ?? "").slice(0, 500)));
    }
    return Response.json(await resolveLink(sp.get("url") ?? "", sp.has("alts")));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not resolve link" }, { status: 400 });
  }
}
