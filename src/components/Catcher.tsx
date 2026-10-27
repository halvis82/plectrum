"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import { SR, decodeToMono, getMicStream, saveLocalAudio, sharedAnalyzer, type Stage } from "@/lib/audio";
import { setPending } from "@/lib/pending";
import { PcmCapture, encodeWav, resample } from "@/lib/capture";
import { chordName, detectKey, keyName, labelFromIndex, parseLabel, spellingFor } from "@/lib/music";
import { songStats } from "@/lib/sheet";

type Resolved = {
  kind: "youtube" | "spotify" | "apple" | "deezer" | "web";
  videoId: string | null;
  title: string;
  artist: string | null;
  sourceUrl: string;
  alternatives: string[];
  duration: number | null;
  /** a library song already made from this link */
  existing?: string | null;
};
type Meta = { title: string; artist: string | null; source: string; sourceUrl?: string; youtubeId?: string; audioUrl?: string };
/** what /api/media found (its x-media header) */
type MediaMeta = { title: string; artist: string | null; site: string; page: string | null; duration: number | null; thumbnail: string | null };
type Card = { title: string; artist: string | null; image: string | null; note?: string };

type Phase =
  | { kind: "idle" }
  | { kind: "listening"; t: number; level: number; waiting: boolean }
  | { kind: "working"; flow: Flow; step: StepKey; p?: number; stepStart: number; start: number };

/** Every step a song can go through, in order, with its share of the progress bar. */
const STEPS = {
  find: { label: "Finding the song", weight: 4 },
  audio: { label: "Getting the audio", weight: 25 },
  read: { label: "Reading the audio", weight: 5 },
  prepare: { label: "Preparing the recording", weight: 3 },
  model: { label: "Loading the chord model (first time only)", weight: 10 },
  features: { label: "Listening to the harmony", weight: 30 },
  chords: { label: "Recognizing chords", weight: 8 },
  beats: { label: "Finding the beat", weight: 6 },
  save: { label: "Saving to the library", weight: 4 },
} as const;
type StepKey = keyof typeof STEPS;
type Flow = StepKey[];
const LINK_FLOW: Flow = ["find", "audio", "read", "model", "features", "chords", "beats", "save"];
const FILE_FLOW: Flow = ["read", "model", "features", "chords", "beats", "save"];
const MIC_FLOW: Flow = ["prepare", "model", "features", "chords", "beats", "save"];

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading the models (first time only)",
  features: "Listening to the harmony",
  chords: "Recognizing chords",
  beats: "Finding the beat",
  notes: "Catching every note",
  paused: "Paused while your newest song's tab is made",
};

const LINK_RE = /^\s*https?:\/\/[^\s/]+\.[^\s]+/i;

const SITE_NAME: Record<string, string> = { soundcloud: "SoundCloud", bandcamp: "Bandcamp", archiveorg: "the Internet Archive" };
/** yt-dlp extractor names -> stored source ("generic" is a plain file link) */
const sourceOf = (site: string) => (site === "generic" ? "web" : site.replace(/[^a-z0-9]/g, "").slice(0, 24) || "web");

/** Live chord timeline while listening: frame-level classes keyed by position. */
type Live = { hop: number; frames: Map<number, number> };

export function Catcher() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [song, setSong] = useState<Card | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const [drag, setDrag] = useState(false);
  const stopRef = useRef<(() => void) | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const lastLink = useRef("");
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = phase.kind !== "idle";
  /** what "Try again" repeats */
  const retryRef = useRef<(() => void) | null>(null);

  /** Moves the progress to a step (or updates the current step's share when it is the same one). */
  const step = (flow: Flow, key: StepKey, p?: number) =>
    setPhase((ph) => {
      const now = Date.now();
      const same = ph.kind === "working" && ph.step === key;
      const start = ph.kind === "working" ? ph.start : now;
      // a step can be skipped (the model is already loaded) but the bar never moves back
      if (ph.kind === "working" && flow.indexOf(key) < flow.indexOf(ph.step)) return ph;
      return { kind: "working", flow, step: key, p, stepStart: same ? ph.stepStart : now, start };
    });

  /** Back to an empty catcher, ready for the next song. */
  const reset = () => {
    stopRef.current = null;
    cancelRef.current = null;
    retryRef.current = null;
    setLive(null);
    setPhase({ kind: "idle" });
    setSong(null);
    setError(null);
    setUrl("");
    lastLink.current = "";
  };
  const go = (path: string) => {
    reset();
    router.push(path);
  };
  // this page is kept while a song is open, so "New song" (see NewSongButton) starts it clean unless a
  // song is still being worked on
  const idle = phase.kind === "idle";
  useEffect(() => {
    const clean = () => {
      if (!idle) return;
      setUrl("");
      setSong(null);
      setError(null);
      lastLink.current = "";
      retryRef.current = null;
      if (fileInput.current) fileInput.current.value = "";
    };
    window.addEventListener("cc:new-song", clean);
    return () => window.removeEventListener("cc:new-song", clean);
  }, [idle]);

  /** The chord model starts loading in the background and is cached afterwards. */
  const getAnalyzer = () => {
    const an = sharedAnalyzer();
    // someone is about to catch a song: start the large note model download
    an.prefetch();
    return an;
  };
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    idle(() => sharedAnalyzer());
  }, []);

  function fail(message: string, retry?: () => void) {
    stopRef.current = null;
    cancelRef.current = null;
    retryRef.current = retry ?? null;
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
    const F = LINK_FLOW;
    step(F, "find");
    try {
      let r = await fetch(`/api/resolve?url=${encodeURIComponent(link.trim())}`);
      let resolved: Resolved = await r.json();
      if (!r.ok) throw new Error((resolved as unknown as { error: string }).error);
      if (resolved.existing) return go(`/song/${resolved.existing}`);
      const progress = (p: number) => step(F, "audio", p);

      // any other site: the server downloads it with yt-dlp
      let site: string | null = null;
      if (resolved.kind === "web") {
        step(F, "audio");
        const got = await download(`/api/media?url=${encodeURIComponent(resolved.sourceUrl)}`, progress);
        if ("blob" in got) {
          const m = got.meta!;
          setSong({ title: m.title, artist: m.artist, image: thumb(m.thumbnail) });
          step(F, "read");
          const samples = await decodeToMono(got.blob);
          const page = m.page ?? resolved.sourceUrl;
          return await finish(F, samples, { title: m.title, artist: m.artist, source: sourceOf(m.site), sourceUrl: page, audioUrl: page }, got.blob);
        }
        // copy-protected there (official SoundCloud uploads): find the same song on YouTube
        if (!got.song) throw new Error(got.error);
        site = new URL(resolved.sourceUrl).hostname.replace(/^www\.|^m\./, "").split(".")[0];
        const q = new URLSearchParams({ title: got.song.title, artist: got.song.artist ?? "", duration: String(got.song.duration ?? ""), url: resolved.sourceUrl });
        r = await fetch(`/api/resolve?${q}`);
        resolved = await r.json();
        if (!r.ok) throw new Error((resolved as unknown as { error: string }).error);
        if (resolved.existing) return go(`/song/${resolved.existing}`);
      }

      const ytImage = (id: string | null) => (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null);
      setSong({ title: resolved.title, artist: resolved.artist, image: ytImage(resolved.videoId) });
      let audio: Blob | null = null;
      let videoId = resolved.videoId;
      for (let attempt = 0; attempt < 4 && !audio; attempt++) {
        if (attempt === 1 && resolved.alternatives.length === 0 && !site) {
          // only look for other uploads of the song if the first one fails
          r = await fetch(`/api/resolve?alts&url=${encodeURIComponent(resolved.sourceUrl)}`);
          if (r.ok) resolved = await r.json();
        }
        videoId = attempt === 0 ? resolved.videoId : resolved.alternatives[attempt - 1];
        if (!videoId) break;
        const got = await download(`/api/audio/${videoId}`, progress);
        if ("blob" in got) audio = got.blob;
      }
      let meta: Meta = { title: resolved.title, artist: resolved.artist, source: site ? sourceOf(site) : resolved.kind, sourceUrl: resolved.sourceUrl, youtubeId: videoId ?? undefined };

      // YouTube refused every upload: use a full-length copy from SoundCloud instead
      if (!audio) {
        step(F, "audio", 0.5);
        const q = new URLSearchParams({ q: `${resolved.artist ?? ""} ${resolved.title}`.trim(), title: resolved.title });
        if (resolved.artist) q.set("artist", resolved.artist);
        if (resolved.duration) q.set("duration", String(resolved.duration));
        const got = await download(`/api/media?${q}`, progress);
        if ("error" in got) throw new Error("Couldn't get the audio for this song from YouTube or anywhere else right now. Try another link, or upload the file.");
        const m = got.meta!;
        audio = got.blob;
        meta = { ...meta, youtubeId: undefined, audioUrl: m.page ?? undefined };
        setSong({
          title: resolved.title,
          artist: resolved.artist,
          image: thumb(m.thumbnail),
          note: `YouTube wouldn't share this one, so this uses "${m.title}"${m.artist ? ` by ${m.artist}` : ""} from ${SITE_NAME[m.site] ?? m.site}.`,
        });
      }

      step(F, "read");
      let samples: Float32Array;
      try {
        samples = await decodeToMono(audio);
      } catch {
        throw new Error("The audio came through but couldn't be read in this browser. Try again, or try another link.");
      }
      await finish(F, samples, meta, meta.audioUrl ? audio : undefined);
    } catch (e) {
      setSong(null);
      fail(e instanceof Error ? e.message : String(e), () => {
        lastLink.current = "";
        void catchLink(link);
      });
    }
  }

  // ---- upload ----
  async function handleFile(file: File | undefined) {
    if (!file || busy) return;
    setError(null);
    const base = file.name.replace(/\.[^.]+$/, "").replace(/_/g, " ");
    const m = base.match(/^(.+?)\s+-\s+(.+)$/);
    setSong({ title: m ? m[2] : base, artist: m ? m[1] : null, image: null });
    getAnalyzer();
    step(FILE_FLOW, "read");
    let samples: Float32Array;
    try {
      samples = await decodeToMono(file);
    } catch {
      setSong(null);
      return fail("Couldn't read that file. Try an mp3, m4a, wav or a video file.");
    }
    await finish(FILE_FLOW, samples, { title: m ? m[2] : base, artist: m ? m[1] : null, source: "upload" }, file);
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
    // one live update at a time: on a slow phone they would otherwise queue up in the worker, and the
    // song's own analysis would wait behind all of them
    let inFlight = false;
    const liveTimer = setInterval(async () => {
      if (pcm.seconds < 2 || pcm.firstSound < 0 || inFlight) return;
      inFlight = true;
      const { pcm: tail, start } = pcm.tail(10);
      const res = await an
        .live(await resample(tail, pcm.sampleRate, SR))
        .catch(() => null)
        .finally(() => (inFlight = false));
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
      step(MIC_FLOW, "prepare");
      const samples = await resample(pcm.stop(), pcm.sampleRate, SR);
      setLive(null);
      const now = new Date();
      const title = `Recording ${now.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      await finish(MIC_FLOW, samples, { title, artist: null, source: "record" }, encodeWav(samples, SR));
    };
    cancelRef.current = () => {
      stopped = true;
      cleanup();
      pcm.stop();
      setLive(null);
      setPhase({ kind: "idle" });
    };
  }

  async function finish(flow: Flow, samples: Float32Array, meta: Meta, localAudio?: Blob) {
    try {
      let peak = 0;
      for (let i = 0; i < samples.length; i += 64) peak = Math.max(peak, Math.abs(samples[i]));
      if (samples.length < SR * 3 || peak < 0.003) throw new Error("There wasn't enough music to work with. Give it at least a few seconds.");
      if (samples.length > SR * 1800) throw new Error("That's over 30 minutes long. ChordCatch works on single songs, so pick one track or trim the file.");
      // the song opens as soon as its chords are in; its page then shows the tab filling in
      const an = getAnalyzer();
      const pass = await an.chords(samples, (stage, p) => stage !== "notes" && stage !== "paused" && step(flow, stage, p));
      const analysis = pass.result;
      step(flow, "save");
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...meta, key: keyName(songStats(analysis).key), analysis }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Saving failed");
      const id: string = body.id;
      setPending(id, { label: STAGE_LABEL.notes, p: 0 });
      void an
        .tab(samples, pass, {
          // a paused tab keeps its progress bar where it was
          progress: (stage, p) => setPending(id, stage === "paused" ? { label: STAGE_LABEL.paused } : { label: STAGE_LABEL[stage], p }),
          partial: (notes, upTo) => setPending(id, { partial: { notes, upTo } }),
        })
        .then(async (done) => {
          setPending(id, { analysis: done });
          const { notes, chords, segments, meter, downbeat } = done;
          const saved = await fetch(`/api/songs/${id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ editKey: body.editKey, key: keyName(songStats(done).key), analysis: { notes, chords, segments, meter, downbeat } }),
          }).catch(() => null);
          if (!saved?.ok) setPending(id, { error: "The tab couldn't be saved, so it only shows on this device until you reload." });
        })
        .catch((e) => setPending(id, { error: `The notes couldn't be worked out: ${e instanceof Error ? e.message : e}` }));
      if (localAudio) await saveLocalAudio(id, localAudio);
      // this page is kept for the way back ("New song"), so leave it ready for the next one
      go(`/song/${id}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      fail(msg === "stalled" ? "The analysis got stuck twice, which usually means this device is short on memory. Close other tabs and try again." : msg, () => void finish(flow, samples, meta, localAudio));
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
          placeholder="Paste a link: YouTube, Spotify, SoundCloud, more"
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
          aria-label="Song link"
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
        <div className="mt-4">
          <div className="flex items-center gap-3">
            {song.image ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={song.image} alt="" className="h-14 w-24 rounded-lg object-cover bg-surface-2 shrink-0" />
            ) : (
              <span className="h-14 w-24 rounded-lg bg-surface-2 grid place-items-center shrink-0" aria-hidden>
                ♪
              </span>
            )}
            <p className="min-w-0">
              <span className="block font-medium truncate">{song.title}</span>
              {song.artist && <span className="block text-sm text-muted truncate">{song.artist}</span>}
            </p>
          </div>
          {song.note && <p className="mt-2 text-xs text-muted">{song.note}</p>}
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

      {working && <Progress phase={working} />}
      {error && (
        <div className="mt-4 text-sm rounded-xl bg-accent-soft px-3 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="flex-1 min-w-48">{error}</span>
          {retryRef.current && (
            <button onClick={() => retryRef.current?.()} className="btn btn-primary btn-sm">
              Try again
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** One bar for the whole job: finished steps fill their share, the current step its progress (or, when
 * it can't be measured, creeps on with time so it never looks frozen), with the steps listed below. */
function Progress({ phase }: { phase: Extract<Phase, { kind: "working" }> }) {
  const [now, setNow] = useState(phase.stepStart);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const at = phase.flow.indexOf(phase.step);
  const total = phase.flow.reduce((a, k) => a + STEPS[k].weight, 0);
  const done = phase.flow.slice(0, at).reduce((a, k) => a + STEPS[k].weight, 0);
  const inStep = phase.p ?? 0.9 * (1 - Math.exp(-Math.max(0, now - phase.stepStart) / 6000));
  const overall = (done + STEPS[phase.step].weight * Math.min(1, inStep)) / total;
  const secs = Math.max(0, Math.floor((now - phase.start) / 1000));
  return (
    <div className="mt-5" aria-live="polite">
      <div className="flex items-baseline justify-between gap-3 text-sm mb-2">
        <span className="font-medium">
          {STEPS[phase.step].label}
          {phase.p !== undefined && <span className="text-muted tabular-nums"> {Math.round(phase.p * 100)}%</span>}
        </span>
        <span className="text-muted tabular-nums shrink-0">
          {Math.round(overall * 100)}% · {fmt(secs)}
        </span>
      </div>
      <div className="relative h-2.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(2, overall * 100)}%` }} />
        <div className="absolute inset-y-0 left-0 progress-shimmer" style={{ width: `${Math.max(2, overall * 100)}%` }} />
      </div>
      <ol className="mt-3 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        {phase.flow.map((k, i) => (
          <li key={k} className={`flex items-center gap-1 ${i === at ? "text-fg font-medium" : ""}`}>
            <span aria-hidden className={`grid place-items-center h-3.5 w-3.5 rounded-full text-[9px] ${i < at ? "bg-accent text-accent-fg" : i === at ? "border-2 border-accent" : "border border-line"}`}>
              {i < at ? "✓" : ""}
            </span>
            {SHORT[k]}
          </li>
        ))}
      </ol>
    </div>
  );
}

const SHORT: Record<StepKey, string> = {
  find: "Find",
  audio: "Download",
  read: "Read",
  prepare: "Prepare",
  model: "Model",
  features: "Harmony",
  chords: "Chords",
  beats: "Beat",
  save: "Save",
};

/** Other sites' cover art goes through this origin (see /api/thumb). */
const thumb = (url: string | null) => (url ? `/api/thumb?u=${encodeURIComponent(url)}` : null);

/** Downloads with progress, plus what /api/media says it found; an error message if the server couldn't get it. */
async function download(
  url: string,
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; meta: MediaMeta | null } | { error: string; song?: { title: string; artist: string | null; duration: number | null } | null }> {
  const res = await fetch(url).catch(() => null);
  if (!res?.ok || !res.body) {
    const body = await res?.json().catch(() => null);
    return { error: body?.error ?? "Couldn't get the audio.", song: body?.song };
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const header = res.headers.get("x-media");
  const meta: MediaMeta | null = header ? JSON.parse(decodeURIComponent(header)) : null;
  // without a length (joined streams), estimate from the duration at ~128 kbps
  const expect = total || (meta?.duration ? meta.duration * 16_000 : 0);
  const reader = res.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (expect) onProgress(Math.min(0.99, got / expect));
    }
  } catch {
    return { error: "The download was interrupted. Try again." };
  }
  return { blob: new Blob(parts, { type: res.headers.get("content-type") ?? "audio/mp4" }), meta };
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
