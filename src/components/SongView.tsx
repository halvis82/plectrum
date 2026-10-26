"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import { loadLocalAudio } from "@/lib/audio";
import { capoOptions, keyName, transpose, type Simplify } from "@/lib/music";
import {
  beatAt,
  buildBars,
  chordsOverLine,
  makeShapeFn,
  parseLrc,
  songStats,
  uniqueShapes,
  type LyricLine,
  type View,
} from "@/lib/sheet";
import { ChordDiagram } from "./ChordDiagram";
import { TabSheet } from "./TabSheet";
import { TUNINGS, detectTuning, type TuningId } from "@/lib/tab";
import { usePendingNotes } from "@/lib/pending";
import { followInPane, touchPane } from "@/lib/follow";

export type SongData = {
  id: string;
  title: string;
  artist: string | null;
  source: string;
  source_url: string | null;
  youtube_id: string | null;
  audio_url?: string | null;
  analysis: Analysis;
};

type Clock = { now: () => number; seek: (t: number) => void; play: () => void; pause: () => void };

function usePrefs(id: string) {
  // v2: the capo now starts at none, so frets read as played
  const storageKey = `cc:view2:${id}`;
  // capo null = auto: follow the easiest capo for the current transposition
  // tuning null = auto (detected from the notes)
  const [view, setView] = useState<
    (Omit<View, "capo"> & { capo: number | null; tuning?: TuningId | null; mode: "tab" | "bars" | "lyrics"; follow: boolean; lyricOffset: number }) | null
  >(null);
  const update = useCallback(
    (patch: Partial<NonNullable<typeof view>>) =>
      setView((v) => {
        const next = { ...v!, ...patch };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      }),
    [storageKey],
  );
  return { view, setView, update, storageKey };
}

export function SongView({ song }: { song: SongData }) {
  // a song just made here: its notes may still be on their way
  const pending = usePendingNotes(song.id);
  const a = pending?.analysis ?? song.analysis;
  const notesComing = !a.notes && !!pending && !pending.error;
  const stats = useMemo(() => songStats(a), [a]);
  const bars = useMemo(() => buildBars(a), [a]);
  const { view, setView, update, storageKey } = usePrefs(song.id);

  useEffect(() => {
    let saved = null;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    } catch {}
    setView(saved ?? { transpose: 0, capo: 0, simplify: "triads", mode: a.notes || notesComing ? "tab" : "bars", follow: true, lyricOffset: 0 });
  }, [storageKey, setView, a.notes, notesComing]);

  // ---- playback ----
  const [mediaClock, setClock] = useState<Clock | null>(null);
  const [playing, setPlaying] = useState(false);
  const [beat, setBeat] = useState(-1);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState(false);
  const audioEl = useRef<HTMLAudioElement>(null);
  const firstChord = useMemo(() => {
    const i = a.chords.findIndex((c) => c < 168);
    return i >= 0 ? a.beats[i] : 0;
  }, [a]);

  // YouTube songs stream from our server; the rest play from this device's storage, or for links from
  // other sites are downloaded whole again (joined streams have no length, so they can't seek)
  useEffect(() => {
    if (song.youtube_id) return;
    let url: string | null = null;
    let gone = false;
    (async () => {
      let blob = await loadLocalAudio(song.id);
      if (!blob && song.audio_url) {
        const res = await fetch(`/api/media?url=${encodeURIComponent(song.audio_url)}`).catch(() => null);
        blob = res?.ok ? await res.blob() : null;
        if (!blob) setAudioFailed(true);
      }
      if (!blob || gone) return;
      url = URL.createObjectURL(blob);
      setLocalUrl(url);
    })();
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [song.id, song.youtube_id, song.audio_url]);
  const audioSrc = song.youtube_id ? `/api/audio/${song.youtube_id}` : localUrl;

  // the audio element only exists once view prefs have loaded
  const mounted = view !== null;
  useEffect(() => {
    const el = audioEl.current;
    if (!audioSrc || !el) return;
    setClock({ now: () => el.currentTime, seek: (t) => (el.currentTime = t), play: () => void el.play().catch(() => setAudioFailed(true)), pause: () => el.pause() });
  }, [audioSrc, mounted]);

  // no audio here (uploaded elsewhere, or YouTube unreachable): a silent play-along clock with a click
  const noAudio = !audioSrc || audioFailed;
  const fallbackClock = useMemo(() => (noAudio ? playAlongClock(a, setPlaying) : null), [noAudio, a]);
  const clock = fallbackClock ?? mediaClock;

  useEffect(() => {
    if (!clock) return;
    let raf = 0;
    const tick = () => {
      setBeat(beatAt(a.beats, clock.now() + 0.05));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [clock, a.beats]);

  /** Play from where you are, but never sit through a silent intro. */
  const play = () => {
    if (!clock) return;
    if (clock.now() < firstChord - 1.5) clock.seek(Math.max(0, firstChord - 1));
    clock.play();
  };

  // ---- lyrics ----
  const [lyrics, setLyrics] = useState<{ lines: LyricLine[] | null; plain: string | null } | "loading" | null>("loading");
  useEffect(() => {
    const qs = new URLSearchParams({ title: song.title, artist: song.artist ?? "", duration: String(Math.round(a.duration)) });
    fetch(`/api/lyrics?${qs}`)
      .then((r) => r.json())
      .then(({ lyrics: l }) => setLyrics(l ? { lines: l.synced ? parseLrc(l.synced) : null, plain: l.plain } : null))
      .catch(() => setLyrics(null));
  }, [song.title, song.artist, a.duration]);

  const detected = useMemo(
    () => (a.notes ? detectTuning(a.notes.map(([start, end, midi, amp, ...strings]) => ({ start, end, midi, amp, strings: strings.length === 6 ? strings : undefined }))) : "standard"),
    [a.notes],
  );
  const tuning = TUNINGS.find((t) => t.id === (view?.tuning ?? detected)) ?? TUNINGS[0];
  // notes too low for the current tuning would drop out of the tab
  const tooLow = useMemo(() => a.notes?.filter(([, , midi]) => midi < tuning.strings[0] && midi >= 36).length ?? 0, [a.notes, tuning]);
  // a lowered tuning works like a negative capo: shapes sit above the sounding chords
  const transposeBy = (view?.transpose ?? 0) - tuning.shift;
  // nobody tunes down and then capos back up, so a lowered tuning plays without one
  const bestCapo = useMemo(
    () => (tuning.shift < 0 ? 0 : capoOptions(stats.items.map((i) => ({ chord: transpose(i.chord, transposeBy), dur: i.dur })))[0].capo),
    [stats, transposeBy, tuning.shift],
  );
  const capo = view?.capo ?? bestCapo;
  const shape = useMemo(() => (view ? makeShapeFn(a, { ...view, capo: capo + tuning.shift }, stats.key) : null), [a, view, capo, tuning.shift, stats.key]);
  const names = useCallback((c: number) => shape!(c).name, [shape]);

  if (!view || !shape) return <div className="h-96" />;

  const shapes = uniqueShapes(a, shape);
  const sounding = { ...stats.key, tonic: (stats.key.tonic + view.transpose + 120) % 12 };
  const seekBeat = (i: number) => {
    if (!clock) return;
    clock.seek(Math.max(0, a.beats[i] - 0.02));
    clock.play();
  };

  return (
    <div>
      {/* player */}
      {audioSrc && !audioFailed ? (
        <audio
          ref={audioEl}
          src={audioSrc}
          preload="metadata"
          controls
          className="w-full mb-4"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setAudioFailed(true)}
        />
      ) : (
        <p className="text-xs text-muted mb-4">
          {audioFailed
            ? "The audio couldn't be loaded right now, so ▶ plays along silently with a click on every beat."
            : song.audio_url
              ? "Loading the audio…"
              : `${song.source === "record" ? "Recorded" : "Uploaded"} on another device, so there's no audio here. ▶ plays along with a click on every beat.`}
        </p>
      )}

      {/* controls */}
      <div data-controls className="sticky top-0 z-10 -mx-4 px-4 py-2.5 bg-bg/90 backdrop-blur border-b border-line flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        {clock && (
          <button
            onClick={() => (playing ? clock.pause() : play())}
            className="h-9 w-9 rounded-full bg-accent text-accent-fg grid place-items-center"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? "❚❚" : "▶"}
          </button>
        )}
        <Stepper label="Transpose" value={view.transpose > 0 ? `+${view.transpose}` : String(view.transpose)} onDec={() => update({ transpose: view.transpose - 1 })} onInc={() => update({ transpose: view.transpose + 1 })} />
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Capo</span>
          <select
            value={view.capo ?? "auto"}
            onChange={(e) => update({ capo: e.target.value === "auto" ? null : Number(e.target.value) })}
            className="rounded-lg border border-line bg-surface px-2 py-1.5"
          >
            <option value="auto">Easiest ({bestCapo === 0 ? "none" : bestCapo})</option>
            {Array.from({ length: 10 }, (_, c) => (
              <option key={c} value={c}>
                {c === 0 ? "None" : c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5">
          <span className="text-muted">Tuning</span>
          <select
            value={view.tuning ?? "auto"}
            onChange={(e) => update({ tuning: e.target.value === "auto" ? null : (e.target.value as TuningId) })}
            className="rounded-lg border border-line bg-surface px-2 py-1.5"
          >
            <option value="auto">Auto ({TUNINGS.find((t) => t.id === detected)!.name})</option>
            {TUNINGS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        <Segmented<Simplify>
          value={view.simplify}
          onChange={(v) => update({ simplify: v })}
          options={[
            ["full", "All"],
            ["sevenths", "7ths"],
            ["triads", "Basic"],
          ]}
        />
        <Segmented<"tab" | "bars" | "lyrics">
          value={view.mode}
          onChange={(v) => update({ mode: v })}
          options={[
            ["tab", "Tab"],
            ["bars", "Bars"],
            ["lyrics", "Lyrics"],
          ]}
        />
      </div>

      <p className="mt-3 text-sm text-muted">
        Key <b className="text-fg">{keyName(sounding)}</b> · {Math.round(a.bpm)} BPM · {a.meter}/4
        {tuning.id !== "standard" && <> · {tuning.name}</>}
        {capo > 0 && (
          <>
            {" "}· Capo {capo}, shapes in <b className="text-fg">{keyName({ ...sounding, tonic: (sounding.tonic - capo - tuning.shift + 24) % 12 }).split(" ")[0]}{sounding.mode === "minor" ? "m" : ""}</b>
          </>
        )}
        {view.capo !== null && view.capo !== bestCapo && (
          <button className="ml-2 underline" onClick={() => update({ capo: null })}>
            easiest: capo {bestCapo}
          </button>
        )}
      </p>

      {/* chord shapes */}
      <div className="mt-4 flex gap-3 overflow-x-auto pb-2 -mx-4 px-4">
        {shapes.map((s) => (
          <div key={s.name} className="shrink-0 rounded-xl bg-surface border border-line px-2 pt-2 pb-1">
            <ChordDiagram chord={s.chord} name={s.name} />
          </div>
        ))}
      </div>

      {view.mode === "tab" && tooLow >= Math.max(12, 0.02 * (a.notes?.length ?? 0)) && (
        <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">
          {tooLow} notes are lower than {tuning.name.toLowerCase()} tuning reaches, so they&apos;re left out. If the guitar is tuned down, pick its tuning:{" "}
          {TUNINGS.filter((t) => t.strings[0] < tuning.strings[0]).map((t) => (
            <button key={t.id} onClick={() => update({ tuning: t.id })} className="underline mr-2">
              {t.name}
            </button>
          ))}
        </p>
      )}
      <div data-pane onWheel={touchPane} onTouchMove={touchPane} className="mt-4 max-h-[78dvh] overflow-y-auto overscroll-contain rounded-2xl border border-line px-3 pb-4 -mx-1">
        {pending?.error && <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">{pending.error}</p>}
        {view.mode === "tab" && notesComing ? (
          <>
            <div className="mt-6 rounded-2xl border border-line bg-surface p-5">
              <p className="text-sm">{pending.label}… the tab replaces the chord sheet below when every note is in.</p>
              <div className="mt-3 h-1.5 rounded-full bg-surface-2 overflow-hidden">
                <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(3, (pending.p ?? 0) * 100)}%` }} />
              </div>
            </div>
            <BarsSheet bars={bars} a={a} names={names} beat={beat} follow={view.follow && playing} onSeek={clock ? seekBeat : undefined} />
          </>
        ) : view.mode === "tab" ? (
          <TabSheet
            a={a}
            bars={bars}
            names={names}
            transpose={view.transpose}
            capo={capo}
            tuning={tuning.strings}
            now={clock?.now ?? null}
            follow={view.follow && playing}
            onSeek={
              clock
                ? (t) => {
                    clock.seek(Math.max(0, t - 0.02));
                    clock.play();
                  }
                : undefined
            }
          />
        ) : view.mode === "bars" ? (
          <BarsSheet bars={bars} a={a} names={names} beat={beat} follow={view.follow && playing} onSeek={clock ? seekBeat : undefined} />
        ) : (
          <LyricsSheet
            lyrics={lyrics}
            a={a}
            names={names}
            beat={beat}
            follow={view.follow && playing}
            offset={view.lyricOffset}
            setOffset={(o) => update({ lyricOffset: o })}
            onSeek={clock ? seekBeat : undefined}
          />
        )}
      </div>

      <label className="mt-6 flex items-center gap-2 text-sm text-muted">
        <input type="checkbox" checked={view.follow} onChange={(e) => update({ follow: e.target.checked })} />
        Auto-scroll while playing
      </label>
    </div>
  );
}

function BarsSheet({
  bars,
  a,
  names,
  beat,
  follow,
  onSeek,
}: {
  bars: ReturnType<typeof buildBars>;
  a: Analysis;
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

function LyricsSheet({
  lyrics,
  a,
  names,
  beat,
  follow,
  offset,
  setOffset,
  onSeek,
}: {
  lyrics: { lines: LyricLine[] | null; plain: string | null } | "loading" | null;
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
  if (!lyrics) return <p className="mt-6 text-muted text-sm">No lyrics found for this title. Renaming the song (artist + title) can help find them.</p>;
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
        <span>Lyrics come from LRCLIB and may be timed for a different version.</span>
      </div>
      <div className="space-y-3">
        {allPieces!.map((pieces, li) => {
          const line = lines[li];
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

function Stepper({ label, value, onDec, onInc }: { label: string; value: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <button onClick={onDec} className="h-8 w-8 rounded-lg border border-line" aria-label={`${label} down`}>−</button>
      <span className="w-7 text-center tabular-nums">{value}</span>
      <button onClick={onInc} className="h-8 w-8 rounded-lg border border-line" aria-label={`${label} up`}>+</button>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex rounded-lg bg-surface-2 p-0.5">
      {options.map(([v, label]) => (
        <button key={v} onClick={() => onChange(v)} className={`px-2.5 py-1 rounded-md ${value === v ? "bg-surface shadow-sm" : "text-muted"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Silent transport that follows the song's beat grid, with a metronome click. */
function playAlongClock(a: Analysis, setPlaying: (p: boolean) => void): Clock {
  let pos = 0, startedAt = 0, running = false, timer = 0;
  let ctx: AudioContext | null = null;
  let nextBeat = 0;
  const now = () => (running ? pos + (performance.now() - startedAt) / 1000 : pos);
  const schedule = () => {
    // look ahead 200 ms and queue clicks on upcoming beats
    const t = now();
    while (nextBeat < a.beats.length && a.beats[nextBeat] < t + 0.2) {
      const at = a.beats[nextBeat];
      if (at >= t - 0.02 && ctx) {
        const when = ctx.currentTime + Math.max(0, at - t);
        const osc = ctx.createOscillator(), gain = ctx.createGain();
        osc.frequency.value = (nextBeat - a.downbeat) % a.meter === 0 ? 1500 : 1000;
        gain.gain.setValueAtTime(0.25, when);
        gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
        osc.connect(gain).connect(ctx.destination);
        osc.start(when);
        osc.stop(when + 0.06);
      }
      nextBeat++;
    }
    if (t >= a.duration) clock.pause();
  };
  const clock: Clock = {
    now,
    seek: (t) => {
      pos = t;
      startedAt = performance.now();
      nextBeat = beatAt(a.beats, t) + 1;
    },
    play: () => {
      if (running) return;
      ctx ??= new AudioContext();
      void ctx.resume();
      startedAt = performance.now();
      nextBeat = beatAt(a.beats, pos) + 1;
      running = true;
      timer = window.setInterval(schedule, 50);
      setPlaying(true);
    },
    pause: () => {
      if (!running) return;
      pos = now();
      running = false;
      clearInterval(timer);
      setPlaying(false);
    },
  };
  return clock;
}
