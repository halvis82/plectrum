// Scores note transcription and string/fret assignment against GuitarSet's per-string annotations.
// Players 00-02 are the tuning half, 03-05 held out.
// Usage: npx tsx scripts/tab-score.mts <notes-dir> <jams-dir> ['<options json or array of them>'] [comp|solo]
//   <notes-dir>: Basic Pitch activations cached by notes-bench.mts (act/*.bin); with NOTES=guitar,
//   guitar-model activations cached by guitar/bench.mts; with NOTES=json, one
//   [[start, end, midi, amp], ...] file per recording (other transcription models).
//   Note options apply to whichever decoder is in use.
//   STRINGS=<model.onnx> F32=<audio dir>: run the string model on the detected notes too.
//   Options: {"tab": {...}, "notes": {...}}; an array scores each set in turn (notes and string
//   probabilities are computed once).
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import * as ort from "onnxruntime-node";
import { decodeNotes, DEFAULT_NOTES, type Note } from "../src/lib/analysis/notes";
import { decodeGuitarNotes, DEFAULT_GUITAR_NOTES } from "../src/lib/analysis/guitar";
import { stringProbs } from "../src/lib/analysis/strings";
import { toTab, DEFAULT_TAB, type TabInput, type TabNote } from "../src/lib/tab";

const [, , notesDir, jamsDir, optArg = "{}", kind = ""] = process.argv;
const parsed = JSON.parse(optArg);
const optSets: { tab?: object; notes?: object }[] = Array.isArray(parsed) ? parsed : [parsed];
const jsonNotes = process.env.NOTES === "json";
const guitarNotes = process.env.NOTES === "guitar";
const session = process.env.STRINGS ? await ort.InferenceSession.create(process.env.STRINGS) : null;

type Ref = { start: number; end: number; midi: number; string: number; fret: number };
const TUNING = [40, 45, 50, 55, 59, 64];
function reference(file: string): Ref[] {
  const j = JSON.parse(readFileSync(file, "utf8"));
  const out: Ref[] = [];
  for (const a of j.annotations)
    if (a.namespace === "note_midi")
      for (const d of a.data) {
        const s = Number(a.annotation_metadata.data_source);
        const midi = Math.round(d.value);
        out.push({ start: d.time, end: d.time + d.duration, midi, string: s, fret: midi - TUNING[s] });
      }
  return out.sort((a, b) => a.start - b.start);
}

/** Greedy onset matching (50 ms, same semitone), earliest-closest first. */
function match<T extends { start: number; midi: number }>(ref: Ref[], est: T[]): [Ref, T][] {
  const pairs: [number, number, number][] = [];
  for (const [i, r] of ref.entries())
    for (const [j, e] of est.entries()) {
      const d = Math.abs(r.start - e.start);
      if (d <= 0.05 && r.midi === e.midi) pairs.push([d, i, j]);
    }
  pairs.sort((a, b) => a[0] - b[0]);
  const ur = new Set<number>(), ue = new Set<number>(), out: [Ref, T][] = [];
  for (const [, i, j] of pairs) {
    if (ur.has(i) || ue.has(j)) continue;
    ur.add(i);
    ue.add(j);
    out.push([ref[i], est[j]]);
  }
  return out;
}

const run = async (patches: Float32Array, midi: Float32Array, n: number) => {
  const out = await session!.run({ patch: new ort.Tensor("float32", patches, [n, 12, 200]), midi: new ort.Tensor("float32", midi, [n]) });
  return out.logits.data as Float32Array;
};

async function withStrings(notes: Note[], name: string): Promise<TabInput[]> {
  if (!session) return notes;
  const b = readFileSync(join(process.env.F32!, name + ".f32"));
  const y = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const p = await stringProbs(y, notes, run);
  return notes.map((n, i) => ({ ...n, strings: p.subarray(i * 6, i * 6 + 6) }));
}

type Acc = { ref: number; est: number; hit: number; tabHit: number; oracleN: number; oracleHit: number };
const accs: Record<string, Acc>[] = optSets.map(() => ({}));
const files = readdirSync(notesDir).filter((f) => f.endsWith(".json") && f.includes(kind)).sort();
// note decoding options rarely change across a sweep, so decoded notes are cached per option set
const decoded = new Map<string, TabInput[]>();
for (const f of files) {
  const name = basename(f, ".json");
  const ref = reference(join(jamsDir, name.replace(/_mic$/, "") + ".jams"));
  const oracleIn = await withStrings(ref.map((r) => ({ start: r.start, end: r.end, midi: r.midi, amp: 1 })), name);
  let act: { note: Float32Array; onset: Float32Array; frames: number } | null = null;
  let gact: { onset: Float32Array; offset: Float32Array; frame: Float32Array; velocity: Float32Array; frames: number } | null = null;
  if (guitarNotes) {
    const b = readFileSync(join(notesDir, "act", name + ".bin"));
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const n = all.length / 4;
    gact = { onset: all.subarray(0, n), offset: all.subarray(n, 2 * n), frame: all.subarray(2 * n, 3 * n), velocity: all.subarray(3 * n), frames: n / 88 };
  } else if (!jsonNotes) {
    const b = readFileSync(join(notesDir, "act", name + ".bin"));
    const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    const half = all.length / 2;
    act = { note: all.slice(0, half), onset: all.slice(half), frames: half / 88 };
  }
  decoded.clear();
  for (const [k, o] of optSets.entries()) {
    const tabOpts = { ...DEFAULT_TAB, ...o.tab };
    const key = JSON.stringify(o.notes ?? {});
    let notes = decoded.get(key);
    if (!notes) {
      const raw: Note[] = jsonNotes
        ? (JSON.parse(readFileSync(join(notesDir, f), "utf8")) as number[][]).map(([start, end, midi, amp]) => ({ start, end, midi, amp }))
        : gact
          ? decodeGuitarNotes(gact, { ...DEFAULT_GUITAR_NOTES, ...o.notes })
          : decodeNotes(act!, { ...DEFAULT_NOTES, ...o.notes });
      notes = await withStrings(raw.filter((n) => n.midi >= 40 && n.midi <= 84), name);
      decoded.set(key, notes);
    }
    const tab = toTab(notes, TUNING, tabOpts);
    const oracle = toTab(oracleIn, TUNING, tabOpts);
    const half = Number(name.slice(0, 2)) <= 2 ? "tune" : "held";
    const a = (accs[k][half] ??= { ref: 0, est: 0, hit: 0, tabHit: 0, oracleN: 0, oracleHit: 0 });
    a.ref += ref.length;
    a.est += notes.length;
    a.hit += match(ref, notes).length;
    a.tabHit += match<TabNote>(ref, tab).filter(([r, e]) => r.string === e.string).length;
    const om = match<TabNote>(ref, oracle);
    a.oracleN += om.length;
    a.oracleHit += om.filter(([r, e]) => r.string === e.string).length;
  }
}
const pct = (x: number) => (100 * x).toFixed(1);
for (const [k, acc] of accs.entries()) {
  if (optSets.length > 1) console.log(JSON.stringify(optSets[k]));
  for (const [h, a] of Object.entries(acc)) {
    const p = a.hit / a.est, r = a.hit / a.ref, tp = a.tabHit / a.est, tr = a.tabHit / a.ref;
    console.log(
      `${h}: notes P ${pct(p)} R ${pct(r)} F1 ${pct((2 * p * r) / (p + r))} | tab F1 ${pct((2 * tp * tr) / (tp + tr))} | string acc on hits ${pct(a.tabHit / a.hit)} | oracle-notes string acc ${pct(a.oracleHit / a.oracleN)}`,
    );
  }
}
