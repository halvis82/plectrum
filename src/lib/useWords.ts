"use client";
// The words for a song, timed: synced lyrics from LRCLIB, else the video's captions, else transcribed
// from the audio right here (once; the result is stored with the song for everyone).

import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptionLine, Captions } from "./captions";
import { decodeToMono, fresh, loadLocalAudio } from "./audio";
import type { LyricsState } from "@/components/song/Sheets";
import type { LyricsInfo } from "@/components/song/SourcePanel";
import type { WhisperMessage } from "./whisper.worker";
import type { Transport } from "./transport";

type Song = { id: string; title: string; artist: string | null; youtube_id: string | null; captions: Captions | null; source: string };

const asLines = (c: CaptionLine[]) => c.map((l) => ({ t: l.t, text: l.text }));

export function useWords(song: Song, duration: number, transport: Transport, wanted: boolean) {
  const [lyrics, setLyrics] = useState<LyricsState>("loading");
  const [info, setInfo] = useState<LyricsInfo | "loading">("loading");
  const [speech, setSpeech] = useState<[number, number][]>([]);
  const [job, setJob] = useState<{ state: string; p: number | null } | null>(null);
  const [canTranscribe, setCanTranscribe] = useState(false);
  const started = useRef(false);

  const applyCaptions = useCallback((c: Captions) => {
    setLyrics({ lines: asLines(c.lines), plain: null, from: c.source === "youtube" ? "youtube" : "transcribed" });
    setInfo(c.source === "youtube" ? { kind: "youtube" } : { kind: "transcribed", lang: c.lang });
    setSpeech(c.lines.map((l) => [l.t, Math.max(l.end, l.t + 0.3)]));
  }, []);

  useEffect(() => {
    let gone = false;
    (async () => {
      const qs = new URLSearchParams({ title: song.title, artist: song.artist ?? "", duration: String(Math.round(duration)) });
      const l = await fetch(`/api/lyrics?${qs}`)
        .then((r) => r.json())
        .then((b) => b.lyrics as { synced: string | null; plain: string | null; track: string; artist: string } | null)
        .catch(() => null);
      if (gone) return;
      if (l?.synced || (l?.plain && !song.captions)) {
        const { parseLrc } = await import("./sheet");
        const lines = l.synced ? parseLrc(l.synced) : null;
        setLyrics({ lines, plain: l.plain, from: "lrclib" });
        setInfo({ kind: "lrclib", track: l.track, artist: l.artist, synced: !!l.synced });
        if (lines) setSpeech(lines.map((x, i) => [x.t, Math.min(lines[i + 1]?.t ?? x.t + 4, x.t + 6)]));
        return;
      }
      if (song.captions) return applyCaptions(song.captions);
      if (song.youtube_id) {
        const c = await fetch(`/api/captions/${song.id}`)
          .then((r) => r.json())
          .then((b) => b.captions as Captions | null)
          .catch(() => null);
        if (gone) return;
        if (c) return applyCaptions(c);
      }
      setLyrics(null);
      setInfo(null);
      setCanTranscribe(song.source !== "scratch");
    })();
    return () => {
      gone = true;
    };
  }, [song.id, song.title, song.artist, song.youtube_id, song.captions, song.source, duration, applyCaptions]);

  const run = useCallback(async () => {
    if (started.current) return;
    started.current = true;
    setJob({ state: "Getting the audio", p: null });
    try {
      let blob = await loadLocalAudio(song.id);
      if (!blob && song.youtube_id) blob = await fetch(`/api/audio/${song.youtube_id}`).then((r) => (r.ok ? r.blob() : null));
      if (!blob) throw new Error("The audio isn't available on this device.");
      setJob({ state: "Reading the audio", p: null });
      const samples = await decodeToMono(blob, 120_000, 16000);
      const w = fresh(() => new Worker(new URL("./whisper.worker.ts", import.meta.url), { type: "module" }));
      const result = await new Promise<{ lines: CaptionLine[]; lang: string | null }>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<WhisperMessage>) => {
          const m = e.data;
          if (m.type === "progress") setJob({ state: m.stage === "model" ? "Loading the speech model (first time only)" : "Listening for the words", p: m.p });
          else if (m.type === "done") resolve(m);
          else reject(new Error(m.message));
        };
        w.onerror = () => reject(new Error("The transcriber stopped unexpectedly."));
        w.postMessage({ samples }, [samples.buffer]);
      }).finally(() => w.terminate());
      const captions: Captions = { source: "transcribed", lang: result.lang, lines: result.lines };
      setJob(null);
      if (!result.lines.length) {
        setLyrics({ lines: null, plain: null, from: "transcribed" });
        setInfo({ kind: "transcribed", lang: result.lang });
        setJob({ state: "No words were heard in this one", p: 1 });
        return;
      }
      applyCaptions(captions);
      void fetch(`/api/captions/${song.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(captions) });
    } catch (e) {
      started.current = false;
      setJob({ state: `Couldn't transcribe: ${e instanceof Error ? e.message : e}`, p: null });
    }
  }, [song.id, song.youtube_id, applyCaptions]);

  // no lyrics anywhere: listen for the words as soon as they're wanted
  useEffect(() => {
    if (wanted && canTranscribe && lyrics === null && !started.current) void run();
  }, [wanted, canTranscribe, lyrics, run]);

  void transport;
  return { lyrics, info, speech, transcribe: canTranscribe ? { run: () => void run(), state: job?.state ?? null, p: job?.p ?? null } : null };
}
