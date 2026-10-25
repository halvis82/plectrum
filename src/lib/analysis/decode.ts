// Turns per-frame chord log-probabilities into clean, beat-aligned chords.

export const N_CLASSES = 170;
export const NO_CHORD = 169;

/**
 * Viterbi over chord classes with a fixed penalty for changing chord.
 * `obs` is T x C row-major log-probabilities. Returns the best class per step.
 */
export function viterbi(obs: Float32Array, T: number, C: number, switchPenalty: number | ArrayLike<number>): Int32Array {
  const path = new Int32Array(T);
  if (T === 0) return path;
  let score = new Float64Array(C);
  let next = new Float64Array(C);
  const back = new Int32Array(T * C);
  for (let c = 0; c < C; c++) score[c] = obs[c];
  for (let t = 1; t < T; t++) {
    let bestPrev = 0;
    for (let c = 1; c < C; c++) if (score[c] > score[bestPrev]) bestPrev = c;
    const switchScore = score[bestPrev] - (typeof switchPenalty === "number" ? switchPenalty : switchPenalty[t]);
    for (let c = 0; c < C; c++) {
      const stay = score[c];
      if (stay >= switchScore) {
        next[c] = stay + obs[t * C + c];
        back[t * C + c] = c;
      } else {
        next[c] = switchScore + obs[t * C + c];
        back[t * C + c] = bestPrev;
      }
    }
    [score, next] = [next, score];
  }
  let best = 0;
  for (let c = 1; c < C; c++) if (score[c] > score[best]) best = c;
  for (let t = T - 1; t >= 0; t--) {
    path[t] = best;
    best = back[t * C + best];
  }
  return path;
}

export type Segment = [start: number, end: number, cls: number];

export function toSegments(path: Int32Array, times: ArrayLike<number>, duration: number): Segment[] {
  const segs: Segment[] = [];
  for (let i = 0; i < path.length; i++) {
    const start = i === 0 ? 0 : (times[i - 1] + times[i]) / 2;
    const last = segs[segs.length - 1];
    if (last && last[2] === path[i]) continue;
    if (last) last[1] = start;
    segs.push([start, duration, path[i]]);
  }
  return segs;
}

/** Average frame log-probs inside each beat interval, then smooth across beats. */
export function beatChords(
  logp: Float32Array,
  times: ArrayLike<number>,
  beats: number[],
  duration: number,
  switchPenalty: number | ArrayLike<number> = 2.5,
  extensionMargin = 0,
): Int32Array {
  const B = beats.length;
  const C = N_CLASSES;
  const obs = new Float32Array(B * C);
  let f = 0;
  for (let b = 0; b < B; b++) {
    const start = beats[b];
    const end = b + 1 < B ? beats[b + 1] : Math.min(duration, start + (beats[b] - (beats[b - 1] ?? 0) || 0.5));
    while (f < times.length && times[f] < start) f++;
    let g = f, n = 0;
    const acc = obs.subarray(b * C, (b + 1) * C);
    for (; g < times.length && times[g] < end; g++, n++) {
      for (let c = 0; c < C; c++) acc[c] += logp[g * C + c];
    }
    if (n === 0) {
      // beat shorter than a frame: use the nearest frame
      const k = Math.min(times.length - 1, f);
      for (let c = 0; c < C; c++) acc[c] = logp[k * C + c];
    } else {
      for (let c = 0; c < C; c++) acc[c] /= n;
    }
  }
  const path = viterbi(obs, B, C, switchPenalty);
  return extensionMargin > 0 ? preferTriads(path, obs, C, extensionMargin) : path;
}

const MINORISH = new Set([0, 2, 4, 6, 7, 10, 11]); // min dim min6 min7 minmaj7 dim7 hdim7

/**
 * Noisy audio tends to invent 7ths and suspensions. For every run of the same extended
 * chord, keep it only if it beats the plain major/minor triad on the same root by `margin`
 * (mean log-prob per beat); otherwise fall back to the triad.
 */
export function preferTriads(path: Int32Array, obs: Float32Array, C: number, margin: number): Int32Array {
  const out = path.slice();
  for (let start = 0; start < path.length; ) {
    let end = start;
    while (end < path.length && path[end] === path[start]) end++;
    const cls = path[start];
    if (cls < 168 && cls % 14 > 1) {
      const triad = Math.floor(cls / 14) * 14 + (MINORISH.has(cls % 14) ? 0 : 1);
      let diff = 0;
      for (let t = start; t < end; t++) diff += obs[t * C + cls] - obs[t * C + triad];
      if (diff / (end - start) < margin) out.fill(triad, start, end);
    }
    start = end;
  }
  return out;
}
