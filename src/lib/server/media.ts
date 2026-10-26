import "server-only";

// Audio from any page yt-dlp understands (api/ytdlp.py finds the media, this file downloads it).
// Plain files are proxied in ranged chunks; HLS playlists are joined into one file, with MPEG-TS
// segments unpacked to raw AAC/MP3 since browsers can't decode TS.

export type MediaFormat = { url: string; protocol: string; ext: string | null; video: boolean; headers: Record<string, string>; bytes: number };

export type MediaInfo = {
  title: string;
  artist: string | null;
  duration: number | null;
  /** yt-dlp extractor name, e.g. "soundcloud", "bandcamp", "generic" */
  site: string;
  page: string | null;
  thumbnail: string | null;
  format: MediaFormat;
};

/** `song` is set when the page's audio is DRM protected but it says what the song is. */
export class MediaError extends Error {
  constructor(
    message: string,
    readonly song: { title: string; artist: string | null; duration: number | null } | null = null,
  ) {
    super(message);
  }
}

const MAX_BYTES = 120 * 1024 * 1024;

/** Calls the yt-dlp function: `{ url }` to extract a page, `{ q, title, duration }` to search SoundCloud. */
export async function extractMedia(params: Record<string, string>, origin: string): Promise<MediaInfo> {
  const base = process.env.YTDLP_URL ?? `${origin}/api/ytdlp`;
  const res = await fetch(`${base}?${new URLSearchParams(params)}`, {
    headers: {
      "x-key": process.env.ADMIN_TOKEN ?? "",
      // preview deployments sit behind Vercel Authentication, even for calls to themselves
      ...(process.env.VERCEL_AUTOMATION_BYPASS_SECRET ? { "x-vercel-protection-bypass": process.env.VERCEL_AUTOMATION_BYPASS_SECRET } : {}),
    },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await res.json().catch(() => ({ error: `extractor HTTP ${res.status}` }));
  if (!res.ok) throw new MediaError(body.error ?? "Couldn't read that link.", body.song ?? null);
  return body as MediaInfo;
}

/** Only public http(s) pages; no localhost or private network addresses. */
export function publicUrl(input: string): URL | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(h)) return null;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || /^(::1?|f[cd]|fe80)/i.test(h)) return null;
  return u;
}

const MIME: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  mov: "audio/mp4",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  weba: "audio/webm",
  wav: "audio/wav",
  flac: "audio/flac",
};

export type MediaBody = { stream: ReadableStream<Uint8Array>; type: string; bytes: number | null };

export async function openMedia(f: MediaFormat): Promise<MediaBody> {
  if (f.protocol.startsWith("m3u8")) return openHls(f);
  // learn the size from a first ranged request, then fetch the rest in chunks (some CDNs throttle
  // whole-file requests)
  const first = await fetch(f.url, { headers: { ...f.headers, range: "bytes=0-0" }, signal: AbortSignal.timeout(20_000) });
  await first.arrayBuffer().catch(() => {});
  if (!first.ok) throw new MediaError(`media HTTP ${first.status}`);
  const total = Number(first.headers.get("content-range")?.split("/")[1]) || null;
  if (total && total > MAX_BYTES) throw new MediaError("That file is too large.");
  const type = MIME[f.ext ?? ""] ?? first.headers.get("content-type") ?? "application/octet-stream";
  if (!total) return { stream: capped((await fetch(f.url, { headers: f.headers })).body!), type, bytes: null };
  return { stream: chunked(first.url, f.headers, total), type, bytes: total };
}

function chunked(url: string, headers: Record<string, string>, total: number): ReadableStream<Uint8Array> {
  const CHUNK = 4 * 1024 * 1024;
  let pos = 0;
  return new ReadableStream({
    async pull(controller) {
      if (pos >= total) return controller.close();
      const end = Math.min(total - 1, pos + CHUNK - 1);
      const res = await fetch(url, { headers: { ...headers, range: `bytes=${pos}-${end}` } });
      if (!res.ok) return controller.error(new MediaError(`media HTTP ${res.status}`));
      controller.enqueue(new Uint8Array(await res.arrayBuffer()));
      pos = end + 1;
    },
  });
}

function capped(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let got = 0;
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        got += chunk.length;
        if (got > MAX_BYTES) controller.error(new MediaError("That file is too large."));
        else controller.enqueue(chunk);
      },
    }),
  );
}

// ---- HLS ----

async function text(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new MediaError(`playlist HTTP ${res.status}`);
  return { body: await res.text(), url: res.url };
}

async function openHls(f: MediaFormat): Promise<MediaBody> {
  let { body, url } = await text(f.url, f.headers);
  // a master playlist: take the lowest-bandwidth variant, or a separate audio rendition when there is one
  if (body.includes("#EXT-X-STREAM-INF")) {
    const audio = body.match(/#EXT-X-MEDIA:[^\n]*TYPE=AUDIO[^\n]*URI="([^"]+)"/)?.[1];
    const variants = [...body.matchAll(/#EXT-X-STREAM-INF:([^\n]*)\n([^#\n][^\n]*)/g)].map((m) => ({
      bw: Number(m[1].match(/BANDWIDTH=(\d+)/)?.[1] ?? Infinity),
      uri: m[2].trim(),
    }));
    const next = audio ?? variants.sort((a, b) => a.bw - b.bw)[0]?.uri;
    if (!next) throw new MediaError("Empty playlist.");
    ({ body, url } = await text(new URL(next, url).href, f.headers));
  }
  if (/#EXT-X-KEY:METHOD=(?!NONE)/.test(body)) throw new MediaError("That stream is encrypted.");
  const init = body.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
  const parts = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => new URL(l, url).href);
  if (!parts.length) throw new MediaError("Empty playlist.");
  const urls = init ? [new URL(init, url).href, ...parts] : parts;
  const ts = !init && /\.ts(\?|$)/.test(parts[0]);

  let i = 0;
  let got = 0;
  const demux = ts ? new TsDemuxer() : null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // fetch a few segments at a time to keep latency down
      if (i >= urls.length) {
        if (demux) controller.enqueue(demux.flush());
        return controller.close();
      }
      const batch = urls.slice(i, i + 6);
      i += batch.length;
      const bufs = await Promise.all(
        batch.map(async (u) => {
          const res = await fetch(u, { headers: f.headers });
          if (!res.ok) throw new MediaError(`segment HTTP ${res.status}`);
          return new Uint8Array(await res.arrayBuffer());
        }),
      ).catch((e) => (controller.error(e), null));
      if (!bufs) return;
      for (const b of bufs) {
        got += b.length;
        if (got > MAX_BYTES) return controller.error(new MediaError("That stream is too long."));
        controller.enqueue(demux ? demux.push(b) : b);
      }
    },
  });
  // TS output is whatever elementary stream the PMT names; fMP4 and plain segments keep their type
  return { stream, type: ts ? "audio/aac" : (MIME[f.ext ?? ""] ?? "audio/mp4"), bytes: null };
}

/** Pulls the first audio elementary stream (ADTS AAC or MPEG audio) out of an MPEG transport stream. */
class TsDemuxer {
  private pmtPid = -1;
  private audioPid = -1;
  private rest = new Uint8Array(0);
  private out: Uint8Array[] = [];

  push(data: Uint8Array): Uint8Array {
    const buf = new Uint8Array(this.rest.length + data.length);
    buf.set(this.rest);
    buf.set(data, this.rest.length);
    let p = 0;
    while (p + 188 <= buf.length) {
      if (buf[p] !== 0x47) {
        p++;
        continue;
      }
      this.packet(buf.subarray(p, p + 188));
      p += 188;
    }
    this.rest = buf.slice(p);
    return this.flush();
  }

  flush(): Uint8Array {
    const n = this.out.reduce((s, b) => s + b.length, 0);
    const res = new Uint8Array(n);
    let o = 0;
    for (const b of this.out) {
      res.set(b, o);
      o += b.length;
    }
    this.out = [];
    return res;
  }

  private packet(pk: Uint8Array) {
    const start = (pk[1] & 0x40) !== 0;
    const pid = ((pk[1] & 0x1f) << 8) | pk[2];
    const afc = (pk[3] >> 4) & 3;
    let p = 4;
    if (afc === 2) return;
    if (afc === 3) p += 1 + pk[4];
    if (p >= 188) return;
    const payload = pk.subarray(p);
    if (pid === 0 && start) {
      // PAT: first program's PMT
      const s = 1 + payload[0];
      this.pmtPid = ((payload[s + 10] & 0x1f) << 8) | payload[s + 11];
    } else if (pid === this.pmtPid && start && this.audioPid < 0) {
      const s = 1 + payload[0];
      const len = ((payload[s + 1] & 0x0f) << 8) | payload[s + 2];
      const infoLen = ((payload[s + 10] & 0x0f) << 8) | payload[s + 11];
      let q = s + 12 + infoLen;
      const end = s + 3 + len - 4;
      while (q + 5 <= end) {
        const type = payload[q];
        const epid = ((payload[q + 1] & 0x1f) << 8) | payload[q + 2];
        // 0x0f ADTS AAC, 0x03/0x04 MPEG-1/2 audio
        if (type === 0x0f || type === 0x03 || type === 0x04) {
          this.audioPid = epid;
          break;
        }
        q += 5 + (((payload[q + 3] & 0x0f) << 8) | payload[q + 4]);
      }
    } else if (pid === this.audioPid) {
      // PES: skip the header at the start of each packet group
      if (start) {
        if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return;
        this.out.push(payload.slice(9 + payload[8]));
      } else this.out.push(payload.slice());
    }
  }
}
