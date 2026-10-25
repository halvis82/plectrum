// Synced lyrics from LRCLIB (free, no key). Matched by artist/title, closest duration wins.
type LrcHit = { trackName: string; artistName: string; duration: number; syncedLyrics: string | null; plainLyrics: string | null };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const title = sp.get("title")?.trim();
  const artist = sp.get("artist")?.trim() ?? "";
  const duration = Number(sp.get("duration")) || 0;
  if (!title) return Response.json({ lyrics: null });
  const headers = { "user-agent": "ChordCatch (https://github.com/halvis82/chordcatch)" };
  const r = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`, { headers });
  let hits: LrcHit[] = r.ok ? await r.json() : [];
  if (hits.length === 0) {
    const r2 = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ q: `${artist} ${title}`.trim() })}`, { headers });
    hits = r2.ok ? await r2.json() : [];
  }
  hits = hits.filter((h) => h.syncedLyrics || h.plainLyrics);
  if (duration) hits.sort((a, b) => Math.abs(a.duration - duration) - Math.abs(b.duration - duration));
  hits.sort((a, b) => Number(!!b.syncedLyrics) - Number(!!a.syncedLyrics));
  const best = hits.find((h) => !duration || Math.abs(h.duration - duration) < 20) ?? null;
  return Response.json(
    { lyrics: best ? { synced: best.syncedLyrics, plain: best.plainLyrics, track: best.trackName, artist: best.artistName } : null },
    { headers: { "cache-control": "public, s-maxage=86400" } },
  );
}
