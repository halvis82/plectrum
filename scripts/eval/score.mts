// Scores the app's note and tab pipeline on evaluation sets made by refs.py (<name>.f32 + <name>.json).
// Guitar-model activations are cached next to the audio (<name>.<model file name>.act), so re-scoring
// is quick; the default model's cache is plain <name>.act.
// Usage: npx tsx scripts/eval/score.mts <guitar model.onnx (export.py --single)> <strings.onnx> <set dir>...
//   SPLIT=1 prints each file too; ONSET=<threshold> and FRAME=<threshold> override the note decoding. Notes match on onset (50 ms) and pitch; the tab also needs the string.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as ort from "onnxruntime-node";
import { DEFAULT_GUITAR_NOTES, GUITAR_SR, SEGMENT, decodeGuitarNotes, guitarActivations, resampleTo } from "../../src/lib/analysis/guitar";
import { stringProbs } from "../../src/lib/analysis/strings";
import { STANDARD, toTab, type TabNote } from "../../src/lib/tab";

const [, , modelPath, stringsPath, ...dirs] = process.argv;
const opts = { intraOpNumThreads: 3, interOpNumThreads: 1 };
const guitar = await ort.InferenceSession.create(modelPath, opts);
const strings = await ort.InferenceSession.create(stringsPath, opts);
const runGuitar = async (x: Float32Array, n: number) => {
  const o = await guitar.run({ audio: new ort.Tensor("float32", x, [n, SEGMENT]) });
  return { onset: o.onset.data as Float32Array, offset: o.offset.data as Float32Array, frame: o.frame.data as Float32Array, velocity: o.velocity.data as Float32Array };
};
const runStrings = async (p: Float32Array, m: Float32Array, n: number) =>
  (await strings.run({ patch: new ort.Tensor("float32", p, [n, 12, 200]), midi: new ort.Tensor("float32", m, [n]) })).logits.data as Float32Array;

type Ref = { start: number; midi: number; string: number };
function match<T extends { start: number; midi: number }>(ref: Ref[], est: T[]): [Ref, T][] {
  const pairs: [number, number, number][] = [];
  let j0 = 0;
  for (const [i, r] of ref.entries()) {
    while (j0 < est.length && est[j0].start < r.start - 0.05) j0++;
    for (let j = j0; j < est.length && est[j].start <= r.start + 0.05; j++) if (est[j].midi === r.midi) pairs.push([Math.abs(est[j].start - r.start), i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const ur = new Set<number>(), ue = new Set<number>(), out: [Ref, T][] = [];
  for (const [, i, j] of pairs) if (!ur.has(i) && !ue.has(j)) ur.add(i), ue.add(j), out.push([ref[i], est[j]]);
  return out;
}

const pct = (x: number) => (100 * x).toFixed(1);
const f1 = (h: number, e: number, r: number) => (e && r && h ? (2 * h) / (e + r) : 0);
for (const dir of dirs) {
  const tot = { ref: 0, est: 0, hit: 0, strRef: 0, strHit: 0, tabHit: 0, modelHit: 0 };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".f32")).sort()) {
    const name = basename(f, ".f32");
    const b = readFileSync(join(dir, f));
    const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const tag = basename(modelPath, ".onnx");
    const actPath = join(dir, tag === "fl" ? name + ".act" : `${name}.${tag}.act`);
    let acts;
    if (existsSync(actPath)) {
      const a = readFileSync(actPath);
      const all = new Float32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
      const n = all.length / 4;
      acts = { onset: all.subarray(0, n), offset: all.subarray(n, 2 * n), frame: all.subarray(2 * n, 3 * n), velocity: all.subarray(3 * n), frames: n / 88 };
    } else {
      acts = await guitarActivations(resampleTo(y, 22050, GUITAR_SR), runGuitar);
      const all = new Float32Array(acts.frames * 88 * 4);
      (["onset", "offset", "frame", "velocity"] as const).forEach((k, i) => all.set(acts![k].subarray(0, acts!.frames * 88), i * acts!.frames * 88));
      writeFileSync(actPath, Buffer.from(all.buffer));
    }
    const thresholds = { ...DEFAULT_GUITAR_NOTES, ...(process.env.ONSET ? { onset: Number(process.env.ONSET) } : {}), ...(process.env.FRAME ? { frame: Number(process.env.FRAME) } : {}) };
    const notes = decodeGuitarNotes(acts, thresholds).filter((n) => n.midi >= 40 && n.midi <= 88);
    const p = await stringProbs(y, notes, runStrings);
    const tab = toTab(notes.map((n, i) => ({ ...n, strings: p.subarray(i * 6, i * 6 + 6) })), STANDARD);
    const ref = (JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")) as number[][]).map(([start, , midi, string]) => ({ start, midi, string })).filter((r) => r.midi >= 40 && r.midi <= 88);
    const hits = match(ref, tab as TabNote[]);
    const withStr = hits.filter(([r]) => r.string >= 0);
    const strHit = withStr.filter(([r, e]) => r.string === e.string).length;
    // the string model's own first choice, before the fingering pass weighs hand position
    const argmax = (st: ArrayLike<number>) => Array.from(st).reduce((b, v, k, a) => (v > a[b] ? k : b), 0);
    tot.modelHit += withStr.filter(([r, e]) => e.strings && argmax(e.strings) === r.string).length;
    tot.ref += ref.length;
    tot.est += tab.length;
    tot.hit += hits.length;
    tot.strRef += withStr.length;
    tot.strHit += strHit;
    tot.tabHit += strHit;
    if (process.env.SPLIT) console.log(`  ${name}: notes F1 ${pct(f1(hits.length, tab.length, ref.length))} (P ${pct(hits.length / tab.length)} R ${pct(hits.length / ref.length)})${withStr.length ? ` string ${pct(strHit / withStr.length)}` : ""}`);
  }
  const strPart = tot.strRef ? ` | right string ${pct(tot.strHit / tot.strRef)} (string model alone ${pct(tot.modelHit / tot.strRef)}) | tab F1 ${pct(f1(tot.tabHit, tot.est, tot.ref))}` : "";
  console.log(`${basename(dir)}: notes P ${pct(tot.hit / tot.est)} R ${pct(tot.hit / tot.ref)} F1 ${pct(f1(tot.hit, tot.est, tot.ref))}${strPart}`);
}
