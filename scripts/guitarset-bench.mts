// Benchmark harness: runs the analysis pipeline over every .f32 file (raw float32 mono 22.05 kHz) in a
// directory, in one process, and writes one JSON per file with beat-level and segment-level chord labels.
// Usage: npx tsx scripts/guitarset-bench.mts <f32-dir> <out-dir>
// Scoring is done separately (mir_eval), e.g. scripts/guitarset-score.py.
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import * as ort from "onnxruntime-node";
import { analyze, type ModelMeta } from "../src/lib/analysis/analyze";
import { parseBasis } from "../src/lib/analysis/cqt";
import { labelFromIndex } from "../src/lib/music";

const [, , inDir, outDir] = process.argv;
if (!inDir || !outDir) {
  console.error("usage: npx tsx scripts/guitarset-bench.mts <f32-dir> <out-dir>");
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });
const b = readFileSync("public/model/cqt_basis.v1.bin");
const basis = parseBasis(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const meta: ModelMeta = JSON.parse(readFileSync("public/model/btc170.v1.json", "utf8"));
const session = await ort.InferenceSession.create("public/model/btc170.v1.onnx");
const run = async (x: Float32Array) => {
  const out = await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) });
  return out.logp.data as Float32Array;
};

const files = readdirSync(inDir).filter((f) => f.endsWith(".f32")).sort();
const t0 = Date.now();
for (const [n, f] of files.entries()) {
  const outPath = join(outDir, basename(f, ".f32") + ".json");
  if (existsSync(outPath)) continue;
  const buf = readFileSync(join(inDir, f));
  const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const res = await analyze(y, basis, meta, run);
  const beat = res.chords.map((c, i) => [res.beats[i], res.beats[i + 1] ?? res.duration, labelFromIndex(c)]);
  const seg = res.segments.map(([s, e, c]) => [s, e, labelFromIndex(c)]);
  writeFileSync(outPath, JSON.stringify({ file: f, duration: res.duration, bpm: res.bpm, meter: res.meter, beat, seg }));
  console.log(`[${n + 1}/${files.length}] ${f} bpm ${res.bpm} beats ${res.beats.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
