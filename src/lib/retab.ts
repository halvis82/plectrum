"use client";
// The tab for a library song that never got one (caught before tabs existed, or its page was closed
// before the tab was in): worked out here from the song's audio and saved for everyone. Progress shows
// on the song page like a new song's.

import { ownerHeaders } from "./access";
import { keyName } from "./music";
import { songStats } from "./sheet";
import { decodeToMono, sharedAnalyzer } from "./audio";
import { STAGE_LABEL, pendingSnapshot, setPending } from "./pending";
import { logEvent } from "./log";

export async function workOutTab(id: string, audio: (onProgress: (p: number) => void) => Promise<Blob>) {
  const now = pendingSnapshot(id);
  if (now && !now.error && !now.analysis) return;
  const t0 = Date.now();
  setPending(id, { label: "Getting the song's audio", p: 0, error: undefined, analysis: undefined, partial: undefined });
  try {
    const blob = await audio((p) => setPending(id, { p }));
    setPending(id, { label: "Reading the audio", p: undefined });
    const samples = await decodeToMono(blob);
    const an = sharedAnalyzer();
    an.prefetch();
    const pass = await an.chords(samples, (stage, p) => setPending(id, { label: STAGE_LABEL[stage], p }));
    const done = await an.tab(samples, pass, {
      progress: (stage, p) => setPending(id, stage === "paused" ? { label: STAGE_LABEL.paused } : { label: STAGE_LABEL[stage], p }),
      partial: (notes, upTo) => setPending(id, { partial: { notes, upTo } }),
    });
    // saving: leaving the page now asks first (see pending.ts)
    setPending(id, { analysis: done, save: { state: "saving" } });
    logEvent("retab-ok", { secs: Math.round((Date.now() - t0) / 1000), notes: done.notes?.length ?? 0 });
    const { notes, chords, segments, meter, downbeat, beats, bpm, duration } = done;
    const body = JSON.stringify({ key: keyName(songStats(done).key), analysis: { notes, chords, segments, meter, downbeat, beats, bpm, duration } });
    const save = async () => {
      setPending(id, { save: { state: "saving" } });
      const res = await fetch(`/api/songs/${id}`, { method: "PATCH", headers: { "content-type": "application/json", ...ownerHeaders(id) }, body }).catch(() => null);
      setPending(id, { save: res?.ok ? { state: "saved" } : { state: "error", retry: () => void save() } });
    };
    await save();
  } catch (e) {
    logEvent("retab-fail", { error: String(e instanceof Error ? e.message : e).slice(0, 300) });
    setPending(id, { error: `The tab couldn't be worked out: ${e instanceof Error ? e.message : e}` });
  }
}

/** A song's audio from this site, with progress; a download with no data for 25 s is given up on. */
export async function fetchAudio(url: string, onProgress: (p: number) => void): Promise<Blob> {
  const ctl = new AbortController();
  let timer = window.setTimeout(() => ctl.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error("the song's audio couldn't be loaded just now");
    const total = Number(res.headers.get("content-length")) || 0;
    const reader = res.body.getReader();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let got = 0;
    for (;;) {
      clearTimeout(timer);
      timer = window.setTimeout(() => ctl.abort(), 25_000);
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      if (total) onProgress(got / total);
    }
    return new Blob(parts, { type: res.headers.get("content-type") ?? "audio/mp4" });
  } finally {
    clearTimeout(timer);
  }
}
