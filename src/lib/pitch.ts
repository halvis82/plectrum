// Pitch of a single plucked string, for the tuner: the McLeod pitch method (normalized square difference
// function, McLeod & Wyvill 2005), which keeps a guitar's strong overtones from reading as the wrong octave.

/** Fundamental in Hz of `x` (sample rate `sr`), or null when there is no clear pitch. `clarity` is how
 * periodic the sound is (0..1). */
export function detectPitch(x: Float32Array, sr: number, minHz = 60, maxHz = 1100): { hz: number; clarity: number } | null {
  const n = x.length;
  const maxTau = Math.min(n - 1, Math.floor(sr / minHz));
  const minTau = Math.max(2, Math.floor(sr / maxHz));
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  if (energy / n < 1e-6) return null;
  const nsdf = new Float32Array(maxTau + 1);
  for (let tau = 0; tau <= maxTau; tau++) {
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
  // the first lobe nearly as high as the best is the fundamental
  const p = peaks.find((q) => nsdf[q] >= 0.9 * top)!;
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
  const shift = (a - c) / (2 * (a - 2 * b + c) || 1);
  const period = p + (Number.isFinite(shift) ? Math.max(-1, Math.min(1, shift)) : 0);
  return { hz: sr / period, clarity: b };
}

export const midiOf = (hz: number) => 69 + 12 * Math.log2(hz / 440);
export const hzOf = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
