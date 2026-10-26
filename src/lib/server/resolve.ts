import "server-only";
import { Innertube } from "youtubei.js";
import { invidiousHosts } from "./youtube-audio";

export type Resolved = {
  /** youtube and the music services (no downloadable audio of their own) are fetched through YouTube;
   * "web" links are fetched by /api/media */
  kind: "youtube" | "spotify" | "apple" | "deezer" | "web";
  videoId: string | null;
  title: string;
  artist: string | null;
  sourceUrl: string;
  /** other uploads of the same song, tried in order when a video refuses to embed (e.g. Vevo) */
  alternatives: string[];
  /** seconds, when the link says; used to pick a matching copy elsewhere */
  duration: number | null;
};

export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "");
    if (host === "youtu.be") return u.pathname.slice(1, 12) || null;
    if (host === "youtube.com" || host === "youtube-nocookie.com") {
      const v = u.searchParams.get("v");
      if (v) return v.slice(0, 11);
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch {}
  return null;
}

/** "Oasis - Wonderwall (Official Video) [4K]" -> { artist: "Oasis", title: "Wonderwall" } */
export function splitTitle(raw: string, channel?: string): { title: string; artist: string | null } {
  const clean = raw
    .replace(/\s*[([](official|lyric|lyrics|audio|video|music video|hd|hq|4k|remaster|visualizer|live)[^)\]]*[)\]]/gi, "")
    .replace(/\s*\|.*$/, "")
    .trim();
  const m = clean.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  const ch = channel?.replace(/(VEVO|\s*-\s*Topic|Official)$/i, "").trim();
  return { title: clean || raw, artist: ch || null };
}

async function youtubeMeta(id: string) {
  const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`);
  if (!r.ok) throw new Error("That YouTube video could not be found (or it does not allow embedding).");
  return (await r.json()) as { title: string; author_name: string };
}

const decode = (s: string) =>
  s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function spotifyMeta(url: string): Promise<Meta> {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; ChordCatch/1.0)" } });
  if (!r.ok) throw new Error("Could not read that Spotify link.");
  const html = await r.text();
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const desc = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
  if (!title) throw new Error("Could not read that Spotify link.");
  const duration = Number(html.match(/<meta name="music:duration" content="(\d+)"/)?.[1]) || null;
  // og:description looks like "Oasis · (What's The Story) Morning Glory? · Song · 1995"
  return { title: decode(title), artist: desc ? decode(desc.split(" · ")[0]) : null, duration };
}

export type Meta = { title: string; artist: string | null; duration: number | null };

/** music.apple.com/.../album/name/123?i=456 or /song/name/456 */
async function appleMeta(u: URL): Promise<Meta> {
  const id = u.searchParams.get("i") ?? u.pathname.match(/\/song\/[^/]+\/(\d+)/)?.[1];
  if (!id) throw new Error("That Apple Music link is not a single song. Open the song and use Share > Copy Link.");
  const r = await fetch(`https://itunes.apple.com/lookup?id=${id}`).then((r) => r.json());
  const t = r.results?.[0];
  if (!t?.trackName) throw new Error("Could not read that Apple Music link.");
  return { title: t.trackName, artist: t.artistName ?? null, duration: t.trackTimeMillis ? t.trackTimeMillis / 1000 : null };
}

/** deezer.com/track/123, or a link.deezer.com / deezer.page.link short link */
async function deezerMeta(u: URL): Promise<Meta> {
  let path = u.pathname;
  if (!/\/track\/\d+/.test(path)) path = new URL((await fetch(u, { redirect: "follow" })).url).pathname;
  const id = path.match(/\/track\/(\d+)/)?.[1];
  if (!id) throw new Error("That Deezer link is not a single song.");
  const t = await fetch(`https://api.deezer.com/track/${id}`).then((r) => r.json());
  if (!t?.title) throw new Error("Could not read that Deezer link.");
  return { title: t.title, artist: t.artist?.name ?? null, duration: t.duration || null };
}

/** Video length, for matching a copy of the song elsewhere when YouTube won't hand it over. */
async function youtubeDuration(id: string): Promise<number | null> {
  try {
    const info = await Promise.race([(await yt()).getBasicInfo(id), new Promise<never>((_, no) => setTimeout(() => no(new Error("timeout")), 5000))]);
    return info.basic_info.duration || null;
  } catch {
    return null;
  }
}

// one client per warm function instance; creating it costs a round trip to YouTube
let client: Promise<Innertube> | null = null;
const yt = () => (client ??= Innertube.create({ retrieve_player: false }).catch((e) => ((client = null), Promise.reject(e))));

export async function searchVideos(query: string): Promise<string[]> {
  try {
    const res = await (await yt()).search(query, { type: "video" });
    const ids = res.videos.flatMap((v) => ("id" in v && typeof v.id === "string" ? [v.id] : [])).slice(0, 8);
    if (ids.length) return ids;
  } catch {}
  // YouTube refused the search: ask an Invidious instance instead
  for (const host of (await invidiousHosts()).slice(0, 3)) {
    try {
      const r = await fetch(`https://${host}/api/v1/search?type=video&q=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(8000) });
      const ids = r.ok ? ((await r.json()) as { videoId?: string }[]).flatMap((v) => (v.videoId ? [v.videoId] : [])).slice(0, 8) : [];
      if (ids.length) return ids;
    } catch {}
  }
  return [];
}

/** Alternatives (other uploads of the same song) are only searched when asked for: the client
 * asks when the first video refuses to embed, which keeps the common case fast. */
export async function resolveLink(input: string, withAlternatives = false): Promise<Resolved> {
  const id = youtubeId(input);
  if (id) {
    const meta = await youtubeMeta(id);
    const { title, artist } = splitTitle(meta.title, meta.author_name);
    const [alternatives, duration] = withAlternatives
      ? await Promise.all([searchVideos(`${artist ?? ""} ${title}`.trim()).then((v) => v.filter((x) => x !== id)), youtubeDuration(id)])
      : [[], null];
    return { kind: "youtube", videoId: id, title, artist, sourceUrl: `https://www.youtube.com/watch?v=${id}`, alternatives, duration };
  }
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Paste a link to a song.");
  }
  let kind: Resolved["kind"];
  let sourceUrl = u.toString();
  let meta: Meta;
  if (u.hostname.endsWith("spotify.com") || u.hostname === "spotify.link") {
    const m = u.pathname.match(/\/track\/([A-Za-z0-9]+)/);
    if (!m && u.hostname !== "spotify.link") throw new Error("That Spotify link is not a single song. Open the song and use Share > Copy link.");
    if (m) sourceUrl = `https://open.spotify.com/track/${m[1]}`;
    kind = "spotify";
    meta = await spotifyMeta(sourceUrl);
  } else if (u.hostname === "music.apple.com" || u.hostname === "itunes.apple.com") {
    kind = "apple";
    meta = await appleMeta(u);
  } else if (/(^|\.)deezer\.(com|page\.link)$/.test(u.hostname)) {
    kind = "deezer";
    meta = await deezerMeta(u);
  } else {
    // anything else is downloaded directly by /api/media
    return { kind: "web", videoId: null, title: "", artist: null, sourceUrl, alternatives: [], duration: null };
  }
  return findSong(meta, sourceUrl, kind);
}

/** A song known only by name (music services, copy-protected pages): its uploads on YouTube. */
export async function findSong({ title, artist, duration }: Meta, sourceUrl: string, kind: Resolved["kind"] = "web"): Promise<Resolved> {
  const [first, ...alternatives] = await searchVideos(`${artist ?? ""} ${title} audio`.trim());
  return { kind, videoId: first ?? null, title, artist, sourceUrl, alternatives, duration };
}
