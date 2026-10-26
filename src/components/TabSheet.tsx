"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import type { buildBars } from "@/lib/sheet";
import { STANDARD, STRING_NAMES, toTab, type TabNote } from "@/lib/tab";

const LINE = 15; // px between strings

/**
 * Note-by-note tablature, one box per bar. Pitches follow the transpose setting and frets are
 * counted from the capo. The playhead is moved directly on the DOM so playback doesn't re-render.
 */
export function TabSheet({
  a,
  bars,
  names,
  transpose,
  capo,
  now,
  follow,
  onSeek,
}: {
  a: Analysis;
  bars: ReturnType<typeof buildBars>;
  names: (cls: number) => string;
  transpose: number;
  capo: number;
  now: (() => number) | null;
  follow: boolean;
  onSeek?: (t: number) => void;
}) {
  const tab = useMemo(() => {
    if (!a.notes) return [];
    const tuning = STANDARD.map((m) => m + capo);
    return toTab(
      a.notes.map(([start, end, midi, amp]) => ({ start, end, midi: midi + transpose, amp })),
      tuning,
    );
  }, [a.notes, transpose, capo]);

  // bar time spans and the notes that start inside each
  const spans = useMemo(() => {
    const end = (i: number) => a.beats[i] ?? a.duration;
    const rows = bars.map((b) => {
      const from = a.beats[b.beats[0]];
      // a pickup bar still gets a full bar's width so its notes line up with the rest
      const beatLen = (end(b.beats.at(-1)! + 1) - from) / b.beats.length;
      const to = b.pickup ? from + beatLen * b.beats.length : end(b.beats.at(-1)! + 1);
      return { bar: b, from, to, notes: [] as TabNote[] };
    });
    let k = 0;
    for (const n of tab) {
      while (k < rows.length - 1 && n.start >= rows[k].to) k++;
      if (n.start >= rows[k].from - 0.05 && n.start < rows[k].to) rows[k].notes.push(n);
    }
    return rows;
  }, [tab, bars, a.beats, a.duration]);

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
        if (i >= 0 && follow) boxes.current[i]?.scrollIntoView({ block: "center", behavior: "smooth" });
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

  if (!a.notes)
    return <p className="mt-6 text-sm text-muted">This song was caught before tabs existed. Catch it again to get the note-by-note tab.</p>;
  if (!tab.length) return <p className="mt-6 text-sm text-muted">No guitar-range notes were heard in this recording.</p>;

  return (
    <div className="mt-5">
      <p className="text-xs text-muted mb-3">
        Every note heard, on the string and fret that keeps your hand in one place{capo > 0 ? `, counted from capo ${capo}` : ""}. Tap a bar to play from there.
      </p>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-3 gap-y-4">
        {spans.map((s, i) => {
          const chordAt = s.bar.beats.map((b, k) => ({ b, k, name: names(a.chords[b]) }));
          return (
            <div key={i} className="rounded-xl bg-surface border border-line px-3 pt-1.5 pb-2">
              <div className="flex text-[11px] text-muted h-5 items-center gap-2">
                <span className="tabular-nums w-6">{s.bar.pickup ? "" : s.bar.index}</span>
                <div className="relative flex-1 h-full">
                  {chordAt
                    .filter((c, k) => c.name !== "N.C." && (k === 0 || c.name !== chordAt[k - 1].name))
                    .map((c) => (
                      <span
                        key={c.b}
                        className="absolute top-0.5 font-semibold text-accent text-xs whitespace-nowrap"
                        style={{ left: `${((a.beats[c.b] - s.from) / (s.to - s.from)) * 100}%` }}
                      >
                        {c.name}
                      </span>
                    ))}
                </div>
              </div>
              <div className="flex gap-2">
                <div className="w-6 font-mono text-[10px] text-muted leading-none select-none" aria-hidden>
                  {[...STRING_NAMES].reverse().map((n) => (
                    <div key={n} style={{ height: LINE }} className="flex items-center">
                      {n}
                    </div>
                  ))}
                </div>
                <div
                  ref={(el) => {
                    boxes.current[i] = el;
                  }}
                  onClick={() => onSeek?.(s.from)}
                  className={`relative flex-1 ${onSeek ? "cursor-pointer" : ""}`}
                  style={{ height: LINE * 6 }}
                  role="img"
                  aria-label={`Bar ${s.bar.index}: ${s.notes.map((n) => `${STRING_NAMES[n.string]} string fret ${n.fret}`).join(", ") || "rest"}`}
                >
                  {STANDARD.map((_, k) => (
                    <div key={k} className="absolute inset-x-0 h-px bg-line" style={{ top: LINE * k + LINE / 2 }} />
                  ))}
                  {s.notes.map((n, k) => (
                    <span
                      key={k}
                      className="absolute -translate-x-1/2 -translate-y-1/2 px-0.5 bg-surface font-mono text-[12px] leading-none font-semibold tabular-nums"
                      style={{
                        left: `${Math.max(1.5, ((n.start - s.from) / (s.to - s.from)) * 100)}%`,
                        top: LINE * (5 - n.string) + LINE / 2,
                        opacity: 0.55 + 0.45 * Math.min(1, n.amp * 2),
                      }}
                    >
                      {n.fret}
                    </span>
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
}
