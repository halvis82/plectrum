"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { Analysis } from "@/lib/analysis/analyze";
import { SR, decodeToMono, getMicStream, saveLocalAudio, sharedAnalyzer, type Stage } from "@/lib/audio";
import { pendingSnapshot, setPending } from "@/lib/pending";
import { customAlphabet } from "nanoid";
import type { SongData } from "@/components/song/SongView";
import { PcmCapture, encodeWav, resample } from "@/lib/capture";
import { chordName, detectKey, keyName, labelFromIndex, parseLabel, spellingFor } from "@/lib/music";
import { songStats } from "@/lib/sheet";
import { logEvent } from "@/lib/log";

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
  /** asking the browser for the microphone; `slow` once that has taken a while */
  | { kind: "mic"; slow: boolean }
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

const newSongId = customAlphabet("23456789abcdefghjkmnpqrstuvwxyz", 10);

/** Saves a new song to the library, trying for about two minutes; resolves with the key that lets this
 * device add the tab, or null when it couldn't be saved (the song page then offers to try again). */
async function saveSong(id: string, body: string): Promise<string | null> {
  for (let k = 0; k < 6; k++) {
    if (k) await new Promise((r) => setTimeout(r, Math.min(30_000, 1500 * 2 ** k)));
    try {
      const res = await fetch("/api/songs", { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(30_000) });
      const out = await res.json().catch(() => ({}));
      if (res.ok) {
        setPending(id, { save: { state: "saved" } });
        return out.editKey ?? null;
      }
      // the request itself is wrong: retrying won't help
      if (res.status < 500) break;
    } catch {}
  }
  logEvent("save-fail", {});
  setPending(id, {
    save: {
      state: "error",
      // by now the tab may be done too: save everything this device has
      retry: () => {
        setPending(id, { save: { state: "saving" } });
        const job = pendingSnapshot(id);
        const analysis = job?.analysis ?? job?.local?.analysis;
        const b = JSON.parse(body);
        void saveSong(id, JSON.stringify({ ...b, analysis: analysis ?? b.analysis }));
      },
    },
  });
  return null;
}

/** when each song's tab started, for the diagnostics log */
const tabWatch = new Map<string, number>();

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

  // each job's steps with the seconds they started at, for the diagnostics log
  const trail = useRef<{ start: number; steps: [StepKey, number][] }>({ start: 0, steps: [] });
  const report = (kind: "song-ok" | "song-fail", extra: Record<string, unknown> = {}) => {
    const t = trail.current;
    if (!t.start) return;
    logEvent(kind, { steps: t.steps, secs: +((Date.now() - t.start) / 1000).toFixed(1), ...extra });
    trail.current = { start: 0, steps: [] };
  };

  /** Moves the progress to a step (or updates the current step's share when it is the same one). */
  const step = (flow: Flow, key: StepKey, p?: number) => {
    const t = trail.current;
    if (!t.start) trail.current = { start: Date.now(), steps: [[flow[0] === "read" ? "read" : flow[0], 0]] };
    if (trail.current.steps.at(-1)?.[0] !== key) trail.current.steps.push([key, +((Date.now() - trail.current.start) / 1000).toFixed(1)]);
    setPhase((ph) => {
      const now = Date.now();
      const same = ph.kind === "working" && ph.step === key;
      const start = ph.kind === "working" ? ph.start : now;
      // a step can be skipped (the model is already loaded) but the bar never moves back
      if (ph.kind === "working" && flow.indexOf(key) < flow.indexOf(ph.step)) return ph;
      return { kind: "working", flow, step: key, p, stepStart: same ? ph.stepStart : now, start };
    });
  };

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
    // a link already in the library opens its song
    report("song-ok", { reused: true });
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

  /** The chord model starts loading in the background and is cached afterwards. The large note model
   * waits until a song's chords are saved, so it never competes with the song's own download. */
  const getAnalyzer = () => sharedAnalyzer();
  useEffect(() => {
    const idle = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1500));
    idle(() => sharedAnalyzer());
  }, []);

  function fail(message: string, retry?: () => void) {
    report("song-fail", { error: message.slice(0, 300) });
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
      let r = await sturdyFetch(`/api/resolve?url=${encodeURIComponent(link.trim())}`);
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
        r = await sturdyFetch(`/api/resolve?${q}`);
        resolved = await r.json();
        if (!r.ok) throw new Error((resolved as unknown as { error: string }).error);
        if (resolved.existing) return go(`/song/${resolved.existing}`);
      }

      const ytImage = (id: string | null) => (id ? `https://i.ytimg.com/vi/${id}/mqdefault.jpg` : null);
      setSong({ title: resolved.title, artist: resolved.artist, image: ytImage(resolved.videoId) });
      // the server takes a few seconds to find the audio stream before any of it arrives
      step(F, "audio");
      let audio: Blob | null = null;
      let videoId = resolved.videoId;
      for (let attempt = 0; attempt < 4 && !audio; attempt++) {
        if (attempt === 1 && resolved.alternatives.length === 0 && !site) {
          // only look for other uploads of the song if the first one fails
          r = await sturdyFetch(`/api/resolve?alts&url=${encodeURIComponent(resolved.sourceUrl)}`);
          if (r.ok) resolved = await r.json();
        }
        videoId = attempt === 0 ? resolved.videoId : resolved.alternatives[attempt - 1];
        if (!videoId) break;
        let got = await download(`/api/audio/${videoId}`, progress);
        // a stalled or dropped download gets one more go before trying another upload
        if ("error" in got && got.retry) got = await download(`/api/audio/${videoId}`, progress);
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
    // the browser may be showing a permission prompt (or waiting on the system's): say so right away
    setPhase({ kind: "mic", slow: false });
    const slow = setTimeout(() => setPhase((ph) => (ph.kind === "mic" ? { kind: "mic", slow: true } : ph)), 6000);
    let stream: MediaStream;
    let pcm: PcmCapture;
    try {
      stream = await getMicStream();
      pcm = await PcmCapture.start(stream);
    } catch (e) {
      const name = e instanceof DOMException ? e.name : "";
      return fail(
        name === "NotAllowedError"
          ? "The microphone is blocked for this site. Click the icon at the left of the address bar, allow the microphone, then tap Listen again. On a Mac, also check System Settings › Privacy & Security › Microphone for your browser."
          : name === "NotFoundError"
            ? "No microphone was found. Plug one in or pick one in your system's sound settings, then try again."
            : name === "NotReadableError"
              ? "The microphone is busy in another app (a call, a recorder). Close it and try again."
              : `The microphone couldn't start (${e instanceof Error ? e.message : e}). Try again, or reload the page.`,
        () => void listen(),
      );
    } finally {
      clearTimeout(slow);
    }
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
      // the song opens right away from what this device has; the library copy is saved alongside, with
      // retries, so a slow or failing server never holds the result back
      const id = newSongId();
      const key = keyName(songStats(analysis).key);
      const local: SongData = {
        id,
        title: meta.title,
        artist: meta.artist,
        source: meta.source,
        source_url: meta.sourceUrl ?? null,
        youtube_id: meta.youtubeId ?? null,
        audio_url: meta.audioUrl ?? null,
        analysis,
        edits: null,
        captions: null,
        created_at: new Date().toISOString(),
        updated_at: null,
        views: 0,
      };
      setPending(id, { label: STAGE_LABEL.notes, p: 0, local, save: { state: "saving" } });
      const saving = saveSong(id, JSON.stringify({ ...meta, id, key, analysis }));
      // the tab (and the first time, its 77 MB of models) starts once the song's page is up: big downloads
      // fill the connection, and the page and the save would otherwise queue behind them for seconds
      const startTab = () =>
        void an
        .tab(samples, pass, {
          // a paused tab keeps its progress bar where it was
          progress: (stage, p) => setPending(id, stage === "paused" ? { label: STAGE_LABEL.paused } : { label: STAGE_LABEL[stage], p }),
          partial: (notes, upTo) => setPending(id, { partial: { notes, upTo } }),
        })
        .then(async (done) => {
          setPending(id, { analysis: done });
          logEvent("tab-ok", { secs: +((Date.now() - (tabWatch.get(id) ?? Date.now())) / 1000).toFixed(1), notes: done.notes?.length ?? 0 });
          const editKey = await saving;
          const { notes, chords, segments, meter, downbeat } = done;
          const saved = editKey
            ? await sturdyFetch(
                `/api/songs/${id}`,
                {
                  method: "PATCH",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ editKey, key: keyName(songStats(done).key), analysis: { notes, chords, segments, meter, downbeat } }),
                },
                { timeoutMs: 60_000, tries: 4 },
              ).catch(() => null)
            : null;
          if (!saved?.ok) setPending(id, { error: "The tab couldn't be saved to the library, so it only shows on this device until you reload." });
        })
        .catch((e) => {
          logEvent("tab-fail", { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
          setPending(id, { error: `The notes couldn't be worked out: ${e instanceof Error ? e.message : e}` });
        });
      setTimeout(startTab, 1500);
      if (localAudio) await saveLocalAudio(id, localAudio);
      report("song-ok", { source: meta.source, minutes: +(samples.length / SR / 60).toFixed(1) });
      const tabStart = Date.now();
      tabWatch.set(id, tabStart);
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
          placeholder="Paste a song link"
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
          className="w-full rounded-2xl border border-line bg-bg px-4 py-3.5 text-base sm:text-lg outline-none transition focus:border-accent disabled:opacity-60"
        />
      </form>

      {!busy && (
        <>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <input ref={fileInput} type="file" accept="audio/*,video/*" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
            <button onClick={() => fileInput.current?.click()} className="btn py-3.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 16V4M7 9l5-5 5 5" />
                <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
              </svg>
              Upload
            </button>
            <button onClick={() => void listen()} className="btn py-3.5">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
              </svg>
              Listen
            </button>
          </div>
          <p className="mt-3 text-xs text-muted">YouTube, Spotify, SoundCloud and more. Or drop a file here, or tap Listen near a speaker or while you play.</p>
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

      {phase.kind === "mic" && (
        <div className="mt-4 rounded-2xl bg-surface-2 p-4 text-sm" aria-live="polite">
          <p className="font-medium flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-accent animate-pulse" aria-hidden />
            Waiting for the microphone…
          </p>
          <p className="mt-1 text-muted">
            {phase.slow
              ? "Your browser is asking for permission: look for the prompt near the address bar and choose Allow. On a Mac, the browser also needs the microphone in System Settings › Privacy & Security › Microphone."
              : "Allow the microphone when your browser asks."}
          </p>
          <button onClick={() => setPhase({ kind: "idle" })} className="btn btn-sm mt-3">
            Cancel
          </button>
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
            <button onClick={() => stopRef.current?.()} className="btn btn-primary py-3.5">
              Done, show the chords
            </button>
            <button onClick={() => cancelRef.current?.()} className="btn px-4">
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

/** fetch with a timeout per try and retries (with a growing pause) on network errors and server errors */
async function sturdyFetch(url: string, init: RequestInit = {}, o: { timeoutMs?: number; tries?: number } = {}): Promise<Response> {
  const { timeoutMs = 25_000, tries = 2 } = o;
  let last: unknown = null;
  for (let k = 0; k < tries; k++) {
    if (k) await new Promise((r) => setTimeout(r, 800 * 2 ** k));
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      // a server error may be passing; a 4xx says what's wrong with the request
      if (res.status < 500 || k === tries - 1) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
  }
  throw new Error(last instanceof Error && last.name === "TimeoutError" ? "The server took too long to answer. Check the connection and try again." : "Couldn't reach the server. Check the connection and try again.");
}

/** Downloads with progress, plus what /api/media says it found; an error message if the server couldn't
 * get it. A response that hasn't started within 60 s, or a download with no data for 25 s, is given up
 * on (`retry`: worth trying again). */
async function download(
  url: string,
  onProgress: (p: number) => void,
): Promise<{ blob: Blob; meta: MediaMeta | null } | { error: string; retry?: boolean; song?: { title: string; artist: string | null; duration: number | null } | null }> {
  const ctl = new AbortController();
  let timer = window.setTimeout(() => ctl.abort(), 60_000);
  const res = await fetch(url, { signal: ctl.signal }).catch(() => null);
  clearTimeout(timer);
  if (!res?.ok || !res.body) {
    const body = await res?.json().catch(() => null);
    return { error: body?.error ?? "Couldn't get the audio.", song: body?.song, retry: !res || res.status >= 500 };
  }
  const total = Number(res.headers.get("content-length")) || 0;
  const header = res.headers.get("x-media");
  const meta: MediaMeta | null = header ? JSON.parse(decodeURIComponent(header)) : null;
  // without a length (joined streams), estimate from the duration at ~128 kbps
  const expect = total || (meta?.duration ? meta.duration * 16_000 : 0);
  const reader = res.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  const stall = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => ctl.abort(), 25_000);
  };
  try {
    stall();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stall();
      parts.push(value);
      got += value.length;
      if (expect) onProgress(Math.min(0.99, got / expect));
    }
  } catch {
    return { error: "The download stopped partway. Trying again…", retry: true };
  } finally {
    clearTimeout(timer);
  }
  if (total && got < total * 0.98) return { error: "The download stopped partway.", retry: true };
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
