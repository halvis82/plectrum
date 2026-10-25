// Tempo estimation and dynamic-programming beat tracking (Ellis 2007, as in librosa.beat).

import { RealFFT } from "./fft";
import { SR } from "./cqt";

const N_FFT = 2048;
const HOP = 512;
export const ONSET_FPS = SR / HOP;

/** Spectral-flux onset strength on a log-compressed magnitude spectrogram. */
export function onsetEnvelope(y: Float32Array): Float32Array {
  const fft = new RealFFT(N_FFT);
  const nb = N_FFT / 2 + 1;
  const re = new Float64Array(nb), im = new Float64Array(nb);
  const win = new Float64Array(N_FFT);
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  const frames = 1 + Math.floor(y.length / HOP);
  const buf = new Float32Array(N_FFT);
  let prev = new Float32Array(nb), cur = new Float32Array(nb);
  const env = new Float32Array(frames);
  // ignore content above ~8 kHz, it is mostly noise for beat purposes
  const maxBin = Math.min(nb, Math.round((8000 * N_FFT) / SR));
  for (let t = 0; t < frames; t++) {
    const start = t * HOP - N_FFT / 2;
    for (let i = 0; i < N_FFT; i++) {
      const j = start + i;
      buf[i] = j >= 0 && j < y.length ? y[j] * win[i] : 0;
    }
    fft.forward(buf, 0, re, im);
    let flux = 0;
    for (let k = 0; k < maxBin; k++) {
      const m = Math.log1p(1000 * Math.sqrt(re[k] * re[k] + im[k] * im[k]));
      cur[k] = m;
      if (t > 0 && m > prev[k]) flux += m - prev[k];
    }
    env[t] = flux;
    [prev, cur] = [cur, prev];
  }
  // remove slow trend so loud sections do not dominate
  const w = Math.round(ONSET_FPS); // ~1 s
  const out = new Float32Array(frames);
  const cs = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) cs[i + 1] = cs[i] + env[i];
  for (let i = 0; i < frames; i++) {
    const a = Math.max(0, i - w), b = Math.min(frames, i + w + 1);
    out[i] = Math.max(0, env[i] - (cs[b] - cs[a]) / (b - a));
  }
  return out;
}

/** Tempo in BPM from onset autocorrelation weighted by a log-normal prior around 110 BPM. */
export function estimateTempo(env: Float32Array): number {
  const n = env.length;
  const minLag = Math.floor((60 * ONSET_FPS) / 220);
  const maxLag = Math.ceil((60 * ONSET_FPS) / 40);
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n || 1;
  const ac = new Float64Array(maxLag + 2);
  for (let lag = minLag; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = 0; i + lag < n; i++) s += (env[i] - mean) * (env[i + lag] - mean);
    ac[lag] = s / (n - lag);
  }
  let best = minLag, bestScore = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * ONSET_FPS) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 110) / 0.9, 2));
    // reinforce with the double-period lag so the metrical level is consistent
    const score = (ac[lag] + 0.5 * (ac[2 * lag] ?? 0)) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
    }
  }
  // parabolic refinement of the peak
  const a = ac[best - 1] ?? ac[best], b = ac[best], c = ac[best + 1] ?? ac[best];
  const denom = a - 2 * b + c;
  const off = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  return (60 * ONSET_FPS) / (best + off);
}

/** Beat times in seconds. */
export function trackBeats(env: Float32Array, bpm: number, tightness = 100): number[] {
  const n = env.length;
  if (n < 4) return [];
  const period = (60 * ONSET_FPS) / bpm;
  let sd = 0, m = 0;
  for (let i = 0; i < n; i++) m += env[i];
  m /= n;
  for (let i = 0; i < n; i++) sd += (env[i] - m) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  // local score: onset envelope smoothed by a gaussian of width period/32
  const half = Math.round(period);
  const kern: number[] = [];
  for (let k = -half; k <= half; k++) kern.push(Math.exp(-0.5 * Math.pow((k * 32) / period, 2)));
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < n) s += (env[j] / sd) * kern[k + half];
    }
    local[i] = s;
  }
  const cum = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.round(2 * period), hi = Math.round(period / 2);
  for (let i = 0; i < n; i++) {
    let best = -Infinity, arg = -1;
    for (let j = i - lo; j <= i - hi; j++) {
      if (j < 0) continue;
      const txwt = -tightness * Math.pow(Math.log((i - j) / period), 2);
      const v = cum[j] + txwt;
      if (v > best) {
        best = v;
        arg = j;
      }
    }
    cum[i] = local[i] + (arg >= 0 ? best : 0);
    back[i] = arg;
  }
  // last beat: final local maximum of cum that is above half the median of local maxima
  const maxima: number[] = [];
  for (let i = 1; i < n - 1; i++) if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1]) maxima.push(cum[i]);
  maxima.sort((a, b) => a - b);
  const thr = 0.5 * (maxima[Math.floor(maxima.length / 2)] ?? 0);
  let last = n - 1;
  for (let i = n - 2; i > 0; i--) {
    if (cum[i] > cum[i - 1] && cum[i] >= cum[i + 1] && cum[i] >= thr) {
      last = i;
      break;
    }
  }
  const beats: number[] = [];
  for (let i = last; i >= 0; i = back[i]) beats.push(i);
  beats.reverse();
  // trim weak leading/trailing beats (silence before/after the music)
  const strength = beats.map((b) => local[b]);
  const rms = Math.sqrt(strength.reduce((s, v) => s + v * v, 0) / (strength.length || 1));
  let a = 0, z = beats.length;
  while (a < z && strength[a] < 0.5 * rms) a++;
  while (z > a && strength[z - 1] < 0.5 * rms) z--;
  return beats.slice(a, z).map((f) => f / ONSET_FPS);
}
