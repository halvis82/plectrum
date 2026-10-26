import { YouTubeError, audioSource, streamAudio } from "@/lib/server/youtube-audio";

export const maxDuration = 300;

async function ytdlpStream(id: string, origin: string): Promise<Response | null> {
  const base = process.env.YTDLP_URL ?? `${origin}/api/ytdlp`;
  const res = await fetch(`${base}?stream=1&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, {
    headers: {
      "x-key": process.env.ADMIN_TOKEN ?? "",
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}),
    },
  }).catch(() => null);
  if (!res?.ok || !res.body) {
    console.error("audio ytdlp", id, res ? (await res.text()).slice(0, 200) : "unreachable");
    return null;
  }
  const headers: Record<string, string> = { "content-type": res.headers.get("content-type") ?? "audio/mp4", "cache-control": "private, max-age=3600", "x-audio-client": "ytdlp" };
  if (res.headers.get("content-length")) headers["content-length"] = res.headers.get("content-length")!;
  return new Response(res.body, { headers });
}

/** Audio for a YouTube video, fetched server-side and streamed with Range support. */
export async function GET(req: Request, ctx: RouteContext<"/api/audio/[id]">) {
  const { id } = await ctx.params;
  if (!/^[\w-]{11}$/.test(id)) return Response.json({ error: "Bad video id" }, { status: 400 });
  let src;
  try {
    src = await audioSource(id);
  } catch (e) {
    console.error("audio", id, e instanceof Error ? e.message : e);
    // last try: yt-dlp extracts and downloads from one machine, since stream URLs are tied to the IP
    const viaYtdlp = await ytdlpStream(id, new URL(req.url).origin);
    if (viaYtdlp) return viaYtdlp;
    const blocked = e instanceof YouTubeError;
    return Response.json({ error: blocked ? "YouTube wouldn't hand over this video's audio." : "Couldn't fetch the audio." }, { status: 502 });
  }
  const total = src.bytes;
  const headers: Record<string, string> = {
    "content-type": src.mime,
    "accept-ranges": "bytes",
    "cache-control": "private, max-age=3600",
    "x-audio-client": src.client,
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
