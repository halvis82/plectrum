// Scores note transcription and string/fret assignment against GuitarSet's per-string annotations.
// Reads activations cached by notes-bench.mts. Players 00-02 are the tuning half, 03-05 held out.
// Usage: npx tsx scripts/tab-score.mts <notes-out-dir> <jams-dir> ['{"tab":{...},"notes":{...}}'] [comp|solo]
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { decodeNotes, DEFAULT_NOTES, type Note } from "../src/lib/analysis/notes";
import { toTab, DEFAULT_TAB, type TabNote } from "../src/lib/tab";

const [, , outDir, jamsDir, optArg = "{}", kind = ""] = process.argv;
const opt = JSON.parse(optArg);
const tabOpts = { ...DEFAULT_TAB, ...opt.tab };
const noteOpts = { ...DEFAULT_NOTES, ...opt.notes };

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

const acc: Record<string, { ref: number; est: number; hit: number; tabHit: number; oracleN: number; oracleHit: number }> = {};
for (const f of readdirSync(outDir).filter((f) => f.endsWith(".json") && f.includes(kind)).sort()) {
  const name = basename(f, ".json");
  const b = readFileSync(join(outDir, "act", name + ".bin"));
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const half = all.length / 2;
  const notes: Note[] = decodeNotes({ note: all.slice(0, half), onset: all.slice(half), frames: half / 88 }, noteOpts);
  const ref = reference(join(jamsDir, name.replace(/_mic$/, "") + ".jams"));
  const tab = toTab(notes, TUNING, tabOpts);
  const oracle = toTab(ref.map((r) => ({ start: r.start, end: r.end, midi: r.midi, amp: 1 })), TUNING, tabOpts);
  const half_ = Number(name.slice(0, 2)) <= 2 ? "tune" : "held";
  const a = (acc[half_] ??= { ref: 0, est: 0, hit: 0, tabHit: 0, oracleN: 0, oracleHit: 0 });
  a.ref += ref.length;
  a.est += notes.filter((n) => n.midi >= 40 && n.midi <= 84).length;
  a.hit += match(ref, notes.filter((n) => n.midi >= 40 && n.midi <= 84)).length;
  a.tabHit += match<TabNote>(ref, tab).filter(([r, e]) => r.string === e.string).length;
  const om = match<TabNote>(ref, oracle);
  a.oracleN += om.length;
  a.oracleHit += om.filter(([r, e]) => r.string === e.string).length;
}
const pct = (x: number) => (100 * x).toFixed(1);
for (const [h, a] of Object.entries(acc)) {
  const p = a.hit / a.est, r = a.hit / a.ref, tp = a.tabHit / a.est, tr = a.tabHit / a.ref;
  console.log(
    `${h}: notes P ${pct(p)} R ${pct(r)} F1 ${pct((2 * p * r) / (p + r))} | tab F1 ${pct((2 * tp * tr) / (tp + tr))} | string acc on hits ${pct(a.tabHit / a.hit)} | oracle-notes string acc ${pct(a.oracleHit / a.oracleN)}`,
  );
}
