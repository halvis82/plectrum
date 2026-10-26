// Checks tuning detection: GuitarSet (all standard tuning) transcriptions shifted down 0, 1 and 2
// semitones should come out as standard, half step down and whole step down.
// Usage: npx tsx scripts/tuning-test.mts <guitar-activation-dir> [tune|held|all]
import { readFileSync, readdirSync } from "fs";
import { join, basename } from "path";
import { decodeGuitarNotes } from "../src/lib/analysis/guitar";
import { detectTuning } from "../src/lib/tab";

const [, , dir, half = "all"] = process.argv;
const want: Record<number, string> = { 0: "standard", [-1]: "half-down", [-2]: "whole-down" };
const counts: Record<string, Record<string, number>> = {};
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
  const player = Number(f.slice(0, 2));
  if ((half === "tune" && player > 2) || (half === "held" && player <= 2)) continue;
  const b = readFileSync(join(dir, "act", basename(f, ".json") + ".bin"));
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  const n = all.length / 4;
  const notes = decodeGuitarNotes({ onset: all.subarray(0, n), offset: all.subarray(n, 2 * n), frame: all.subarray(2 * n, 3 * n), velocity: all.subarray(3 * n), frames: n / 88 });
  for (const shift of [0, -1, -2]) {
    const got = detectTuning(notes.map((x) => ({ ...x, midi: x.midi + shift })));
    const c = (counts[want[shift]] ??= {});
    c[got] = (c[got] ?? 0) + 1;
  }
}
for (const [w, c] of Object.entries(counts)) {
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  console.log(`${w}: ${(((c[w] ?? 0) / total) * 100).toFixed(1)}% right`, JSON.stringify(c));
}
