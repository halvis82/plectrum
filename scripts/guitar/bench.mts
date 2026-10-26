// Runs the guitar transcription model over every .f32 file (raw float32 mono 22.05 kHz) through the
// app's own TypeScript pipeline (resampling, windowing) and caches the activations for tab-score.mts.
// Usage: npx tsx scripts/guitar/bench.mts <f32-dir> <model.onnx> <out-dir> [file-substring]
//   <model.onnx> is a self-contained float32 export (scripts/guitar/export.py --single).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as ort from "onnxruntime-node";
import { GUITAR_SR, SEGMENT, guitarActivations, resampleTo } from "../../src/lib/analysis/guitar";
import { SR } from "../../src/lib/analysis/cqt";

const [, , inDir, modelPath, outDir, only = ""] = process.argv;
mkdirSync(join(outDir, "act"), { recursive: true });
const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: 4 });
const run = async (x: Float32Array, n: number) => {
  const o = await session.run({ audio: new ort.Tensor("float32", x, [n, SEGMENT]) });
  return { onset: o.onset.data as Float32Array, offset: o.offset.data as Float32Array, frame: o.frame.data as Float32Array, velocity: o.velocity.data as Float32Array };
};
const t0 = Date.now();
let audioSeconds = 0;
for (const f of readdirSync(inDir).filter((f) => f.endsWith(".f32") && f.includes(only)).sort()) {
  const name = basename(f, ".f32");
  const out = join(outDir, "act", name + ".bin");
  if (existsSync(out)) continue;
  const b = readFileSync(join(inDir, f));
  const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  audioSeconds += y.length / SR;
  const a = await guitarActivations(resampleTo(y, SR, GUITAR_SR), run);
  // onset, offset, frame, velocity, each frames x 88
  const all = new Float32Array(a.frames * 88 * 4);
  ["onset", "offset", "frame", "velocity"].forEach((k, i) => all.set((a as unknown as Record<string, Float32Array>)[k].subarray(0, a.frames * 88), i * a.frames * 88));
  writeFileSync(out, Buffer.from(all.buffer));
  writeFileSync(join(outDir, name + ".json"), "{}");
}
console.log(`${audioSeconds.toFixed(0)} s of audio in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
