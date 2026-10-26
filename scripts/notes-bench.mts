// Note/tab benchmark harness: transcribes every .f32 file (raw float32 mono 22.05 kHz) in a directory
// and writes one JSON per file with the decoded notes. Raw activations are cached next to the output
// so decoding options can be swept without rerunning the model.
// Usage: npx tsx scripts/notes-bench.mts <f32-dir> <out-dir> [file-substring]
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "fs";
import { join, basename } from "path";
import * as ort from "onnxruntime-node";
import { decodeNotes, noteActivations, type Activations } from "../src/lib/analysis/notes";

const [, , inDir, outDir, only = ""] = process.argv;
mkdirSync(join(outDir, "act"), { recursive: true });
const session = await ort.InferenceSession.create("public/model/basicpitch.v1.onnx");
const run = async (x: Float32Array) => {
  const out = await session.run({ "serving_default_input_2:0": new ort.Tensor("float32", x, [1, x.length, 1]) });
  return { note: out["StatefulPartitionedCall:1"].data as Float32Array, onset: out["StatefulPartitionedCall:2"].data as Float32Array };
};

const files = readdirSync(inDir).filter((f) => f.endsWith(".f32") && f.includes(only)).sort();
const t0 = Date.now();
for (const [n, f] of files.entries()) {
  const name = basename(f, ".f32");
  const actPath = join(outDir, "act", name + ".bin");
  let act: Activations;
  if (existsSync(actPath)) {
    const b = readFileSync(actPath);
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const half = all.length / 2;
    act = { note: all.slice(0, half), onset: all.slice(half), frames: half / 88 };
  } else {
    const buf = readFileSync(join(inDir, f));
    const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    act = await noteActivations(y, run);
    const all = new Float32Array(act.note.length * 2);
    all.set(act.note);
    all.set(act.onset, act.note.length);
    writeFileSync(actPath, new Uint8Array(all.buffer));
  }
  const notes = decodeNotes(act);
  writeFileSync(join(outDir, name + ".json"), JSON.stringify({ file: f, notes }));
  console.log(`[${n + 1}/${files.length}] ${f} notes ${notes.length} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
