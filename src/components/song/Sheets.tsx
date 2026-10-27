"use client";

import { useEffect, useMemo, useRef } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import { chordsOverLine, type LyricLine, type buildBars } from "@/lib/sheet";
import { followInPane } from "@/lib/follow";

export type LyricsState = { lines: LyricLine[] | null; plain: string | null; from: "lrclib" | "youtube" | "transcribed" } | "loading" | null;

/** A cut covers this whole span */
const inCut = (cuts: [number, number][], from: number, to: number) => cuts.some(([a, b]) => a <= from + 0.01 && b >= to - 0.01);

export function BarsSheet({
  bars,
  a,
  names,
  beat,
  follow,
  onSeek,
  cuts,
}: {
  bars: ReturnType<typeof buildBars>;
  a: Analysis;
  cuts: [number, number][];
  names: (cls: number) => string;
  beat: number;
  follow: boolean;
  onSeek?: (beat: number) => void;
}) {
  const current = useRef<HTMLButtonElement>(null);
  const curBar = bars.findIndex((b) => b.beats.includes(beat));
  useEffect(() => {
    if (follow && current.current) followInPane(current.current);
  }, [curBar, follow]);

  const rows = useMemo(
    () =>
      bars.map((bar, bi) => {
        const prevBeat = bars[bi - 1]?.beats.at(-1);
        const prevName = prevBeat === undefined ? "" : names(a.chords[prevBeat]);
        return bar.beats.map((i, k) => {
          const name = names(a.chords[i]);
          const show = k === 0 || name !== names(a.chords[bar.beats[k - 1]]);
          return { i, name, show, repeat: k === 0 && name === prevName };
        });
      }),
    [bars, a, names],
  );

  return (
    <div className="mt-5 grid grid-cols-2 sm:grid-cols-4 gap-px rounded-2xl overflow-hidden border border-line bg-line">
      {bars.map((bar, bi) => {
        if (inCut(cuts, a.beats[bar.beats[0]], a.beats[bar.beats.at(-1)! + 1] ?? a.duration)) return null;
        const isCur = bi === curBar;
        const cells = rows[bi];
        return (
          <button
            key={bi}
            ref={isCur ? current : undefined}
            onClick={() => onSeek?.(bar.beats[0])}
            className={`relative text-left bg-surface px-2.5 pt-5 pb-2.5 min-h-16 ${isCur ? "bg-accent-soft" : ""} ${onSeek ? "hover:bg-surface-2" : "cursor-default"}`}
          >
            <span className="absolute top-1 left-2 text-[10px] text-muted tabular-nums">{bar.pickup ? "pickup" : bar.index}</span>
            <div className="grid" style={{ gridTemplateColumns: `repeat(${a.meter}, minmax(0, 1fr))` }}>
              {cells.map((c, k) => (
                <span
                  key={c.i}
                  style={bar.pickup ? { gridColumnStart: a.meter - bar.beats.length + k + 1 } : undefined}
                  className={`relative font-semibold text-lg leading-tight whitespace-nowrap ${c.show ? "" : "text-transparent"} ${c.repeat ? "opacity-45" : ""}`}
                >
                  {c.show ? (c.name === "N.C." ? "–" : c.name) : "·"}
                  {c.i === beat && <span className="absolute -bottom-1.5 left-0 h-1 w-5 rounded-full bg-now" aria-hidden />}
                </span>
              ))}
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function LyricsSheet({
  lyrics,
  a,
  names,
  beat,
  follow,
  offset,
  setOffset,
  onSeek,
  cuts,
  transcribe,
}: {
  lyrics: LyricsState;
  cuts: [number, number][];
  /** finds the words by listening, when no lyrics were found (null while not possible) */
  transcribe: { run: () => void; state: string | null; p: number | null } | null;
  a: Analysis;
  names: (cls: number) => string;
  beat: number;
  follow: boolean;
  offset: number;
  setOffset: (o: number) => void;
  onSeek?: (beat: number) => void;
}) {
  const current = useRef<HTMLDivElement>(null);
  const lines = lyrics !== "loading" && lyrics?.lines ? lyrics.lines : null;
  const t = beat >= 0 ? a.beats[beat] : -1;
  const curLine = lines ? lines.findLastIndex((l) => l.t + offset <= t) : -1;
  const allPieces = lines?.map((line, li) => chordsOverLine(line, lines[li + 1]?.t ?? line.t + 6, a, names, offset));
  useEffect(() => {
    if (follow && current.current) followInPane(current.current);
  }, [curLine, follow]);

  if (lyrics === "loading") return <p className="mt-6 text-muted text-sm">Looking for lyrics…</p>;
  if (!lyrics || (!lyrics.lines && !lyrics.plain))
    return (
      <div className="mt-6 text-sm">
        <p className="text-muted">No lyrics or captions were found for this one. Renaming the song (artist + title) can help find them.</p>
        {transcribe && (
          <div className="mt-3">
            {transcribe.state ? (
              <Working label={transcribe.state} p={transcribe.p} />
            ) : (
              <button onClick={transcribe.run} className="btn btn-primary btn-sm">
                Listen for the words
              </button>
            )}
          </div>
        )}
      </div>
    );
  if (!lines) {
    return (
      <div className="mt-6">
        <p className="text-xs text-muted mb-3">Only unsynced lyrics were found, so chords can&apos;t be placed on them. Use the Bars view for chords.</p>
        <pre className="whitespace-pre-wrap font-sans leading-relaxed">{lyrics.plain}</pre>
      </div>
    );
  }
  return (
    <div className="mt-5">
      <div className="flex items-center gap-2 text-xs text-muted mb-4">
        Lyrics timing
        <button className="rounded-md border border-line px-2 py-1" onClick={() => setOffset(Math.round((offset - 0.25) * 100) / 100)}>−</button>
        <span className="tabular-nums w-12 text-center">{offset > 0 ? "+" : ""}{offset.toFixed(2)}s</span>
        <button className="rounded-md border border-line px-2 py-1" onClick={() => setOffset(Math.round((offset + 0.25) * 100) / 100)}>+</button>
        <span>
          {lyrics.from === "lrclib"
            ? "Lyrics come from LRCLIB and may be timed for a different version."
            : lyrics.from === "youtube"
              ? "Words from the video's captions."
              : "Words transcribed from the audio; some may be misheard."}
        </span>
      </div>
      <div className="space-y-3">
        {allPieces!.map((pieces, li) => {
          const line = lines[li];
          if (inCut(cuts, line.t + offset, (lines[li + 1]?.t ?? line.t + 4) + offset)) return null;
          const carried = li > 0 && pieces[0].chord === allPieces![li - 1].at(-1)!.chord;
          const isCur = li === curLine;
          return (
            <div
              key={li}
              ref={isCur ? current : undefined}
              onClick={() => onSeek?.(pieces[0].beat)}
              className={`rounded-lg px-2 -mx-2 py-1 ${isCur ? "bg-accent-soft" : ""} ${onSeek ? "cursor-pointer" : ""}`}
            >
              <div className="flex flex-wrap items-end">
                {pieces.map((p, k) => (
                  <span key={k} className="inline-flex flex-col">
                    <span className={`text-accent font-semibold text-sm min-h-5 pr-2 ${k === 0 && carried ? "opacity-40" : ""}`}>
                      {p.chord === "N.C." ? "" : p.chord}
                    </span>
                    <span className="whitespace-pre text-[17px] leading-snug">{p.text || (line.text ? "" : "♪")}</span>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}


export function Working({ label, p }: { label: string; p: number | null }) {
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span>{label}…</span>
        {p !== null && <span className="tabular-nums text-muted">{Math.round(p * 100)}%</span>}
      </div>
      <div className="relative h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="absolute inset-y-0 left-0 bg-accent rounded-full transition-[width] duration-300" style={{ width: `${Math.max(4, (p ?? 0.15) * 100)}%` }} />
        <div className="absolute inset-0 progress-shimmer" />
      </div>
    </div>
  );
}
