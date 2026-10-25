"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import {
  Recorder,
  alignToVideo,
  analyzeSamples,
  canCaptureTab,
  decodeToMono,
  getMicStream,
  getTabStream,
  saveLocalAudio,
  type Stage,
  type SyncPoint,
} from "@/lib/audio";
import { songStats } from "@/lib/sheet";
import { keyName } from "@/lib/music";
import { YT_STATE, createPlayer, type YTPlayer } from "@/lib/youtube";

type Mode = "link" | "upload" | "record";
type Meta = { title: string; artist: string | null; source: string; sourceUrl?: string; youtubeId?: string };
type Busy = { label: string; p?: number } | null;

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading the chord model",
  features: "Listening to the harmony",
  chords: "Recognizing chords",
  beats: "Finding the beat",
};

function useFinish(setBusy: (b: Busy) => void, setError: (e: string | null) => void) {
  const router = useRouter();
  return async (samples: Float32Array, meta: Meta, localAudio?: Blob) => {
    try {
      if (samples.length < 22050 * 3) throw new Error("That was too short. Give it at least a few seconds of music.");
      let peak = 0;
      for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
      if (peak < 0.003) throw new Error("No sound was captured. Check that audio is actually playing and being shared.");
      setBusy({ label: STAGE_LABEL.model, p: 0 });
      const analysis: Analysis = await analyzeSamples(samples, (stage, p) => setBusy({ label: STAGE_LABEL[stage], p }));
      setBusy({ label: "Saving to the library" });
      const { key } = songStats(analysis);
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...meta, key: keyName(key), analysis }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Saving failed");
      if (localAudio) await saveLocalAudio(body.id, localAudio);
      router.push(`/song/${body.id}`);
    } catch (e) {
      setBusy(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  };
}

export function Catcher() {
  const [mode, setMode] = useState<Mode>("link");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const finish = useFinish(setBusy, setError);

  const tabs: { id: Mode; label: string; icon: string }[] = [
    { id: "link", label: "Link", icon: "🔗" },
    { id: "upload", label: "Upload", icon: "📁" },
    { id: "record", label: "Record", icon: "🎙️" },
  ];

  return (
    <section className="rounded-3xl bg-surface border border-line shadow-sm p-4 sm:p-6">
      <div className="grid grid-cols-3 gap-1 p-1 rounded-2xl bg-surface-2 mb-5" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={mode === t.id}
            disabled={!!busy}
            onClick={() => {
              setMode(t.id);
              setError(null);
            }}
            className={`py-2.5 rounded-xl text-sm font-medium transition ${mode === t.id ? "bg-surface shadow-sm text-fg" : "text-muted hover:text-fg"}`}
          >
            <span className="mr-1.5" aria-hidden>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      {mode === "link" && <LinkMode busy={busy} setBusy={setBusy} setError={setError} finish={finish} />}
      {mode === "upload" && <UploadMode busy={busy} setBusy={setBusy} setError={setError} finish={finish} />}
      {mode === "record" && <RecordMode busy={busy} setBusy={setBusy} setError={setError} finish={finish} />}

      {busy && (
        <div className="mt-5" aria-live="polite">
          <div className="flex justify-between text-sm mb-1.5">
            <span className="font-medium">{busy.label}…</span>
            {busy.p !== undefined && <span className="text-muted tabular-nums">{Math.round(busy.p * 100)}%</span>}
          </div>
          <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
            <div
              className={`h-full bg-accent transition-[width] duration-300 ${busy.p === undefined ? "animate-pulse w-full" : ""}`}
              style={busy.p !== undefined ? { width: `${Math.max(3, busy.p * 100)}%` } : undefined}
            />
          </div>
        </div>
      )}
      {error && <p className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5">{error}</p>}
    </section>
  );
}

type ModeProps = {
  busy: Busy;
  setBusy: (b: Busy) => void;
  setError: (e: string | null) => void;
  finish: ReturnType<typeof useFinish>;
};

// ---------------- link (YouTube / Spotify) ----------------

type Resolved = { kind: "youtube" | "spotify"; videoId: string; title: string; artist: string | null; sourceUrl: string; alternatives: string[] };

function LinkMode({ busy, setBusy, setError, finish }: ModeProps) {
  const [url, setUrl] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  // index into [videoId, ...alternatives]: blocked embeds (Vevo etc.) fall through to the next upload
  const [candidate, setCandidate] = useState(0);
  const videoId = resolved ? [resolved.videoId, ...resolved.alternatives][candidate] : null;
  const [loading, setLoading] = useState(false);
  const tabOk = useSyncExternalStore(noop, canCaptureTab, () => false);
  const [pref, setMethod] = useState<"tab" | "mic" | null>(null);
  const method = pref ?? (tabOk ? "tab" : "mic");
  const [capture, setCapture] = useState<{ t: number; d: number } | null>(null);
  const playerEl = useRef<HTMLDivElement>(null);
  const player = useRef<YTPlayer | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!resolved || !videoId || !playerEl.current) return;
    const host = document.createElement("div");
    playerEl.current.replaceChildren(host);
    let cancelled = false;
    const fallbacks = resolved.alternatives.length - candidate;
    createPlayer(host, videoId, (s) => s === YT_STATE.ENDED && stopRef.current?.(), (code) => {
      if (stopRef.current) return;
      if ((code === 101 || code === 150 || code === 100) && fallbacks > 0) setCandidate((c) => c + 1);
      else setError(code === 101 || code === 150 ? "None of the YouTube uploads of this song allow playback on other sites. Use Record > Browser tab and play it on youtube.com instead." : `YouTube error ${code}`);
    }).then((p) => {
      if (cancelled) p.destroy();
      else player.current = p;
    });
    return () => {
      cancelled = true;
      player.current?.destroy();
      player.current = null;
    };
  }, [resolved, videoId, candidate, setError]);

  async function resolve(e: React.FormEvent) {
    e.preventDefault();
    if (!url.trim()) return;
    setError(null);
    setLoading(true);
    setResolved(null);
    setCandidate(0);
    try {
      const r = await fetch(`/api/resolve?url=${encodeURIComponent(url.trim())}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error);
      setResolved(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function start() {
    const p = player.current;
    if (!p || !resolved || !videoId) return;
    setError(null);
    let stream: MediaStream;
    try {
      stream = method === "tab" ? await getTabStream() : await getMicStream();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(/denied|NotAllowed/i.test(msg) ? "Permission was denied. Allow it to let ChordCatch hear the song." : msg);
      return;
    }
    const rec = new Recorder(stream);
    const points: SyncPoint[] = [];
    p.seekTo(0, true);
    p.unMute();
    p.setVolume(100);
    await rec.start();
    p.playVideo();
    const duration = () => p.getDuration() || 0;
    setCapture({ t: 0, d: duration() });
    const poll = setInterval(() => {
      const video = p.getCurrentTime();
      points.push({ rec: rec.elapsed(), video, playing: p.getPlayerState() === YT_STATE.PLAYING });
      setCapture({ t: video, d: duration() });
    }, 200);
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      stopRef.current = null;
      clearInterval(poll);
      points.push({ rec: rec.elapsed(), video: p.getCurrentTime(), playing: p.getPlayerState() === YT_STATE.PLAYING });
      p.pauseVideo();
      setCapture(null);
      setBusy({ label: "Reading the recording" });
      try {
        const blob = await rec.stop();
        const recorded = await decodeToMono(blob);
        const end = Math.max(...points.filter((q) => q.playing).map((q) => q.video), 0);
        const samples = alignToVideo(recorded, points, Math.min(duration() || end, end + 0.5));
        await finish(samples, {
          title: resolved.title,
          artist: resolved.artist,
          source: resolved.kind,
          sourceUrl: resolved.sourceUrl,
          youtubeId: videoId,
        });
      } catch (err) {
        setBusy(null);
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    stopRef.current = stop;
    stream.getAudioTracks()[0]?.addEventListener("ended", () => void stop());
  }

  const capturing = !!capture;
  return (
    <div>
      <form onSubmit={resolve} className="flex gap-2">
        <input
          type="url"
          inputMode="url"
          placeholder="Paste a YouTube or Spotify link"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          disabled={capturing || !!busy}
          className="flex-1 min-w-0 rounded-xl border border-line bg-bg px-3.5 py-3 text-base outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={loading || capturing || !!busy}
          className="rounded-xl bg-fg text-bg px-4 font-medium disabled:opacity-50"
        >
          {loading ? "…" : "Go"}
        </button>
      </form>

      {resolved && (
        <div className="mt-4">
          <p className="text-sm text-muted mb-2">
            {resolved.kind === "spotify" ? "Matched on YouTube: " : ""}
            <span className="text-fg font-medium">{resolved.title}</span>
            {resolved.artist ? ` · ${resolved.artist}` : ""}
          </p>
          {candidate > 0 && (
            <p className="text-xs text-muted mb-2">The original video blocks playback on other sites, so this is another upload of the same song.</p>
          )}
          <div ref={playerEl} className="aspect-video w-full rounded-2xl overflow-hidden bg-black" />

          {!busy && (
            <div className="mt-4 space-y-3">
              {capturing ? (
                <>
                  <div className="flex items-center gap-3">
                    <span className="h-3 w-3 rounded-full bg-red-500 animate-pulse" aria-hidden />
                    <span className="text-sm">
                      Listening… {fmt(capture.t)} / {fmt(capture.d)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-surface-2 overflow-hidden">
                    <div className="h-full bg-red-500" style={{ width: `${capture.d ? (capture.t / capture.d) * 100 : 0}%` }} />
                  </div>
                  <button onClick={() => stopRef.current?.()} className="w-full rounded-xl border border-line py-3 font-medium">
                    Stop here and get chords
                  </button>
                </>
              ) : (
                <>
                  <button onClick={start} className="w-full rounded-xl bg-accent text-accent-fg py-3.5 font-semibold text-lg">
                    Catch the chords
                  </button>
                  <div className="text-xs text-muted space-y-1.5">
                    {method === "tab" ? (
                      <p>
                        The song plays once while ChordCatch listens to this tab. When Chrome asks, choose <b>this tab</b> and keep <b>Also share tab audio</b> on.{" "}
                        <button className="underline" onClick={() => setMethod("mic")}>Use the microphone instead</button>
                      </p>
                    ) : (
                      <p>
                        The song plays once while ChordCatch listens through your microphone. Turn the volume up, or play the song on a speaker nearby.
                        {tabOk && (
                          <>
                            {" "}
                            <button className="underline" onClick={() => setMethod("tab")}>Capture tab audio instead (cleaner)</button>
                          </>
                        )}
                      </p>
                    )}
                    <p>YouTube blocks servers from downloading audio, so the capture happens right here in your browser in real time.</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {!resolved && (
        <p className="mt-3 text-xs text-muted">Works with youtube.com, youtu.be, YouTube Music and open.spotify.com song links.</p>
      )}
    </div>
  );
}

// ---------------- upload ----------------

function UploadMode({ busy, setBusy, setError, finish }: ModeProps) {
  const [drag, setDrag] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  async function handle(file: File | undefined) {
    if (!file) return;
    setError(null);
    setBusy({ label: "Reading the file" });
    try {
      const samples = await decodeToMono(file);
      const base = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
      const m = base.match(/^(.+?)\s+-\s+(.+)$/);
      await finish(samples, { title: m ? m[2] : base, artist: m ? m[1] : null, source: "upload" }, file);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error && !/decode/i.test(err.message) ? err.message : "Couldn't read that file. Try an mp3, m4a, wav or a video file.");
    }
  }

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void handle(e.dataTransfer.files[0]);
      }}
      className={`rounded-2xl border-2 border-dashed p-8 text-center transition ${drag ? "border-accent bg-accent-soft" : "border-line"}`}
    >
      <input ref={input} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => void handle(e.target.files?.[0])} />
      <button
        disabled={!!busy}
        onClick={() => input.current?.click()}
        className="rounded-xl bg-accent text-accent-fg px-6 py-3.5 font-semibold text-lg disabled:opacity-50"
      >
        Choose a song file
      </button>
      <p className="mt-3 text-sm text-muted">or drop it here · mp3, m4a, wav, flac, even video files</p>
      <p className="mt-1 text-xs text-muted">The audio never leaves your device. Only the chords are saved.</p>
    </div>
  );
}

// ---------------- record ----------------

function RecordMode({ busy, setBusy, setError, finish }: ModeProps) {
  const [rec, setRec] = useState<Recorder | null>(null);
  const [source, setSource] = useState<"record" | "tab">("record");
  const tabOk = useSyncExternalStore(noop, canCaptureTab, () => false);
  const [t, setT] = useState(0);
  const [level, setLevel] = useState(0);

  useEffect(() => {
    if (!rec) return;
    let raf = 0;
    const tick = () => {
      setT(rec.elapsed());
      setLevel(rec.rms());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [rec]);

  async function begin(from: "record" | "tab") {
    setError(null);
    try {
      const stream = from === "tab" ? await getTabStream(false) : await getMicStream();
      const r = new Recorder(stream);
      await r.start();
      setSource(from);
      setRec(r);
      // the browser's own "Stop sharing" button finishes the recording too
      stream.getAudioTracks()[0]?.addEventListener("ended", () => document.getElementById("cc-rec-stop")?.click());
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(from === "tab" && !/NotAllowed|denied/i.test(msg) ? msg : from === "tab" ? "Tab sharing was cancelled." : "Microphone permission is needed to record.");
    }
  }

  async function toggle() {
    if (!rec) return begin("record");
    setRec(null);
    setBusy({ label: "Reading the recording" });
    try {
      const blob = await rec.stop();
      const samples = await decodeToMono(blob);
      const now = new Date();
      const title = `${source === "tab" ? "Tab capture" : "Recording"} ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      await finish(samples, { title, artist: null, source }, blob);
    } catch (err) {
      setBusy(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex flex-col items-center py-4">
      <button
        id="cc-rec-stop"
        onClick={toggle}
        disabled={!!busy}
        aria-label={rec ? "Stop recording" : "Start recording"}
        className={`relative h-28 w-28 rounded-full grid place-items-center text-accent-fg shadow-lg transition disabled:opacity-50 ${rec ? "bg-red-500" : "bg-accent"}`}
      >
        {rec && (
          <span className="absolute inset-0 rounded-full bg-red-500/40" style={{ transform: `scale(${1 + level * 0.6})`, transition: "transform 80ms" }} aria-hidden />
        )}
        <span className="relative">
          {rec ? (
            <span className="block h-8 w-8 rounded-md bg-white" />
          ) : (
            <svg width="40" height="40" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" />
            </svg>
          )}
        </span>
      </button>
      <p className="mt-4 text-sm tabular-nums">
        {rec ? `${source === "tab" ? "Capturing tab" : "Recording"} ${fmt(t)}  ·  tap to finish` : "Tap to record what's playing around you"}
      </p>
      {!rec && <p className="mt-1 text-xs text-muted text-center max-w-xs">Hold your phone near the speaker. 30 seconds or more gives the best results.</p>}
      {!rec && tabOk && (
        <div className="mt-5 pt-5 border-t border-line w-full text-center">
          <button disabled={!!busy} onClick={() => begin("tab")} className="rounded-xl border border-line px-4 py-2.5 font-medium disabled:opacity-50">
            Capture a browser tab instead
          </button>
          <p className="mt-2 text-xs text-muted max-w-sm mx-auto">
            Play the song in another tab (youtube.com, Spotify web player, anything), pick that tab when Chrome asks, and keep <b>Also share tab audio</b> on. Start from the beginning for the full song.
          </p>
        </div>
      )}
    </div>
  );
}

const noop = () => () => {};

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
