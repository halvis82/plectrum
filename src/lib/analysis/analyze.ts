// Full pipeline: mono 22.05 kHz audio -> CQT -> BTC model -> beat-synchronous chords.

import { estimateTempo, onsetEnvelope, trackBeats } from "./beats";
import { FRAMES_PER_CHUNK, N_BINS, SR, frameTimes, logCqt, type CqtBasis } from "./cqt";
import { N_CLASSES, beatChords, toSegments, viterbi, type Segment } from "./decode";

/** Decoding knobs (tuned on GuitarSet, see scripts/guitarset-tune.mts). */
export type DecodeOptions = {
  /** frame-level change penalty for the segment timeline */
  framePenalty: number;
  /** subtracted from the no-chord classes' log-prob: muted strumming is still a chord */
  noChordPenalty: number;
  /** a 7th/sus/6th must beat its plain triad by this much (mean log-prob per beat) */
  extensionMargin: number;
  /** beat-level change penalties: on the downbeat, on beat 3 of 4/4, elsewhere */
  downbeatPenalty: number;
  halfBarPenalty: number;
  offbeatPenalty: number;
};

export const DEFAULT_DECODE: DecodeOptions = {
  framePenalty: 4,
  noChordPenalty: 2,
  extensionMargin: 1.5,
  downbeatPenalty: 0.5,
  halfBarPenalty: 1,
  offbeatPenalty: 1.5,
};

/** Test-time pitch shifts (semitones). +-1 gained ~1.3 points on held-out GuitarSet players; +-2 added nothing. */
export const TTA_SHIFTS = [-1, 0, 1];

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

export async function analyze(
  y: Float32Array,
  basis: CqtBasis,
  meta: ModelMeta,
  run: RunWindow,
  onProgress?: Progress,
  opts: DecodeOptions = DEFAULT_DECODE,
): Promise<Analysis> {
  const frames = await chordFrames(y, basis, meta, run, onProgress, TTA_SHIFTS);
  onProgress?.("beats", 0.5);
  const r = rhythm(y);
  onProgress?.("beats", 1);
  return decode(frames, r, y.length / SR, opts);
}

export type ChordFrames = {
  logp: Float32Array;
  times: Float64Array;
  frames: number;
  /** 1 where the audio is near-silent: those frames may stay "no chord" */
  quiet: Uint8Array;
};

/**
 * CQT + BTC: per-frame chord log-probabilities. With `shifts`, the model also hears the audio
 * transposed by those semitones (CQT shifted 2 bins per semitone) and the predictions are
 * rotated back and averaged: cheap test-time augmentation.
 */
export async function chordFrames(
  y: Float32Array,
  basis: CqtBasis,
  meta: ModelMeta,
  run: RunWindow,
  onProgress?: Progress,
  shifts: number[] = [0],
): Promise<ChordFrames> {
  const { data, frames } = logCqt(y, basis, (p) => onProgress?.("features", p));
  const nWin = Math.ceil(frames / FRAMES_PER_CHUNK);
  const prob = new Float32Array(frames * N_CLASSES);
  const fill = (meta.mean - meta.mean) / meta.std; // shifted-in bins: the normalized mean, i.e. 0
  for (let w = 0; w < nWin; w++) {
    const from = w * FRAMES_PER_CHUNK, to = Math.min(frames, from + FRAMES_PER_CHUNK);
    for (const semis of shifts) {
      const x = new Float32Array(FRAMES_PER_CHUNK * N_BINS); // zero padding == padded mean in BTC
      const bins = semis * 2;
      for (let f = from; f < to; f++) {
        const row = (f - from) * N_BINS;
        for (let b = 0; b < N_BINS; b++) {
          const src = b - bins;
          x[row + b] = src >= 0 && src < N_BINS ? (data[f * N_BINS + src] - meta.mean) / meta.std : fill;
        }
      }
      const out = await run(x);
      for (let f = 0; f < to - from; f++) {
        for (let c = 0; c < N_CLASSES; c++) {
          // undo the transposition: class root r heard as r + semis
          const src = c >= 168 ? c : ((Math.floor(c / 14) + semis + 120) % 12) * 14 + (c % 14);
          prob[(from + f) * N_CLASSES + c] += Math.exp(out[f * N_CLASSES + src]) / shifts.length;
        }
      }
    }
    onProgress?.("chords", (w + 1) / nWin);
  }
  const logp = prob.map((v) => Math.log(v + 1e-9));
  const times = frameTimes(y.length, frames);
  return { logp, times, frames, quiet: quietFrames(y, times) };
}

/** Frames whose surrounding 0.2 s is more than 40 dB below the loudest part of the song. */
function quietFrames(y: Float32Array, times: Float64Array): Uint8Array {
  const half = Math.round(0.1 * SR);
  const rms = Array.from(times, (t) => {
    const c = Math.round(t * SR);
    let s = 0, n = 0;
    for (let i = Math.max(0, c - half); i < Math.min(y.length, c + half); i += 4, n++) s += y[i] * y[i];
    return Math.sqrt(s / Math.max(1, n));
  });
  const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.95)] ?? 0;
  return Uint8Array.from(rms, (r) => (r < loud * 0.01 ? 1 : 0));
}

export type Rhythm = { bpm: number; beats: number[] };

export function rhythm(y: Float32Array): Rhythm {
  const duration = y.length / SR;
  const env = onsetEnvelope(y);
  let bpm = estimateTempo(env);
  let beats = trackBeats(env, bpm);
  if (beats.length < 8) {
    // not enough rhythmic content (e.g. a quiet recording): fall back to a steady grid
    bpm = bpm > 40 && bpm < 220 ? bpm : 90;
    beats = [];
    for (let t = 0; t < duration; t += 60 / bpm) beats.push(t);
  }
  return { bpm, beats };
}

export function decode({ logp: raw, times, frames, quiet }: ChordFrames, { bpm, beats }: Rhythm, duration: number, opts: DecodeOptions = DEFAULT_DECODE): Analysis {
  let logp = raw;
  if (opts.noChordPenalty > 0) {
    logp = raw.slice();
    for (let f = 0; f < frames; f++) {
      if (quiet[f]) continue;
      logp[f * N_CLASSES + 168] -= opts.noChordPenalty;
      logp[f * N_CLASSES + 169] -= opts.noChordPenalty;
    }
  }
  const framePath = viterbi(logp, frames, N_CLASSES, opts.framePenalty);
  const segments = toSegments(framePath, times, duration).map(([s, e, c]) => [round(s), round(e), c] as Segment);
  const firstPass = Array.from(beatChords(logp, times, beats, duration));
  const { meter, downbeat } = chooseMeter(firstPass);
  // second pass: chord changes are cheap on downbeats, costlier mid-bar
  const penalties = beats.map((_, i) => {
    const pos = (((i - downbeat) % meter) + meter) % meter;
    return pos === 0 ? opts.downbeatPenalty : meter === 4 && pos === 2 ? opts.halfBarPenalty : opts.offbeatPenalty;
  });
  const chords = Array.from(beatChords(logp, times, beats, duration, penalties, opts.extensionMargin));
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
