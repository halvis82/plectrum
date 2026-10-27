"use client";

import { useState } from "react";
import { QUALITIES, chordName, parseLabel, labelFromIndex, type Chord, type Quality } from "@/lib/music";
import { NO_CHORD } from "@/lib/edits";
import { ChordDiagram } from "../ChordDiagram";

const ORDER: Quality[] = ["maj", "min", "7", "maj7", "min7", "sus2", "sus4", "maj6", "min6", "dim", "aug", "hdim7", "dim7", "minmaj7"];

/** Pick a chord: root, then kind, with its shape shown. `cls` is the chord class now playing. */
export function ChordPicker({ cls, spelling, onPick, onClose, span }: { cls: number; spelling: readonly string[]; onPick: (cls: number) => void; onClose: () => void; span: string }) {
  const now = parseLabel(labelFromIndex(cls));
  const [root, setRoot] = useState(now?.root ?? 0);
  const [quality, setQuality] = useState<Quality>(now?.quality ?? "maj");
  const chord: Chord = { root, quality };
  const index = root * 14 + QUALITIES.indexOf(quality);
  return (
    <div className="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/40 p-2" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-surface border border-line shadow-2xl p-4" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Choose a chord">
        <div className="flex items-start gap-4">
          <div className="flex-1">
            <p className="font-semibold">Chord for {span}</p>
            <p className="text-xs text-muted mt-0.5">Pick the root, then the kind.</p>
          </div>
          <ChordDiagram chord={chord} name={chordName(chord, spelling)} size={70} />
        </div>
        <div className="mt-3 grid grid-cols-6 gap-1.5">
          {spelling.map((n, r) => (
            <button key={r} onClick={() => setRoot(r)} className={`btn btn-sm px-0 ${root === r ? "btn-primary" : ""}`}>
              {n}
            </button>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {ORDER.map((q) => (
            <button key={q} onClick={() => setQuality(q)} className={`btn btn-sm px-1 ${quality === q ? "btn-primary" : ""}`}>
              {chordName({ root, quality: q }, spelling)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex gap-2">
          <button onClick={() => onPick(NO_CHORD)} className="btn btn-sm">
            No chord
          </button>
          <span className="flex-1" />
          <button onClick={onClose} className="btn btn-sm btn-ghost">
            Cancel
          </button>
          <button onClick={() => onPick(index)} className="btn btn-sm btn-primary">
            Use {chordName(chord, spelling)}
          </button>
        </div>
      </div>
    </div>
  );
}
