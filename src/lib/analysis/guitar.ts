// Guitar note transcription with the high-resolution CRNN of Riley, Edwards & Dixon (ICASSP 2024), a
// guitar adaptation of Kong et al.'s piano transcription model (MIT, weights from
// huggingface.co/xavriley/midi-transcription-models). Windowing and note decoding are ported from
// piano_transcription_inference (inference.py, utilities.py, piano_vad.py).

import type { Note } from "./notes";

export const GUITAR_SR = 16000;
export const SEGMENT = 160000; // 10 s per model call
const FPS = 100;
const SEG_FRAMES = SEGMENT / 160; // 1000, after dropping the extra frame from centered STFT
const P = 88;
const BEGIN_NOTE = 21;

/** Runs the model on n segments of SEGMENT samples; each output is [n, SEG_FRAMES + 1, 88]. */
export type RunGuitar = (x: Float32Array, n: number) => Promise<{ onset: Float32Array; offset: Float32Array; frame: Float32Array; velocity: Float32Array }>;

export type GuitarActivations = { onset: Float32Array; offset: Float32Array; frame: Float32Array; velocity: Float32Array; frames: number };

export type GuitarNoteOptions = { onset: number; offset: number; frame: number };
/** Reference thresholds, except onset 0.4 (slightly better on GuitarSet players 00-02, fewer stray notes). */
export const DEFAULT_GUITAR_NOTES: GuitarNoteOptions = { onset: 0.4, offset: 0.3, frame: 0.1 };

/** Windowed-sinc (Kaiser) resampler for rational rate changes such as 22.05 -> 16 kHz, with one
 * precomputed filter per output phase. */
export function resampleTo(y: Float32Array, from: number, to: number): Float32Array {
  const g = gcd(from, to);
  const up = to / g, down = from / g; // output i sits at input position i * down / up
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * 0.97;
  const width = 24 / cutoff; // half-width in input samples
  const taps = 2 * Math.ceil(width) + 1;
  const beta = 8.6;
  const norm = besselI0(beta);
  const table = new Float32Array(up * taps);
  for (let ph = 0; ph < up; ph++) {
    const frac = ph / up; // output phase ph = (i * down) mod up sits frac of a sample past floor
    for (let t = 0; t < taps; t++) {
      const d = t - Math.ceil(width) - frac; // input offset from the output position
      const r = d / width;
      if (Math.abs(r) > 1) continue;
      const x = d * cutoff;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      table[ph * taps + t] = (sinc * besselI0(beta * Math.sqrt(1 - r * r)) * cutoff) / norm;
    }
  }
  const n = Math.floor(y.length * ratio);
  const out = new Float32Array(n);
  const half = Math.ceil(width);
  for (let i = 0; i < n; i++) {
    const ph = (i * down) % up;
    const base = Math.floor((i * down) / up) - half;
    const w = ph * taps;
    let acc = 0;
    if (base >= 0 && base + taps <= y.length) for (let t = 0; t < taps; t++) acc += y[base + t] * table[w + t];
    else for (let t = 0; t < taps; t++) if (base + t >= 0 && base + t < y.length) acc += y[base + t] * table[w + t];
    out[i] = acc;
  }
  return out;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

function besselI0(x: number) {
  let s = 1, t = 1;
  for (let k = 1; k < 30; k++) {
    t *= (x / (2 * k)) ** 2;
    s += t;
  }
  return s;
}

/** IEEE half -> float, for the weights file. */
export function halfToFloat(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  const u = new Uint32Array(out.buffer);
  for (let i = 0; i < h.length; i++) {
    const x = h[i];
    const sign = (x & 0x8000) << 16;
    const exp = (x >> 10) & 0x1f;
    const man = x & 0x3ff;
    if (exp === 0) out[i] = (sign ? -1 : 1) * man * 2 ** -24; // zero and subnormals
    else if (exp === 31) u[i] = sign | 0x7f800000 | (man << 13);
    else u[i] = sign | ((exp + 112) << 23) | (man << 13);
  }
  return out;
}

/** 16 kHz audio -> frame activations at 100 fps, from half-overlapping 10 s segments. */
export async function guitarActivations(y: Float32Array, run: RunGuitar, onProgress?: (p: number) => void, batch = 1): Promise<GuitarActivations> {
  const padded = new Float32Array(Math.max(1, Math.ceil(y.length / SEGMENT)) * SEGMENT);
  padded.set(y);
  const nSeg = 2 * (padded.length / SEGMENT) - 1;
  const total = nSeg === 1 ? SEG_FRAMES + 1 : (nSeg + 1) * (SEG_FRAMES / 2);
  const acts = { onset: new Float32Array(total * P), offset: new Float32Array(total * P), frame: new Float32Array(total * P), velocity: new Float32Array(total * P) };
  let row = 0;
  for (let s = 0; s < nSeg; s += batch) {
    const n = Math.min(batch, nSeg - s);
    const x = new Float32Array(n * SEGMENT);
    for (let k = 0; k < n; k++) x.set(padded.subarray(((s + k) * SEGMENT) / 2, ((s + k) * SEGMENT) / 2 + SEGMENT), k * SEGMENT);
    const out = await run(x, n);
    for (let k = 0; k < n; k++) {
      const i = s + k;
      // keep the middle half of each segment (the first keeps its start, the last its end)
      const from = nSeg === 1 || i === 0 ? 0 : SEG_FRAMES / 4;
      const to = nSeg === 1 ? SEG_FRAMES + 1 : i === nSeg - 1 ? SEG_FRAMES : (3 * SEG_FRAMES) / 4;
      for (const key of ["onset", "offset", "frame", "velocity"] as const) {
        const src = out[key].subarray(k * (SEG_FRAMES + 1) * P, (k + 1) * (SEG_FRAMES + 1) * P);
        acts[key].set(src.subarray(from * P, to * P), row * P);
      }
      row += to - from;
    }
    onProgress?.(Math.min(1, (s + n) / nSeg));
  }
  return { ...acts, frames: row };
}

/** Peaks of a regression curve that rise monotonically for `nb` frames on each side, with sub-frame shift. */
function binarize(reg: Float32Array, T: number, threshold: number, nb: number) {
  const on = new Uint8Array(T * P);
  const shift = new Float32Array(T * P);
  for (let k = 0; k < P; k++)
    for (let n = nb; n < T - nb; n++) {
      const x = (t: number) => reg[t * P + k];
      if (x(n) <= threshold) continue;
      let mono = true;
      for (let i = 0; i < nb && mono; i++) if (x(n - i) < x(n - i - 1) || x(n + i) < x(n + i + 1)) mono = false;
      if (!mono) continue;
      on[n * P + k] = 1;
      shift[n * P + k] = x(n - 1) > x(n + 1) ? (x(n + 1) - x(n - 1)) / (x(n) - x(n + 1)) / 2 : (x(n + 1) - x(n - 1)) / (x(n) - x(n - 1)) / 2;
    }
  return { on, shift };
}

export function decodeGuitarNotes(a: GuitarActivations, o: GuitarNoteOptions = DEFAULT_GUITAR_NOTES): Note[] {
  const T = a.frames;
  const onset = binarize(a.onset, T, o.onset, 2);
  const offset = binarize(a.offset, T, o.offset, 4);
  const notes: Note[] = [];
  for (let k = 0; k < P; k++) {
    let bgn: number | null = null;
    let disappear: number | null = null;
    let offOccur: number | null = null;
    const push = (b: number, fin: number, offShift: number) =>
      notes.push({ start: (b + onset.shift[b * P + k]) / FPS, end: (fin + offShift) / FPS, midi: k + BEGIN_NOTE, amp: a.velocity[b * P + k] });
    for (let i = 0; i < T; i++) {
      if (onset.on[i * P + k]) {
        // the reference treats frame 0 as "no onset" (a falsy index); kept for parity
        if (bgn) {
          push(bgn, Math.max(i - 1, 0), 0);
          disappear = offOccur = null;
        }
        bgn = i;
      }
      if (bgn && i > bgn) {
        if (a.frame[i * P + k] <= o.frame && !disappear) disappear = i;
        if (offset.on[i * P + k] && !offOccur) offOccur = i;
        if (disappear) {
          const fin = offOccur && offOccur - bgn > disappear - offOccur ? offOccur : disappear;
          push(bgn, fin, offset.shift[fin * P + k]);
          bgn = disappear = offOccur = null;
        }
        if (bgn && (i - bgn >= 600 || i === T - 1)) {
          push(bgn, i, offset.shift[i * P + k]);
          bgn = disappear = offOccur = null;
        }
      }
    }
  }
  return notes.sort((x, y) => x.start - y.start || x.midi - y.midi);
}
