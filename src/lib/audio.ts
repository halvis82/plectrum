"use client";
// Browser audio plumbing: decoding, capture streams, the analysis worker and local storage.

import type { Analysis } from "./analysis/analyze";
import type { WorkerMessage, WorkerRequest } from "./analysis/worker";

export const SR = 22050;

/** Decode any audio/video file the browser understands into mono 22.05 kHz samples. */
export async function decodeToMono(data: Blob | ArrayBuffer): Promise<Float32Array> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(buf);
    const length = Math.max(1, Math.ceil(decoded.duration * SR));
    const off = new OfflineAudioContext(1, length, SR);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  } finally {
    void ctx.close();
  }
}

export type Stage = "model" | "features" | "chords" | "beats";

/** A long-lived analysis worker. Model loading starts as soon as it is created. */
export class Analyzer {
  private worker = new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private pending = new Map<number, (m: WorkerMessage) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.pending.get(e.data.id)?.(e.data);
    this.ready = this.call({ type: "load" }, () => {}).then(() => undefined);
  }

  private call(req: Omit<WorkerRequest, "id"> & { samples?: Float32Array }, onMsg: (m: WorkerMessage) => void): Promise<WorkerMessage> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        if (m.type === "progress") return onMsg(m);
        this.pending.delete(id);
        if (m.type === "error") reject(new Error(m.message));
        else resolve(m);
      });
      this.worker.postMessage({ ...req, id } as WorkerRequest, req.samples ? [req.samples.buffer] : []);
    });
  }

  async analyze(samples: Float32Array, onProgress?: (stage: Stage, p: number) => void): Promise<Analysis> {
    const m = await this.call({ type: "analyze", samples }, (m) => m.type === "progress" && onProgress?.(m.stage, m.p));
    if (m.type !== "done") throw new Error("Unexpected worker reply");
    return m.result;
  }

  /** Chord class per CQT frame for the last <=10 s of audio, plus the frame hop in seconds. */
  async live(samples: Float32Array): Promise<{ frames: Int32Array; hop: number }> {
    const m = await this.call({ type: "live", samples }, () => {});
    if (m.type !== "live") throw new Error("Unexpected worker reply");
    return { frames: m.frames, hop: m.hop };
  }

  terminate() {
    this.worker.terminate();
  }
}

// ---------- capture streams ----------

/** Mic with all voice processing off so music is captured as-is. */
export function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
}

/** Desktop Chrome/Edge: capture this tab's (or, with currentTab false, any tab's) audio. */
export async function getTabStream(currentTab = true): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chrome-only hints: offer the current tab first and keep sound playing locally
    ...({ preferCurrentTab: currentTab, selfBrowserSurface: currentTab ? "include" : "exclude", systemAudio: "include", suppressLocalAudioPlayback: false } as object),
  } as DisplayMediaStreamOptions);
  // only the audio is used; dropping video keeps the "sharing" overhead low
  stream.getVideoTracks().forEach((t) => (t.enabled = false));
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Try again and keep "Also share tab audio" switched on.');
  }
  return stream;
}

export function canCaptureTab(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
  const ua = navigator.userAgent;
  // Safari and Firefox can't capture tab audio; headless test browsers must never trigger OS capture prompts
  if (/Android|iPhone|iPad|Mobile|HeadlessChrome/i.test(ua)) return false;
  return /Chrome|Chromium|Edg\//.test(ua);
}

// ---------- aligning a capture to the video timeline ----------

/** A poll of the player while recording: recording time vs. video time. */
export type SyncPoint = { rec: number; video: number; playing: boolean };

/**
 * Rebuilds audio on the video's own timeline from a real-time capture, dropping
 * buffering stalls, ads and seeks. Each run of steady playback gets its own offset.
 */
export function alignToVideo(recorded: Float32Array, points: SyncPoint[], videoDuration: number): Float32Array {
  const out = new Float32Array(Math.ceil(videoDuration * SR));
  let run: SyncPoint[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const offsets = run.map((p) => p.rec - p.video).sort((a, b) => a - b);
      const offset = offsets[Math.floor(offsets.length / 2)];
      const v0 = run[0].video, v1 = run[run.length - 1].video;
      const from = Math.max(0, Math.floor(v0 * SR)), to = Math.min(out.length, Math.ceil(v1 * SR));
      const shift = Math.round(offset * SR);
      for (let i = from; i < to; i++) {
        const j = i + shift;
        if (j >= 0 && j < recorded.length) out[i] = recorded[j];
      }
    }
    run = [];
  };
  for (const p of points) {
    const prev = run[run.length - 1];
    const steady = prev && Math.abs(p.video - prev.video - (p.rec - prev.rec)) < 0.35;
    if (!p.playing || (prev && !steady)) flush();
    if (p.playing) run.push(p);
  }
  flush();
  return out;
}

/** Median recording-minus-video offset over recent steady playback (for live display). */
export function currentOffset(points: SyncPoint[]): number | null {
  const recent = points.filter((p) => p.playing).slice(-20);
  if (recent.length < 3) return null;
  const o = recent.map((p) => p.rec - p.video).sort((a, b) => a - b);
  return o[Math.floor(o.length / 2)];
}

// ---------- local audio for playback of uploads/recordings (this device only) ----------

const DB = "chordcatch";
function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore("audio");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLocalAudio(id: string, blob: Blob) {
  try {
    const db = await idb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("audio", "readwrite");
      tx.objectStore("audio").put(blob, id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // storage can be unavailable (private mode); playback just won't be offered
  }
}

export async function loadLocalAudio(id: string): Promise<Blob | null> {
  try {
    const db = await idb();
    return await new Promise((resolve) => {
      const req = db.transaction("audio").objectStore("audio").get(id);
      req.onsuccess = () => resolve((req.result as Blob) ?? null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}
