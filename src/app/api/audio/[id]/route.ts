import { YouTubeError, audioSource, streamAudio } from "@/lib/server/youtube-audio";

export const maxDuration = 300;

/** Audio for a YouTube video, fetched server-side and streamed with Range support. */
export async function GET(req: Request, ctx: RouteContext<"/api/audio/[id]">) {
  const { id } = await ctx.params;
  if (!/^[\w-]{11}$/.test(id)) return Response.json({ error: "Bad video id" }, { status: 400 });
  let src;
  try {
    src = await audioSource(id);
  } catch (e) {
    console.error("audio", id, e instanceof Error ? e.message : e);
    const blocked = e instanceof YouTubeError;
    return Response.json({ error: blocked ? "YouTube wouldn't hand over this video's audio." : "Couldn't fetch the audio." }, { status: 502 });
  }
  const total = src.bytes;
  const headers: Record<string, string> = {
    "content-type": src.mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
  };
  const m = req.headers.get("range")?.match(/bytes=(\d*)-(\d*)/);
  if (m && total) {
    const start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
    const end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (start >= total || start > end) return new Response(null, { status: 416, headers: { "content-range": `bytes */${total}` } });
    return new Response(streamAudio(src, start, end), {
      status: 206,
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1) },
    });
  }
  return new Response(streamAudio(src), { headers: total ? { ...headers, "content-length": String(total) } : headers });
}
