"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import type { Analysis, NoteRow } from "@/lib/analysis/analyze";
import { loadLocalAudio } from "@/lib/audio";
import { capoOptions, keyName, spellingFor, transpose, type Simplify } from "@/lib/music";
import { beatAt, buildBars, makeShapeFn, songStats, uniqueShapes, type View } from "@/lib/sheet";
import { STANDARD, TUNINGS, detectTuning, stringNames, toTab, type TuningId } from "@/lib/tab";
import { usePendingNotes } from "@/lib/pending";
import { touchPane } from "@/lib/follow";
import { addCut, applyEdits, keptLength, setChords, type EditNote, type Edits, type Technique } from "@/lib/edits";
import { useEdits } from "@/lib/useEdits";
import { DEFAULT_DETAIL, hasConfidence, noteStrength, notesForDetail } from "@/lib/strength";
import { Transport, type SynthNote } from "@/lib/transport";
import type { Captions } from "@/lib/captions";
import { useWords } from "@/lib/useWords";
import { ChordDiagram } from "../ChordDiagram";
import { TabSheet, type SheetNote } from "./TabSheet";
import { BarsSheet, LyricsSheet, Working } from "./Sheets";
import { Player } from "./Player";
import { EditToolbar, type NoteActions } from "./EditToolbar";
import { ChordPicker } from "./ChordPicker";
import { Trim } from "./Trim";
import { SourcePanel } from "./SourcePanel";

export type SongData = {
  id: string;
  title: string;
  artist: string | null;
  source: string;
  source_url: string | null;
  youtube_id: string | null;
  audio_url?: string | null;
  analysis: Analysis;
  edits: Edits | null;
  captions: Captions | null;
  created_at?: string;
  updated_at?: string | null;
  views: number;
};

type Prefs = Omit<View, "capo"> & {
  capo: number | null;
  tuning: TuningId | null;
  mode: "tab" | "bars" | "lyrics";
  follow: boolean;
  lyricOffset: number;
  /** 1 = every note heard, lower = only the most clearly played; null = the recommended setting */
  clean: number | null;
  /** grid steps per beat for editing */
  snap: number;
};

const DEFAULT_PREFS: Prefs = { transpose: 0, capo: 0, simplify: "triads", tuning: null, mode: "tab", follow: true, lyricOffset: 0, clean: null, snap: 4 };

function usePrefs(id: string, hasTab: boolean) {
  const storageKey = `cc:view3:${id}`;
  const [view, setView] = useState<Prefs | null>(null);
  useEffect(() => {
    let saved: Partial<Prefs> | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(storageKey) ?? localStorage.getItem(`cc:view2:${id}`) ?? "null");
    } catch {}
    // saved display choices live in this browser, so they're read once the page is on screen
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setView({ ...DEFAULT_PREFS, mode: hasTab ? "tab" : "bars", ...saved });
  }, [storageKey, id, hasTab]);
  const update = useCallback(
    (patch: Partial<Prefs>) =>
      setView((v) => {
        const next = { ...(v ?? DEFAULT_PREFS), ...patch };
        try {
          localStorage.setItem(storageKey, JSON.stringify(next));
        } catch {}
        return next;
      }),
    [storageKey],
  );
  return { view, update };
}

const rowToInput = (r: NoteRow, shift = 0) => ({ start: r[0], end: r[1], midi: r[2] + shift, amp: r[3], strings: r.length >= 10 ? r.slice(4, 10) : undefined });

export function SongView({ song }: { song: SongData }) {
  const router = useRouter();

  // a song just made here: its notes may still be on their way
  const pending = usePendingNotes(song.id);
  const base = pending?.analysis ?? song.analysis;
  const notesComing = !base.notes && !!pending && !pending.error;
  const partial = notesComing ? pending.partial : undefined;
  const scratch = song.source === "scratch";

  const ed = useEdits(song.id, song.edits);
  const edits = ed.edits;
  const a = useMemo(() => applyEdits(base, edits), [base, edits]);
  const cuts = useMemo(() => edits?.cuts ?? [], [edits?.cuts]);
  const bars = useMemo(() => buildBars(a, scratch), [a, scratch]);
  const stats = useMemo(() => songStats(a), [a]);
  const { view, update } = usePrefs(song.id, !!(a.notes || notesComing || edits?.tab));
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);
  const [picker, setPicker] = useState<{ from: number; to: number } | null>(null);
  const [showOptions, setShowOptions] = useState(false);
  const [trimming, setTrimming] = useState(false);

  // ---- notes: as heard (thinned by the detail slider) or as written by hand ----
  const rows = partial ? partial.notes : a.notes;
  const confident = hasConfidence(rows);
  const strength = useMemo(() => (rows && !confident ? noteStrength(rows) : null), [rows, confident]);
  // songs analyzed before the cleanup start with every note, as they always showed
  const detail = view?.clean ?? (confident ? DEFAULT_DETAIL : 1);
  const shownRows = useMemo(() => (rows ? notesForDetail(rows, detail, strength) : null), [rows, strength, detail]);
  const detected = useMemo(() => (a.notes ? detectTuning(a.notes.map((r) => rowToInput(r))) : "standard"), [a.notes]);
  const autoTuning = TUNINGS.find((t) => t.id === (view?.tuning ?? detected)) ?? TUNINGS[0];
  const written = edits?.tab ?? null;
  const openStrings = written ? (edits?.tuning ?? STANDARD) : autoTuning.strings;
  const tuningShift = written ? 0 : autoTuning.shift;
  const transposeBy = (view?.transpose ?? 0) - tuningShift;
  const bestCapo = useMemo(
    () => (tuningShift < 0 ? 0 : capoOptions(stats.items.map((i) => ({ chord: transpose(i.chord, transposeBy), dur: i.dur })))[0].capo),
    [stats, transposeBy, tuningShift],
  );
  const capo = view?.capo ?? bestCapo;
  const tabCapo = written ? 0 : capo;
  const tabTranspose = written ? 0 : (view?.transpose ?? 0);

  const autoTab = useMemo(() => {
    if (written || !shownRows) return [];
    const tuning = openStrings.map((m) => m + tabCapo);
    return toTab(shownRows.map((r) => rowToInput(r, tabTranspose)), tuning);
  }, [written, shownRows, openStrings, tabCapo, tabTranspose]);

  const sheetNotes: SheetNote[] = useMemo(
    () =>
      written
        ? written.map((n, i) => ({ id: i, start: n[0], end: n[0] + n[1], string: n[2], fret: n[3], amp: 1, tech: n[4] }))
        : autoTab.map((n, i) => ({ id: i, start: n.start, end: n.end, string: n.string, fret: n.fret, amp: n.amp, tech: 0 as Technique })),
    [written, autoTab],
  );
  const midiOf = useCallback((n: { string: number; fret: number }) => openStrings[n.string] + tabCapo + n.fret, [openStrings, tabCapo]);

  // ---- playback ----
  const transport = useMemo(() => new Transport(a.duration, a.beats, a.meter, a.downbeat), [song.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => transport.dispose(), [transport]);
  useEffect(() => transport.setGrid(a.duration, a.beats, a.meter, a.downbeat), [transport, a]);
  useEffect(() => transport.setCuts(cuts), [transport, cuts]);
  useEffect(() => {
    const notes: SynthNote[] = sheetNotes.map((n) => ({ t: n.start, end: Math.max(n.end, n.start + 0.12), midi: midiOf(n), gain: written ? 0.75 : 0.35 + 0.5 * Math.min(1, n.amp * 1.5), soft: n.tech === 1 || n.tech === 2 }));
    transport.setNotes(notes);
  }, [transport, sheetNotes, midiOf, written]);
  const tstate = useSyncExternalStore(transport.subscribe, transport.getState, transport.getState);

  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const [audioFailed, setAudioFailed] = useState(false);
  const [audioMissing, setAudioMissing] = useState(false);
  useEffect(() => {
    if (song.youtube_id || scratch) return;
    let url: string | null = null;
    let gone = false;
    (async () => {
      let blob = await loadLocalAudio(song.id);
      if (!blob && song.audio_url) {
        const res = await fetch(`/api/media?url=${encodeURIComponent(song.audio_url)}`).catch(() => null);
        blob = res?.ok ? await res.blob() : null;
      }
      if (gone) return;
      if (!blob) return setAudioMissing(true);
      url = URL.createObjectURL(blob);
      setLocalUrl(url);
    })();
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [song.id, song.youtube_id, song.audio_url, scratch]);
  const audioSrc = audioFailed ? null : song.youtube_id ? `/api/audio/${song.youtube_id}` : localUrl;
  const hasAudio = !!audioSrc;
  const audioEl = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    transport.setMedia(audioSrc ? audioEl.current : null);
    // nothing to hear but the tab: play it on the guitar
    if (!audioSrc && (scratch || audioFailed || audioMissing)) transport.setOptions({ audio: false, guitar: true });
  }, [transport, audioSrc, scratch, audioFailed, audioMissing, view === null]); // eslint-disable-line react-hooks/exhaustive-deps

  // the beat now playing, for the chord and lyric sheets. Set only when it changes: a state update every
  // frame would keep interrupting (and so starve) the render of a long tab
  const [beat, setBeat] = useState(-1);
  useEffect(() => {
    let raf = 0;
    let last = -2;
    const tick = () => {
      const b = beatAt(a.beats, transport.now() + 0.05);
      if (b !== last) setBeat((last = b));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [transport, a.beats]);

  // playing from the very start skips a silent intro
  useEffect(() => {
    const i = a.chords.findIndex((c) => c < 168);
    const firstNote = a.notes?.[0]?.[0] ?? Infinity;
    transport.setIntro(Math.max(0, Math.min(i >= 0 ? a.beats[i] : 0, firstNote) - 1));
  }, [transport, a]);
  const seekPlay = (t: number) => {
    transport.seek(Math.max(0, t - 0.02));
    void transport.play();
  };

  // ---- words: lyrics, the video's captions, or transcribed ----
  const words = useWords(song, a.duration, transport, view?.mode === "lyrics" || editing);

  // ---- editing ----
  const startEditing = useCallback(() => {
    if (!edits?.tab) {
      // the tab as it reads now becomes the written one (no capo or transposition, so frets are as played)
      const tuning = autoTuning.strings;
      const tab = shownRows ? toTab(shownRows.map((r) => rowToInput(r)), tuning) : [];
      const asWritten: EditNote[] = tab.map((n) => [+n.start.toFixed(3), +Math.max(0.05, n.end - n.start).toFixed(3), n.string, n.fret, 0]);
      ed.change((e) => ({ ...e, v: 1, tab: asWritten, tuning: [...tuning] }));
      update({ capo: 0, transpose: 0, mode: "tab" });
    } else update({ mode: "tab" });
    setEditing(true);
  }, [edits?.tab, autoTuning.strings, shownRows, ed, update]);

  // a new song from scratch opens ready to write in
  const openedForEditing = useRef(false);
  useEffect(() => {
    if (openedForEditing.current || !view || new URLSearchParams(location.search).get("edit") !== "1") return;
    openedForEditing.current = true;
    startEditing();
    router.replace(`/song/${song.id}`, { scroll: false });
  }, [view, startEditing, router, song.id]);

  const snap = view?.snap ?? 4;
  /** one grid step at time t */
  const stepLen = (t: number) => {
    const i = Math.max(0, beatAt(a.beats, t));
    const beatLen = (a.beats[i + 1] ?? a.beats[i] + 0.5) - a.beats[i] || 0.5;
    return snap ? beatLen / snap : 0.05;
  };
  const lastFret = useRef(0);
  const setNote = (id: number, fn: (n: EditNote) => EditNote, merge = false) =>
    ed.change((e) => ({ ...e, tab: (e.tab ?? []).map((n, i) => (i === id ? fn([...n] as EditNote) : n)) }), merge);
  const sel = selected !== null && written?.[selected] ? sheetNotes[selected] : null;
  const strings = openStrings.length;
  const actions: NoteActions = {
    setFret: (f) => {
      if (selected === null) return;
      lastFret.current = f;
      setNote(selected, (n) => ((n[3] = f), n));
      transport.preview(openStrings[sel!.string] + f, 0.5);
    },
    moveString: (d) => selected !== null && setNote(selected, (n) => ((n[2] = Math.max(0, Math.min(strings - 1, n[2] + d))), n)),
    nudge: (d) => selected !== null && setNote(selected, (n) => ((n[0] = Math.max(0, +(n[0] + d * stepLen(n[0])).toFixed(4))), n)),
    lengthen: (d) => selected !== null && setNote(selected, (n) => ((n[1] = Math.max(0.03, +(n[1] + d * stepLen(n[0])).toFixed(4))), n)),
    setTech: (k) => selected !== null && setNote(selected, (n) => ((n[4] = k), n)),
    remove: () => {
      if (selected === null) return;
      const id = selected;
      setSelected(null);
      ed.change((e) => ({ ...e, tab: (e.tab ?? []).filter((_, i) => i !== id) }));
    },
    hear: () => sel && transport.preview(midiOf(sel)),
  };
  const editHandlers = editing && written
    ? {
        selected,
        select: (id: number | null) => {
          setSelected(id);
          if (id !== null && written[id]) {
            lastFret.current = written[id][3];
            transport.preview(openStrings[written[id][2]] + written[id][3], 0.6);
          }
        },
        add: (t: number, s: number) => {
          const len = Math.max(0.1, stepLen(t) * 2);
          const id = written.length;
          ed.change((e) => ({ ...e, tab: [...(e.tab ?? []), [+t.toFixed(4), +len.toFixed(4), s, lastFret.current, 0] as EditNote] }));
          setSelected(id);
          transport.preview(openStrings[s] + lastFret.current, 0.5);
        },
        move: (id: number, t: number, s: number, first: boolean) => setNote(id, (n) => ((n[0] = Math.max(0, t)), (n[2] = s), n), !first),
        resize: (id: number, end: number, first: boolean) => setNote(id, (n) => ((n[1] = Math.max(0.03, +(end - n[0]).toFixed(4))), n), !first),
        chordAt: (b: number) => {
          // the chord from this beat to where it changes (a bar at most when there is none)
          const cls = a.chords[b];
          let to = b;
          const barEnd = bars.find((x) => x.beats.includes(b))?.beats.at(-1) ?? b;
          while (to + 1 < a.chords.length && a.chords[to + 1] === cls && (cls < 168 || to < barEnd)) to++;
          setPicker({ from: b, to });
        },
        snap: view?.snap ?? 4,
      }
    : null;

  // stable functions and lists for the tab sheet, which only re-renders when they change
  const shapeFn = useMemo(() => (view ? makeShapeFn(a, { ...view, capo: capo + tuningShift }, stats.key) : null), [a, view, capo, tuningShift, stats.key]);
  const namesFn = useMemo(() => (shapeFn ? (c: number) => shapeFn(c).name : null), [shapeFn]);
  const stringLabels = useMemo(() => stringNames(openStrings.map((m) => m + tabCapo)), [openStrings, tabCapo]);
  const seekPlayCb = useCallback(
    (t: number) => {
      transport.seek(Math.max(0, t - 0.02));
      void transport.play();
    },
    [transport],
  );

  // ---- trimming ----
  const activity = useMemo(() => {
    const bins = new Float32Array(Math.max(10, Math.min(400, Math.ceil(a.duration))));
    const per = a.duration / bins.length;
    const src = rows ?? [];
    for (const r of src) bins[Math.min(bins.length - 1, Math.floor(r[0] / per))] += r[3];
    if (!src.length) a.chords.forEach((c, i) => c < 168 && (bins[Math.min(bins.length - 1, Math.floor(a.beats[i] / per))] += 1));
    let max = 0;
    for (const v of bins) max = Math.max(max, v);
    return bins.map((v) => (max ? Math.sqrt(v / max) : 0));
  }, [rows, a]);
  const cutsChange = (fn: (c: [number, number][]) => [number, number][]) => ed.change((e) => ({ ...e, cuts: fn(e.cuts ?? []) }));

  if (!view || !shapeFn || !namesFn) return <div className="h-96" />;

  const shape = shapeFn;
  const names = namesFn;
  const shapes = uniqueShapes(a, shape);
  const sounding = { ...stats.key, tonic: (stats.key.tonic + view.transpose + 120) % 12 };
  const spelling = spellingFor({ ...stats.key, tonic: (stats.key.tonic + view.transpose - capo + 120) % 12 });
  const tooLow = written ? 0 : (a.notes?.filter(([, , midi]) => midi < autoTuning.strings[0] && midi >= 36).length ?? 0);
  const shownCount = written ? written.length : autoTab.length;
  const allCount = rows?.length ?? 0;
  const playback = scratch
    ? "The tab, played on a synthesized acoustic guitar"
    : song.youtube_id
      ? audioFailed
        ? "The video's audio couldn't be loaded just now, so the tab plays on a guitar"
        : "The video's audio, streamed through this site"
      : localUrl
        ? "The file saved on this device"
        : audioMissing
          ? "Not on this device (it was added on another one), so the tab plays on a guitar"
          : "Loading…";

  const tabCaption = written
    ? `Edited by hand, frets as played${openStrings.join() !== STANDARD.join() ? `, ${TUNINGS.find((t) => t.strings.join() === openStrings.join())?.name ?? "custom"} tuning` : ""}. Capo and transpose change only the chord names here.`
    : `${detail < 1 ? `The ${shownCount} clearest of ${allCount} notes heard` : "Every note heard"}, on the string and fret that keeps your hand in one place${capo > 0 ? `, counted from capo ${capo}` : ""}. Tap a bar to play from there.`;

  return (
    <div className="pb-44">
      {audioSrc && (
        <audio
          ref={(el) => {
            audioEl.current = el;
            if (el) transport.setMedia(el);
          }}
          src={audioSrc}
          preload="auto"
          className="hidden"
          onError={() => {
            setAudioFailed(true);
            transport.setMedia(null);
          }}
        />
      )}

      <p className="text-sm text-muted -mt-2 mb-3">
        {a.chords.some((c) => c < 168) && (
          <>
            Key <b className="text-fg">{keyName(sounding)}</b> ·{" "}
          </>
        )}
        {Math.round(a.bpm)} BPM · {a.meter}/4 · {clockTime(keptLength(a.duration, cuts))}
        {!written && autoTuning.id !== "standard" && <> · {autoTuning.name}</>}
        {capo > 0 && (
          <>
            {" "}· Capo {capo}, shapes in <b className="text-fg">{keyName({ ...sounding, tonic: (sounding.tonic - capo - tuningShift + 24) % 12 }).split(" ")[0]}{sounding.mode === "minor" ? "m" : ""}</b>
          </>
        )}
        {view.capo !== null && view.capo !== bestCapo && !written && (
          <button className="ml-2 underline" onClick={() => update({ capo: null })}>
            easiest: capo {bestCapo}
          </button>
        )}
      </p>

      {/* controls */}
      <div data-controls className="sticky top-0 z-20 -mx-4 px-4 py-2 bg-bg/90 backdrop-blur border-b border-line text-sm">
        <div className="flex items-center gap-2">
          <Segmented<Prefs["mode"]>
            value={view.mode}
            onChange={(v) => update({ mode: v })}
            options={[
              ["tab", "Tab"],
              ["bars", "Chords"],
              ["lyrics", "Lyrics"],
            ]}
          />
          <span className="flex-1" />
          {editing ? null : (
            <button onClick={startEditing} className="btn btn-sm" title="Fix notes and chords, add your own, cut parts out">
              ✎ Edit
            </button>
          )}
          <button onClick={() => setShowOptions(!showOptions)} className={`btn btn-sm px-2.5 ${showOptions ? "btn-primary" : ""}`} aria-expanded={showOptions} aria-label="Display options">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" />
              <circle cx="16" cy="6" r="2" />
              <circle cx="10" cy="12" r="2" />
              <circle cx="18" cy="18" r="2" />
            </svg>
          </button>
        </div>
        {view.mode === "tab" && !written && rows && (
          <div className={`mt-2 flex items-center gap-3 ${confident ? "pb-3" : ""}`}>
            <span className="text-xs text-muted shrink-0 w-16">Clearest</span>
            <span className="relative flex-1 min-w-0 flex items-center">
              <input
                type="range"
                className="range w-full"
                min={0}
                max={1}
                step={0.02}
                value={detail}
                style={{ ["--fill" as string]: `${detail * 100}%` }}
                onChange={(e) => update({ clean: Number(e.target.value) })}
                aria-label="How many notes to show, from only the clearest to every note heard"
              />
              {confident && (
                <button
                  onClick={() => update({ clean: null })}
                  className={`absolute -bottom-3 -translate-x-1/2 text-[10px] whitespace-nowrap ${view.clean === null ? "text-accent font-medium" : "text-muted underline"}`}
                  style={{ left: `calc(${DEFAULT_DETAIL * 100}% + ${(0.5 - DEFAULT_DETAIL) * 20}px)` }}
                  title="Back to the recommended setting"
                >
                  ▲ recommended
                </button>
              )}
            </span>
            <span className="text-xs text-muted shrink-0 w-16 text-right">All notes</span>
            <span className="text-xs tabular-nums text-muted shrink-0 hidden sm:inline">
              {shownCount}/{allCount}
            </span>
          </div>
        )}
        {showOptions && (
          <div className="mt-2 pt-2 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-2">
            <Stepper label="Transpose" value={view.transpose > 0 ? `+${view.transpose}` : String(view.transpose)} onDec={() => update({ transpose: view.transpose - 1 })} onInc={() => update({ transpose: view.transpose + 1 })} />
            <label className="flex items-center gap-1.5">
              <span className="text-muted">Capo</span>
              <select value={view.capo ?? "auto"} onChange={(e) => update({ capo: e.target.value === "auto" ? null : Number(e.target.value) })} className="select">
                <option value="auto">Easiest ({bestCapo === 0 ? "none" : bestCapo})</option>
                {Array.from({ length: 10 }, (_, c) => (
                  <option key={c} value={c}>
                    {c === 0 ? "None" : c}
                  </option>
                ))}
              </select>
            </label>
            {!written && (
              <label className="flex items-center gap-1.5">
                <span className="text-muted">Tuning</span>
                <select value={view.tuning ?? "auto"} onChange={(e) => update({ tuning: e.target.value === "auto" ? null : (e.target.value as TuningId) })} className="select">
                  <option value="auto">Auto ({TUNINGS.find((t) => t.id === detected)!.name})</option>
                  {TUNINGS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <Segmented<Simplify>
              value={view.simplify}
              onChange={(v) => update({ simplify: v })}
              options={[
                ["full", "All chords"],
                ["sevenths", "7ths"],
                ["triads", "Basic"],
              ]}
            />
            <label className="flex items-center gap-2 text-muted">
              <input type="checkbox" checked={view.follow} onChange={(e) => update({ follow: e.target.checked })} />
              Follow while playing
            </label>
          </div>
        )}
      </div>

      {/* chord shapes */}
      <div className="mt-4 flex gap-3 overflow-x-auto no-scrollbar pb-2 -mx-4 px-4">
        {shapes.map((s) => (
          <div key={s.name} className="shrink-0 rounded-xl bg-surface border border-line px-2 pt-2 pb-1">
            <ChordDiagram chord={s.chord} name={s.name} />
          </div>
        ))}
      </div>

      {editing && (
        <div className="mt-4 space-y-3">
          {scratch && <GridSettings edits={edits} change={ed.change} />}
          <div className="flex flex-wrap items-center gap-2">
            <button onClick={() => setTrimming(!trimming)} className={`btn btn-sm ${trimming ? "btn-primary" : ""}`} aria-expanded={trimming}>
              ✂ Trim the song{cuts.length ? ` (${cuts.length} cut)` : ""}
            </button>
            {!scratch && (
              <button
                onClick={() => {
                  if (confirm("Put the tab back the way it was heard? Your note changes are removed; cuts and chord changes stay.")) {
                    setSelected(null);
                    ed.change((e) => ({ ...e, tab: undefined, tuning: undefined }));
                    setEditing(false);
                  }
                }}
                className="btn btn-sm btn-ghost text-muted"
              >
                Undo all note edits
              </button>
            )}
          </div>
          {trimming && (
          <Trim
            duration={a.duration}
            activity={activity}
            speech={words.speech}
            cuts={cuts}
            now={transport.now}
            onSeek={(t) => transport.seek(t)}
            onCut={(x, y) => cutsChange((c) => addCut(c, x, y))}
            onKeepOnly={(x, y) => cutsChange((c) => addCut(addCut(c, 0, x), y, a.duration + 1).filter(([p, q]) => q - p > 0.05))}
            onRestore={(k) => cutsChange((c) => c.filter((_, i) => i !== k))}
          />
          )}
        </div>
      )}

      {view.mode === "tab" && tooLow >= Math.max(12, 0.02 * (a.notes?.length ?? 0)) && (
        <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">
          {tooLow} notes are lower than {autoTuning.name.toLowerCase()} tuning reaches, so they&apos;re left out. If the guitar is tuned down, pick its tuning:{" "}
          {TUNINGS.filter((t) => t.strings[0] < autoTuning.strings[0]).map((t) => (
            <button key={t.id} onClick={() => update({ tuning: t.id })} className="underline mr-2">
              {t.name}
            </button>
          ))}
        </p>
      )}

      <div data-pane onWheel={touchPane} onTouchMove={touchPane} className="mt-4 max-h-[calc(100dvh-13rem)] overflow-y-auto overscroll-contain rounded-2xl border border-line px-3 pb-4 -mx-1">
        {pending?.error && <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">{pending.error}</p>}
        {view.mode === "tab" && notesComing && !written && (
          <div className="sticky top-0 z-[1] -mx-3 px-3 pt-3 pb-2 bg-bg/95 backdrop-blur border-b border-line">
            <Working
              label={`${pending.label}${partial ? `, ready up to ${clockTime(partial.upTo)} of ${clockTime(a.duration)}` : ""}`}
              p={pending.p ?? null}
            />
            {!partial && <p className="mt-1.5 text-xs text-muted">The first bars of the tab appear here in a few seconds; the chords below already follow the music.</p>}
          </div>
        )}
        {view.mode === "tab" && (written || !notesComing || partial) && (a.notes || partial || written) ? (
          <TabSheet
            a={a}
            bars={bars}
            names={names}
            notes={sheetNotes}
            stringLabels={stringLabels}
            upTo={written ? undefined : partial?.upTo}
            now={transport.now}
            follow={view.follow && tstate.playing && !editing}
            onSeek={seekPlayCb}
            cuts={cuts}
            edit={editHandlers}
            caption={tabCaption}
          />
        ) : view.mode === "tab" && !notesComing && !a.notes ? (
          <div className="mt-6 text-sm text-muted">
            <p>There&apos;s no tab for this one yet: it was caught before tabs existed, or its page was closed before every note was in.</p>
            <button onClick={startEditing} className="btn btn-sm mt-3">
              Write the tab by hand
            </button>
          </div>
        ) : view.mode === "lyrics" ? (
          <LyricsSheet
            lyrics={words.lyrics}
            a={a}
            names={names}
            beat={beat}
            follow={view.follow && tstate.playing}
            offset={view.lyricOffset}
            setOffset={(o) => update({ lyricOffset: o })}
            onSeek={(b) => seekPlay(a.beats[b])}
            cuts={cuts}
            transcribe={words.transcribe}
          />
        ) : (
          <BarsSheet bars={bars} a={a} names={names} beat={beat} follow={view.follow && tstate.playing} onSeek={(b) => seekPlay(a.beats[b])} cuts={cuts} />
        )}
      </div>

      <SourcePanel song={song} lyrics={words.info} edited={!!edits && !!(edits.tab || edits.cuts?.length || edits.chords?.length)} playback={playback} />

      <Player
        transport={transport}
        duration={a.duration}
        cuts={cuts}
        hasAudio={hasAudio}
        audioNote={!hasAudio && !scratch ? "This song's audio isn't available here, so only the guitar plays." : null}
      >
        {editing && (
          <EditToolbar
            note={sel}
            stringName={sel ? stringNames(openStrings)[sel.string] : ""}
            actions={actions}
            undo={ed.undo}
            redo={ed.redo}
            canUndo={ed.canUndo}
            canRedo={ed.canRedo}
            save={ed.save}
            retry={ed.retry}
            snap={view.snap}
            setSnap={(n) => update({ snap: n })}
            done={() => {
              setSelected(null);
              setEditing(false);
            }}
            deselect={() => setSelected(null)}
            empty={!written?.length}
          />
        )}
      </Player>

      {picker && (
        <ChordPicker
          cls={(() => {
            // shown as fingered: after capo, transposition and tuning
            const c = a.chords[picker.from];
            return c >= 168 ? c : ((Math.floor(c / 14) + view.transpose - capo - tuningShift + 120) % 12) * 14 + (c % 14);
          })()}
          spelling={spelling}
          span={picker.from === picker.to ? `beat ${picker.from - (bars.find((b) => b.beats.includes(picker.from))?.beats[0] ?? 0) + 1} of bar ${bars.find((b) => b.beats.includes(picker.from))?.index ?? ""}` : `bar ${bars.find((b) => b.beats.includes(picker.from))?.index ?? ""} on`}
          onClose={() => setPicker(null)}
          onPick={(cls) => {
            // the picker shows shapes as fingered (after capo and transposition); store the sounding chord
            const shift = view.transpose - capo - tuningShift;
            const sounding = cls >= 168 ? cls : ((Math.floor(cls / 14) - shift + 120) % 12) * 14 + (cls % 14);
            ed.change((e) => setChords(e, picker.from, picker.to, sounding));
            setPicker(null);
          }}
        />
      )}
    </div>
  );
}

/** Tempo, beats per bar and length of a song written from scratch. */
function GridSettings({ edits, change }: { edits: Edits | null; change: (fn: (e: Edits) => Edits | null, merge?: boolean) => void }) {
  const g = edits?.grid ?? { bpm: 90, meter: 4 as const, bars: 16 };
  const set = (patch: Partial<typeof g>, merge = false) => change((e) => ({ ...e, grid: { ...g, ...patch } }), merge);
  return (
    <div className="rounded-2xl border border-line bg-surface px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
      <label className="flex items-center gap-2 flex-1 min-w-52">
        <span className="text-muted">Tempo</span>
        <input type="range" className="range flex-1 min-w-0" min={40} max={220} value={g.bpm} style={{ ["--fill" as string]: `${((g.bpm - 40) / 180) * 100}%` }} onChange={(e) => set({ bpm: Number(e.target.value) }, true)} />
        <span className="tabular-nums w-16">{g.bpm} BPM</span>
      </label>
      <Segmented<"3" | "4"> value={String(g.meter) as "3" | "4"} onChange={(v) => set({ meter: Number(v) as 3 | 4 })} options={[["4", "4/4"], ["3", "3/4"]]} />
      <Stepper label="Bars" value={String(g.bars)} onDec={() => set({ bars: Math.max(1, g.bars - 1) })} onInc={() => set({ bars: Math.min(1000, g.bars + 1) })} />
      <button onClick={() => set({ bars: Math.min(1000, g.bars + 4) })} className="btn btn-sm px-2.5">
        +4
      </button>
    </div>
  );
}

const clockTime = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;

function Stepper({ label, value, onDec, onInc }: { label: string; value: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-muted">{label}</span>
      <button onClick={onDec} className="btn btn-sm h-8 w-8 p-0" aria-label={`${label} down`}>
        −
      </button>
      <span className="w-7 text-center tabular-nums">{value}</span>
      <button onClick={onInc} className="btn btn-sm h-8 w-8 p-0" aria-label={`${label} up`}>
        +
      </button>
    </div>
  );
}

function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: [T, string][] }) {
  return (
    <div className="flex rounded-xl bg-surface-2 p-0.5" role="tablist">
      {options.map(([v, label]) => (
        <button key={v} role="tab" aria-selected={value === v} onClick={() => onChange(v)} className={`px-3 py-1.5 rounded-[10px] transition ${value === v ? "bg-surface shadow-sm font-medium" : "text-muted hover:text-fg"}`}>
          {label}
        </button>
      ))}
    </div>
  );
}
