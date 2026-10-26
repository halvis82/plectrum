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

/** a worker request without its id (Omit applied to each variant of the union) */
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

export type Stage = "model" | "features" | "chords" | "beats" | "notes";

/** A long-lived analysis worker. The chord model starts loading as soon as it is created; the much
 * larger note model only once `prefetch()` says a song is actually on its way. */
export class Analyzer {
  private worker = new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module" });
  private next = 1;
  private pending = new Map<number, (m: WorkerMessage) => void>();
  readonly ready: Promise<void>;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.pending.get(e.data.id)?.(e.data);
    this.ready = this.call({ type: "load" }, () => {}).then(() => undefined);
  }

  private call(req: RequestBody, onMsg: (m: WorkerMessage) => void): Promise<WorkerMessage> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        if (m.type === "progress" || m.type === "chords") return onMsg(m);
        this.pending.delete(id);
        if (m.type === "error") reject(new Error(m.message));
        else resolve(m);
      });
      this.worker.postMessage({ ...req, id } as WorkerRequest, "samples" in req ? [req.samples.buffer] : []);
    });
  }

  /** The full analysis; `onChords` gets the chords first, while the notes are still being worked out. */
  async analyze(samples: Float32Array, onProgress?: (stage: Stage, p: number) => void, onChords?: (a: Analysis) => void): Promise<Analysis> {
    const m = await this.call({ type: "analyze", samples }, (m) => {
      if (m.type === "progress") onProgress?.(m.stage, m.p);
      else if (m.type === "chords") onChords?.(m.result);
    });
    if (m.type !== "done") throw new Error("Unexpected worker reply");
    return m.result;
  }

  /** Chord class per CQT frame for the last <=10 s of audio, plus the frame hop in seconds. */
  async live(samples: Float32Array): Promise<{ frames: Int32Array; hop: number }> {
    const m = await this.call({ type: "live", samples }, () => {});
    if (m.type !== "live") throw new Error("Unexpected worker reply");
    return { frames: m.frames, hop: m.hop };
  }

  prefetch() {
    void this.call({ type: "prefetch" }, () => {}).catch(() => {});
  }

  terminate() {
    this.worker.terminate();
  }
}

let shared: Analyzer | null = null;
/** One worker for the whole visit: it keeps working on a song's notes after the page has moved on. */
export const sharedAnalyzer = () => (shared ??= new Analyzer());

// ---------- microphone ----------

/** Mic with all voice processing off so music is captured as-is. */
export function getMicStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
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
