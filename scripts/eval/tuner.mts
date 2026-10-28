// The tuner on recorded single notes (clips.json + .f32 at 48 kHz, see scripts/eval/tuner-clips.py):
// how often the shown note is off by more than 50 cents (the needle pinned to one side), how often
// nothing shows, and how much the needle wobbles while one note rings.
// Usage: npx tsx scripts/eval/tuner.mts <clips dir>
import { readFileSync } from "fs";
import { FRAME, STEP_MS, TunerTracker } from "../../src/lib/tuner";

const DIR = process.argv[2];
const SR = 48000;
const DEC = 2;
const clips = JSON.parse(readFileSync(`${DIR}/clips.json`, "utf8")) as { file: string; src: string; cond: string; midi: number }[];

/** the page's 55 Hz high-pass (Web Audio biquad, Q 1 dB) */
function highpass(x: Float32Array, f0: number) {
  const w = (2 * Math.PI * f0) / SR, q = 10 ** (1 / 20), al = Math.sin(w) / (2 * q), c = Math.cos(w);
  const [b0, b1, b2, a0, a1, a2] = [(1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al];
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    [x2, x1, y2, y1] = [x1, x[i], y1, v];
    y[i] = v;
  }
  return y;
}

const stats: Record<string, { n: number; gross: number; none: number; err: number[]; wobble: number[] }> = {};
for (const c of clips) {
  const y = highpass(new Float32Array(readFileSync(`${DIR}/${c.file}`).buffer.slice(0)), 55);
  const t = new TunerTracker();
  const x = new Float32Array(FRAME);
  const shown: (number | null)[] = [];
  for (let end = FRAME * DEC; end <= y.length; end += (SR * STEP_MS) / 1000) {
    for (let i = 0; i < FRAME; i++) x[i] = (y[end - FRAME * DEC + i * DEC] + y[end - FRAME * DEC + i * DEC + 1]) / 2;
    shown.push(t.push(x, SR / DEC)?.midi ?? null);
  }
  // EARLY=1: the first half second, as the pluck rings sharp; else from 0.5 s on
  // SESSION=1: a whole tuning session (scripts/eval/tuner-session.py)
  const steps = process.env.SESSION ? shown.slice(8) : process.env.EARLY ? shown.slice(0, 12) : shown.slice(12, 55);
  const s = (stats[`${c.src}-${c.cond}`] ??= { n: 0, gross: 0, none: 0, err: [], wobble: [] });
  const good: number[] = [];
  for (const m of steps) {
    s.n++;
    if (m === null) s.none++;
    else if (Math.abs(m - c.midi) > 0.5) {
      s.gross++;
      if (process.env.DEBUG) console.log("off", c.file, c.src, c.cond, "true", c.midi.toFixed(2), "shown", m.toFixed(2));
    }
    else (s.err.push(Math.abs(m - c.midi) * 100), good.push(m * 100));
  }
  if (good.length > 3) {
    const mean = good.reduce((a, b) => a + b, 0) / good.length;
    s.wobble.push(Math.sqrt(good.reduce((a, b) => a + (b - mean) ** 2, 0) / good.length));
  }
}
const q = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.floor(v.length * p)] ?? NaN;
for (const [k, s] of Object.entries(stats).sort()) {
  console.log(`${k.padEnd(14)} off >50c ${((100 * s.gross) / s.n).toFixed(1).padStart(5)}%  no reading ${((100 * s.none) / s.n).toFixed(1).padStart(5)}%  median err ${q(s.err, 0.5).toFixed(1)}c  p90 ${q(s.err, 0.9).toFixed(1)}c  wobble ${q(s.wobble, 0.5).toFixed(1)}c (worst ${Math.max(...s.wobble).toFixed(1)}c)`);
}
