// Random search over toTab costs using GuitarSet's annotated notes (so only string/fret choice is scored).
// Fits on players 00-02 and reports 03-05. Usage: npx tsx scripts/tab-sweep.mts <jams-dir> [trials]
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { toTab, DEFAULT_TAB, type TabOptions } from "../src/lib/tab";

const [, , jamsDir, trials = "200", fm = "-1"] = process.argv;
// open strings are rare in GuitarSet but everywhere in rock and pop; a floor of 0 keeps the fit from learning to avoid them
const FRETTED_MIN = Number(fm);
const TUNING = [40, 45, 50, 55, 59, 64];
type Ref = { start: number; end: number; midi: number; amp: number; ref: number };
const sets = readdirSync(jamsDir).filter((f) => f.endsWith(".jams")).sort().map((f) => {
  const j = JSON.parse(readFileSync(join(jamsDir, f), "utf8"));
  const notes: Ref[] = [];
  for (const a of j.annotations)
    if (a.namespace === "note_midi")
      for (const d of a.data) notes.push({ start: d.time, end: d.time + d.duration, midi: Math.round(d.value), amp: 1, ref: Number(a.annotation_metadata.data_source) });
  notes.sort((a, b) => a.start - b.start);
  return { f, held: Number(f.slice(0, 2)) > 2, solo: f.includes("solo"), notes };
});

function score(o: TabOptions, held: boolean) {
  const acc = { comp: [0, 0], solo: [0, 0] };
  for (const s of sets) {
    if (s.held !== held) continue;
    const tab = toTab(s.notes, TUNING, o);
    // toTab keeps the note objects' fields, so the reference string travels along
    const a = acc[s.solo ? "solo" : "comp"];
    for (const n of tab) {
      a[1]++;
      a[0] += Number(n.string === (n as unknown as Ref).ref);
    }
    a[1] += s.notes.length - tab.length; // dropped notes count as wrong
  }
  const comp = acc.comp[0] / acc.comp[1], solo = acc.solo[0] / acc.solo[1];
  return { comp, solo, mean: (comp + solo) / 2 };
}

const fmt = (r: ReturnType<typeof score>) => `comp ${(100 * r.comp).toFixed(1)} solo ${(100 * r.solo).toFixed(1)} mean ${(100 * r.mean).toFixed(1)}`;
let best = { o: DEFAULT_TAB, r: score(DEFAULT_TAB, false) };
console.log("default tune", fmt(best.r), "| held", fmt(score(DEFAULT_TAB, true)));
const R = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
for (let t = 0; t < Number(trials); t++) {
  // half the trials explore broadly, half perturb the best so far
  const b = best.o;
  const local = t % 2 === 1;
  const p = (v: number, lo: number, hi: number) => (local ? Math.min(hi, Math.max(lo, v * R(0.6, 1.6))) : R(lo, hi));
  const o: TabOptions = {
    ...b,
    span: p(b.span, 0, 3),
    stretch: p(b.stretch, 0, 4),
    height: p(b.height, -0.1, 0.3),
    high: p(b.high, 0, 1),
    move: p(b.move, 0, 2),
    shift: p(b.shift, 0, 4),
    moveRelax: p(b.moveRelax, 0.1, 5),
    cut: p(b.cut, 0, 6),
    fretted: p(b.fretted, FRETTED_MIN, 1.5),
    shape: p(b.shape, 0, 6),
    shapeLink: p(b.shapeLink, 0, 3),
  };
  const r = score(o, false);
  if (r.mean > best.r.mean) {
    best = { o, r };
    console.log(`#${t} tune`, fmt(r), JSON.stringify(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v.toFixed(3)]))));
  }
}
console.log("best tune", fmt(best.r), "| held", fmt(score(best.o, true)));
