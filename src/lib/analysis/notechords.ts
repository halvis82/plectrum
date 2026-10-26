// Chord evidence from the transcribed notes. The chord model (BTC) was trained on band recordings
// and only hears a spectrogram; on guitar, the notes actually played say far more directly which
// chord it is. Each frame gets a score per chord class from the pitch classes ringing then, and the
// score is added to BTC's log-probabilities before decoding.

import type { Note } from "./notes";
import { N_CLASSES } from "./decode";

/** Semitones above the root for each BTC quality, in BTC's class order. */
const TONES = [
  [0, 3, 7], [0, 4, 7], [0, 3, 6], [0, 4, 8], [0, 3, 7, 9], [0, 4, 7, 9], [0, 3, 7, 10], [0, 3, 7, 11],
  [0, 4, 7, 11], [0, 4, 7, 10], [0, 3, 6, 9], [0, 3, 6, 10], [0, 2, 7], [0, 5, 7],
];

export type NoteChordOptions = {
  /** weight of the note evidence against BTC's log-probabilities */
  weight: number;
  /** penalty per unit of energy on pitch classes outside the chord */
  outside: number;
  /** penalty per chord tone that isn't heard at all */
  missing: number;
  /** bonus when the lowest ringing note is the root */
  bass: number;
  /** seconds over which a note's weight fades after its onset */
  decay: number;
};

export const DEFAULT_NOTE_CHORDS: NoteChordOptions = { weight: 0, outside: 1, missing: 0.3, bass: 0.3, decay: 1 };

export function noteChordScores(notes: Note[], times: ArrayLike<number>, o: NoteChordOptions = DEFAULT_NOTE_CHORDS): Float32Array {
  const F = times.length;
  const out = new Float32Array(F * N_CLASSES);
  const sorted = [...notes].sort((a, b) => a.start - b.start);
  const pcs = new Float32Array(12);
  let first = 0;
  for (let f = 0; f < F; f++) {
    const t = times[f];
    pcs.fill(0);
    let bassMidi = 999, total = 0;
    while (first < sorted.length && sorted[first].end < t - 4) first++;
    for (let k = first; k < sorted.length && sorted[k].start <= t; k++) {
      const n = sorted[k];
      if (n.end < t) continue;
      const w = Math.max(0.05, n.amp) * Math.exp(-(t - n.start) / o.decay);
      pcs[n.midi % 12] += w;
      total += w;
      if (n.midi < bassMidi && w > 0.05) bassMidi = n.midi;
    }
    const row = out.subarray(f * N_CLASSES, (f + 1) * N_CLASSES);
    if (total < 0.1) {
      // nothing ringing: favor "no chord" a little, leave the chords to BTC
      row[169] = 0.5 * o.weight;
      continue;
    }
    let peak = 0;
    for (let p = 0; p < 12; p++) peak = Math.max(peak, pcs[p]);
    for (let root = 0; root < 12; root++)
      for (let q = 0; q < 14; q++) {
        const tones = TONES[q];
        let inside = 0, missing = 0;
        for (const iv of tones) {
          const e = pcs[(root + iv) % 12];
          inside += e;
          if (e < 0.15 * peak) missing++;
        }
        let s = (inside - o.outside * (total - inside)) / total - o.missing * missing;
        if (bassMidi % 12 === root) s += o.bass;
        row[root * 14 + q] = s * o.weight;
      }
    row[169] = -1 * o.weight;
  }
  return out;
}
