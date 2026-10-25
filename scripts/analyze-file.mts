// Dev harness: runs the browser analysis pipeline in Node on a raw float32 22.05 kHz mono file.
// Usage: npx tsx scripts/analyze-file.mts audio.f32 [out.json]
import { readFileSync, writeFileSync } from "fs";
import * as ort from "onnxruntime-node";
import { analyze, type ModelMeta } from "../src/lib/analysis/analyze";
import { parseBasis } from "../src/lib/analysis/cqt";
import { chordName, parseLabel, labelFromIndex, detectKey, keyName, capoOptions } from "../src/lib/music";

const [, , input, outPath] = process.argv;
const buf = readFileSync(input);
const y = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const b = readFileSync("public/model/cqt_basis.bin");
const basis = parseBasis(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
const meta: ModelMeta = JSON.parse(readFileSync("public/model/btc170.json", "utf8"));

const session = await ort.InferenceSession.create("public/model/btc170.onnx");
const t0 = Date.now();
const res = await analyze(y, basis, meta, async (x) => {
  const out = await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) });
  return out.logp.data as Float32Array;
});
console.log(`analyzed ${res.duration}s in ${Date.now() - t0}ms, bpm ${res.bpm}, meter ${res.meter}, downbeat ${res.downbeat}, beats ${res.beats.length}`);
const items = res.chords.map((c, i) => ({ chord: parseLabel(labelFromIndex(c)), dur: (res.beats[i + 1] ?? res.duration) - res.beats[i] }));
const key = detectKey(items);
console.log("key", keyName(key), "capo", capoOptions(items).slice(0, 3));
let line = "";
for (let i = res.downbeat; i < res.chords.length; i += res.meter) {
  const bar = res.chords.slice(i, i + res.meter).map((c) => chordName(parseLabel(labelFromIndex(c))));
  line += "| " + bar.map((c, j) => (j > 0 && c === bar[j - 1] ? "." : c)).join(" ").padEnd(22);
  if (((i - res.downbeat) / res.meter) % 4 === 3) { console.log(line + "|"); line = ""; }
}
if (line) console.log(line + "|");
if (outPath) writeFileSync(outPath, JSON.stringify(res));
