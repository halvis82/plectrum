import "server-only";
import { Constants, Innertube, Platform, UniversalCache, type Types } from "youtubei.js";
import { poMinter } from "./potoken";
import { getSetting, setSetting } from "./settings";

// YouTube's player JS has to be evaluated to decipher stream URLs.
// The generated script already embeds its inputs, so it only needs running (as in the ytjs docs).
Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

// Present the TV client the way yt-dlp's "tv_samsung" client does (yt-dlp PR #17723): YouTube answers
// bare TVHTML5 requests with "The page needs to be reloaded" unless they carry real device info.
const TV_DEVICE = { deviceMake: "Samsung", deviceModel: "UKS9800", osName: "Tizen", osVersion: "2.4.0" };
const TV_UA = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1";
Object.assign(Constants.CLIENTS.TV, { VERSION: "5.20260707", USER_AGENT: TV_UA });

export const tvFetch: typeof fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
  if (/youtubei\/v1\//.test(url) && typeof body === "string" && body.includes('"TVHTML5"')) {
    const json = JSON.parse(body);
    Object.assign(json.context.client, TV_DEVICE, { userAgent: TV_UA });
    body = JSON.stringify(json);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set("user-agent", TV_UA);
    return fetch(input instanceof Request ? input.url : input, { ...init, method: init?.method ?? (input instanceof Request ? input.method : "POST"), headers, body });
  }
  return fetch(input, init);
};

export type AudioSource = { url: string; mime: string; bytes: number; client: string; expires: number; headers: Record<string, string> };

/** Netscape cookies.txt (as exported by browser extensions) -> Cookie header for youtube.com. */
export function cookieHeader(cookiesTxt: string): string {
  const pairs: string[] = [];
  for (const raw of cookiesTxt.split("\n")) {
    const line = raw.replace(/^#HttpOnly_/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 7 || !/youtube\.com$/.test(parts[0])) continue;
    pairs.push(`${parts[5]}=${parts[6]}`);
  }
  return pairs.join("; ");
}

function cookies(): string | undefined {
  const b64 = process.env.YT_COOKIES_B64;
  return b64 ? cookieHeader(Buffer.from(b64, "base64").toString("utf8")) : undefined;
}

type OAuthTokens = Parameters<Innertube["session"]["signIn"]>[0];

const CHROME_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

type Session = { yt: Innertube; mode: "cookies" | "oauth" | "anonymous"; binding: string | null };

/**
 * Signed in with cookies (YT_COOKIES_B64, yt-dlp's logged-in mode) or, failing that, device-flow
 * OAuth tokens from /api/admin/youtube-login. `binding` is what stream PO tokens are bound to:
 * the account's data sync id when signed in with cookies (as yt-dlp does), else visitor data.
 */
let client: Promise<Session> | null = null;
function yt() {
  client ??= (async (): Promise<Session> => {
    const cookie = cookies();
    const yt = await Innertube.create({ cookie, retrieve_player: true, cache: new UniversalCache(false), fetch: tvFetch });
    if (cookie) {
      const html = await fetch("https://www.youtube.com/", { headers: { cookie, "user-agent": CHROME_UA, "accept-language": "en" } }).then((r) => r.text());
      const dataSync = html.match(/"DATASYNC_ID":"([^"]+)"/)?.[1]?.split("||")[0] || null;
      return { yt, mode: "cookies", binding: dataSync || yt.session.context.client.visitorData || null };
    }
    const tokens = await getSetting<OAuthTokens>("yt_oauth");
    if (tokens) {
      // refreshed tokens are written back so the next cold start reuses them
      yt.session.on("update-credentials", ({ credentials }) => void (credentials && setSetting("yt_oauth", credentials)));
      await yt.session.signIn(tokens);
    }
    return { yt, mode: tokens ? "oauth" : "anonymous", binding: yt.session.context.client.visitorData ?? null };
  })().catch((e) => {
    client = null;
    throw e;
  });
  return client;
}

// stream URLs live ~6 h; cache per warm instance so playback doesn't re-resolve every request
const cache = new Map<string, AudioSource>();

/** Client order per session type, after yt-dlp's defaults (authed: web_embedded, tv_samsung, web). */
const CLIENT_ORDER: Record<Session["mode"], readonly ("WEB" | "MWEB" | "TV" | "WEB_EMBEDDED" | "IOS" | "ANDROID")[]> = {
  cookies: ["WEB_EMBEDDED", "TV", "WEB", "MWEB"],
  oauth: ["TV"],
  anonymous: ["TV", "WEB", "MWEB", "IOS", "ANDROID"],
};

export class YouTubeError extends Error {}

export async function audioSource(videoId: string, fresh = false): Promise<AudioSource> {
  const hit = fresh ? null : cache.get(videoId);
  if (hit && hit.expires > Date.now() + 10 * 60_000) return hit;
  const problems: string[] = [];
  const src = (await fromYouTube(videoId, problems).catch((e) => (problems.push(`session: ${e instanceof Error ? e.message : e}`), null))) ?? (await fromInvidious(videoId, problems));
  if (!src) throw new YouTubeError(problems.join(" | "));
  cache.set(videoId, src);
  return src;
}

async function fromYouTube(videoId: string, problems: string[]): Promise<AudioSource | null> {
  const { yt: innertube, mode, binding } = await yt();
  for (const name of CLIENT_ORDER[mode]) {
    try {
      const info = await innertube.getBasicInfo(videoId, { client: name });
      const status = info.playability_status;
      if (status?.status !== "OK") {
        problems.push(`${name}: ${status?.reason ?? status?.status}`);
        continue;
      }
      const formats = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video);
      // AAC in MP4 decodes everywhere (Safari included); fall back to Opus
      const format = formats.find((f) => f.mime_type.startsWith("audio/mp4")) ?? formats[0];
      if (!format) {
        problems.push(`${name}: no audio formats`);
        continue;
      }
      const base = format.url ?? (await format.decipher(innertube.session.player));
      // the stream server expects the same client identity that requested the player
      const headers: Record<string, string> = name === "TV" ? { "user-agent": TV_UA } : { "user-agent": CHROME_UA, origin: "https://www.youtube.com", referer: "https://www.youtube.com/" };
      // try the plain URL, then with a BotGuard PO token bound to the session (yt-dlp's GVS token)
      const candidates = [base];
      if (binding) {
        const pot = await (await poMinter()).mintAsWebsafeString(binding).catch(() => null);
        if (pot) candidates.push(`${base}&pot=${encodeURIComponent(pot)}`);
      }
      let url: string | null = null;
      for (const c of candidates) {
        const probe = await fetch(c, { headers: { ...headers, range: "bytes=0-1023" } });
        await probe.arrayBuffer().catch(() => {});
        if (probe.ok) {
          url = c;
          break;
        }
        problems.push(`${name}${c === base ? "" : "+pot"}: stream HTTP ${probe.status}`);
      }
      if (!url) continue;
      const expires = Number(new URL(url).searchParams.get("expire") ?? 0) * 1000 || Date.now() + 3 * 3600_000;
      return { url, mime: format.mime_type.split(";")[0], bytes: Number(format.content_length ?? 0), client: name, expires, headers };
    } catch (e) {
      problems.push(`[${mode}] ${name}: ${e instanceof Error ? e.message.slice(0, 120) : e}`);
    }
  }
  return null;
}

// ---- Invidious: public YouTube front ends that fetch the stream from their own servers (local=true) ----

const INVIDIOUS_FALLBACK = ["yt.chocolatemoo53.com"];
let invidiousList: { hosts: string[]; at: number } | null = null;

/** Instances with their API enabled, healthiest first, from the public directory (cached for an hour). */
export async function invidiousHosts(): Promise<string[]> {
  if (invidiousList && Date.now() - invidiousList.at < 3600_000) return invidiousList.hosts;
  let hosts = INVIDIOUS_FALLBACK;
  try {
    const list = (await fetch("https://api.invidious.io/instances.json?sort_by=health", { signal: AbortSignal.timeout(5000) }).then((r) => r.json())) as [string, { type: string; api: boolean | null }][];
    const live = list.filter(([, i]) => i.type === "https" && i.api).map(([h]) => h);
    hosts = [...new Set([...live, ...INVIDIOUS_FALLBACK])];
  } catch {}
  invidiousList = { hosts, at: Date.now() };
  return hosts;
}

type InvidiousFormat = { itag: string; type: string; url: string; clen?: string };

async function fromInvidious(videoId: string, problems: string[]): Promise<AudioSource | null> {
  for (const host of (await invidiousHosts()).slice(0, 5)) {
    try {
      const r = await fetch(`https://${host}/api/v1/videos/${videoId}?local=true&fields=adaptiveFormats`, { signal: AbortSignal.timeout(15_000) });
      if (!r.ok) {
        problems.push(`invidious ${host}: HTTP ${r.status}`);
        continue;
      }
      const formats = ((await r.json()).adaptiveFormats ?? []) as InvidiousFormat[];
      // AAC first (decodes everywhere), then Opus
      const f = ["140", "139", "251", "250", "249"].map((i) => formats.find((x) => x.itag === i)).find(Boolean);
      if (!f) {
        problems.push(`invidious ${host}: no audio`);
        continue;
      }
      // the proxy redirects to a media host; keep the final URL so ranged reads skip the redirect.
      // Read from the middle: a media host YouTube has blocked still serves the start from its cache
      const mid = Math.floor((Number(f.clen) || 0) / 2);
      const probe = await fetch(new URL(f.url, `https://${host}`), { headers: { range: `bytes=${mid}-${mid + 1023}` }, signal: AbortSignal.timeout(15_000) });
      await probe.arrayBuffer().catch(() => {});
      if (!probe.ok) {
        problems.push(`invidious ${host}: stream HTTP ${probe.status}`);
        continue;
      }
      const bytes = Number(f.clen) || Number(probe.headers.get("content-range")?.split("/")[1]) || 0;
      return { url: probe.url, mime: f.type.split(";")[0], bytes, client: `invidious:${host}`, expires: Date.now() + 3 * 3600_000, headers: {} };
    } catch (e) {
      problems.push(`invidious ${host}: ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
  }
  return null;
}

/** Streams the audio, fetching from YouTube in ranged chunks (whole-file requests get throttled).
 * The first chunk is fetched before this resolves, so a stream URL that stopped working (they can
 * expire early, mirrors especially) throws here instead of failing the response midway. */
export async function openAudio(src: AudioSource, from = 0, to = src.bytes - 1): Promise<ReadableStream<Uint8Array>> {
  const reader = streamAudio(src, from, to).getReader();
  const first = await reader.read();
  return new ReadableStream({
    start(controller) {
      if (first.done) controller.close();
      else controller.enqueue(first.value);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

function streamAudio(src: AudioSource, from: number, to: number): ReadableStream<Uint8Array> {
  const CHUNK = 4 * 1024 * 1024;
  let pos = from;
  return new ReadableStream({
    async pull(controller) {
      if (pos > to) return controller.close();
      const end = Math.min(to, pos + CHUNK - 1);
      const res = await fetch(src.url, { headers: { ...src.headers, range: `bytes=${pos}-${end}` } });
      if (!res.ok || !res.body) return controller.error(new Error(`YouTube HTTP ${res.status}`));
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        controller.enqueue(value);
      }
      pos = end + 1;
    },
  });
}

/** The video's caption track as WebVTT (hand-written ones first), from YouTube itself. Caption
 * requests may need a PO token like streams do (yt-dlp's "subs" token, bound to the video). */
export async function youtubeCaptionsVtt(videoId: string): Promise<{ vtt: string; lang: string | null } | null> {
  const { yt: innertube, binding } = await yt();
  for (const name of ["WEB", "MWEB", "TV"] as const) {
    let tracks: { base_url: string; language_code: string; kind?: string }[] = [];
    try {
      const info = await innertube.getBasicInfo(videoId, { client: name });
      tracks = (info.captions?.caption_tracks ?? []) as typeof tracks;
    } catch {
      continue;
    }
    if (!tracks.length) continue;
    const track = tracks.find((t) => t.kind !== "asr") ?? tracks[0];
    const base = `${track.base_url}&fmt=vtt`;
    const candidates = [base];
    const minter = await poMinter().catch(() => null);
    for (const b of [videoId, binding]) {
      const pot = b && minter ? await minter.mintAsWebsafeString(b).catch(() => null) : null;
      if (pot) candidates.push(`${base}&pot=${encodeURIComponent(pot)}&c=${name}`);
    }
    for (const url of candidates) {
      const r = await fetch(url, { headers: { "user-agent": CHROME_UA, referer: "https://www.youtube.com/" } }).catch(() => null);
      const text = r?.ok ? await r.text() : "";
      if (text.includes("-->")) return { vtt: text, lang: track.language_code ?? null };
    }
  }
  return null;
}
