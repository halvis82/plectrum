// A song's hand edits, kept apart from what the models heard so they can always be undone back to it.
// Once the tab is edited it is stored as written (string and fret per note) and no longer refingered.

import type { Analysis } from "./analysis/analyze";

/** technique leading into a note: none, hammer-on, pull-off, slide, bend */
export const TECHNIQUES = ["", "h", "p", "/", "b"] as const;
export type Technique = 0 | 1 | 2 | 3 | 4;

/** [start s, length s, string (0 = low E), fret, technique] */
export type EditNote = [number, number, number, number, Technique];

/** A song started from scratch has no audio: its beats come from a tempo grid. */
export type Grid = { bpm: number; meter: 3 | 4; bars: number };

export type Edits = {
  v: 1;
  /** the tab as written; absent until the tab is first edited */
  tab?: EditNote[];
  /** open-string pitches the tab is written for, low first */
  tuning?: number[];
  /** parts of the song left out (talking in a lesson, say): [from, to] seconds */
  cuts?: [number, number][];
  /** chord changes by hand: [beat index, chord class] */
  chords?: [number, number][];
  grid?: Grid;
};

export const MAX_FRET = 24;
export const NO_CHORD = 169;

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);

export function validEdits(e: unknown): e is Edits {
  if (!e || typeof e !== "object") return false;
  const x = e as Edits;
  if (x.v !== 1) return false;
  if (x.tab !== undefined)
    if (
      !Array.isArray(x.tab) ||
      x.tab.length > 40000 ||
      !x.tab.every(
        (n) =>
          Array.isArray(n) && n.length === 5 && n.every(num) && n[0] >= 0 && n[0] < 3600 && n[1] > 0 && n[1] <= 60 &&
          Number.isInteger(n[2]) && n[2] >= 0 && n[2] < 8 && Number.isInteger(n[3]) && n[3] >= 0 && n[3] <= MAX_FRET && Number.isInteger(n[4]) && n[4] >= 0 && n[4] < TECHNIQUES.length,
      )
    )
      return false;
  if (x.tuning !== undefined && !(Array.isArray(x.tuning) && x.tuning.length >= 4 && x.tuning.length <= 8 && x.tuning.every((m) => Number.isInteger(m) && m >= 20 && m <= 80))) return false;
  if (x.cuts !== undefined && !(Array.isArray(x.cuts) && x.cuts.length <= 200 && x.cuts.every((c) => Array.isArray(c) && c.length === 2 && c.every(num) && c[0] >= 0 && c[1] > c[0]))) return false;
  if (x.chords !== undefined && !(Array.isArray(x.chords) && x.chords.length <= 20000 && x.chords.every((c) => Array.isArray(c) && c.length === 2 && Number.isInteger(c[0]) && c[0] >= 0 && Number.isInteger(c[1]) && c[1] >= 0 && c[1] < 170))) return false;
  if (x.grid !== undefined) {
    const g = x.grid;
    if (!g || !num(g.bpm) || g.bpm < 20 || g.bpm > 300 || (g.meter !== 3 && g.meter !== 4) || !Number.isInteger(g.bars) || g.bars < 1 || g.bars > 1000) return false;
  }
  return true;
}

/** Beats of a tempo grid, starting at 0. */
export function gridBeats(g: Grid): number[] {
  const step = 60 / g.bpm;
  return Array.from({ length: g.bars * g.meter }, (_, i) => +(i * step).toFixed(4));
}

/** The analysis with the hand edits laid over it: the tempo grid (songs from scratch) and chords. */
export function applyEdits(a: Analysis, e: Edits | null): Analysis {
  if (!e) return a;
  let out = a;
  if (e.grid) {
    const beats = gridBeats(e.grid);
    out = {
      ...out,
      beats,
      chords: beats.map((_, i) => out.chords[i] ?? NO_CHORD),
      bpm: e.grid.bpm,
      meter: e.grid.meter,
      downbeat: 0,
      duration: beats.length * (60 / e.grid.bpm),
      segments: [],
    };
  }
  if (e.chords?.length) {
    const chords = [...out.chords];
    for (const [i, c] of e.chords) if (i < chords.length) chords[i] = c;
    out = { ...out, chords };
  }
  return out;
}

/** Sets beats from..to (inclusive) to a chord, merging with earlier hand changes. */
export function setChords(e: Edits, from: number, to: number, cls: number): Edits {
  const map = new Map(e.chords ?? []);
  for (let i = from; i <= to; i++) map.set(i, cls);
  return { ...e, chords: [...map.entries()].sort((x, y) => x[0] - y[0]) };
}

/** Adds a cut, merging any it overlaps. */
export function addCut(cuts: [number, number][] = [], from: number, to: number): [number, number][] {
  const all = [...cuts, [Math.min(from, to), Math.max(from, to)] as [number, number]].sort((x, y) => x[0] - y[0]);
  const out: [number, number][] = [];
  for (const c of all) {
    const last = out.at(-1);
    if (last && c[0] <= last[1] + 0.01) last[1] = Math.max(last[1], c[1]);
    else out.push([c[0], c[1]]);
  }
  return out.map(([x, y]) => [+x.toFixed(3), +y.toFixed(3)]);
}

/** The cut a time falls in, if any. */
export const cutAt = (cuts: [number, number][] | undefined, t: number) => cuts?.find(([a, b]) => t >= a && t < b) ?? null;

/** Seconds of song left after the cuts. */
export const keptLength = (duration: number, cuts: [number, number][] = []) => duration - cuts.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, duration) - a), 0);
