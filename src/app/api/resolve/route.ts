import { findExisting } from "@/lib/server/db";
import { findSong, resolveLink, youtubeId } from "@/lib/server/resolve";

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  try {
    // ?title=&artist=&duration=&url=: a song named by a page whose own audio is copy-protected
    const title = sp.get("title")?.slice(0, 200);
    if (title) {
      const meta = { title, artist: sp.get("artist")?.slice(0, 200) || null, duration: Number(sp.get("duration")) || null };
      const found = await findSong(meta, (sp.get("url") ?? "").slice(0, 500));
      return Response.json({ ...found, existing: await findExisting(found.videoId, found.sourceUrl) });
    }
    const url = sp.get("url") ?? "";
    // a video already in the library opens without looking anything up
    const id = sp.has("alts") ? null : youtubeId(url);
    const known = id ? await findExisting(id, null) : null;
    if (known) return Response.json({ existing: known });
    const resolved = await resolveLink(url, sp.has("alts"));
    return Response.json({ ...resolved, existing: sp.has("alts") ? null : await findExisting(resolved.videoId, resolved.sourceUrl) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Could not resolve link" }, { status: 400 });
  }
}
