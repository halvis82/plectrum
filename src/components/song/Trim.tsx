"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The whole song at a glance for trimming: how much guitar is going on over time, where words are
 * spoken, and the parts cut out. Drag across it to pick a part, then cut it or keep only it.
 */
export function Trim({
  duration,
  activity,
  speech,
  cuts,
  now,
  onSeek,
  onCut,
  onKeepOnly,
  onRestore,
}: {
  duration: number;
  /** guitar activity per bin, 0..1 */
  activity: Float32Array;
  /** spans with spoken or sung words */
  speech: [number, number][];
  cuts: [number, number][];
  now: () => number;
  onSeek: (t: number) => void;
  onCut: (from: number, to: number) => void;
  onKeepOnly: (from: number, to: number) => void;
  onRestore: (index: number) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<[number, number] | null>(null);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (head.current) head.current.style.left = `${(now() / duration) * 100}%`;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [now, duration]);

  const timeAt = (x: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration;
  };
  const pct = (t: number) => `${(t / duration) * 100}%`;
  const W = activity.length;
  const path = Array.from(activity, (v, i) => `${i === 0 ? "M" : "L"}${(i / Math.max(1, W - 1)) * 1000},${60 - v * 56}`).join(" ");
  const selCut = sel ? cuts.findIndex(([a, b]) => sel[0] >= a && sel[1] <= b) : -1;

  return (
    <div className="rounded-2xl border border-line bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Trim the song</p>
        <p className="text-xs text-muted">Drag across to pick a part. Tap a striped part to bring it back.</p>
      </div>
      <div
        ref={box}
        className="relative mt-2 h-20 rounded-xl bg-bg border border-line overflow-hidden touch-none select-none cursor-crosshair"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { x0: e.clientX, t0: timeAt(e.clientX), moved: false };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          if (Math.abs(e.clientX - d.x0) > 4) d.moved = true;
          if (d.moved) {
            const t = timeAt(e.clientX);
            setSel([Math.min(d.t0, t), Math.max(d.t0, t)]);
          }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (!d || d.moved) return;
          const t = timeAt(e.clientX);
          const k = cuts.findIndex(([a, b]) => t >= a && t < b);
          if (k >= 0) setSel([cuts[k][0], cuts[k][1]]);
          else {
            setSel(null);
            onSeek(t);
          }
        }}
        aria-label="Song overview for trimming"
      >
        {speech.map(([a, b], k) => (
          <div key={k} className="absolute bottom-0 h-2 bg-sky-500/50" style={{ left: pct(a), width: pct(b - a) }} />
        ))}
        <svg viewBox="0 0 1000 60" preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden>
          <path d={`${path} L1000,60 L0,60 Z`} fill="color-mix(in oklab, var(--accent) 30%, transparent)" stroke="var(--accent)" strokeWidth="1.2" vectorEffect="non-scaling-stroke" />
        </svg>
        {cuts.map(([a, b], k) => (
          <div key={k} className="absolute inset-y-0 cut-hatch bg-bg/60 border-x border-muted/40" style={{ left: pct(a), width: pct(Math.min(duration, b) - a) }} />
        ))}
        {sel && <div className="absolute inset-y-0 bg-accent/20 border-x-2 border-accent" style={{ left: pct(sel[0]), width: pct(sel[1] - sel[0]) }} />}
        <div ref={head} className="absolute inset-y-0 w-0.5 bg-now pointer-events-none" aria-hidden />
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted tabular-nums">
        <span>0:00</span>
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-2 w-3 rounded-sm bg-accent/50" /> guitar
          </span>
          {speech.length > 0 && (
            <span className="flex items-center gap-1">
              <span className="h-2 w-3 rounded-sm bg-sky-500/60" /> words
            </span>
          )}
        </span>
        <span>{clock(duration)}</span>
      </div>
      {sel && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted tabular-nums">
            {clock(sel[0])} to {clock(sel[1])}
          </span>
          <span className="flex-1" />
          {selCut >= 0 ? (
            <button
              onClick={() => {
                onRestore(selCut);
                setSel(null);
              }}
              className="btn btn-sm"
            >
              Bring this part back
            </button>
          ) : (
            <>
              <button
                onClick={() => {
                  onKeepOnly(sel[0], sel[1]);
                  setSel(null);
                }}
                className="btn btn-sm"
              >
                Keep only this
              </button>
              <button
                onClick={() => {
                  onCut(sel[0], sel[1]);
                  setSel(null);
                }}
                className="btn btn-sm btn-primary"
              >
                Cut this out
              </button>
            </>
          )}
          <button onClick={() => setSel(null)} className="btn btn-sm btn-ghost" aria-label="Clear the selection">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
