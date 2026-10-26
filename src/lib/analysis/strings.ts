// String classification: which of the six strings each note was played on, judged from its timbre
// (a wound low string sounds darker and less harmonic than a plain high string at the same pitch).
// The features mirror scripts/strings/features.py exactly; the model is trained by scripts/strings/train.py.

import { SR } from "./cqt";
import { RealFFT } from "./fft";

const N_FFT = 4096;
const HOP = 256;
const RES = 4; // rows per semitone
const LO = -1; // semitones relative to the note
const HI = 49;
export const NB = (HI - LO) * RES; // 200 rows, harmonics up to about the 16th
export const NF = 12; // frames, about 140 ms
const OFF = -1; // first frame, in hops relative to the onset

/** Runs the string model on a batch: patches [n, NF, NB] and pitches [n] -> logits [n, 6]. */
export type RunStrings = (patches: Float32Array, midi: Float32Array, n: number) => Promise<Float32Array>;

const WIN = (() => {
  const w = new Float32Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  return w;
})();

/** dB magnitude spectra of frames centered on f * HOP, cached because chord notes share frames. */
class Spectra {
  private fft = new RealFFT(N_FFT);
  private cache = new Map<number, Float32Array>();
  private seg = new Float32Array(N_FFT);
  private re = new Float64Array(N_FFT / 2 + 1);
  private im = new Float64Array(N_FFT / 2 + 1);
  constructor(private y: Float32Array) {}

  frame(f: number): Float32Array {
    let mag = this.cache.get(f);
    if (mag) return mag;
    const a = f * HOP - N_FFT / 2;
    for (let i = 0; i < N_FFT; i++) {
      const j = a + i;
      this.seg[i] = j >= 0 && j < this.y.length ? this.y[j] * WIN[i] : 0;
    }
    this.fft.forward(this.seg, 0, this.re, this.im);
    mag = new Float32Array(N_FFT / 2 + 1);
    for (let k = 0; k < mag.length; k++) mag[k] = 20 * Math.log10(Math.hypot(this.re[k], this.im[k]) + 1e-6);
    // keep memory bounded on long songs: frames are requested roughly in time order
    if (this.cache.size > 4000) this.cache.clear();
    this.cache.set(f, mag);
    return mag;
  }
}

/** One pitch-aligned patch per note, concatenated: [notes.length, NF, NB]. */
export function stringPatches(y: Float32Array, notes: { start: number; midi: number }[]): Float32Array {
  const spectra = new Spectra(y);
  const out = new Float32Array(notes.length * NF * NB);
  const lo = new Int32Array(NB);
  const frac = new Float32Array(NB);
  const ok = new Uint8Array(NB);
  for (const [n, note] of notes.entries()) {
    for (let b = 0; b < NB; b++) {
      const semis = note.midi + LO + b / RES;
      const bin = ((440 * 2 ** ((semis - 69) / 12)) * N_FFT) / SR;
      lo[b] = Math.floor(bin);
      frac[b] = bin - lo[b];
      ok[b] = lo[b] + 1 < N_FFT / 2 ? 1 : 0;
    }
    const start = Math.round((note.start * SR) / HOP) + OFF;
    const p = out.subarray(n * NF * NB, (n + 1) * NF * NB);
    let max = -Infinity;
    for (let k = 0; k < NF; k++) {
      const mag = spectra.frame(start + k);
      for (let b = 0; b < NB; b++) {
        const v = ok[b] ? mag[lo[b]] * (1 - frac[b]) + mag[lo[b] + 1] * frac[b] : -100;
        p[k * NB + b] = v;
        if (v > max) max = v;
      }
    }
    // level-independent: relative to the patch maximum, floored at -80 dB
    for (let i = 0; i < p.length; i++) p[i] = Math.max(p[i] - max, -80) / 80 + 1;
  }
  return out;
}

/** Probability of each string (low E first) for every note; infeasible strings get 0. */
export async function stringProbs(y: Float32Array, notes: { start: number; midi: number }[], run: RunStrings, onProgress?: (p: number) => void): Promise<Float32Array> {
  const out = new Float32Array(notes.length * 6);
  const BATCH = 256;
  for (let i = 0; i < notes.length; i += BATCH) {
    const batch = notes.slice(i, i + BATCH);
    const logits = await run(stringPatches(y, batch), Float32Array.from(batch, (n) => n.midi), batch.length);
    for (let j = 0; j < batch.length; j++) {
      const l = logits.subarray(j * 6, j * 6 + 6);
      const m = Math.max(...l);
      let z = 0;
      for (let s = 0; s < 6; s++) z += Math.exp(l[s] - m);
      for (let s = 0; s < 6; s++) out[(i + j) * 6 + s] = Math.exp(l[s] - m) / z;
    }
    onProgress?.(Math.min(1, (i + BATCH) / notes.length));
  }
  return out;
}
