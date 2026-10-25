// Turns a stored analysis into what the chord sheet renders.

import type { Analysis } from "./analysis/analyze";
import { capoOptions, chordName, detectKey, labelFromIndex, parseLabel, simplify, spellingFor, transpose, type Chord, type Key, type Simplify } from "./music";

export type Bar = { index: number; beats: number[]; pickup: boolean };

export function buildBars(a: Analysis): Bar[] {
  const bars: Bar[] = [];
  const n = a.beats.length;
  const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from) }, (_, k) => from + k);
  if (a.downbeat > 0) bars.push({ index: 0, beats: range(0, a.downbeat), pickup: true });
  for (let i = a.downbeat; i < n; i += a.meter) bars.push({ index: bars.length, beats: range(i, Math.min(n, i + a.meter)), pickup: false });
  // drop empty no-chord bars at the very start and end
  const isEmpty = (b: Bar) => b.beats.every((i) => parseLabel(labelFromIndex(a.chords[i])) === null);
  while (bars.length && isEmpty(bars[0])) bars.shift();
  while (bars.length && isEmpty(bars[bars.length - 1])) bars.pop();
  // number full bars from 1 after trimming (a leading pickup keeps index 0)
  let num = 0;
  return bars.map((b) => ({ ...b, index: b.pickup ? 0 : ++num }));
}

export type View = { transpose: number; capo: number; simplify: Simplify };

/** The chord a player fingers for beat i: sounding chord transposed, then shifted down by the capo. */
export function makeShapeFn(a: Analysis, view: View, key: Key) {
  const spelling = spellingFor({ ...key, tonic: (key.tonic + view.transpose - view.capo + 120) % 12 });
  const cache = new Map<number, { chord: Chord; name: string }>();
  return (cls: number) => {
    let hit = cache.get(cls);
    if (!hit) {
      const chord = transpose(simplify(parseLabel(labelFromIndex(cls)), view.simplify), view.transpose - view.capo);
      hit = { chord, name: chordName(chord, spelling) };
      cache.set(cls, hit);
    }
    return hit;
  };
}

export function songStats(a: Analysis) {
  const items = a.chords.map((c, i) => ({
    chord: parseLabel(labelFromIndex(c)),
    dur: (a.beats[i + 1] ?? a.duration) - a.beats[i],
  }));
  const key = detectKey(items);
  return { key, capo: capoOptions(items), items };
}

/** Beat index playing at time t (binary search), -1 before the first beat. */
export function beatAt(beats: number[], t: number): number {
  let lo = 0, hi = beats.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (beats[mid] <= t) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Ordered unique chord shapes as they first appear. */
export function uniqueShapes(a: Analysis, shape: ReturnType<typeof makeShapeFn>) {
  const seen = new Map<string, Chord>();
  for (const c of a.chords) {
    const s = shape(c);
    if (s.chord && !seen.has(s.name)) seen.set(s.name, s.chord);
  }
  return [...seen.entries()].map(([name, chord]) => ({ name, chord: chord! }));
}

// ---- lyrics ----

export type LyricLine = { t: number; text: string };

export function parseLrc(lrc: string): LyricLine[] {
  const out: LyricLine[] = [];
  for (const line of lrc.split("\n")) {
    const tags = [...line.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = line.replace(/\[[^\]]*\]/g, "").trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  return out.sort((a, b) => a.t - b.t);
}

export type LyricPiece = { chord: string | null; text: string; beat: number };

/** Splits a lyric line into pieces, each starting where a chord changes inside the line. */
export function chordsOverLine(
  line: LyricLine,
  end: number,
  a: Analysis,
  names: (cls: number) => string,
  offset: number,
): LyricPiece[] {
  const start = line.t + offset, stop = end + offset;
  const first = Math.max(0, beatAt(a.beats, start));
  const changes: { t: number; name: string; beat: number }[] = [{ t: start, name: names(a.chords[first]), beat: first }];
  for (let i = first + 1; i < a.beats.length && a.beats[i] < stop; i++) {
    const n = names(a.chords[i]);
    if (n !== changes[changes.length - 1].name) changes.push({ t: a.beats[i], name: n, beat: i });
  }
  const text = line.text;
  const span = Math.max(0.5, stop - start);
  const pos: number[] = [];
  changes.forEach((c, k) => {
    let p = k === 0 ? 0 : Math.round(((c.t - start) / span) * text.length);
    // snap forward to a word start so chords sit over words, never mid-word
    while (p > 0 && p < text.length && text[p - 1] !== " ") p++;
    pos.push(Math.max(pos[k - 1] ?? 0, Math.min(text.length, p)));
  });
  return changes.map((c, k) => ({ chord: c.name, beat: c.beat, text: text.slice(pos[k], pos[k + 1] ?? text.length) }));
}
