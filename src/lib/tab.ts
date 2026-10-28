// Tablature: picks a string and fret for every transcribed note. Notes that start together form an
// event; each event gets a fingering, and a Viterbi pass picks the sequence of fingerings that keeps
// the hand compact, low on the neck, and moving as little as possible.

import type { Note } from "./analysis/notes";
import shapes from "./chord-shapes.json";

/** Open-string MIDI pitches, low E first (string 0 = low E, as in GuitarSet). */
export const STANDARD = [40, 45, 50, 55, 59, 64];
export const STRING_NAMES = ["E", "A", "D", "G", "B", "e"];

/** Common tunings, low string first. `shift` is how far chord shapes sit from the sounding chords. */
export const TUNINGS = [
  { id: "standard", name: "Standard", strings: STANDARD, shift: 0 },
  { id: "half-down", name: "Half step down", strings: STANDARD.map((m) => m - 1), shift: -1 },
  { id: "drop-d", name: "Drop D", strings: [38, 45, 50, 55, 59, 64], shift: 0 },
  { id: "whole-down", name: "Whole step down", strings: STANDARD.map((m) => m - 2), shift: -2 },
  { id: "drop-c", name: "Drop C", strings: [36, 43, 48, 53, 57, 62], shift: -2 },
] as const;
export type TuningId = (typeof TUNINGS)[number]["id"];

const NOTE_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/** Letter for each string, low first; the top string is lowercase as tab convention has it. */
export const stringNames = (tuning: readonly number[]) => tuning.map((m, i) => (i === tuning.length - 1 ? NOTE_NAMES[m % 12].toLowerCase() : NOTE_NAMES[m % 12]));

/** `strings`: the string model's probability for each string (low E first), when it ran */
export type TabInput = Note & { strings?: ArrayLike<number> };
export type TabNote = TabInput & { string: number; fret: number };

export type TabOptions = {
  maxFret: number;
  /** notes starting within this many seconds of an event's first note join it */
  chordWindow: number;
  /** cost per fret of stretch, and per fret of stretch beyond 3 (squared) */
  span: number;
  stretch: number;
  /** cost per fret of mean hand height */
  height: number;
  /** cost per fret above 12 */
  high: number;
  /** cost per fret the hand (a 4-fret window) shifts, plus a flat cost per shift; both relax with the
   * time between events (s) */
  move: number;
  shift: number;
  moveRelax: number;
  /** cost of cutting off a note still ringing on the same string */
  cut: number;
  /** cost per fretted note (open strings are free) */
  fretted: number;
  /** bonus when an event's frets fit a common chord shape, and when they do together with the notes still ringing */
  shape: number;
  shapeLink: number;
  /** weight of the string model's opinion: cost -audio * log p(string) per note */
  audio: number;
  /** candidate fingerings kept per event */
  beam: number;
};

/** Fitted on the app's own detected notes from Guitar-TECHS players 1-2 and GuitarSet players 00-02,
 * each scored with a string model that never heard those players (scripts/eval/tab-fit.mts). */
export const DEFAULT_TAB: TabOptions = {
  maxFret: 20,
  chordWindow: 0.05,
  span: 0.746,
  stretch: 5.32,
  height: 0.002,
  high: 0.042,
  move: 1.536,
  shift: 2.453,
  moveRelax: 1.829,
  cut: 9.126,
  fretted: 0.021,
  shape: 0.307,
  shapeLink: 0.75,
  audio: 1,
  beam: 64,
};

/** Every partial fingering (string -> fret, 6 chars, "x" = unused) found inside a chords-db shape. */
const SHAPE_KEYS = (() => {
  const keys = new Set<string>();
  for (const list of Object.values(shapes as Record<string, { f: number[]; b: number }[]>))
    for (const { f, b } of list) {
      const abs = f.map((x) => (x > 0 ? x + b - 1 : x));
      const played = abs.flatMap((x, s) => (x >= 0 ? [s] : []));
      for (let m = 1; m < 1 << played.length; m++) {
        if ((m & (m - 1)) === 0) continue; // single notes say nothing about shape
        const key = ["x", "x", "x", "x", "x", "x"];
        played.forEach((s, i) => m & (1 << i) && (key[s] = String.fromCharCode(97 + abs[s])));
        keys.add(key.join(""));
      }
    }
  return keys;
})();

function shapeKey(strings: number[], frets: number[]): string | null {
  if (strings.length < 2) return null;
  const key = ["x", "x", "x", "x", "x", "x"];
  strings.forEach((s, i) => (key[s] = String.fromCharCode(97 + frets[i])));
  return key.join("");
}

const inShape = (strings: number[], frets: number[]) => {
  const k = shapeKey(strings, frets);
  return k !== null && SHAPE_KEYS.has(k);
};

/** lo/hi: lowest and highest fretted fret (null when every string is open) */
type Fingering = { strings: number[]; frets: number[]; lo: number | null; hi: number | null; cost: number };

function fingerings(notes: TabInput[], tuning: readonly number[], o: TabOptions): Fingering[] {
  const midis = notes.map((n) => n.midi);
  const out: Fingering[] = [];
  const strings: number[] = [];
  const frets: number[] = [];
  const used = new Set<number>();
  const rec = (i: number) => {
    if (i === midis.length) {
      const fretted = frets.filter((f) => f > 0);
      const lo = Math.min(...fretted);
      const hi = Math.max(...fretted);
      const span = fretted.length > 1 ? hi - lo : 0;
      const center = fretted.length ? fretted.reduce((a, b) => a + b, 0) / fretted.length : null;
      const cost =
        o.span * span +
        o.stretch * Math.max(0, span - 3) ** 2 +
        o.height * (center ?? 0) +
        o.high * fretted.reduce((a, f) => a + Math.max(0, f - 12), 0) +
        o.fretted * fretted.length -
        (inShape(strings, frets) ? o.shape : 0) -
        o.audio * strings.reduce((a, st, i) => a + (notes[i].strings ? Math.log(Math.max(1e-3, notes[i].strings![st])) : 0), 0);
      out.push({ strings: [...strings], frets: [...frets], lo: fretted.length ? lo : null, hi: fretted.length ? hi : null, cost });
      return;
    }
    for (let s = 0; s < tuning.length; s++) {
      const f = midis[i] - tuning[s];
      if (f < 0 || f > o.maxFret || used.has(s)) continue;
      // fretted notes of one event must fit under one hand
      if (f > 0 && frets.some((g) => g > 0 && Math.abs(g - f) > 5)) continue;
      used.add(s);
      strings.push(s);
      frets.push(f);
      rec(i + 1);
      used.delete(s);
      strings.pop();
      frets.pop();
    }
  };
  rec(0);
  return out.sort((a, b) => a.cost - b.cost).slice(0, o.beam);
}

/** Groups notes into events (chords / single notes) that are fingered together. */
function events(notes: TabInput[], window: number): TabInput[][] {
  const out: TabInput[][] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && n.start - last[0].start <= window && !last.some((m) => m.midi === n.midi)) last.push(n);
    else out.push([n]);
  }
  return out;
}

export function toTab(notes: TabInput[], tuning: readonly number[] = STANDARD, o: TabOptions = DEFAULT_TAB): TabNote[] {
  return scoredTab(notes, tuning, o).tab;
}

/**
 * The tuning a recording needs. Pitches alone can't tell a song played half a step down from the same
 * song in another key, so only notes below standard tuning's low E count as evidence: when enough of
 * them are heard, the cheapest of the lowered tunings that can play them wins. Otherwise standard.
 */
export function detectTuning(notes: TabInput[], o: TabOptions = DEFAULT_TAB): TuningId {
  const strength = notes.reduce((a, n) => a + n.amp, 0) || 1;
  const low = notes.filter((n) => n.midi < STANDARD[0] && n.midi >= 36);
  const lowStrength = low.reduce((a, n) => a + n.amp, 0);
  if (low.length < LOW_NOTES_MIN || lowStrength / strength < LOW_SHARE_MIN) return "standard";
  // notes below any guitar tuning mean a bass is playing, and its notes explain the low ones too
  const bass = notes.filter((n) => n.midi < 36).reduce((a, n) => a + n.amp, 0);
  if (bass > BASS_SHARE_MAX * lowStrength) return "standard";
  // the tunings are compared where they differ: the passages around the low notes (elsewhere a mix's
  // other instruments decide the cost)
  const near = notes.filter((n) => low.some((l) => Math.abs(n.start - l.start) < LOW_CONTEXT));
  let best: TuningId = "standard";
  let bestCost = Infinity;
  for (const t of TUNINGS) {
    // a tuning has to reach nearly all of the low notes (a few stray ones don't decide it)
    const reached = low.filter((n) => n.midi >= t.strings[0]).reduce((a, n) => a + n.amp, 0);
    if (reached < LOW_REACH_MIN * lowStrength) continue;
    const { cost, kept } = scoredTab(near, t.strings, o);
    const c = cost / Math.max(1, kept);
    if (c < bestCost) {
      bestCost = c;
      best = t.id;
    }
  }
  return best;
}

/** Evidence needed for a lowered tuning: at least this many notes below low E, carrying this share of
 * the strength. Standard-tuned GuitarSet takes and band mixes (with a bass) stay under 3%. */
const LOW_NOTES_MIN = 6;
const LOW_SHARE_MIN = 0.03;
const BASS_SHARE_MAX = 0.25;
const LOW_REACH_MIN = 0.9;
/** seconds around each low note that the tunings are compared on */
const LOW_CONTEXT = 2;

function scoredTab(notes: TabInput[], tuning: readonly number[], o: TabOptions): { tab: TabNote[]; cost: number; kept: number } {
  const lowest = tuning[0];
  const highest = tuning[tuning.length - 1] + o.maxFret;
  const playable = notes.filter((n) => n.midi >= lowest && n.midi <= highest).sort((a, b) => a.start - b.start);
  const evs: { notes: TabInput[]; options: Fingering[] }[] = [];
  for (let ev of events(playable, o.chordWindow)) {
    // more notes than strings, or no way to finger them all: drop the quietest until it fits
    ev = [...ev].sort((a, b) => b.amp - a.amp).slice(0, tuning.length);
    let options = fingerings(ev, tuning, o);
    while (!options.length && ev.length > 1) {
      ev = ev.slice(0, -1);
      options = fingerings(ev, tuning, o);
    }
    if (options.length) evs.push({ notes: ev, options });
  }
  if (!evs.length) return { tab: [], cost: 0, kept: 0 };

  // Viterbi over events
  let score = evs[0].options.map((f) => f.cost);
  const back: Int32Array[] = [];
  // where the hand (index finger) is after each candidate; it covers frets hand..hand+3
  const place = (hand: number | null, f: Fingering) =>
    f.lo === null || f.hi === null ? hand : hand === null || f.hi - 3 > f.lo ? f.lo : Math.min(f.lo, Math.max(f.hi - 3, hand));
  let hand = evs[0].options.map((f) => place(null, f));
  for (let e = 1; e < evs.length; e++) {
    const prev = evs[e - 1];
    const cur = evs[e];
    const gap = Math.max(0, cur.notes[0].start - prev.notes[0].start);
    const relax = 1 / (1 + gap / o.moveRelax);
    const nextScore: number[] = [];
    const nextHand: (number | null)[] = [];
    const bp = new Int32Array(cur.options.length);
    for (const [j, f] of cur.options.entries()) {
      let best = Infinity;
      let arg = 0;
      for (const [i, g] of prev.options.entries()) {
        let c = score[i];
        const from = hand[i];
        const to = place(from, f);
        if (from !== null && to !== null && to !== from) c += relax * (o.move * Math.abs(to - from) + o.shift);
        // reusing a string whose note is still ringing cuts it short; the ones left ringing should
        // make a chord shape together with the new notes
        const ss = [...f.strings];
        const ff = [...f.frets];
        for (const [k, s] of g.strings.entries()) {
          if (prev.notes[k].end <= cur.notes[0].start + 0.05) continue;
          if (f.strings.includes(s)) c += o.cut;
          else {
            ss.push(s);
            ff.push(g.frets[k]);
          }
        }
        if (ss.length > f.strings.length && inShape(ss, ff)) c -= o.shapeLink;
        if (c < best) {
          best = c;
          arg = i;
        }
      }
      nextScore.push(best + f.cost);
      nextHand.push(place(hand[arg], f));
      bp[j] = arg;
    }
    score = nextScore;
    hand = nextHand;
    back.push(bp);
  }
  const cost = Math.min(...score);
  let j = score.indexOf(cost);
  const out: TabNote[] = [];
  for (let e = evs.length - 1; e >= 0; e--) {
    const f = evs[e].options[j];
    evs[e].notes.forEach((n, k) => out.push({ ...n, string: f.strings[k], fret: f.frets[k] }));
    if (e > 0) j = back[e - 1][j];
  }
  return { tab: out.sort((a, b) => a.start - b.start || a.string - b.string), cost, kept: out.length };
}
