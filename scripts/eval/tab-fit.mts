// Fits the fingering costs (DEFAULT_TAB in src/lib/tab.ts) on the app's own detected notes, so the
// fit sees the same false notes, misses and string-model probabilities the app does. Each set dir is
// from refs.py; notes and string probabilities are cached per file (<name>.<strings model>.notes.json).
// Coordinate search on the fit sets, scored by the share of matched notes on the right string.
// Usage: npx tsx scripts/eval/tab-fit.mts <guitar model.onnx> <strings.onnx> <rounds> fit:<dir>[@<strings.onnx>]... held:<dir>[@<strings.onnx>]...
//   a set's own strings model should be one that never trained on its players; START=<json> starts from other costs
import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { basename, join } from "path";
import * as ort from "onnxruntime-node";
import { DEFAULT_GUITAR_NOTES, GUITAR_SR, SEGMENT, decodeGuitarNotes, guitarActivations, resampleTo } from "../../src/lib/analysis/guitar";
import { stringProbs } from "../../src/lib/analysis/strings";
import { DEFAULT_TAB, STANDARD, toTab, type TabInput, type TabOptions } from "../../src/lib/tab";

const [, , modelPath, stringsPath, rounds, ...specs] = process.argv;
const opts = { intraOpNumThreads: 3, interOpNumThreads: 1 };
const guitar = await ort.InferenceSession.create(modelPath, opts);
const runGuitar = async (x: Float32Array, n: number) => {
  const o = await guitar.run({ audio: new ort.Tensor("float32", x, [n, SEGMENT]) });
  return { onset: o.onset.data as Float32Array, offset: o.offset.data as Float32Array, frame: o.frame.data as Float32Array, velocity: o.velocity.data as Float32Array };
};
const stringsRunner = async (path: string) => {
  const strings = await ort.InferenceSession.create(path, opts);
  return async (p: Float32Array, m: Float32Array, n: number) =>
    (await strings.run({ patch: new ort.Tensor("float32", p, [n, 12, 200]), midi: new ort.Tensor("float32", m, [n]) })).logits.data as Float32Array;
};

/** detected notes, each with the reference string when it matches a reference note (else -1) */
type Item = TabInput & { ref: number };

async function load(dir: string, stringsFile: string): Promise<Item[][]> {
  const tag = basename(modelPath, ".onnx");
  const stag = basename(stringsFile, ".onnx");
  const runStrings = await stringsRunner(stringsFile);
  const out: Item[][] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".f32")).sort()) {
    const name = basename(f, ".f32");
    const cache = join(dir, `${name}.${tag}.${stag}.notes.json`);
    if (existsSync(cache)) {
      out.push(JSON.parse(readFileSync(cache, "utf8")));
      continue;
    }
    const b = readFileSync(join(dir, f));
    const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
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
    const notes = decodeGuitarNotes(acts, DEFAULT_GUITAR_NOTES).filter((n) => n.midi >= 40 && n.midi <= 88);
    const p = await stringProbs(y, notes, runStrings);
    const ref = (JSON.parse(readFileSync(join(dir, name + ".json"), "utf8")) as number[][]).map(([start, , midi, string]) => ({ start, midi, string }));
    // nearest unmatched reference note with the same pitch within 50 ms
    const used = new Set<number>();
    const items: Item[] = notes.map((n, i) => {
      let best = -1;
      for (const [k, r] of ref.entries())
        if (!used.has(k) && r.midi === n.midi && Math.abs(r.start - n.start) <= 0.05 && (best < 0 || Math.abs(r.start - n.start) < Math.abs(ref[best].start - n.start))) best = k;
      if (best >= 0) used.add(best);
      return { ...n, strings: Array.from(p.subarray(i * 6, i * 6 + 6)), ref: best >= 0 ? ref[best].string : -1 };
    });
    writeFileSync(cache, JSON.stringify(items));
    out.push(items);
  }
  return out;
}

const sets: { name: string; fit: boolean; files: Item[][] }[] = [];
for (const s of specs) {
  const [kind, rest] = [s.slice(0, s.indexOf(":")), s.slice(s.indexOf(":") + 1)];
  const [dir, own] = rest.split("@");
  sets.push({ name: basename(dir), fit: kind === "fit", files: await load(dir, own ?? stringsPath) });
  console.log("loaded", basename(dir), sets.at(-1)!.files.length, "files");
}

/** right-string share per set, and the mean over the fit sets (each set weighs the same) */
function score(o: TabOptions) {
  const per: Record<string, number> = {};
  for (const s of sets) {
    let hit = 0, n = 0;
    for (const items of s.files)
      for (const t of toTab(items, STANDARD, o) as unknown as (Item & { string: number })[])
        if (t.ref >= 0) {
          n++;
          if (t.string === t.ref) hit++;
        }
    per[s.name] = n ? hit / n : 0;
  }
  const fit = sets.filter((s) => s.fit);
  return { per, fit: fit.reduce((a, s) => a + per[s.name], 0) / fit.length };
}

const show = (r: ReturnType<typeof score>) => Object.entries(r.per).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}`).join("  ");
// START='{"cut":9}' starts the search from other values
let best: TabOptions = { ...DEFAULT_TAB, ...JSON.parse(process.env.START ?? "{}") };
let bestScore = score(best);
console.log("default:", show(bestScore));
const KEYS = ["span", "stretch", "height", "high", "move", "shift", "moveRelax", "cut", "fretted", "shape", "shapeLink", "audio"] as const;
for (let r = 0; r < Number(rounds); r++) {
  let improved = false;
  for (const k of KEYS)
    for (const m of [0.5, 0.75, 1.33, 2]) {
      const base = best[k] || 0.05;
      const o = { ...best, [k]: base * m };
      const sc = score(o);
      if (sc.fit > bestScore.fit + 1e-4) {
        best = o;
        bestScore = sc;
        improved = true;
        console.log(`round ${r} ${k}=${o[k].toFixed(3)}:`, show(sc));
      }
    }
  if (!improved) break;
}
console.log("best:", JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, Number(best[k].toFixed(3))]))));
console.log("final:", show(bestScore));
