"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import type { buildBars } from "@/lib/sheet";
import { followInPane } from "@/lib/follow";
import { TECHNIQUES, type Technique } from "@/lib/edits";

/** A note as the sheet draws it; `id` is its index in the edited tab while editing. */
export type SheetNote = { id: number; start: number; end: number; string: number; fret: number; amp: number; tech: Technique };

export type EditHandlers = {
  selected: number | null;
  select: (id: number | null) => void;
  add: (t: number, string: number) => void;
  /** `first` is false while the same drag goes on (one undo step per drag) */
  move: (id: number, t: number, string: number, first: boolean) => void;
  resize: (id: number, end: number, first: boolean) => void;
  chordAt: (beat: number) => void;
  /** grid steps per beat (0: no snapping) */
  snap: number;
};

type Span = { bar: ReturnType<typeof buildBars>[number]; from: number; to: number; notes: SheetNote[]; cut: [number, number][] };

/**
 * Tablature, one box per bar, for reading along and for editing by hand. The playhead moves on the DOM
 * directly so playback doesn't re-render the sheet.
 */
export const TabSheet = memo(function TabSheet({
  a,
  bars,
  names,
  notes,
  stringLabels,
  upTo,
  now,
  follow,
  onSeek,
  cuts,
  edit,
  caption,
}: {
  a: Analysis;
  bars: ReturnType<typeof buildBars>;
  names: (cls: number) => string;
  notes: SheetNote[];
  /** string names, low first */
  stringLabels: string[];
  /** while the tab is still coming in: seconds it covers so far */
  upTo?: number;
  now: (() => number) | null;
  follow: boolean;
  onSeek?: (t: number) => void;
  cuts: [number, number][];
  edit: EditHandlers | null;
  caption: string;
}) {
  const strings = stringLabels.length;
  const LINE = edit ? 26 : 15;

  const spans = useMemo<Span[]>(() => {
    const end = (i: number) => a.beats[i] ?? a.duration;
    const rows: Span[] = bars.map((b) => {
      const from = a.beats[b.beats[0]];
      // a pickup bar still gets a full bar's width so its notes line up with the rest
      const beatLen = (end(b.beats.at(-1)! + 1) - from) / b.beats.length;
      const to = b.pickup ? from + beatLen * b.beats.length : end(b.beats.at(-1)! + 1);
      const cut = cuts.filter(([x, y]) => y > from && x < to).map(([x, y]) => [Math.max(x, from), Math.min(y, to)] as [number, number]);
      return { bar: b, from, to, notes: [], cut };
    });
    const sorted = [...notes].sort((x, y) => x.start - y.start);
    let k = 0;
    for (const n of sorted) {
      while (k < rows.length - 1 && n.start >= rows[k].to) k++;
      if (n.start >= rows[k].from - 0.05 && n.start < rows[k].to) rows[k].notes.push(n);
    }
    // bars entirely inside a cut are left out
    return rows.filter((r) => !(r.cut.length === 1 && r.cut[0][0] <= r.from + 0.01 && r.cut[0][1] >= r.to - 0.01));
  }, [notes, bars, a.beats, a.duration, cuts]);

  const boxes = useRef<(HTMLDivElement | null)[]>([]);
  const heads = useRef<(HTMLDivElement | null)[]>([]);
  const lastBar = useRef(-1);
  useEffect(() => {
    if (!now) return;
    let raf = 0;
    const tick = () => {
      const t = now();
      const i = spans.findIndex((s) => t >= s.from && t < s.to);
      if (i !== lastBar.current) {
        const old = heads.current[lastBar.current];
        if (old) old.style.display = "none";
        const box = boxes.current[i];
        if (i >= 0 && follow && box) followInPane(box);
        lastBar.current = i;
      }
      const el = i >= 0 ? heads.current[i] : null;
      if (el) {
        el.style.left = `${((t - spans[i].from) / (spans[i].to - spans[i].from)) * 100}%`;
        el.style.display = "block";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [now, spans, follow]);

  // ---- editing: pointer position -> time and string ----
  const drag = useRef<{ kind: "move" | "resize" | "tap"; id: number; box: number; x0: number; y0: number; moved: boolean; offset: number } | null>(null);
  const snapTime = (t: number) => {
    if (!edit?.snap) return t;
    // nearest grid step inside the beat it falls in
    let i = a.beats.findIndex((b, k) => t < (a.beats[k + 1] ?? Infinity) && t >= b);
    if (i < 0) i = t < a.beats[0] ? 0 : a.beats.length - 1;
    const b0 = a.beats[i], b1 = a.beats[i + 1] ?? b0 + (b0 - (a.beats[i - 1] ?? b0 - 0.5));
    const step = (b1 - b0) / edit.snap;
    return Math.max(0, +(b0 + Math.round((t - b0) / step) * step).toFixed(4));
  };
  const at = (box: number, clientX: number, clientY: number) => {
    const el = boxes.current[box]!;
    const r = el.getBoundingClientRect();
    const s = spans[box];
    const t = s.from + ((clientX - r.left) / r.width) * (s.to - s.from);
    const row = Math.max(0, Math.min(strings - 1, Math.floor((clientY - r.top) / LINE)));
    return { t, string: strings - 1 - row };
  };

  if (!notes.length && upTo === undefined && !edit) return <p className="mt-6 text-sm text-muted">No guitar-range notes were heard in this recording.</p>;

  return (
    <div className="mt-4">
      <p className="text-xs text-muted mb-3">{caption}</p>
      <div className={`grid grid-cols-1 ${edit ? "lg:grid-cols-2" : "md:grid-cols-2"} gap-x-3 gap-y-3`}>
        {spans.map((s, i) => {
          const chordAt = s.bar.beats.map((b, k) => ({ b, k, name: names(a.chords[b]) }));
          const pct = (t: number) => ((t - s.from) / (s.to - s.from)) * 100;
          return (
            <div key={s.bar.beats[0]} className={`rounded-xl bg-surface border border-line px-3 pt-1.5 pb-2 ${upTo !== undefined && s.to > upTo ? "opacity-40" : ""}`}>
              <div className="flex text-[11px] text-muted h-5 items-center gap-2">
                <span className="tabular-nums w-6">{s.bar.pickup ? "" : s.bar.index}</span>
                <div
                  className={`relative flex-1 h-full ${edit ? "cursor-pointer rounded hover:bg-surface-2" : ""}`}
                  onClick={(e) => {
                    if (!edit) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    const t = s.from + ((e.clientX - r.left) / r.width) * (s.to - s.from);
                    const k = s.bar.beats.findLastIndex((b) => a.beats[b] <= t + 0.01);
                    edit.chordAt(s.bar.beats[Math.max(0, k)]);
                  }}
                  title={edit ? "Change the chord" : undefined}
                >
                  {chordAt
                    .filter((c, k) => c.name !== "N.C." && (k === 0 || c.name !== chordAt[k - 1].name))
                    .map((c) => (
                      <span key={c.b} className="absolute top-0.5 font-semibold text-accent text-xs whitespace-nowrap pointer-events-none" style={{ left: `${pct(a.beats[c.b])}%` }}>
                        {c.name}
                      </span>
                    ))}
                  {edit && chordAt.every((c) => c.name === "N.C.") && <span className="absolute top-0.5 left-0 text-[11px] text-muted pointer-events-none">+ chord</span>}
                </div>
              </div>
              <div className="flex gap-2">
                <div className="w-6 font-mono text-[10px] text-muted leading-none select-none" aria-hidden>
                  {[...stringLabels].reverse().map((n, k) => (
                    <div key={k} style={{ height: LINE }} className="flex items-center">
                      {n}
                    </div>
                  ))}
                </div>
                <div
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  onClick={edit ? undefined : () => onSeek?.(s.from)}
                  onPointerDown={
                    edit
                      ? (e) => {
                          if ((e.target as HTMLElement).dataset.note) return;
                          drag.current = { kind: "tap", id: -1, box: i, x0: e.clientX, y0: e.clientY, moved: false, offset: 0 };
                        }
                      : undefined
                  }
                  onPointerMove={
                    edit
                      ? (e) => {
                          const d = drag.current;
                          if (!d || d.box !== i) return;
                          if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
                          if (d.kind === "tap") return;
                          if (!d.moved) e.currentTarget.setPointerCapture(e.pointerId);
                          const first = !d.moved;
                          d.moved = true;
                          const p = at(i, e.clientX, e.clientY);
                          if (d.kind === "move") edit.move(d.id, snapTime(p.t - d.offset), p.string, first);
                          else edit.resize(d.id, snapTime(p.t), first);
                        }
                      : undefined
                  }
                  onPointerUp={
                    edit
                      ? (e) => {
                          const d = drag.current;
                          drag.current = null;
                          if (!d || d.box !== i) return;
                          if (d.kind === "tap" && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 8) {
                            const p = at(i, e.clientX, e.clientY);
                            edit.add(snapTime(p.t), p.string);
                          }
                        }
                      : undefined
                  }
                  className={`relative flex-1 ${edit ? "touch-none select-none cursor-crosshair" : onSeek ? "cursor-pointer" : ""}`}
                  style={{ height: LINE * strings }}
                  role="img"
                  aria-label={`Bar ${s.bar.index}: ${s.notes.map((n) => `${stringLabels[n.string]} string fret ${n.fret}`).join(", ") || "rest"}`}
                >
                  {/* beat grid while editing */}
                  {edit &&
                    s.bar.beats.map((b) => (
                      <div key={b} className="absolute inset-y-0 w-px bg-line/70" style={{ left: `${pct(a.beats[b])}%` }} aria-hidden />
                    ))}
                  {stringLabels.map((_, k) => (
                    <div key={k} className="absolute inset-x-0 h-px bg-line" style={{ top: LINE * k + LINE / 2 }} />
                  ))}
                  {s.cut.map(([x, y], k) => (
                    <div key={k} className="absolute inset-y-0 cut-hatch rounded" style={{ left: `${pct(x)}%`, width: `${pct(y) - pct(x)}%` }} title="Cut from the song" />
                  ))}
                  {edit &&
                    s.notes.map((n) => (
                      <div
                        key={`sus${n.id}`}
                        className={`absolute h-[3px] rounded-full ${n.id === edit.selected ? "bg-accent" : "bg-accent/30"}`}
                        style={{ left: `${pct(n.start)}%`, width: `${Math.max(0, Math.min(100, pct(n.end)) - pct(n.start))}%`, top: LINE * (strings - 1 - n.string) + LINE / 2 + 7 }}
                        aria-hidden
                      />
                    ))}
                  {s.notes.map((n) => {
                    const sel = edit?.selected === n.id;
                    return (
                      <span
                        key={n.id}
                        data-note="1"
                        onPointerDown={
                          edit
                            ? (e) => {
                                e.stopPropagation();
                                // tapping the selected note again lets go of it
                                edit.select(edit.selected === n.id ? null : n.id);
                                const p = at(i, e.clientX, e.clientY);
                                drag.current = { kind: "move", id: n.id, box: i, x0: e.clientX, y0: e.clientY, moved: false, offset: p.t - n.start };
                              }
                            : undefined
                        }
                        className={`absolute -translate-x-1/2 -translate-y-1/2 px-0.5 font-mono leading-none font-semibold tabular-nums whitespace-nowrap ${
                          edit ? "text-[15px] cursor-grab rounded-md px-1 py-0.5" : "text-[12px]"
                        } ${sel ? "bg-accent text-accent-fg" : "bg-surface"}`}
                        style={{
                          left: `${Math.max(edit ? 3 : 1.5, pct(n.start))}%`,
                          top: LINE * (strings - 1 - n.string) + LINE / 2,
                          opacity: edit ? 1 : 0.55 + 0.45 * Math.min(1, n.amp * 2),
                        }}
                      >
                        {n.tech > 0 && <span className={`text-[10px] italic mr-px ${sel ? "" : "text-accent"}`}>{TECHNIQUES[n.tech]}</span>}
                        {n.fret}
                      </span>
                    );
                  })}
                  {edit &&
                    s.notes
                      .filter((n) => n.id === edit.selected)
                      .map((n) => (
                        <span
                          key="handle"
                          data-note="1"
                          onPointerDown={(e) => {
                            e.stopPropagation();
                            drag.current = { kind: "resize", id: n.id, box: i, x0: e.clientX, y0: e.clientY, moved: false, offset: 0 };
                          }}
                          className="absolute h-5 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent border-2 border-surface cursor-ew-resize shadow"
                          style={{ left: `${Math.min(100, pct(n.end))}%`, top: LINE * (strings - 1 - n.string) + LINE / 2 + 8 }}
                          title="Drag to make the note ring longer or shorter"
                        />
                      ))}
                  <div
                    ref={(el) => {
                      heads.current[i] = el;
                    }}
                    className="absolute -top-1 -bottom-1 w-0.5 bg-now rounded-full pointer-events-none"
                    style={{ display: "none" }}
                    aria-hidden
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
