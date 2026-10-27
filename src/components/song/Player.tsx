"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Transport } from "@/lib/transport";

const SPEEDS = [0.5, 0.6, 0.75, 0.85, 1, 1.1, 1.25, 1.5];

/** The song's transport, pinned to the bottom of the screen: play, a scrubber that shows the cut parts,
 * speed, and what you hear (the song, the tab on a guitar, or both). */
export function Player({
  transport,
  duration,
  cuts,
  hasAudio,
  audioNote,
  children,
}: {
  transport: Transport;
  duration: number;
  cuts: [number, number][];
  hasAudio: boolean;
  audioNote: string | null;
  /** shown above the player (the edit toolbar) */
  children?: React.ReactNode;
}) {
  const st = useSyncExternalStore(transport.subscribe, transport.getState, transport.getState);
  const [t, setT] = useState(0);
  const [menu, setMenu] = useState<"speed" | "sound" | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (!scrubbing.current) setT(transport.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transport]);

  // space plays and pauses (outside text fields)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.code !== "Space" || /INPUT|TEXTAREA|SELECT/.test(el.tagName) || el.isContentEditable) return;
      e.preventDefault();
      if (transport.getState().playing) transport.pause();
      else void transport.play();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [transport]);

  const seekTo = (clientX: number, commit: boolean) => {
    const r = bar.current!.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * duration;
    setT(x);
    if (commit) transport.seek(x);
  };

  const sound = st.audio && st.guitar ? "both" : st.guitar ? "guitar" : "song";
  const pct = (x: number) => `${(x / Math.max(1e-3, duration)) * 100}%`;

  return (
    <div className="fixed inset-x-0 bottom-0 z-30 pointer-events-none pb-[env(safe-area-inset-bottom)]">
      <div className="mx-auto max-w-5xl px-2 sm:px-4 pb-2 sm:pb-3">
        {children}
        <div data-dock className="pointer-events-auto relative rounded-2xl border border-line bg-surface/95 backdrop-blur shadow-lg px-3 py-2.5">
          {/* scrubber */}
          <div
            ref={bar}
            className="relative h-5 flex items-center cursor-pointer touch-none select-none"
            onPointerDown={(e) => {
              scrubbing.current = true;
              e.currentTarget.setPointerCapture(e.pointerId);
              seekTo(e.clientX, false);
            }}
            onPointerMove={(e) => scrubbing.current && seekTo(e.clientX, false)}
            onPointerUp={(e) => {
              scrubbing.current = false;
              seekTo(e.clientX, true);
            }}
            role="slider"
            aria-label="Position in the song"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(t)}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") transport.seek(transport.now() + 5);
              if (e.key === "ArrowLeft") transport.seek(transport.now() - 5);
            }}
          >
            <div className="absolute inset-x-0 h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <div className="h-full bg-accent" style={{ width: pct(t) }} />
              {cuts.map(([a, b], k) => (
                <div key={k} className="absolute inset-y-0 cut-hatch" style={{ left: pct(a), width: pct(Math.min(duration, b) - a) }} />
              ))}
            </div>
            <div className="absolute h-4 w-4 -translate-x-1/2 rounded-full bg-surface border-2 border-accent shadow" style={{ left: pct(t) }} aria-hidden />
          </div>

          <div className="mt-1.5 flex items-center gap-2">
            <button onClick={() => transport.seek(transport.now() - 5)} className="btn btn-ghost btn-icon h-9 w-9 text-muted" aria-label="Back 5 seconds">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </button>
            <button
              onClick={() => (st.playing ? transport.pause() : void transport.play())}
              className="relative btn btn-primary btn-icon h-11 w-11 shadow"
              aria-label={st.playing ? "Pause" : "Play"}
            >
              {st.buffering && <span className="absolute -inset-1 rounded-full border-2 border-accent border-t-transparent animate-spin" aria-hidden />}
              {st.playing ? (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <rect x="6" y="4" width="4" height="16" rx="1.2" />
                  <rect x="14" y="4" width="4" height="16" rx="1.2" />
                </svg>
              ) : (
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                  <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
                </svg>
              )}
            </button>
            <span className="text-sm tabular-nums text-muted min-w-0 truncate" aria-live="polite">
              {st.buffering ? (
                "Loading audio…"
              ) : (
                <>
                  <span className="text-fg">{clock(t)}</span> / {clock(duration)}
                </>
              )}
            </span>
            <span className="flex-1" />
            <button onClick={() => setMenu(menu === "speed" ? null : "speed")} className={`btn btn-sm ${st.rate !== 1 ? "btn-primary" : ""}`} aria-label="Speed" aria-expanded={menu === "speed"}>
              {st.rate}×
            </button>
            <button onClick={() => setMenu(menu === "sound" ? null : "sound")} className={`btn btn-sm gap-1.5 ${st.guitar ? "btn-primary" : ""}`} aria-label="What you hear" aria-expanded={menu === "sound"}>
              {st.guitar && (
                <span className="hidden sm:inline-flex">
                  <GuitarIcon />
                </span>
              )}
              {sound === "song" ? "Song" : sound === "guitar" ? "Guitar" : "Both"}
              {st.click && <span className="hidden sm:inline">+ click</span>}
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden>
                <path d="M6 15l6-6 6 6" />
              </svg>
            </button>
          </div>

          {menu && (
            <div className="absolute bottom-full right-2 mb-2 w-72 max-w-[calc(100vw-2rem)] rounded-2xl border border-line bg-surface shadow-xl p-3 text-sm">
              {menu === "speed" ? (
                <>
                  <div className="flex justify-between mb-1">
                    <span className="font-medium">Speed</span>
                    <span className="tabular-nums text-muted">{st.rate}×</span>
                  </div>
                  <input
                    type="range"
                    className="range w-full"
                    min={0.4}
                    max={1.6}
                    step={0.05}
                    value={st.rate}
                    style={{ ["--fill" as string]: `${((st.rate - 0.4) / 1.2) * 100}%` }}
                    onChange={(e) => transport.setOptions({ rate: Number(e.target.value) })}
                  />
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {SPEEDS.map((r) => (
                      <button key={r} onClick={() => transport.setOptions({ rate: r })} className={`btn btn-sm px-2.5 ${st.rate === r ? "btn-primary" : ""}`}>
                        {r}×
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-muted">The pitch stays the same at any speed.</p>
                </>
              ) : (
                <>
                  <p className="font-medium mb-2">What you hear</p>
                  <div className="grid grid-cols-3 gap-1.5">
                    {(
                      [
                        ["song", "Song", hasAudio],
                        ["both", "Both", hasAudio],
                        ["guitar", "Guitar", true],
                      ] as const
                    ).map(([k, label, ok]) => (
                      <button
                        key={k}
                        disabled={!ok}
                        onClick={() => transport.setOptions({ audio: k !== "guitar", guitar: k !== "song" })}
                        className={`btn btn-sm px-1.5 ${sound === k ? "btn-primary" : ""}`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {sound === "both" && (
                    <div className="mt-3 flex items-center gap-2 text-xs text-muted">
                      <span>Song</span>
                      <input
                        type="range"
                        className="range flex-1"
                        min={0}
                        max={1}
                        step={0.05}
                        value={st.balance}
                        style={{ ["--fill" as string]: `${st.balance * 100}%` }}
                        onChange={(e) => transport.setBalance(Number(e.target.value))}
                        aria-label="Balance between the song and the guitar"
                      />
                      <span>Guitar</span>
                    </div>
                  )}
                  <p className="mt-2 text-xs text-muted">The guitar plays the tab exactly as shown, note for note, on a recorded acoustic guitar.</p>
                  {audioNote && <p className="mt-1 text-xs text-muted">{audioNote}</p>}
                  <label className="mt-3 flex items-center gap-2">
                    <input type="checkbox" checked={st.click} onChange={(e) => transport.setOptions({ click: e.target.checked })} />
                    Click on every beat
                  </label>
                </>
              )}
            </div>
          )}
        </div>
      </div>
      {menu && <div className="fixed inset-0 -z-10 pointer-events-auto" onClick={() => setMenu(null)} aria-hidden />}
    </div>
  );
}

const clock = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

/** a small acoustic guitar */
export function GuitarIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14.5 9.5L20 4" />
      <path d="M18.5 2.5l3 3" />
      <path d="M11.3 8.2c-1.3-1-3.3-.9-4.5.4-.7.7-.9 1.6-.9 2.4-1.3.1-2.4.6-3.1 1.6-1.5 2.1-.8 5.2 1.4 6.9s5.4 2.1 7.2.4c.8-.8 1.2-1.8 1.2-3 .9-.1 1.8-.4 2.4-1.1 1.3-1.3 1.3-3.4.2-4.7" />
      <circle cx="9.5" cy="14.5" r="1.6" />
    </svg>
  );
}
