// Full pipeline: mono 22.05 kHz audio -> CQT -> BTC model -> beat-synchronous chords.

import { estimateTempo, onsetEnvelope, trackBeats } from "./beats";
import { FRAMES_PER_CHUNK, N_BINS, SR, frameTimes, logCqt, type CqtBasis } from "./cqt";
import { N_CLASSES, beatChords, toSegments, viterbi, type Segment } from "./decode";

export type ModelMeta = { mean: number; std: number; labels: string[] };
/** Runs BTC on one window (108 x 144 normalized features) and returns 108 x 170 log-probs. */
export type RunWindow = (x: Float32Array) => Promise<Float32Array>;

export type Analysis = {
  v: 1;
  duration: number;
  bpm: number;
  meter: number;
  /** index of the first beat that starts a bar */
  downbeat: number;
  beats: number[];
  /** chord class index (BTC vocabulary) per beat */
  chords: number[];
  /** frame-level smoothed segments [start, end, class] */
  segments: Segment[];
};

export type Progress = (stage: "features" | "chords" | "beats", p: number) => void;

export async function analyze(y: Float32Array, basis: CqtBasis, meta: ModelMeta, run: RunWindow, onProgress?: Progress): Promise<Analysis> {
  const duration = y.length / SR;
  const { data, frames } = logCqt(y, basis, (p) => onProgress?.("features", p));
  const nWin = Math.ceil(frames / FRAMES_PER_CHUNK);
  const logp = new Float32Array(frames * N_CLASSES);
  for (let w = 0; w < nWin; w++) {
    const x = new Float32Array(FRAMES_PER_CHUNK * N_BINS); // zero padding == padded mean in BTC
    const from = w * FRAMES_PER_CHUNK, to = Math.min(frames, from + FRAMES_PER_CHUNK);
    for (let i = from * N_BINS; i < to * N_BINS; i++) x[i - from * N_BINS] = (data[i] - meta.mean) / meta.std;
    const out = await run(x);
    logp.set(out.subarray(0, (to - from) * N_CLASSES), from * N_CLASSES);
    onProgress?.("chords", (w + 1) / nWin);
  }
  const times = frameTimes(y.length, frames);
  const framePath = viterbi(logp, frames, N_CLASSES, 4);
  const segments = toSegments(framePath, times, duration).map(
    ([s, e, c]) => [round(s), round(e), c] as Segment,
  );

  const env = onsetEnvelope(y);
  onProgress?.("beats", 0.5);
  let bpm = estimateTempo(env);
  let beats = trackBeats(env, bpm);
  if (beats.length < 8) {
    // not enough rhythmic content (e.g. a quiet recording): fall back to a steady grid
    bpm = bpm > 40 && bpm < 220 ? bpm : 90;
    beats = [];
    for (let t = 0; t < duration; t += 60 / bpm) beats.push(t);
  }
  const firstPass = Array.from(beatChords(logp, times, beats, duration));
  const { meter, downbeat } = chooseMeter(firstPass);
  // second pass: chord changes are cheap on downbeats, costlier mid-bar
  const penalties = beats.map((_, i) => {
    const pos = (((i - downbeat) % meter) + meter) % meter;
    return pos === 0 ? 1 : meter === 4 && pos === 2 ? 2 : 3;
  });
  const chords = Array.from(beatChords(logp, times, beats, duration, penalties));
  onProgress?.("beats", 1);
  return { v: 1, duration: round(duration), bpm: Math.round(bpm * 10) / 10, meter, downbeat, beats: beats.map(round), chords, segments };
}

/** Pick 3/4 or 4/4 and the bar phase that puts the most chord changes on downbeats. */
export function chooseMeter(chords: number[]): { meter: number; downbeat: number } {
  const changes: number[] = [];
  for (let i = 1; i < chords.length; i++) if (chords[i] !== chords[i - 1]) changes.push(i);
  if (changes.length === 0) return { meter: 4, downbeat: 0 };
  const best = (m: number) => {
    let top = { phase: 0, frac: -1 };
    for (let phase = 0; phase < m; phase++) {
      const hits = changes.filter((i) => (i - phase) % m === 0).length;
      const frac = hits / changes.length;
      if (frac > top.frac) top = { phase, frac };
    }
    return top;
  };
  const four = best(4), three = best(3);
  // compare lift over chance (uniform phases give frac = 1/m), with a bias toward 4/4
  const lift4 = four.frac * 4, lift3 = three.frac * 3;
  if (lift3 > 1.3 && lift3 > lift4 * 1.15) return { meter: 3, downbeat: three.phase };
  return { meter: 4, downbeat: four.phase };
}

const round = (t: number) => Math.round(t * 1000) / 1000;
