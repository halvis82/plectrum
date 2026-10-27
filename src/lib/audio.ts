"use client";
// Browser audio plumbing: decoding, capture streams, the analysis worker and local storage.

import type { Analysis, NoteRow } from "./analysis/analyze";
import type { WorkerMessage, WorkerRequest } from "./analysis/worker-shared";
import { logEvent } from "./log";

export const SR = 22050;

/** Decode any audio/video file the browser understands into mono samples (22.05 kHz unless `rate`). An offline context
 * at 22.05 kHz decodes and resamples in one pass (no live AudioContext, which browsers limit and can
 * leave suspended); a decoder that never answers is given up on after `timeoutMs`. */
export async function decodeToMono(data: Blob | ArrayBuffer, timeoutMs = 90_000, rate = SR): Promise<Float32Array> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const off = new OfflineAudioContext(1, 1, rate);
  let timer = 0;
  const decoded = await Promise.race([
    off.decodeAudioData(buf),
    new Promise<never>((_, reject) => (timer = window.setTimeout(() => reject(new Error("Decoding the audio took too long")), timeoutMs))),
  ]).finally(() => clearTimeout(timer));
  const n = decoded.length;
  if (decoded.numberOfChannels === 1) return decoded.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i];
  }
  const k = 1 / decoded.numberOfChannels;
  for (let i = 0; i < n; i++) out[i] *= k;
  return out;
}

/** a worker request without its id (Omit applied to each variant of the union) */
type RequestBody = WorkerRequest extends infer R ? (R extends WorkerRequest ? Omit<R, "id"> : never) : never;

export type Stage = "model" | "features" | "chords" | "beats" | "notes" | "paused";

/** One analysis worker (see analysis/worker.ts): requests are numbered and answered in order. A worker
 * that crashes (out of memory, say) fails its requests and is replaced on the next call. */
const CRASHED = "The analysis stopped unexpectedly (the device may be low on memory)";

class WorkerLink {
  private worker: Worker | null = null;
  constructor(
    private spawn: () => Worker,
    private label: string,
  ) {}
  private next = 1;
  private pending = new Map<number, { onMsg: (m: WorkerMessage) => void; reject: (e: Error) => void }>();
  /** the worker's script ran (it says so with message 0) */
  private started = false;

  private get w(): Worker {
    if (!this.worker) {
      const w = this.spawn();
      this.started = false;
      w.onmessage = (e: MessageEvent<WorkerMessage>) => (e.data.id === 0 ? (this.started = true) : this.pending.get(e.data.id)?.onMsg(e.data));
      w.onerror = (e) => {
        e.preventDefault?.();
        logEvent("worker-crash", { worker: this.label, started: this.started, message: String(e.message ?? "").slice(0, 300), at: `${e.filename ?? ""}:${e.lineno ?? ""}`.slice(-120), pending: this.pending.size });
        this.restart(new Error(CRASHED));
      };
      this.worker = w;
    }
    return this.worker;
  }

  /** Ends the worker and fails everything it was doing; the next call starts a fresh one. */
  restart(reason: Error) {
    this.worker?.terminate();
    this.worker = null;
    const all = [...this.pending.values()];
    this.pending.clear();
    all.forEach((p) => p.reject(reason));
  }

  /** `onMsg` gets the messages before the final one (progress, partial results). With `stallMs`, a
   * request that hears nothing back for that long restarts the worker and fails. */
  call(req: RequestBody, onMsg: (m: WorkerMessage) => void = () => {}, stallMs = 0): Promise<WorkerMessage> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      let timer = 0;
      const arm = () => {
        if (!stallMs) return;
        clearTimeout(timer);
        timer = window.setTimeout(() => this.restart(new Error("stalled")), stallMs);
      };
      this.pending.set(id, {
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        onMsg: (m) => {
          arm();
          if (m.type === "progress" || m.type === "partial") return onMsg(m);
          clearTimeout(timer);
          this.pending.delete(id);
          if (m.type === "error") reject(new Error(m.message));
          else resolve(m);
        },
      });
      arm();
      this.w.postMessage({ ...req, id } as WorkerRequest);
    });
  }

  terminate() {
    this.restart(new Error("closed"));
  }
}

export type ChordPass = Extract<WorkerMessage, { type: "chords" }>;

/** The analysis workers: one for chords and live listening, one for tabs, so a new song's chords
 * never wait behind another song's tab. The chord model starts loading as soon as this exists; the
 * much larger note model only once `prefetch()` says a song is actually on its way. */
export class Analyzer {
  // (each `new URL(...)` has to be written out for the bundler to find the worker)
  private chordsWorker = new WorkerLink(() => new Worker(new URL("./analysis/chords.worker.ts", import.meta.url), { type: "module" }), "chords");
  /** one thread: less memory, and no helper workers that could fail to start */
  private singleWorker = new WorkerLink(() => new Worker(new URL("./analysis/chords.worker.ts", import.meta.url), { type: "module", name: "single" }), "chords-single");
  private notesWorker = new WorkerLink(() => new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module" }), "notes");
  private notesSingle = new WorkerLink(() => new Worker(new URL("./analysis/worker.ts", import.meta.url), { type: "module", name: "single" }), "notes-single");
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.chordsWorker.call({ type: "load" }).then(() => undefined);
  }

  /** Chords and beats of a whole song, in seconds. A worker that crashes or goes quiet for a minute is
   * replaced by a single-threaded one, and if that fails too the page works them out itself. */
  async chords(samples: Float32Array, onProgress?: (stage: Stage, p: number) => void): Promise<ChordPass> {
    const progress = (stage: Stage, p: number) => onProgress?.(stage, p);
    for (const link of [this.chordsWorker, this.singleWorker]) {
      try {
        const m = await link.call({ type: "chords", samples }, (m) => m.type === "progress" && progress(m.stage, m.p), 60_000);
        if (m.type !== "chords") throw new Error("Unexpected worker reply");
        return m;
      } catch (e) {
        logEvent("chords-retry", { worker: link === this.chordsWorker ? "chords" : "chords-single", error: String(e instanceof Error ? e.message : e).slice(0, 200) });
      }
    }
    const { chordEngine } = await import("./analysis/chord-engine");
    const pass = await chordEngine(1).chords(samples, progress);
    return { id: 0, type: "chords", ...pass };
  }

  /** The tab, with the chords decided again from its notes. `onPartial` gets the tab so far every few
   * seconds. The newest song's tab goes first; older ones pause (stage "paused") until it is done. */
  async tab(samples: Float32Array, pass: ChordPass, on: { progress?: (stage: Stage, p: number) => void; partial?: (notes: NoteRow[], upTo: number) => void } = {}): Promise<Analysis> {
    const onMsg = (m: WorkerMessage) => {
      if (m.type === "progress") on.progress?.(m.stage, m.p);
      else if (m.type === "partial") on.partial?.(m.notes, m.upTo);
    };
    const req = { type: "notes", samples, frames: pass.frames, rhythm: pass.rhythm } as const;
    let m: WorkerMessage;
    try {
      m = await this.notesWorker.call(req, onMsg);
    } catch (e) {
      // a crash gets one more try in a fresh single-threaded worker; a reported error is final
      if (!(e instanceof Error) || e.message !== CRASHED) throw e;
      m = await this.notesSingle.call(req, onMsg);
    }
    if (m.type !== "done") throw new Error("Unexpected worker reply");
    return m.result;
  }

  /** Chord class per CQT frame for the last <=10 s of audio, plus the frame hop in seconds. */
  async live(samples: Float32Array): Promise<{ frames: Int32Array; hop: number }> {
    const m = await this.chordsWorker.call({ type: "live", samples });
    if (m.type !== "live") throw new Error("Unexpected worker reply");
    return { frames: m.frames, hop: m.hop };
  }

  prefetch() {
    void this.notesWorker.call({ type: "prefetch" }).catch(() => {});
  }

  terminate() {
    for (const w of [this.chordsWorker, this.singleWorker, this.notesWorker, this.notesSingle]) w.terminate();
  }
}

let shared: Analyzer | null = null;
/** One analyzer for the whole visit: it keeps working on a song's tab after the page has moved on. */
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
