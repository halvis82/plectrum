// Words with their times, for songs whose lyrics aren't in LRCLIB: the video's own captions when it has
// them, otherwise transcribed from the audio in the browser. Stored with the song once found.

export type CaptionLine = { t: number; end: number; text: string };
export type Captions = { source: "youtube" | "transcribed"; lang?: string | null; lines: CaptionLine[] };

export function validCaptions(c: unknown): c is Captions {
  if (!c || typeof c !== "object") return false;
  const x = c as Captions;
  return (
    (x.source === "youtube" || x.source === "transcribed") &&
    Array.isArray(x.lines) &&
    x.lines.length <= 5000 &&
    x.lines.every((l) => l && typeof l.t === "number" && typeof l.end === "number" && l.end >= l.t && typeof l.text === "string" && l.text.length <= 500)
  );
}

/** WebVTT (YouTube's captions) to lines, with YouTube's rolling duplicates of auto captions removed. */
export function parseVtt(vtt: string): CaptionLine[] {
  const out: CaptionLine[] = [];
  const time = (s: string) => {
    const p = s.trim().split(":").map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  for (const block of vtt.replace(/\r/g, "").split("\n\n")) {
    const lines = block.split("\n");
    const ti = lines.findIndex((l) => l.includes("-->"));
    if (ti < 0) continue;
    const [a, b] = lines[ti].split("-->");
    let body = lines.slice(ti + 1);
    // auto captions mark the words new in this cue with inline times; the other line repeats the last cue
    if (body.some((l) => /<\d\d:\d\d/.test(l))) body = body.filter((l) => /<\d\d:\d\d/.test(l));
    const text = body
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    out.push({ t: time(a), end: time(b.split(" ").filter(Boolean)[0]), text });
  }
  // auto captions repeat the previous line as the next one builds up: keep only what's new
  const clean: CaptionLine[] = [];
  for (const l of out) {
    const prev = clean.at(-1);
    if (prev && l.text === prev.text) {
      prev.end = Math.max(prev.end, l.end);
      continue;
    }
    if (prev && l.text.startsWith(prev.text + " ")) {
      clean.push({ ...l, text: l.text.slice(prev.text.length + 1) });
      continue;
    }
    clean.push({ ...l });
  }
  return clean.filter((l) => l.end - l.t > 0.02);
}
