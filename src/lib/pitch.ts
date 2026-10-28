// Pitch of a single plucked string, for the tuner. The McLeod pitch method (normalized square difference
// function, McLeod & Wyvill 2005) measures the period precisely; which period is the note is decided
// from the overtones, since a guitar's (and a laptop or phone mic's missing low end) easily make the
// octave, the fifth or the octave below look as periodic.

/** Fundamental in Hz of `x` (sample rate `sr`), or null when there is no clear pitch. `clarity` is how
 * periodic the sound is (0..1). */
export function detectPitch(x: Float32Array, sr: number, minHz = 60, maxHz = 1100): { hz: number; clarity: number } | null {
  const n = x.length;
  const maxTau = Math.min(n >> 1, Math.ceil(sr / minHz) + 2);
  const minTau = Math.max(2, Math.floor(sr / maxHz));
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  if (energy / n < 1e-6) return null;
  const nsdf = new Float32Array(maxTau + 2);
  for (let tau = 0; tau <= maxTau + 1; tau++) {
    let acf = 0, m = 0;
    for (let j = 0; j < n - tau; j++) {
      acf += x[j] * x[j + tau];
      m += x[j] * x[j] + x[j + tau] * x[j + tau];
    }
    nsdf[tau] = m > 0 ? (2 * acf) / m : 0;
  }
  // the highest point of each positive lobe after the first zero crossing
  const peaks: number[] = [];
  let tau = 1;
  while (tau < maxTau && nsdf[tau] > 0) tau++;
  while (tau < maxTau) {
    while (tau < maxTau && nsdf[tau] <= 0) tau++;
    let best = tau;
    while (tau < maxTau && nsdf[tau] > 0) {
      if (nsdf[tau] > nsdf[best]) best = tau;
      tau++;
    }
    if (best < maxTau && best >= minTau) peaks.push(best);
  }
  if (!peaks.length) return null;
  const top = Math.max(...peaks.map((p) => nsdf[p]));
  // every periodic-looking lobe is a candidate; the overtones pick the note among them
  const candidates = peaks.filter((p) => nsdf[p] >= 0.6 * top);
  const win = hann(n);
  const scores = candidates.map((p) => harmonicScore(x, win, sr, sr / refine(nsdf, p)));
  const best = Math.max(...scores);
  // the lowest note that explains the overtones nearly as well as the best: a weak fundamental (small
  // mics) can make a sparser, higher grid score a little better, while a guess an octave too low scores
  // about half
  const pick = candidates[candidates.length - 1 - [...scores].reverse().findIndex((s) => s >= best - (1 - LOWEST_SHARE) * Math.abs(best))];
  return { hz: sr / refine(nsdf, pick), clarity: nsdf[pick] };
}

const LOWEST_SHARE = 0.7;

/** the period at a lobe's top, between samples */
function refine(nsdf: Float32Array, p: number) {
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  return p + (Number.isFinite(shift) ? Math.max(-1, Math.min(1, shift)) : 0);
}

/** How well `f0` explains the spectrum: the energy at its harmonics against the energy halfway between
 * them. Too high a guess (an octave up) has the real odd harmonics in between; too low a guess has half
 * its harmonics empty. */
function harmonicScore(x: Float32Array, win: Float32Array, sr: number, f0: number) {
  // the same span for every guess, so a guess an octave low isn't credited with fewer, stronger harmonics
  const top = Math.min(3000, sr * 0.45);
  let on = 0, off = 0, k = 0;
  for (let h = 1; h * f0 < top; h++, k++) {
    on += Math.sqrt(amp(x, win, sr, h * f0));
    off += Math.sqrt(amp(x, win, sr, (h - 0.5) * f0));
  }
  return k ? (on - off) / k : -Infinity;
}

/** magnitude of the windowed signal at `hz` (Goertzel) */
function amp(x: Float32Array, win: Float32Array, sr: number, hz: number) {
  const c = 2 * Math.cos((2 * Math.PI * hz) / sr);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s = x[i] * win[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - c * s1 * s2));
}

const hanns = new Map<number, Float32Array>();
function hann(n: number) {
  let w = hanns.get(n);
  if (!w) {
    w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hanns.set(n, w);
  }
  return w;
}

export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
