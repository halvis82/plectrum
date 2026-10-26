"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import { Analyzer, SR, decodeToMono, getMicStream, saveLocalAudio, type Stage } from "@/lib/audio";
import { PcmCapture, encodeWav, resample } from "@/lib/capture";
import { chordName, detectKey, keyName, labelFromIndex, parseLabel, spellingFor } from "@/lib/music";
import { songStats } from "@/lib/sheet";

type Resolved = { kind: "youtube" | "spotify"; videoId: string; title: string; artist: string | null; sourceUrl: string; alternatives: string[] };
type Meta = { title: string; artist: string | null; source: string; sourceUrl?: string; youtubeId?: string };

type Phase =
  | { kind: "idle" }
  | { kind: "listening"; t: number; level: number; waiting: boolean }
  | { kind: "working"; label: string; p?: number };

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading the chord model",
  features: "Listening to the harmony",
  chords: "Recognizing chords",
  beats: "Finding the beat",
  notes: "Catching every note",
};

const LINK_RE = /(youtube\.com|youtu\.be|spotify\.com|spotify\.link)\//i;

/** Live chord timeline while listening: frame-level classes keyed by position. */
type Live = { hop: number; frames: Map<number, number> };

export function Catcher() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [song, setSong] = useState<Resolved | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [drag, setDrag] = useState(false);
  const analyzer = useRef<Analyzer | null>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const lastLink = useRef("");
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = phase.kind !== "idle";

  /** The 13 MB model starts loading in the background and is cached afterwards. */
  const getAnalyzer = () => (analyzer.current ??= new Analyzer());
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    idle(() => (analyzer.current ??= new Analyzer()));
    return () => analyzer.current?.terminate();
  }, []);

  function fail(message: string) {
    stopRef.current = null;
    cancelRef.current = null;
    setLive(null);
    setPhase({ kind: "idle" });
    setError(message);
  }

  // ---- link: the server fetches the audio, the browser finds the chords ----
  async function catchLink(link: string) {
    if (busy || !LINK_RE.test(link)) return;
    lastLink.current = link;
    setError(null);
    setSong(null);
    getAnalyzer();
    setPhase({ kind: "working", label: "Finding the song" });
    try {
      let r = await fetch(`/api/resolve?url=${encodeURIComponent(link.trim())}`);
      let resolved: Resolved = await r.json();
      if (!r.ok) throw new Error((resolved as unknown as { error: string }).error);
      setSong(resolved);

      let audio: Blob | null = null;
      let videoId = resolved.videoId;
      for (let attempt = 0; attempt < 4 && !audio; attempt++) {
        if (attempt === 1 && resolved.alternatives.length === 0) {
          // only look for other uploads of the song if the first one fails
          r = await fetch(`/api/resolve?alts&url=${encodeURIComponent(resolved.sourceUrl)}`);
          if (r.ok) resolved = await r.json();
        }
        videoId = attempt === 0 ? resolved.videoId : resolved.alternatives[attempt - 1];
        if (!videoId) break;
        audio = await download(`/api/audio/${videoId}`, (p) => setPhase({ kind: "working", label: "Getting the audio", p }));
      }
      if (!audio) throw new Error("YouTube wouldn't give up the audio for this song right now. Try another link, or upload the file.");

      setPhase({ kind: "working", label: "Reading the audio" });
      const samples = await decodeToMono(audio);
      await finish(samples, { title: resolved.title, artist: resolved.artist, source: resolved.kind, sourceUrl: resolved.sourceUrl, youtubeId: videoId });
    } catch (e) {
      setSong(null);
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- upload ----
  async function handleFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    setSong(null);
    getAnalyzer();
    setPhase({ kind: "working", label: "Reading the file" });
    try {
      const samples = await decodeToMono(file);
      const base = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      await finish(samples, { title: m ? m[2] : base, artist: m ? m[1] : null, source: "upload" }, file);
    } catch (e) {
      fail(e instanceof Error && !/decod/i.test(e.message) ? e.message : "Couldn't read that file. Try an mp3, m4a, wav or a video file.");
    }
  }

  // ---- listen through the mic, with chords appearing live ----
  async function listen() {
    if (busy) return;
    setError(null);
    setSong(null);
    const an = getAnalyzer();
    let stream: MediaStream;
    try {
      stream = await getMicStream();
    } catch {
      return setError("Microphone access is needed to listen.");
    }
    const pcm = await PcmCapture.start(stream);
    const liveState: Live = { hop: 2048 / SR, frames: new Map() };
    setLive({ ...liveState });
    let stopped = false;
    const poll = setInterval(() => setPhase({ kind: "listening", t: pcm.seconds, level: pcm.level(), waiting: pcm.firstSound < 0 }), 100);
    const liveTimer = setInterval(async () => {
      if (pcm.seconds < 2 || pcm.firstSound < 0) return;
      const { pcm: tail, start } = pcm.tail(10);
      const res = await an.live(await resample(tail, pcm.sampleRate, SR)).catch(() => null);
      if (!res || stopped) return;
      res.frames.forEach((cls, i) => {
        // the first second of a window has no left context; an earlier window covered it
        if (start === 0 || i * res.hop >= 1) liveState.frames.set(Math.round((start + i * res.hop) / liveState.hop), cls);
      });
      setLive({ hop: liveState.hop, frames: new Map(liveState.frames) });
    }, 1500);
    const cleanup = () => {
      clearInterval(poll);
      clearInterval(liveTimer);
      stopRef.current = null;
      cancelRef.current = null;
    };
    stopRef.current = async () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      setPhase({ kind: "working", label: "Finishing up" });
      const samples = await resample(pcm.stop(), pcm.sampleRate, SR);
      const now = new Date();
      const title = `Recording ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      await finish(samples, { title, artist: null, source: "record" }, encodeWav(samples, SR));
    };
    cancelRef.current = () => {
      stopped = true;
      cleanup();
      pcm.stop();
      setLive(null);
      setPhase({ kind: "idle" });
    };
  }

  async function finish(samples: Float32Array, meta: Meta, localAudio?: Blob) {
    try {
      let peak = 0;
      for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
      if (samples.length < SR * 3 || peak < 0.003) throw new Error("There wasn't enough music to work with. Give it at least a few seconds.");
      const analysis: Analysis = await getAnalyzer().analyze(samples, (stage, p) => setPhase({ kind: "working", label: STAGE_LABEL[stage], p }));
      setPhase({ kind: "working", label: "Saving to the library" });
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...meta, key: keyName(songStats(analysis).key), analysis }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Saving failed");
      if (localAudio) await saveLocalAudio(body.id, localAudio);
      router.push(`/song/${body.id}`);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e));
    }
  }

  // a typed (not pasted) link starts on its own after a short pause
  useEffect(() => {
    if (!LINK_RE.test(url) || busy || url === lastLink.current) return;
    const t = setTimeout(() => void catchLink(url), 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const listening = phase.kind === "listening" ? phase : null;
  const working = phase.kind === "working" ? phase : null;

  return (
    <section
      className={`rounded-3xl bg-surface border shadow-sm p-4 sm:p-6 transition ${drag ? "border-accent bg-accent-soft" : "border-line"}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        const f = e.dataTransfer.files[0];
        if (f) return void handleFile(f);
        const text = e.dataTransfer.getData("text").trim();
        if (LINK_RE.test(text)) {
          setUrl(text);
          void catchLink(text);
        }
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void catchLink(url);
        }}
      >
        <input
          type="url"
          inputMode="url"
          placeholder="Paste a YouTube or Spotify link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onPaste={(e) => {
            const text = e.clipboardData.getData("text").trim();
            if (!LINK_RE.test(text)) return;
            e.preventDefault();
            setUrl(text);
            void catchLink(text);
          }}
          onFocus={() => getAnalyzer()}
          disabled={busy}
          aria-label="YouTube or Spotify link"
          className="w-full rounded-2xl border border-line bg-bg px-4 py-4 text-lg outline-none focus:border-accent disabled:opacity-60"
        />
      </form>

      {!busy && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input ref={fileInput} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
            <button onClick={() => fileInput.current?.click()} className="rounded-2xl border border-line py-3.5 font-medium hover:border-accent">
              📁 Upload a song
            </button>
            <button onClick={() => void listen()} className="rounded-2xl border border-line py-3.5 font-medium hover:border-accent">
              🎙️ Listen
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">Drop a file anywhere here, or tap Listen and hold your phone near a speaker.</p>
        </>
      )}

      {song && (
        <div className="mt-4 flex items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={`https://i.ytimg.com/vi/${song.videoId}/mqdefault.jpg`} alt="" className="h-14 w-24 rounded-lg object-cover bg-surface-2 shrink-0" />
          <p className="min-w-0">
            <span className="block font-medium truncate">{song.title}</span>
            {song.artist && <span className="block text-sm text-muted truncate">{song.artist}</span>}
          </p>
        </div>
      )}

      {listening && (
        <div className="mt-4">
          <LiveChords live={live} t={listening.t} />
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-hidden />
            <span className="tabular-nums">{listening.waiting ? "Waiting for music…" : `Listening ${fmt(listening.t)}`}</span>
            <span className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <span className="block h-full bg-red-500" style={{ width: `${listening.level * 100}%` }} />
            </span>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <button onClick={() => stopRef.current?.()} className="rounded-2xl bg-accent text-accent-fg py-3.5 font-semibold">
              Done, show the chords
            </button>
            <button onClick={() => cancelRef.current?.()} className="rounded-2xl border border-line px-4">
              Cancel
            </button>
          </div>
        </div>
      )}

      {working && (
        <div className="mt-5" aria-live="polite">
          <div className="flex justify-between text-sm mb-1.5">
            <span className="font-medium">{working.label}…</span>
            {working.p !== undefined && <span className="text-muted tabular-nums">{Math.round(working.p * 100)}%</span>}
          </div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
            <div
              className={`h-full bg-accent transition-[width] duration-300 ${working.p === undefined ? "animate-pulse w-full" : ""}`}
              style={working.p !== undefined ? { width: `${Math.max(3, working.p * 100)}%` } : undefined}
            />
          </div>
        </div>
      )}
      {error && <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">{error}</p>}
    </section>
  );
}

/** Downloads with progress; null if the server couldn't get this video's audio. */
async function download(url: string, onProgress: (p: number) => void): Promise<Blob | null> {
  const res = await fetch(url);
  if (!res.ok || !res.body) return null;
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    if (total) onProgress(got / total);
  }
  return new Blob(parts, { type: res.headers.get("content-type") ?? "audio/mp4" });
}

/** Big "now" chord with the progression heard so far leading into it. */
function LiveChords({ live, t }: { live: Live | null; t: number }) {
  if (!live || live.frames.size === 0) {
    return <div className="rounded-2xl bg-surface-2 h-24 grid place-items-center text-muted text-sm">Chords will appear here as it listens…</div>;
  }
  const keys = [...live.frames.keys()].sort((a, b) => a - b);
  const segs: { start: number; cls: number }[] = [];
  for (const k of keys) {
    const cls = live.frames.get(k)!;
    if (segs.at(-1)?.cls !== cls) segs.push({ start: k * live.hop, cls });
  }
  // drop blips shorter than ~0.4 s, and no-chord stretches
  const items = segs
    .filter((s, i) => i === segs.length - 1 || segs[i + 1].start - s.start > 0.4)
    .map((s) => ({ start: s.start, chord: parseLabel(labelFromIndex(s.cls)) }))
    .filter((s) => s.chord);
  if (!items.length) return <div className="rounded-2xl bg-surface-2 h-24 grid place-items-center text-muted text-sm">Listening for chords…</div>;
  const spelling = spellingFor(detectKey(items.map((s, i) => ({ chord: s.chord, dur: (items[i + 1]?.start ?? s.start + 2) - s.start }))));
  const merged = items.filter((s, i) => i === 0 || chordName(s.chord, spelling) !== chordName(items[i - 1].chord, spelling));
  let nowIdx = merged.findLastIndex((s) => s.start <= t);
  if (nowIdx < 0) nowIdx = merged.length - 1;
  return (
    <div className="rounded-2xl bg-surface-2 p-4 flex items-center gap-4 min-h-24">
      <div className="flex gap-1.5 overflow-hidden flex-1 justify-end">
        {merged.slice(Math.max(0, nowIdx - 10), nowIdx).map((s, i, arr) => (
          <span key={i} className="text-sm font-semibold rounded-md bg-surface px-2 py-1 whitespace-nowrap" style={{ opacity: 0.35 + (0.6 * (i + 1)) / arr.length }}>
            {chordName(s.chord, spelling)}
          </span>
        ))}
      </div>
      <span className="text-5xl font-bold tracking-tight text-accent shrink-0">{chordName(merged[nowIdx].chord, spelling)}</span>
    </div>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
