// The tuner's reading from the microphone, frame by frame: kept apart from the page so it can be
// tested on recordings (scripts/eval/tuner.mts).
import { detectPitch, midiOf } from "./pitch";

/** analysis frame, in samples after decimation to about 24 kHz: 128 ms holds 10 periods of low E */
export const FRAME = 3072;
/** the page reads a frame this often (ms) */
export const STEP_MS = 40;
/** the first moment of a pluck rings sharp; readings wait this long after one (ms) */
const ATTACK_MS = 120;
/** a different note has to hold this many frames before the reading moves to it */
const SWITCH_FRAMES = 3;

export type TunerReading = { midi: number; clarity: number };

export class TunerTracker {
  private recent: number[] = [];
  private smooth: number | null = null;
  private level = 0;
  private attackLeft = 0;
  private quiet = 0;
  private other: number[] = [];

  /** One frame (FRAME samples at `sr`); the reading to show, or null for none. */
  push(x: Float32Array, sr: number): TunerReading | null {
    let rms = 0;
    for (let i = 0; i < x.length; i++) rms += x[i] * x[i];
    rms = Math.sqrt(rms / x.length);
    // a new pluck: much louder than the ringing before it
    if (rms > 0.004 && rms > 2.5 * this.level) this.attackLeft = Math.ceil(ATTACK_MS / STEP_MS);
    this.level = rms > this.level ? rms : 0.8 * this.level + 0.2 * rms;
    if (this.attackLeft > 0) {
      this.attackLeft--;
      return this.hold();
    }
    const p = rms > 0.004 ? detectPitch(x, sr, 60, 1100) : null;
    if (!p || p.clarity < 0.8) return this.hold();
    this.quiet = 0;
    const m = midiOf(p.hz);
    if (this.smooth !== null && Math.abs(m - this.smooth) > 0.5) {
      // another note: only once it holds (a stray frame on an overtone doesn't move the needle)
      if (this.other.length && Math.abs(m - this.other[this.other.length - 1]) > 0.3) this.other = [];
      this.other.push(m);
      if (this.other.length < SWITCH_FRAMES) return this.shown(p.clarity);
      this.recent = [...this.other];
      this.smooth = null;
    }
    this.other = [];
    this.recent.push(m);
    if (this.recent.length > 5) this.recent.shift();
    const med = [...this.recent].sort((a, b) => a - b)[this.recent.length >> 1];
    this.smooth = this.smooth === null ? med : this.smooth + 0.3 * (med - this.smooth);
    return this.shown(p.clarity);
  }

  private shown(clarity: number) {
    return this.smooth === null ? null : { midi: this.smooth, clarity };
  }

  /** nothing to read this frame: the last reading stays a moment as the string dies away */
  private hold() {
    if (++this.quiet * STEP_MS > 1500) {
      this.smooth = null;
      this.recent = [];
      this.other = [];
    }
    return this.shown(1);
  }
}
