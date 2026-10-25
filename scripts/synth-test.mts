// Accuracy check on synthetic strummed guitar with a known progression.
// Usage: npx tsx scripts/synth-test.mts [--mic]   (--mic simulates a phone mic: reverb, band-limit, noise)
import { readFileSync } from "fs";
import * as ort from "onnxruntime-node";
import { analyze, type ModelMeta } from "../src/lib/analysis/analyze";
import { parseBasis, SR } from "../src/lib/analysis/cqt";
import { labelFromIndex, parseLabel, chordName, simplify, type Chord } from "../src/lib/music";
import shapes from "../src/lib/chord-shapes.json";

const OPEN = [40, 45, 50, 55, 59, 64]; // E A D G B E
const progression = ["7:maj", "2:maj", "4:min", "0:maj", "9:min7", "2:7", "7:maj", "0:maj7", "11:min", "4:7", "9:sus4", "9:maj", "2:sus2", "6:min", "4:maj", "9:maj"];
const BPM = 100, BEATS_PER_CHORD = 4, REPEATS = 2;
const beat = 60 / BPM;
const total = progression.length * BEATS_PER_CHORD * REPEATS * beat + 2;
const y = new Float32Array(Math.ceil(total * SR));
let seed = 1;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

function pluck(midi: number, t0: number, dur: number, amp: number) {
  const f = 440 * 2 ** ((midi - 69) / 12);
  const N = Math.round(SR / f);
  const buf = Float32Array.from({ length: N }, () => rand() * 2 - 1);
  const start = Math.round(t0 * SR), len = Math.round(dur * SR);
  for (let i = 0; i < len && start + i < y.length; i++) {
    const k = i % N, v = buf[k];
    buf[k] = 0.996 * 0.5 * (v + buf[(k + 1) % N]);
    y[start + i] += v * amp;
  }
}

const truth: Chord[] = [];
let t = 0.5;
for (let r = 0; r < REPEATS; r++) {
  for (const label of progression) {
    const shape = (shapes as Record<string, { f: number[]; b: number }[]>)[label][0];
    const notes = shape.f.map((fret, s) => (fret < 0 ? -1 : OPEN[s] + (fret === 0 ? 0 : fret + shape.b - 1))).filter((n) => n > 0);
    const [root, q] = label.split(":");
    for (let b = 0; b < BEATS_PER_CHORD; b++) {
      const tb = t + b * beat;
      truth.push({ root: Number(root), quality: q as Chord extends null ? never : NonNullable<Chord>["quality"] });
      notes.forEach((n, i) => pluck(n, tb + (b % 2 ? (notes.length - i) : i) * 0.012, beat * 1.2, 0.18));
      pluck(28 + ((Number(root) - 4 + 12) % 12), tb, beat, 0.3); // bass root
      for (let i = 0; i < 0.08 * SR; i++) {
        const j = Math.round(tb * SR) + i;
        if (j < y.length) y[j] += 0.5 * Math.sin(2 * Math.PI * (60 - 300 * i / SR) * i / SR) * Math.exp(-i / (0.02 * SR));
      }
    }
    t += BEATS_PER_CHORD * beat;
  }
}

if (process.argv.includes("--mic")) {
  // room: a few decaying echoes
  for (const [d, g] of [[0.023, 0.5], [0.041, 0.4], [0.067, 0.3], [0.11, 0.2]] as const) {
    const off = Math.round(d * SR);
    for (let i = y.length - 1; i >= off; i--) y[i] += g * y[i - off];
  }
  // tiny speaker + mic: high-pass ~250 Hz, low-pass ~5 kHz, then hiss and hum
  let hp = 0, lp = 0, prev = 0;
  const a = Math.exp((-2 * Math.PI * 250) / SR), c = 1 - Math.exp((-2 * Math.PI * 5000) / SR);
  for (let i = 0; i < y.length; i++) {
    hp = a * (hp + y[i] - prev);
    prev = y[i];
    lp += c * (hp - lp);
    y[i] = lp + 0.03 * (rand() * 2 - 1) + 0.02 * Math.sin((2 * Math.PI * 60 * i) / SR);
  }
}

const b = readFileSync("public/model/cqt_basis.bin");
const basis = parseBasis(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const meta: ModelMeta = JSON.parse(readFileSync("public/model/btc170.json", "utf8"));
const session = await ort.InferenceSession.create("public/model/btc170.onnx");
const res = await analyze(y, basis, meta, async (x) => (await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) })).logp.data as Float32Array);
console.log(`bpm ${res.bpm} (true ${BPM}), meter ${res.meter}, beats ${res.beats.length} (true ${truth.length})`);

let exact = 0, triad = 0, n = 0;
const errors = new Map<string, number>();
for (let i = 0; i < res.beats.length; i++) {
  const k = Math.round((res.beats[i] - 0.5) / beat);
  if (k < 0 || k >= truth.length) continue;
  n++;
  const got = parseLabel(labelFromIndex(res.chords[i])), want = truth[k];
  if (got && want && got.root === want.root && got.quality === want.quality) exact++;
  else errors.set(`${chordName(want)} -> ${chordName(got)}`, (errors.get(`${chordName(want)} -> ${chordName(got)}`) ?? 0) + 1);
  const gs = simplify(got, "triads"), ws = simplify(want, "triads");
  if (gs && ws && gs.root === ws.root && gs.quality === ws.quality) triad++;
}
console.log(`exact chord: ${(exact / n * 100).toFixed(1)}%   root+maj/min: ${(triad / n * 100).toFixed(1)}%   (${n} beats)`);
console.log("errors:", [...errors.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10));
