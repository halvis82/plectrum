"use client";
// Browser audio plumbing: decoding, resampling, recording and running the analysis worker.

import type { Analysis } from "./analysis/analyze";
import type { WorkerMessage } from "./analysis/worker";

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

export function analyzeSamples(samples: Float32Array, onProgress?: (stage: Stage, p: number) => void): Promise<Analysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const m = e.data;
      if (m.type === "progress") onProgress?.(m.stage, m.p);
      else {
        worker.terminate();
        if (m.type === "done") resolve(m.result);
        else reject(new Error(m.message));
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || "Analysis worker crashed"));
    };
    worker.postMessage({ type: "analyze", samples }, [samples.buffer]);
  });
}

// ---------- recording ----------

export type AudioSource = "mic" | "tab";

/** Mic with all voice processing off so music is captured as-is. */
export async function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
}

/** Desktop Chrome/Edge: capture this tab's (or another tab's) audio. */
export async function getTabStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    // Chrome-only hints: offer the current tab first and keep sound playing locally
    ...({ preferCurrentTab: true, selfBrowserSurface: "include", systemAudio: "include", suppressLocalAudioPlayback: false } as object),
  } as DisplayMediaStreamOptions);
  if (stream.getAudioTracks().length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('No audio was shared. Pick the tab and make sure "Also share tab audio" is on.');
  }
  return stream;
}

export function canCaptureTab(): boolean {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) return false;
  // Safari and Firefox expose getDisplayMedia but cannot capture tab audio
  const ua = navigator.userAgent;
  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  return !mobile && /Chrome|Chromium|Edg\//.test(ua);
}

export class Recorder {
  private rec: MediaRecorder;
  private chunks: Blob[] = [];
  private startedAt = 0;
  readonly level: AnalyserNode;
  private ctx: AudioContext;

  constructor(private stream: MediaStream) {
    const audioOnly = new MediaStream(stream.getAudioTracks());
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m));
    this.rec = new MediaRecorder(audioOnly, mime ? { mimeType: mime, audioBitsPerSecond: 128000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.ctx = new AudioContext();
    this.level = this.ctx.createAnalyser();
    this.level.fftSize = 1024;
    this.ctx.createMediaStreamSource(audioOnly).connect(this.level);
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.rec.onstart = () => {
        this.startedAt = performance.now();
        resolve(this.startedAt);
      };
      this.rec.start(1000);
    });
  }

  /** Seconds since recording started. */
  elapsed() {
    return this.startedAt ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  stop(): Promise<Blob> {
    return new Promise((resolve) => {
      this.rec.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        void this.ctx.close();
        resolve(new Blob(this.chunks, { type: this.rec.mimeType }));
      };
      if (this.rec.state !== "inactive") this.rec.stop();
      else this.rec.onstop(new Event("stop"));
    });
  }

  /** 0..1 loudness for a meter. */
  rms(): number {
    const buf = new Float32Array(this.level.fftSize);
    this.level.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    return Math.min(1, Math.sqrt(s / buf.length) * 4);
  }
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
