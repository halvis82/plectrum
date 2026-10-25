// Constant-Q features matching what BTC was trained on:
// librosa.cqt(sr=22050, n_bins=144, bins_per_octave=24, hop_length=2048) computed over
// independent 10 second chunks, then log(|C| + 1e-6). The sparse spectral kernel is
// exported from librosa (scripts/export_model.py) so this is a single full-rate FFT pass.

import { RealFFT } from "./fft";

export const SR = 22050;
export const HOP = 2048;
export const N_BINS = 144;
export const CHUNK = SR * 10;
export const FRAMES_PER_CHUNK = 1 + Math.floor(CHUNK / HOP); // 108, one model window

export type CqtBasis = {
  nBins: number;
  nFft: number;
  start: Int32Array;
  count: Int32Array;
  offset: Int32Array;
  values: Float32Array; // interleaved re, im (already divided by sqrt(filter length))
};

export function parseBasis(buf: ArrayBuffer): CqtBasis {
  const head = new Int32Array(buf, 0, 2);
  const nBins = head[0], nFft = head[1];
  const meta = new Int32Array(buf, 8, nBins * 2);
  const start = new Int32Array(nBins), count = new Int32Array(nBins), offset = new Int32Array(nBins);
  let total = 0;
  for (let b = 0; b < nBins; b++) {
    start[b] = meta[2 * b];
    count[b] = meta[2 * b + 1];
    offset[b] = total;
    total += count[b];
  }
  const values = new Float32Array(buf, 8 + nBins * 8, total * 2);
  return { nBins, nFft, start, count, offset, values };
}

/** Returns log-CQT frames (frames x 144, row-major) for the whole signal. */
export function logCqt(y: Float32Array, basis: CqtBasis, onProgress?: (p: number) => void): { data: Float32Array; frames: number } {
  const fft = new RealFFT(basis.nFft);
  const re = new Float64Array(basis.nFft / 2 + 1);
  const im = new Float64Array(basis.nFft / 2 + 1);
  const pad = basis.nFft / 2;
  const nChunks = Math.max(1, Math.ceil(y.length / CHUNK));
  let frames = 0;
  for (let c = 0; c < nChunks; c++) frames += 1 + Math.floor(Math.min(CHUNK, y.length - c * CHUNK) / HOP);
  const data = new Float32Array(frames * basis.nBins);
  let row = 0;
  for (let c = 0; c < nChunks; c++) {
    const seg = y.subarray(c * CHUNK, Math.min(y.length, (c + 1) * CHUNK));
    const n = 1 + Math.floor(seg.length / HOP);
    for (let t = 0; t < n; t++, row++) {
      fft.forward(seg, t * HOP - pad, re, im);
      const o = row * basis.nBins;
      for (let b = 0; b < basis.nBins; b++) {
        let sr = 0, si = 0;
        const s = basis.start[b], cnt = basis.count[b];
        let v = basis.offset[b] * 2;
        for (let k = 0; k < cnt; k++, v += 2) {
          const br = basis.values[v], bi = basis.values[v + 1];
          const xr = re[s + k], xi = im[s + k];
          sr += br * xr - bi * xi;
          si += br * xi + bi * xr;
        }
        data[o + b] = Math.log(Math.sqrt(sr * sr + si * si) + 1e-6);
      }
    }
    onProgress?.((c + 1) / nChunks);
  }
  return { data, frames };
}

/** Time in seconds of the centre of CQT frame `i` (frames restart every 10 s chunk). */
export function frameTimes(y: number, frames: number): Float64Array {
  const out = new Float64Array(frames);
  let row = 0;
  for (let c = 0; row < frames; c++) {
    const n = 1 + Math.floor(Math.min(CHUNK, y - c * CHUNK) / HOP);
    for (let t = 0; t < n && row < frames; t++, row++) out[row] = c * 10 + (t * HOP) / SR;
  }
  return out;
}
