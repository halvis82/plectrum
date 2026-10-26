import { MediaError, extractMedia, openMedia, publicUrl } from "@/lib/server/media";

export const maxDuration = 300;

/**
 * Audio from a page on any site yt-dlp supports (?url=), or the first full-length SoundCloud copy of a
 * song (?q=&title=&duration=) when YouTube won't hand one over. What was found is described in the
 * x-media header (URI-encoded JSON).
 */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const origin = new URL(req.url).origin;
  let params: Record<string, string>;
  if (sp.get("q")) {
    params = { q: sp.get("q")!.slice(0, 200), title: (sp.get("title") ?? "").slice(0, 200) };
    if (sp.get("artist")) params.artist = sp.get("artist")!.slice(0, 200);
    if (Number(sp.get("duration")) > 0) params.duration = String(Number(sp.get("duration")));
  } else {
    const u = publicUrl(sp.get("url") ?? "");
    if (!u) return Response.json({ error: "That isn't a link to a public page." }, { status: 400 });
    params = { url: u.href };
  }
  try {
    const info = await extractMedia(params, origin);
    const body = await openMedia(info.format);
    const meta = { title: info.title, artist: info.artist, site: info.site, page: info.page, duration: info.duration, thumbnail: info.thumbnail };
    const headers: Record<string, string> = {
      "content-type": body.type,
      "cache-control": "private, max-age=600",
      "x-media": encodeURIComponent(JSON.stringify(meta)),
    };
    if (body.bytes) headers["content-length"] = String(body.bytes);
    return new Response(body.stream, { headers });
  } catch (e) {
    console.error("media", params, e instanceof Error ? e.message : e);
    if (e instanceof MediaError) return Response.json({ error: e.message, song: e.song }, { status: 502 });
    return Response.json({ error: "Couldn't fetch the audio from that link." }, { status: 502 });
  }
}
