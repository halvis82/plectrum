"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import {
  Analyzer,
  SR,
  alignToVideo,
  canCaptureTab,
  currentOffset,
  decodeToMono,
  getMicStream,
  getTabStream,
  saveLocalAudio,
  type Stage,
  type SyncPoint,
} from "@/lib/audio";
import { PcmCapture, encodeWav, resample } from "@/lib/capture";
import { chordName, detectKey, keyName, labelFromIndex, parseLabel, spellingFor } from "@/lib/music";
import { songStats } from "@/lib/sheet";
import { YT_STATE, createPlayer, type YTPlayer } from "@/lib/youtube";

type Resolved = { kind: "youtube" | "spotify"; videoId: string; title: string; artist: string | null; sourceUrl: string; alternatives: string[] };
type Meta = { title: string; artist: string | null; source: string; sourceUrl?: string; youtubeId?: string };

type Phase =
  | { kind: "idle" }
  | { kind: "resolving" }
  /** link resolved; capture needs a click (no user gesture was available, or sharing was cancelled) */
  | { kind: "ready" }
  /** waiting for the browser's share/mic permission */
  | { kind: "permission" }
  | { kind: "capturing"; source: "link" | "mic" | "tab"; t: number; d: number; level: number; waiting: boolean }
  | { kind: "working"; label: string; p?: number };

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading the chord model",
  features: "Listening to the harmony",
  chords: "Recognizing chords",
  beats: "Finding the beat",
};

const NO_EMBED = "None of the YouTube uploads of this song can be played here. Upload the file, or tap Listen while it plays somewhere else.";
const LINK_RE = /(youtube\.com|youtu\.be|spotify\.com|spotify\.link)\//i;
const noop = () => () => {};

/** Live chord timeline: frame-level classes keyed by timeline position. */
type Live = { hop: number; frames: Map<number, number> };

export function Catcher() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [candidate, setCandidate] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [drag, setDrag] = useState(false);
  const [startReq, setStartReq] = useState(0);
  const tabOk = useSyncExternalStore(noop, canCaptureTab, () => false);
  const [preferMic, setPreferMic] = useState(false);
  const linkMethod: "tab" | "mic" = preferMic || !tabOk ? "mic" : "tab";

  const analyzer = useRef<Analyzer | null>(null);
  const playerEl = useRef<HTMLDivElement>(null);
  const playerReady = useRef<Promise<YTPlayer> | null>(null);
  /** the live player; replaced when a blocked embed falls through to another upload */
  const playerRef = useRef<YTPlayer | null>(null);
  const pendingStream = useRef<Promise<MediaStream> | null>(null);
  const altsFetched = useRef(false);
  const stopRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const busy = phase.kind === "capturing" || phase.kind === "working" || phase.kind === "permission";
  const videoId = resolved ? [resolved.videoId, ...resolved.alternatives][candidate] : null;
  const currentVideo = useRef<string | null>(null);
  currentVideo.current = videoId;

  /** The 13 MB model starts loading on first interaction and is cached afterwards. */
  const getAnalyzer = () => (analyzer.current ??= new Analyzer());
  useEffect(() => {
    // warm up the model in the background so the first song starts instantly
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    idle(() => (analyzer.current ??= new Analyzer()));
    return () => analyzer.current?.terminate();
  }, []);

  // ---- YouTube player for the resolved link (falls through blocked embeds) ----
  useEffect(() => {
    if (!resolved || !videoId || !playerEl.current) return;
    const fallbacks = resolved.alternatives.length - candidate;
    let cancelled = false;
    let player: YTPlayer | null = null;
    const ready = createPlayer(
      playerEl.current,
      videoId,
      (s) => s === YT_STATE.ENDED && stopRef.current?.(),
      (code) => {
        if (cancelled) return;
        const blocked = [100, 101, 150, 153].includes(code);
        if (blocked && fallbacks > 0) return setCandidate((c) => c + 1);
        if (blocked && !altsFetched.current) {
          // look for other uploads of the same song only now that we need them
          altsFetched.current = true;
          void fetch(`/api/resolve?alts&url=${encodeURIComponent(resolved.sourceUrl)}`)
            .then((r) => r.json())
            .then((r: Resolved) => {
              const extra = (r.alternatives ?? []).filter((v) => v !== resolved.videoId && !resolved.alternatives.includes(v));
              if (!extra.length) throw new Error();
              setResolved({ ...resolved, alternatives: [...resolved.alternatives, ...extra] });
              setCandidate((c) => c + 1);
            })
            .catch(() => fail(NO_EMBED));
          return;
        }
        fail(blocked ? NO_EMBED : `YouTube error ${code}.`);
      },
    );
    playerReady.current = ready;
    ready.then(
      (p) => {
        if (cancelled) return p.destroy();
        player = p;
        playerRef.current = p;
        // a fallback upload loaded mid-capture: start it from the top, capture follows along
        if (stopRef.current) {
          p.unMute();
          p.seekTo(0);
          p.playVideo();
        }
      },
      (e: Error) => !cancelled && fail(e.message),
    );
    return () => {
      cancelled = true;
      player?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolved, videoId]);

  // once the link is resolved and capture permission was requested, start listening
  useEffect(() => {
    if (phase.kind !== "ready" || !resolved || !pendingStream.current) return;
    const streamP = pendingStream.current;
    pendingStream.current = null;
    setPhase({ kind: "permission" });
    void (async () => {
      let stream: MediaStream;
      try {
        stream = await streamP;
      } catch (e) {
        setPhase({ kind: "ready" });
        return permissionError(e);
      }
      try {
        await playerReady.current;
        await captureLink(stream);
      } catch (e) {
        stream.getTracks().forEach((t) => t.stop());
        fail(e instanceof Error ? e.message : String(e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, resolved, startReq]);

  function fail(message: string) {
    stopRef.current = null;
    cancelRef.current = null;
    setLive(null);
    setPhase(resolved ? { kind: "ready" } : { kind: "idle" });
    setError(message);
  }

  function permissionError(e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    setError(/NotAllowed|denied|Permission/i.test(msg) ? "Sharing was cancelled. Press Start when you're ready." : msg);
  }

  /** Ask for capture permission right away, while the paste/Enter/click still counts as a gesture. */
  function requestStream(m: "tab" | "mic") {
    const p = m === "tab" ? getTabStream() : getMicStream();
    p.catch(() => {}); // handled where it is awaited
    pendingStream.current = p;
    setStartReq((n) => n + 1);
  }

  async function resolveLink(link: string, gesture: boolean) {
    if (busy) return;
    setError(null);
    setLive(null);
    getAnalyzer();
    if (gesture) requestStream(linkMethod);
    setPhase({ kind: "resolving" });
    setCandidate(0);
    altsFetched.current = false;
    try {
      const r = await fetch(`/api/resolve?url=${encodeURIComponent(link.trim())}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setResolved(body);
      setPhase({ kind: "ready" });
    } catch (e) {
      pendingStream.current?.then((s) => s.getTracks().forEach((t) => t.stop()), () => {});
      pendingStream.current = null;
      setResolved(null);
      setPhase({ kind: "idle" });
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  // ---- capture of the embedded video ----
  async function captureLink(stream: MediaStream) {
    if (!resolved || !videoId || !playerRef.current) return;
    // always talk to the current player (it changes if this upload turns out to be blocked)
    const p: YTPlayer = {
      playVideo: () => playerRef.current?.playVideo(),
      pauseVideo: () => playerRef.current?.pauseVideo(),
      seekTo: (t) => playerRef.current?.seekTo(t),
      setVolume: (v) => playerRef.current?.setVolume(v),
      unMute: () => playerRef.current?.unMute(),
      getCurrentTime: () => playerRef.current?.getCurrentTime() ?? 0,
      getDuration: () => playerRef.current?.getDuration() ?? 0,
      getPlayerState: () => playerRef.current?.getPlayerState() ?? YT_STATE.UNSTARTED,
      destroy: () => {},
    };
    const pcm = await PcmCapture.start(stream);
    const points: SyncPoint[] = [];
    const liveState: Live = { hop: 2048 / SR, frames: new Map() };
    setLive({ ...liveState });
    p.unMute();
    p.setVolume(100);
    p.seekTo(0);
    p.playVideo();
    let lastSeek = performance.now();
    let stopped = false;

    const poll = setInterval(() => {
      const playing = p.getPlayerState() === YT_STATE.PLAYING;
      const video = p.getCurrentTime();
      points.push({ rec: pcm.now(), video, playing });
      const d = p.getDuration();
      const waiting = pcm.firstSound < 0;
      setPhase({ kind: "capturing", source: "link", t: video, d, level: pcm.level(), waiting });
      if (!playing) return;
      const sinceSeek = (performance.now() - lastSeek) / 1000;
      // silent intro: skip ahead until the music starts (tab audio is digitally silent there)
      if (linkMethod === "tab" && waiting && sinceSeek > 1.2 && video > 0.5 && (!d || video < d - 10)) {
        p.seekTo(video + 2);
        lastSeek = performance.now();
      }
      // the song is over: long silence after the music (e.g. a music video's outro)
      if (linkMethod === "tab" && !waiting && pcm.seconds - pcm.lastSound > 5 && sinceSeek > 6 && video > 20) void stop();
    }, 100);

    const liveTimer = setInterval(async () => {
      const offset = currentOffset(points);
      if (offset === null || pcm.seconds < 2 || pcm.firstSound < 0) return;
      const { pcm: tail, start } = pcm.tail(10);
      const res = await getAnalyzer().live(await resample(tail, pcm.sampleRate, SR)).catch(() => null);
      if (!res || stopped) return;
      res.frames.forEach((cls, i) => {
        // the first second of a window has no left context; earlier windows covered it
        if (start > 0 && i * res.hop < 1) return;
        const videoT = start + i * res.hop - offset;
        if (videoT >= 0) liveState.frames.set(Math.round(videoT / liveState.hop), cls);
      });
      setLive({ hop: liveState.hop, frames: new Map(liveState.frames) });
    }, 1500);

    const cleanup = () => {
      clearInterval(poll);
      clearInterval(liveTimer);
      stopRef.current = null;
      cancelRef.current = null;
    };

    const stop = async () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      points.push({ rec: pcm.now(), video: p.getCurrentTime(), playing: p.getPlayerState() === YT_STATE.PLAYING });
      p.pauseVideo();
      setPhase({ kind: "working", label: "Finishing up" });
      const raw = pcm.stop();
      if (pcm.firstSound < 0) {
        return fail(linkMethod === "tab" ? 'Nothing was heard. Make sure "Also share tab audio" is on when Chrome asks.' : "Nothing was heard through the microphone. Turn the volume up and try again.");
      }
      const recorded = await resample(raw, pcm.sampleRate, SR);
      const end = Math.max(0, ...points.filter((q) => q.playing).map((q) => q.video));
      const samples = alignToVideo(recorded, points, Math.min(p.getDuration() || end + 1, end + 0.5));
      await finish(samples, { title: resolved.title, artist: resolved.artist, source: resolved.kind, sourceUrl: resolved.sourceUrl, youtubeId: currentVideo.current ?? videoId });
    };
    stopRef.current = () => void stop();
    cancelRef.current = () => {
      stopped = true;
      cleanup();
      pcm.stop();
      p.pauseVideo();
      setLive(null);
      setPhase({ kind: "ready" });
    };
    stream.getAudioTracks()[0]?.addEventListener("ended", () => void stop());
  }

  // ---- mic / any-tab recording ----
  async function captureRecording(source: "mic" | "tab") {
    if (busy) return;
    setError(null);
    setResolved(null);
    const an = getAnalyzer();
    setPhase({ kind: "permission" });
    let stream: MediaStream;
    try {
      stream = source === "tab" ? await getTabStream(false) : await getMicStream();
    } catch (e) {
      setPhase({ kind: "idle" });
      const msg = e instanceof Error ? e.message : String(e);
      return setError(/NotAllowed|denied|Permission/i.test(msg) ? (source === "mic" ? "Microphone access is needed to listen." : "Tab sharing was cancelled.") : msg);
    }
    const pcm = await PcmCapture.start(stream);
    const liveState: Live = { hop: 2048 / SR, frames: new Map() };
    setLive({ ...liveState });
    let stopped = false;
    const poll = setInterval(() => setPhase({ kind: "capturing", source, t: pcm.seconds, d: 0, level: pcm.level(), waiting: pcm.firstSound < 0 }), 100);
    const liveTimer = setInterval(async () => {
      if (pcm.seconds < 2) return;
      const { pcm: tail, start } = pcm.tail(10);
      const res = await an.live(await resample(tail, pcm.sampleRate, SR)).catch(() => null);
      if (!res || stopped) return;
      res.frames.forEach((cls, i) => {
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
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      cleanup();
      setPhase({ kind: "working", label: "Finishing up" });
      const samples = await resample(pcm.stop(), pcm.sampleRate, SR);
      const now = new Date();
      const title = `${source === "tab" ? "Tab capture" : "Recording"} ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      const wav = encodeWav(samples, SR);
      await finish(samples, { title, artist: null, source: source === "mic" ? "record" : "tab" }, wav);
    };
    stopRef.current = () => void stop();
    cancelRef.current = () => {
      stopped = true;
      cleanup();
      pcm.stop();
      setLive(null);
      setPhase({ kind: "idle" });
    };
    stream.getAudioTracks()[0]?.addEventListener("ended", () => void stop());
  }

  // ---- upload ----
  async function handleFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    setResolved(null);
    setLive(null);
    getAnalyzer();
    setPhase({ kind: "working", label: "Reading the file" });
    try {
      const samples = await decodeToMono(file);
      const base = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      await finish(samples, { title: m ? m[2] : base, artist: m ? m[1] : null, source: "upload" }, file);
    } catch (e) {
      setPhase({ kind: "idle" });
      setError(e instanceof Error && !/decod/i.test(e.message) ? e.message : "Couldn't read that file. Try an mp3, m4a, wav or a video file.");
    }
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

  function onPaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text").trim();
    if (!LINK_RE.test(text)) return;
    e.preventDefault();
    setUrl(text);
    void resolveLink(text, true);
  }

  // typed links (no paste) resolve after a pause; capture then needs a click on Start
  useEffect(() => {
    if (!LINK_RE.test(url) || busy || phase.kind === "resolving" || resolved) return;
    const t = setTimeout(() => void resolveLink(url, false), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const capturing = phase.kind === "capturing" ? phase : null;
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
          void resolveLink(text, true);
        }
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) void resolveLink(url, true);
        }}
      >
        <input
          type="url"
          inputMode="url"
          placeholder="Paste a YouTube or Spotify link"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            if (resolved && !busy) setResolved(null);
          }}
          onPaste={onPaste}
          onFocus={() => getAnalyzer()}
          disabled={busy}
          aria-label="YouTube or Spotify link"
          className="w-full rounded-2xl border border-line bg-bg px-4 py-4 text-lg outline-none focus:border-accent disabled:opacity-60"
        />
      </form>

      {!resolved && !busy && phase.kind !== "resolving" && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input ref={fileInput} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
            <button onClick={() => fileInput.current?.click()} className="rounded-2xl border border-line py-3.5 font-medium hover:border-accent">
              📁 Upload a song
            </button>
            <button onClick={() => void captureRecording("mic")} className="rounded-2xl border border-line py-3.5 font-medium hover:border-accent">
              🎙️ Listen
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">
            Drop a file anywhere here, or hold your phone near a speaker and tap Listen.
            {tabOk && (
              <>
                {" "}Playing it in another tab, like Spotify?{" "}
                <button className="underline" onClick={() => void captureRecording("tab")}>
                  Catch that tab
                </button>
                .
              </>
            )}
          </p>
        </>
      )}

      {phase.kind === "resolving" && <p className="mt-4 text-sm text-muted animate-pulse">Finding the song…</p>}
      {phase.kind === "permission" && (
        <p className="mt-4 text-sm text-muted animate-pulse">
          {linkMethod === "tab" && resolved ? 'Allow sharing this tab, with "Also share tab audio" on…' : "Waiting for permission…"}
        </p>
      )}

      {resolved && (
        <div className="mt-4">
          <div className="flex items-baseline justify-between gap-3 mb-2">
            <p className="text-sm text-muted min-w-0 truncate">
              <span className="text-fg font-medium">{resolved.title}</span>
              {resolved.artist ? ` · ${resolved.artist}` : ""}
            </p>
            {!busy && (
              <button
                className="text-xs text-muted underline shrink-0"
                onClick={() => {
                  setResolved(null);
                  setUrl("");
                  setError(null);
                  setPhase({ kind: "idle" });
                }}
              >
                Clear
              </button>
            )}
          </div>
          <div ref={playerEl} className="aspect-video w-full rounded-2xl overflow-hidden bg-black" />
          {candidate > 0 && <p className="mt-1 text-xs text-muted">The original video can&apos;t play on other sites, so this is another upload of the same song.</p>}

          {phase.kind === "ready" && (
            <div className="mt-4">
              <button
                onClick={() => {
                  setError(null);
                  requestStream(linkMethod);
                }}
                className="w-full rounded-2xl bg-accent text-accent-fg py-4 font-semibold text-lg"
              >
                ▶ Start
              </button>
              <p className="mt-2 text-xs text-muted">
                {linkMethod === "tab" ? (
                  <>
                    Chrome asks to share this tab so ChordCatch can hear the song. Keep <b>Also share tab audio</b> on.{" "}
                    <button className="underline" onClick={() => setPreferMic(true)}>Use the microphone instead</button>
                  </>
                ) : (
                  <>ChordCatch listens through your microphone while the video plays. Turn the volume up.</>
                )}
              </p>
            </div>
          )}
        </div>
      )}

      {capturing && (
        <div className="mt-4">
          <LiveChords live={live} t={capturing.t} />
          <div className="mt-3 flex items-center gap-3 text-sm">
            <span className="h-2.5 w-2.5 rounded-full bg-red-500 animate-pulse shrink-0" aria-hidden />
            <span className="tabular-nums">
              {capturing.waiting
                ? capturing.source === "link" && linkMethod === "tab"
                  ? "Skipping the silent intro…"
                  : "Waiting for music…"
                : `Listening ${fmt(capturing.t)}${capturing.d ? ` / ${fmt(capturing.d)}` : ""}`}
            </span>
            <span className="flex-1 h-1.5 rounded-full bg-surface-2 overflow-hidden">
              <span className="block h-full bg-red-500" style={{ width: capturing.d ? `${(capturing.t / capturing.d) * 100}%` : `${capturing.level * 100}%` }} />
            </span>
          </div>
          <div className="mt-3 grid grid-cols-[1fr_auto] gap-2">
            <button onClick={() => stopRef.current?.()} className="rounded-2xl bg-accent text-accent-fg py-3.5 font-semibold">
              {capturing.d ? "Stop here and save" : "Done, show the chords"}
            </button>
            <button onClick={() => cancelRef.current?.()} className="rounded-2xl border border-line px-4">
              Cancel
            </button>
          </div>
          <p className="mt-2 text-xs text-muted">Chords show up as it listens, so you can play along right away. Stop any time to keep what&apos;s been heard.</p>
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

/** Big "now" chord plus the progression heard so far. */
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
      {/* history reads left to right into the current chord */}
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
