"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { NO_CHORD, gridBeats, type Edits, type Grid } from "@/lib/edits";
import { STANDARD } from "@/lib/tab";

/** Starts an empty song (16 bars of 4/4 at 90 BPM) and opens it ready to write in. */
export function ScratchButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function start() {
    setBusy(true);
    setError(null);
    const grid: Grid = { bpm: 90, meter: 4, bars: 16 };
    const beats = gridBeats(grid);
    const analysis = { v: 1, duration: beats.length * (60 / grid.bpm), bpm: grid.bpm, meter: grid.meter, downbeat: 0, beats, chords: beats.map(() => NO_CHORD), segments: [], notes: [] };
    const edits: Edits = { v: 1, grid, tab: [], tuning: [...STANDARD] };
    try {
      const r = await fetch("/api/songs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Untitled song", source: "scratch", analysis, edits }) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      router.push(`/song/${body.id}?edit=1`);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Couldn't start a new song");
    }
  }
  return (
    <div className="mt-3 text-sm">
      <button onClick={start} disabled={busy} className="text-muted hover:text-fg underline decoration-line underline-offset-4 hover:decoration-accent">
        {busy ? "Starting…" : "✎ Or write a tab from scratch"}
      </button>
      {error && <span className="ml-2 text-red-500">{error}</span>}
    </div>
  );
}
