// Decoder tuning on GuitarSet: runs the model once per file, then re-decodes with every
// parameter combination and writes bench-format outputs per combo for guitarset-sweep.py.
// Usage: npx tsx scripts/guitarset-tune.mts <f32-dir> <out-root>
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as ort from "onnxruntime-node";
import { DEFAULT_DECODE, chordFrames, decode, rhythm, type DecodeOptions, type ModelMeta } from "../src/lib/analysis/analyze";
import { SR, parseBasis } from "../src/lib/analysis/cqt";
import { labelFromIndex } from "../src/lib/music";

const [, , inDir, outRoot, shiftArg = "0"] = process.argv;
const shifts = shiftArg.split(",").map(Number);
const b = readFileSync("public/model/cqt_basis.v1.bin");
const basis = parseBasis(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const meta: ModelMeta = JSON.parse(readFileSync("public/model/btc170.v1.json", "utf8"));
const session = await ort.InferenceSession.create("public/model/btc170.v1.onnx");
const run = async (x: Float32Array) => (await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) })).logp.data as Float32Array;

const files = readdirSync(inDir).filter((f) => f.endsWith(".f32")).sort();
const cache = [];
for (const f of files) {
  const buf = readFileSync(join(inDir, f));
  const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  cache.push({ f, frames: await chordFrames(y, basis, meta, run, undefined, shifts), r: rhythm(y), duration: y.length / SR });
}
console.log(`cached ${cache.length} files`);

const grid: Record<string, Partial<DecodeOptions>> = {};
for (const ext of [1, 1.5])
  for (const nc of [2])
    for (const scale of [0.5]) {
      grid[`ext${ext}_nc${nc}_pen${scale}`] = {
        extensionMargin: ext,
        noChordPenalty: nc,
        downbeatPenalty: DEFAULT_DECODE.downbeatPenalty * scale,
        halfBarPenalty: DEFAULT_DECODE.halfBarPenalty * scale,
        offbeatPenalty: DEFAULT_DECODE.offbeatPenalty * scale,
      };
    }
for (const [name, o] of Object.entries(grid)) {
  const dir = join(outRoot, name);
  mkdirSync(dir, { recursive: true });
  for (const { f, frames, r, duration } of cache) {
    const res = decode(frames, r, duration, { ...DEFAULT_DECODE, ...o });
    const beat = res.chords.map((c, i) => [res.beats[i], res.beats[i + 1] ?? res.duration, labelFromIndex(c)]);
    const seg = res.segments.map(([s, e, c]) => [s, e, labelFromIndex(c)]);
    writeFileSync(join(dir, basename(f, ".f32") + ".json"), JSON.stringify({ file: f, duration: res.duration, beat, seg }));
  }
}
console.log(`wrote ${Object.keys(grid).length} combos`);
