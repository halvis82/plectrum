// How clearly each note was played, 0..1, so the tab can show only the pronounced ones. Echoes, ringing
// overtones and faint strings brushed in passing are quiet next to what was actually picked around them,
// short, or an octave or twelfth over a louder note that starts with them.

import type { NoteRow } from "./analysis/analyze";

/** seconds either side that a note's loudness is compared against */
const AROUND = 0.75;

export function noteStrength(notes: NoteRow[]): Float32Array {
  const n = notes.length;
  const out = new Float32Array(n);
  const order = notes.map((_, i) => i).sort((a, b) => notes[a][0] - notes[b][0]);
  // loudest note within AROUND seconds (two pointers over start times)
  const localMax = new Float32Array(n);
  const deque: number[] = [];
  let lo = 0, hi = 0;
  for (const i of order) {
    const t = notes[i][0];
    while (hi < n && notes[order[hi]][0] <= t + AROUND) {
      const j = order[hi++];
      while (deque.length && notes[deque.at(-1)!][3] <= notes[j][3]) deque.pop();
      deque.push(j);
    }
    while (lo < n && notes[order[lo]][0] < t - AROUND) lo++;
    while (deque.length && notes[deque[0]][0] < t - AROUND) deque.shift();
    localMax[i] = deque.length ? notes[deque[0]][3] : notes[i][3];
  }
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const [start, end, midi, amp] = notes[i];
    let s = amp / Math.max(1e-3, localMax[i]);
    // very short notes are mostly pick noise and bleed
    s *= Math.min(1, Math.pow(Math.max(0.01, end - start) / 0.25, 0.35));
    // an overtone of a louder note struck at the same moment
    for (let m = k - 1; m >= 0 && start - notes[order[m]][0] < 0.04; m--) s *= overtone(notes[order[m]], midi, amp);
    for (let m = k + 1; m < n && notes[order[m]][0] - start < 0.04; m++) s *= overtone(notes[order[m]], midi, amp);
    out[i] = Math.max(0, Math.min(1, s));
  }
  return out;
}

function overtone(other: NoteRow, midi: number, amp: number) {
  const iv = midi - other[2];
  return (iv === 12 || iv === 19 || iv === 24) && other[3] >= amp ? 0.55 : 1;
}

/** Notes to keep for a slider value: 1 keeps every note, 0 only the strongest 12%, by rank, so the
 * slider thins any song evenly however loud its notes are overall. */
export function filterByDetail(notes: NoteRow[], strength: Float32Array, detail: number): NoteRow[] {
  if (detail >= 1) return notes;
  const keep = 0.12 + 0.88 * detail;
  const sorted = Float32Array.from(strength).sort();
  const cut = sorted[Math.min(sorted.length - 1, Math.floor((1 - keep) * sorted.length))];
  return notes.filter((_, i) => strength[i] >= cut);
}

/** Songs analyzed since the slider existed carry each note's onset confidence (column 11). */
export const hasConfidence = (rows: NoteRow[] | null | undefined) => !!rows?.length && rows[0].length >= 11;

/** Slider (0 only the clearest notes, 1 everything heard) to an onset confidence cutoff. */
export const cutoffFor = (detail: number) => 0.85 - 0.65 * detail;
/** where the slider starts: onset confidence 0.5, which on held-out GuitarSet, phone recordings and band
 * mixes kept as much of the music as 0.4 (the model's own setting) with fewer stray notes */
export const DEFAULT_DETAIL = (0.85 - 0.5) / 0.65;

/** The notes to show for a slider value: by onset confidence when the song has it, else by the loudness
 * ranking above. */
export function notesForDetail(rows: NoteRow[], detail: number, strength: Float32Array | null): NoteRow[] {
  if (hasConfidence(rows)) {
    const cut = cutoffFor(detail);
    return rows.filter((r) => r[10] >= cut);
  }
  return strength ? filterByDetail(rows, strength, detail) : rows;
}
