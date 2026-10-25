// Chord labels, naming, simplification, transposition, key and capo logic.
// Internal labels use BTC's format: "N", "X", "C", "C#:min7", ...

export const QUALITIES = ["min", "maj", "dim", "aug", "min6", "maj6", "min7", "minmaj7", "maj7", "7", "dim7", "hdim7", "sus2", "sus4"] as const;
export type Quality = (typeof QUALITIES)[number];
const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export type Chord = { root: number; quality: Quality } | null; // null = no chord

export function labelFromIndex(i: number): string {
  if (i === 169) return "N";
  if (i === 168) return "X";
  const root = SHARP[Math.floor(i / 14)];
  const q = QUALITIES[i % 14];
  return q === "maj" ? root : `${root}:${q}`;
}

export function parseLabel(label: string): Chord {
  if (label === "N" || label === "X") return null;
  const [r, q = "maj"] = label.split(":");
  const root = SHARP.indexOf(r);
  return root < 0 ? null : { root, quality: q as Quality };
}

export function toLabel(c: Chord): string {
  if (!c) return "N";
  return c.quality === "maj" ? SHARP[c.root] : `${SHARP[c.root]}:${c.quality}`;
}

const SUFFIX: Record<Quality, string> = {
  min: "m", maj: "", dim: "dim", aug: "aug", min6: "m6", maj6: "6", min7: "m7",
  minmaj7: "m(maj7)", maj7: "maj7", "7": "7", dim7: "dim7", hdim7: "m7b5", sus2: "sus2", sus4: "sus4",
};

export type Simplify = "full" | "sevenths" | "triads";

export function simplify(c: Chord, mode: Simplify): Chord {
  if (!c || mode === "full") return c;
  const q = c.quality;
  const minorish = q === "min" || q === "min6" || q === "min7" || q === "minmaj7" || q === "dim" || q === "dim7" || q === "hdim7";
  if (mode === "sevenths") {
    if (q === "min7" || q === "hdim7") return { root: c.root, quality: "min7" };
    if (q === "7" || q === "maj7" || q === "sus4" || q === "sus2") return c;
    return { root: c.root, quality: minorish ? "min" : "maj" };
  }
  return { root: c.root, quality: minorish ? "min" : "maj" };
}

export function transpose(c: Chord, semis: number): Chord {
  return c ? { root: (((c.root + semis) % 12) + 12) % 12, quality: c.quality } : c;
}

export function chordName(c: Chord, spelling: readonly string[] = SHARP): string {
  if (!c) return "N.C.";
  return spelling[c.root] + SUFFIX[c.quality];
}

export function noteName(pc: number, spelling: readonly string[] = SHARP) {
  return spelling[((pc % 12) + 12) % 12];
}

// ---- key detection (Krumhansl-Schmuckler on chord tones weighted by duration) ----

const INTERVALS: Record<Quality, number[]> = {
  maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], min6: [0, 3, 7, 9], maj6: [0, 4, 7, 9],
  min7: [0, 3, 7, 10], minmaj7: [0, 3, 7, 11], maj7: [0, 4, 7, 11], "7": [0, 4, 7, 10], dim7: [0, 3, 6, 9],
  hdim7: [0, 3, 6, 10], sus2: [0, 2, 7], sus4: [0, 5, 7],
};
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export type Key = { tonic: number; mode: "major" | "minor" };

export function detectKey(chords: { chord: Chord; dur: number }[]): Key {
  const pcs = new Array(12).fill(0);
  for (const { chord, dur } of chords) {
    if (!chord) continue;
    for (const iv of INTERVALS[chord.quality]) pcs[(chord.root + iv) % 12] += dur;
    pcs[chord.root] += dur * 0.5; // roots carry extra weight
  }
  let best: Key = { tonic: 0, mode: "major" }, bestR = -Infinity;
  for (const mode of ["major", "minor"] as const) {
    const prof = mode === "major" ? MAJOR_PROFILE : MINOR_PROFILE;
    for (let t = 0; t < 12; t++) {
      const r = corr(pcs, (i) => prof[(i - t + 12) % 12]);
      if (r > bestR) {
        bestR = r;
        best = { tonic: t, mode };
      }
    }
  }
  return best;
}

function corr(a: number[], b: (i: number) => number) {
  const n = 12;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  let mb = 0;
  for (let i = 0; i < n; i++) mb += b(i);
  mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i] - ma, y = b(i) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / Math.sqrt(da * db || 1);
}

// C major / A minor borrow Bb, Eb, Ab and F# far more often than A#, D#, G# or Gb
const NATURAL = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** Note names that read naturally in a key: sharps in sharp keys, flats in flat keys. */
export function spellingFor(key: Key): readonly string[] {
  const major = key.mode === "major" ? key.tonic : (key.tonic + 3) % 12;
  if (major === 0) return NATURAL;
  return [5, 10, 3, 8, 1].includes(major) ? FLAT : SHARP;
}

export function keyName(key: Key): string {
  return noteName(key.tonic, spellingFor(key)) + (key.mode === "minor" ? " minor" : " major");
}

// ---- capo suggestions: prefer the capo whose chord shapes are open-position chords ----

const OPEN_SHAPES = new Set([
  "0:maj", "2:maj", "4:maj", "7:maj", "9:maj", // C D E G A
  "2:min", "4:min", "9:min", // Dm Em Am
  "0:7", "2:7", "4:7", "7:7", "9:7", "11:7", // C7 D7 E7 G7 A7 B7
  "2:min7", "4:min7", "9:min7", // Dm7 Em7 Am7
  "0:maj7", "2:maj7", "5:maj7", "9:maj7", "4:maj7", // Cmaj7 Dmaj7 Fmaj7 Amaj7 Emaj7
  "2:sus2", "9:sus2", "2:sus4", "4:sus4", "9:sus4", // Dsus2 Asus2 Dsus4 Esus4 Asus4
  "0:maj6", "7:maj6", "4:maj6", "9:maj6", "2:maj6", "4:min6", "9:min6",
]);

function shapeCost(c: Chord): number {
  if (!c) return 0;
  return OPEN_SHAPES.has(`${c.root}:${c.quality}`) ? 0 : c.root === 5 && c.quality === "maj" ? 0.6 : 1;
}

/** Returns capo positions 0..7 sorted by how open-chord friendly the song becomes. */
export function capoOptions(chords: { chord: Chord; dur: number }[]): { capo: number; cost: number }[] {
  const total = chords.reduce((s, c) => s + (c.chord ? c.dur : 0), 0) || 1;
  const opts = [];
  for (let capo = 0; capo <= 7; capo++) {
    let cost = 0;
    for (const { chord, dur } of chords) cost += shapeCost(transpose(chord, -capo)) * dur;
    // tiny bias toward lower capos when results tie
    opts.push({ capo, cost: cost / total + capo * 0.01 });
  }
  return opts.sort((a, b) => a.cost - b.cost);
}
