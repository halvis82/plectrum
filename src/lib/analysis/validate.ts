import type { Analysis } from "./analyze";

export function validAnalysis(a: unknown): a is Analysis {
  if (!a || typeof a !== "object") return false;
  const x = a as Analysis;
  const nums = (arr: unknown, max: number) => Array.isArray(arr) && arr.length <= max && arr.every((n) => typeof n === "number" && Number.isFinite(n));
  return (
    x.v === 1 &&
    typeof x.duration === "number" && x.duration > 0 && x.duration < 3600 &&
    nums(x.beats, 20000) && nums(x.chords, 20000) && x.beats.length === x.chords.length &&
    x.chords.every((c) => Number.isInteger(c) && c >= 0 && c < 170) &&
    (x.meter === 3 || x.meter === 4) && Number.isInteger(x.downbeat) &&
    Array.isArray(x.segments) && x.segments.length <= 20000 && x.segments.every((s) => nums(s, 3))
  );
}
