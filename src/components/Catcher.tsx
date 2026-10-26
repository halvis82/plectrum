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
  | { kind: "working"; label: string; p?: number };

const STAGE_LABEL: Record<Stage, string> = {
  model: "Loading the models (first time only)",
  features: "Listening to the harmony",
  chords: "Recognizing chords",
  beats: "Finding the beat",
  notes: "Catching every note",
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
      if (resolved.existing) return router.push(`/song/${resolved.existing}`);
      const progress = (p: number) => setPhase({ kind: "working", label: "Getting the audio", p });

      // any other site: the server downloads it with yt-dlp
      let site: string | null = null;
      if (resolved.kind === "web") {
        setPhase({ kind: "working", label: "Getting the audio" });
        const got = await download(`/api/media?url=${encodeURIComponent(resolved.sourceUrl)}`, progress);
        if ("blob" in got) {
          const m = got.meta!;
          setSong({ title: m.title, artist: m.artist, image: thumb(m.thumbnail) });
          setPhase({ kind: "working", label: "Reading the audio" });
          const samples = await decodeToMono(got.blob);
          const page = m.page ?? resolved.sourceUrl;
          return await finish(samples, { title: m.title, artist: m.artist, source: sourceOf(m.site), sourceUrl: page, audioUrl: page }, got.blob);
        }
        // copy-protected there (official SoundCloud uploads): find the same song on YouTube
        if (!got.song) throw new Error(got.error);
        site = new URL(resolved.sourceUrl).hostname.replace(/^www\.|^m\./, "").split(".")[0];
        const q = new URLSearchParams({ title: got.song.title, artist: got.song.artist ?? "", duration: String(got.song.duration ?? ""), url: resolved.sourceUrl });
        r = await fetch(`/api/resolve?${q}`);
        resolved = await r.json();
        if (!r.ok) throw new Error((resolved as unknown as { error: string }).error);
        if (resolved.existing) return router.push(`/song/${resolved.existing}`);
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
        setPhase({ kind: "working", label: "Looking for another copy" });
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

      setPhase({ kind: "working", label: "Reading the audio" });
      const samples = await decodeToMono(audio);
      await finish(samples, meta, meta.audioUrl ? audio : undefined);
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
      if (samples.length > SR * 1800) throw new Error("That's over 30 minutes long. ChordCatch works on single songs, so pick one track or trim the file.");
      // the song opens as soon as its chords are in; the page then shows the tab filling in
      let songId: string | null = null;
      let notesProgress: { label: string; p: number } | null = null;
      let gotChords!: (a: Analysis) => void;
      const chords = new Promise<Analysis>((resolve) => (gotChords = resolve));
      const full = getAnalyzer().analyze(
        samples,
        (stage, p) => {
          const label = STAGE_LABEL[stage];
          if (songId) setPending(songId, { label, p });
          else if (notesProgress) notesProgress = { label, p };
          else setPhase({ kind: "working", label, p });
        },
        gotChords,
      );
      const analysis = await Promise.race([chords, full]);
      notesProgress = { label: STAGE_LABEL.notes, p: 0 };
      setPhase({ kind: "working", label: "Saving to the library" });
      const res = await fetch("/api/songs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...meta, key: keyName(songStats(analysis).key), analysis }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Saving failed");
      if (!analysis.notes) {
        const id: string = (songId = body.id);
        setPending(id, notesProgress);
        void full
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
      }
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
