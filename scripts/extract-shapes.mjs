// Builds src/lib/chord-shapes.json (the first 4 voicings per chord) from @tombatossals/chords-db (MIT).
import { createRequire } from "module";
import { writeFileSync } from "fs";
const g = createRequire(import.meta.url)("@tombatossals/chords-db/lib/guitar.json");
const map = { min: "minor", maj: "major", dim: "dim", aug: "aug", min6: "m6", maj6: "6", min7: "m7", minmaj7: "mmaj7", maj7: "maj7", "7": "7", dim7: "dim7", hdim7: "m7b5", sus2: "sus2", sus4: "sus4" };
const keys = ["C", "Csharp", "D", "Eb", "E", "F", "Fsharp", "G", "Ab", "A", "Bb", "B"];
const out = {};
keys.forEach((k, pc) => {
  for (const [q, s] of Object.entries(map)) {
    const c = g.chords[k].find((x) => x.suffix === s);
    if (c) out[`${pc}:${q}`] = c.positions.slice(0, 4).map((p) => ({ f: p.frets, g: p.fingers, b: p.baseFret, r: p.barres }));
  }
});
writeFileSync(new URL("../src/lib/chord-shapes.json", import.meta.url), JSON.stringify(out));
