// The fingering model (scripts/fingering): which string each note is played on, judged from the passage
// around it (pitch, timing, what sounds together), learned from guitarists' tabs. Its inputs mirror
// scripts/fingering/model.py `features` exactly.

/** onsets this close are one event */
const CHORD = 0.03;
const WIN = 256;
const HOP = WIN / 2;

/** Runs the model: inputs [256, 4] -> logits [256, 6] (low E first). */
export type RunFinger = (x: Float32Array, t: number) => Promise<Float32Array>;

/** Probability of each string (low E first) for every note, [n * 6] in the order given. Pitches are in
 * standard tuning. */
export async function fingerProbs(notes: { start: number; end: number; midi: number }[], run: RunFinger): Promise<Float32Array> {
  const n = notes.length;
  const order = notes.map((_, i) => i).sort((a, b) => Math.round(notes[a].start / CHORD) - Math.round(notes[b].start / CHORD) || notes[a].midi - notes[b].midi);
  const sum = new Float32Array(n * 6);
  const weight = new Float32Array(n);
  const starts: number[] = [];
  if (n <= WIN) starts.push(0);
  else for (let a = 0; a < n - HOP; a += HOP) starts.push(Math.min(a, n - WIN));
  for (const a of starts) {
    const b = Math.min(n, a + WIN);
    const t = b - a;
    // always a full window, padded the way training padded short passages (lowest pitch, no time apart)
    const x = new Float32Array(WIN * 4);
    for (let k = t; k < WIN; k++) {
      x[k * 4] = 40;
      x[k * 4 + 3] = 1;
    }
    for (let k = 0; k < t; k++) {
      const note = notes[order[a + k]];
      const prev = notes[order[a + Math.max(0, k - 1)]];
      const dt = Math.max(0, note.start - prev.start);
      x[k * 4] = note.midi;
      x[k * 4 + 1] = Math.log1p(dt * 20);
      x[k * 4 + 2] = Math.log1p(Math.max(0, note.end - note.start) * 10);
      x[k * 4 + 3] = dt < CHORD ? 1 : 0;
    }
    const logits = await run(x, WIN);
    for (let k = 0; k < t; k++) {
      // the middle of a window has the most context around it
      const w = Math.min(k + 1, t - k);
      const l = logits.subarray(k * 6, k * 6 + 6);
      const m = Math.max(...l);
      let z = 0;
      for (let s = 0; s < 6; s++) z += Math.exp(l[s] - m);
      const i = order[a + k];
      for (let s = 0; s < 6; s++) sum[i * 6 + s] += w * (l[s] - m - Math.log(z));
      weight[i] += w;
    }
  }
  const out = new Float32Array(n * 6);
  for (let i = 0; i < n; i++) {
    let z = 0;
    for (let s = 0; s < 6; s++) z += out[i * 6 + s] = Math.exp(sum[i * 6 + s] / weight[i]);
    for (let s = 0; s < 6; s++) out[i * 6 + s] /= z;
  }
  return out;
}

/** The string model's probabilities and the fingering model's, combined: p_audio * p_fingering^w. */
export function combine(audio: ArrayLike<number>, finger: ArrayLike<number>, w: number): Float32Array {
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i += 6) {
    let z = 0;
    for (let s = 0; s < 6; s++) z += out[i + s] = Math.max(1e-4, audio[i + s]) * Math.max(1e-6, finger[i + s]) ** w * (audio[i + s] > 0 ? 1 : 0);
    if (z > 0) for (let s = 0; s < 6; s++) out[i + s] /= z;
  }
  return out;
}
