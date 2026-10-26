// Note transcription: mono 22.05 kHz audio -> Basic Pitch (Spotify, Apache-2.0) -> note events.
// Windowing and note decoding are ported from basic_pitch/inference.py and note_creation.py (v0.4.0).

import { SR } from "./cqt";

const FFT_HOP = 256;
const FPS = Math.floor(SR / FFT_HOP); // 86, as Basic Pitch rounds it
export const BP_WINDOW = SR * 2 - FFT_HOP; // 43844 samples per model call
export const BP_FRAMES = 172; // output frames per model call
const N_OVERLAP_FRAMES = 30;
const OVERLAP = N_OVERLAP_FRAMES * FFT_HOP;
const HOP = BP_WINDOW - OVERLAP;
const N_PITCH = 88;
const MIDI_OFFSET = 21;

/** Runs Basic Pitch on one window; returns note and onset activations, each 172 x 88. */
export type RunNotes = (x: Float32Array) => Promise<{ note: Float32Array; onset: Float32Array }>;

export type Note = {
  /** seconds */
  start: number;
  end: number;
  midi: number;
  /** mean frame activation, 0..1 */
  amp: number;
};

export type NoteOptions = {
  onsetThresh: number;
  frameThresh: number;
  /** frames; a note must be longer than this */
  minNoteLen: number;
  inferOnsets: boolean;
  melodia: boolean;
  /** lowest and highest MIDI pitch kept */
  minMidi: number;
  maxMidi: number;
};

/** Basic Pitch defaults, except frame threshold and minimum length (tuned on GuitarSet players 00-02). */
export const DEFAULT_NOTES: NoteOptions = {
  onsetThresh: 0.5,
  frameThresh: 0.4,
  minNoteLen: 8,
  inferOnsets: true,
  melodia: true,
  minMidi: 21,
  maxMidi: 108,
};

/** Model activations for the whole signal, frames x 88 each. */
export type Activations = { note: Float32Array; onset: Float32Array; frames: number };

export async function noteActivations(y: Float32Array, run: RunNotes, onProgress?: (p: number) => void): Promise<Activations> {
  // the signal is left-padded by half the overlap, then cut into overlapping windows
  const padded = new Float32Array(OVERLAP / 2 + y.length);
  padded.set(y, OVERLAP / 2);
  const nWin = Math.max(1, Math.ceil(padded.length / HOP));
  const keep = BP_FRAMES - N_OVERLAP_FRAMES; // 15 frames trimmed from each side
  const total = Math.floor(y.length * (FPS / SR));
  const note = new Float32Array(total * N_PITCH);
  const onset = new Float32Array(total * N_PITCH);
  let row = 0;
  for (let w = 0; w < nWin && row < total; w++) {
    const x = new Float32Array(BP_WINDOW);
    x.set(padded.subarray(w * HOP, w * HOP + BP_WINDOW));
    const out = await run(x);
    const from = N_OVERLAP_FRAMES / 2;
    const n = Math.min(keep, total - row);
    note.set(out.note.subarray(from * N_PITCH, (from + n) * N_PITCH), row * N_PITCH);
    onset.set(out.onset.subarray(from * N_PITCH, (from + n) * N_PITCH), row * N_PITCH);
    row += n;
    onProgress?.((w + 1) / nWin);
  }
  return { note, onset, frames: total };
}

/** Frame index -> seconds, including Basic Pitch's per-window alignment correction. */
export function frameTime(i: number): number {
  const offset = (FFT_HOP / SR) * (BP_FRAMES - BP_WINDOW / FFT_HOP) + 0.0018;
  return (i * FFT_HOP) / SR - offset * Math.floor(i / BP_FRAMES);
}

/** Polyphonic note decoding (Basic Pitch's output_to_notes_polyphonic). */
export function decodeNotes(act: Activations, opts: NoteOptions = DEFAULT_NOTES): Note[] {
  const { frames: T } = act;
  const P = N_PITCH;
  const lo = Math.max(0, opts.minMidi - MIDI_OFFSET);
  const hi = Math.min(P, opts.maxMidi - MIDI_OFFSET + 1);
  const frames = new Float32Array(act.note);
  let onsets: Float32Array = new Float32Array(act.onset);
  for (let t = 0; t < T; t++)
    for (let p = 0; p < P; p++)
      if (p < lo || p >= hi) frames[t * P + p] = onsets[t * P + p] = 0;
  if (opts.inferOnsets) onsets = inferOnsets(onsets, frames, T);

  // strict local maxima in time above the onset threshold, latest first
  const starts: [number, number][] = [];
  for (let t = 1; t < T - 1; t++)
    for (let p = 0; p < P; p++) {
      const v = onsets[t * P + p];
      if (v >= opts.onsetThresh && v > onsets[(t - 1) * P + p] && v > onsets[(t + 1) * P + p]) starts.push([t, p]);
    }
  starts.sort((a, b) => b[0] - a[0] || b[1] - a[1]);

  const energy = new Float32Array(frames);
  const ENERGY_TOL = 11;
  const notes: [number, number, number, number][] = [];
  const clear = (t0: number, t1: number, p: number) => {
    for (let t = t0; t < t1; t++)
      for (let q = Math.max(0, p - 1); q <= Math.min(P - 1, p + 1); q++) energy[t * P + q] = 0;
  };
  const mean = (t0: number, t1: number, p: number) => {
    let s = 0;
    for (let t = t0; t < t1; t++) s += frames[t * P + p];
    return s / (t1 - t0);
  };

  for (const [t0, p] of starts) {
    if (t0 >= T - 1) continue;
    let i = t0 + 1;
    let k = 0;
    while (i < T - 1 && k < ENERGY_TOL) {
      k = energy[i * P + p] < opts.frameThresh ? k + 1 : 0;
      i++;
    }
    i -= k;
    if (i - t0 <= opts.minNoteLen) continue;
    clear(t0, i, p);
    notes.push([t0, i, p, mean(t0, i, p)]);
  }

  if (opts.melodia) {
    for (;;) {
      let best = -1;
      let bestV = opts.frameThresh;
      for (let j = 0; j < energy.length; j++)
        if (energy[j] > bestV) {
          bestV = energy[j];
          best = j;
        }
      if (best < 0) break;
      const mid = Math.floor(best / P);
      const p = best % P;
      energy[best] = 0;
      const zero = (t: number) => {
        for (let q = Math.max(0, p - 1); q <= Math.min(P - 1, p + 1); q++) energy[t * P + q] = 0;
      };
      let i = mid + 1;
      let k = 0;
      while (i < T - 1 && k < ENERGY_TOL) {
        k = energy[i * P + p] < opts.frameThresh ? k + 1 : 0;
        zero(i);
        i++;
      }
      const end = i - 1 - k;
      i = mid - 1;
      k = 0;
      while (i > 0 && k < ENERGY_TOL) {
        k = energy[i * P + p] < opts.frameThresh ? k + 1 : 0;
        zero(i);
        i--;
      }
      const start = i + 1 + k;
      if (end - start <= opts.minNoteLen) continue;
      notes.push([start, end, p, mean(start, end, p)]);
    }
  }

  return notes
    .map(([s, e, p, amp]) => ({ start: frameTime(s), end: frameTime(e), midi: p + MIDI_OFFSET, amp }))
    .sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/** Adds onsets where frame activations jump (Basic Pitch's get_infered_onsets, n_diff = 2). */
function inferOnsets(onsets: Float32Array, frames: Float32Array, T: number): Float32Array {
  const P = N_PITCH;
  const diff = new Float32Array(T * P);
  let maxDiff = 0;
  let maxOnset = 0;
  for (let t = 0; t < T; t++)
    for (let p = 0; p < P; p++) {
      const j = t * P + p;
      maxOnset = Math.max(maxOnset, onsets[j]);
      if (t < 2) continue;
      const d = Math.min(frames[j] - frames[j - P], frames[j] - frames[j - 2 * P]);
      if (d > 0) {
        diff[j] = d;
        maxDiff = Math.max(maxDiff, d);
      }
    }
  const out = new Float32Array(T * P);
  const scale = maxDiff > 0 ? maxOnset / maxDiff : 0;
  for (let j = 0; j < out.length; j++) out[j] = Math.max(onsets[j], diff[j] * scale);
  return out;
}
