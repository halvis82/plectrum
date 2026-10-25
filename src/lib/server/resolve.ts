import "server-only";
import { Innertube } from "youtubei.js";

export type Resolved = {
  kind: "youtube" | "spotify";
  videoId: string;
  title: string;
  artist: string | null;
  sourceUrl: string;
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

async function spotifyMeta(url: string) {
  const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; ChordCatch/1.0)" } });
  if (!r.ok) throw new Error("Could not read that Spotify link.");
  const html = await r.text();
  const title = html.match(/<meta property="og:title" content="([^"]*)"/)?.[1];
  const desc = html.match(/<meta property="og:description" content="([^"]*)"/)?.[1];
  if (!title) throw new Error("Could not read that Spotify link.");
  // og:description looks like "Oasis · (What's The Story) Morning Glory? · Song · 1995"
  return { title: decode(title), artist: desc ? decode(desc.split(" · ")[0]) : null };
}

export async function resolveLink(input: string): Promise<Resolved> {
  const id = youtubeId(input);
  if (id) {
    const meta = await youtubeMeta(id);
    const { title, artist } = splitTitle(meta.title, meta.author_name);
    return { kind: "youtube", videoId: id, title, artist, sourceUrl: `https://www.youtube.com/watch?v=${id}` };
  }
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error("Paste a YouTube or Spotify link.");
  }
  if (u.hostname.endsWith("spotify.com") || u.hostname === "spotify.link") {
    const m = u.pathname.match(/\/track\/([A-Za-z0-9]+)/);
    if (!m && u.hostname !== "spotify.link") throw new Error("That Spotify link is not a single song. Open the song and use Share > Copy link.");
    const url = m ? `https://open.spotify.com/track/${m[1]}` : u.toString();
    const { title, artist } = await spotifyMeta(url);
    const yt = await Innertube.create({ retrieve_player: false });
    const res = await yt.search(`${artist ?? ""} ${title} audio`.trim(), { type: "video" });
    const hit = res.videos.find((v) => "id" in v && typeof v.id === "string") as { id: string } | undefined;
    if (!hit) throw new Error(`Couldn't find "${title}" on YouTube.`);
    return { kind: "spotify", videoId: hit.id, title, artist, sourceUrl: url };
  }
  throw new Error("Only YouTube and Spotify links are supported. For anything else, upload the file or record it.");
}
