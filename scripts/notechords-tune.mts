// Tunes the note-based chord evidence (src/lib/analysis/notechords.ts) on GuitarSet comping: BTC
// frames are computed once per file, notes come from cached guitar-model activations, and every
// option set is decoded and written in guitarset-bench format, split into players 00-02 (tune) and
// 03-05 (held), for guitarset-score.py.
// Usage: npx tsx scripts/notechords-tune.mts <f32-dir> <act-dir> <out-root> '<json array of options>'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as ort from "onnxruntime-node";
import { TTA_SHIFTS, chordFrames, decode, rhythm, type ModelMeta } from "../src/lib/analysis/analyze";
import { SR, parseBasis } from "../src/lib/analysis/cqt";
import { decodeGuitarNotes } from "../src/lib/analysis/guitar";
import { DEFAULT_NOTE_CHORDS, noteChordScores } from "../src/lib/analysis/notechords";
import { labelFromIndex } from "../src/lib/music";

const [, , inDir, actDir, outRoot, optArg] = process.argv;
const sets = JSON.parse(optArg) as Partial<typeof DEFAULT_NOTE_CHORDS>[];
const b = readFileSync("public/model/cqt_basis.v1.bin");
const basis = parseBasis(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const meta: ModelMeta = JSON.parse(readFileSync("public/model/btc170.v1.json", "utf8"));
const session = await ort.InferenceSession.create("public/model/btc170.v1.onnx");
const run = async (x: Float32Array) => (await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) })).logp.data as Float32Array;

for (const f of readdirSync(inDir).filter((f) => f.endsWith("_comp_mic.f32")).sort()) {
  const name = basename(f, ".f32");
  const buf = readFileSync(join(inDir, f));
  const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const frames = await chordFrames(y, basis, meta, run, undefined, TTA_SHIFTS);
  const r = rhythm(y);
  const ab = readFileSync(join(actDir, name + ".bin"));
  const all = new Float32Array(ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength));
  const n = all.length / 4;
  const notes = decodeGuitarNotes({ onset: all.subarray(0, n), offset: all.subarray(n, 2 * n), frame: all.subarray(2 * n, 3 * n), velocity: all.subarray(3 * n), frames: n / 88 });
  for (const [k, o] of sets.entries()) {
    const ev = noteChordScores(notes, frames.times, { ...DEFAULT_NOTE_CHORDS, ...o });
    const logp = frames.logp.map((v, i) => v + ev[i]);
    const res = decode({ ...frames, logp }, r, y.length / SR);
    const dir = join(outRoot, String(k), Number(name.slice(0, 2)) <= 2 ? "tune" : "held");
    mkdirSync(dir, { recursive: true });
    const beat = res.chords.map((c, i) => [res.beats[i], res.beats[i + 1] ?? res.duration, labelFromIndex(c)]);
    const seg = res.segments.map(([s, e, c]) => [s, e, labelFromIndex(c)]);
    writeFileSync(join(dir, name + ".json"), JSON.stringify({ file: f, duration: res.duration, bpm: res.bpm, meter: res.meter, beat, seg }));
  }
  process.stdout.write(".");
}
console.log();
sets.forEach((o, k) => console.log(k, JSON.stringify(o)));
