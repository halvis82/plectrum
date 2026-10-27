// Timing between reference and detected onsets (same pitch, nearest within 300 ms), to spot a fixed
// delay in a dataset's annotations. Usage: npx tsx scripts/eval/offsets.mts <set dir>
import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";
import { decodeGuitarNotes } from "../../src/lib/analysis/guitar";
const dir = process.argv[2];
const d: number[] = [];
for (const f of readdirSync(dir).filter((f) => f.endsWith(".act"))) {
  const a = readFileSync(join(dir, f));
  const all = new Float32Array(a.buffer.slice(a.byteOffset, a.byteOffset + a.byteLength));
  const n = all.length / 4;
  const notes = decodeGuitarNotes({ onset: all.subarray(0, n), offset: all.subarray(n, 2 * n), frame: all.subarray(2 * n, 3 * n), velocity: all.subarray(3 * n), frames: n / 88 });
  const ref = JSON.parse(readFileSync(join(dir, basename(f, ".act") + ".json"), "utf8")) as number[][];
  for (const [s, , m] of ref) {
    let best = 1;
    for (const e of notes) if (e.midi === m && Math.abs(e.start - s) < Math.abs(best)) best = e.start - s;
    if (Math.abs(best) < 0.3) d.push(best);
  }
}
d.sort((a, b) => a - b);
const q = (p: number) => (1000 * d[Math.floor(p * (d.length - 1))]).toFixed(0);
console.log(`${d.length} pairs; est - ref ms: p10 ${q(0.1)} p25 ${q(0.25)} median ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)}`);
