// Web Worker for the analysis, run as two instances so a song's chords never wait behind another
// song's tab: one does chords and live listening (small model, seconds per song), the other the
// note-by-note tab (large model, on the GPU via WebGPU when there is one), one song at a time.
// Both stay alive between requests so models load once per visit.
// the "all" build: the WebGPU-only bundle (onnxruntime-web 1.30) ran the guitar model 7x slower
import * as ort from "onnxruntime-web/all";
import { analyzeChords, noteRows, withNotes, type Analysis, type ChordFrames, type ModelMeta, type NoteRow, type Rhythm } from "./analyze";
import { FRAMES_PER_CHUNK, HOP, N_BINS, SR, logCqt, parseBasis, type CqtBasis } from "./cqt";
import { N_CLASSES, viterbi } from "./decode";
import { CANDIDATE_ONSET, DEFAULT_GUITAR_NOTES, GUITAR_SR, SEGMENT, decodeGuitarNotes, guitarActivations, halfToFloat, resampleTo, type GuitarActivations } from "./guitar";
import type { Note } from "./notes";
import { NB, NF, stringProbs } from "./strings";

export type WorkerRequest =
  | { id: number; type: "load" }
  /** start downloading the note models */
  | { id: number; type: "prefetch" }
  /** chords and beats of a whole song (22.05 kHz mono) */
  | { id: number; type: "chords"; samples: Float32Array }
  /** the tab: notes, their strings, and the chords decided again with them */
  | { id: number; type: "notes"; samples: Float32Array; frames: ChordFrames; rhythm: Rhythm }
  /** up to 10 s of 22.05 kHz audio; returns one chord class per CQT frame */
  | { id: number; type: "live"; samples: Float32Array };

export type WorkerMessage =
  | { id: number; type: "progress"; stage: "model" | "features" | "chords" | "beats" | "notes" | "paused"; p: number }
  | { id: number; type: "chords"; result: Analysis; frames: ChordFrames; rhythm: Rhythm }
  /** the tab so far: notes starting before `upTo` seconds */
  | { id: number; type: "partial"; notes: NoteRow[]; upTo: number }
  | { id: number; type: "done"; result: Analysis }
  | { id: number; type: "live"; frames: Int32Array; hop: number }
  | { id: number; type: "loaded" }
  | { id: number; type: "error"; message: string };

// served from this site by scripts/copy-ort.mjs
ort.env.wasm.wasmPaths = `/ort/${ort.env.versions.web}/`;
// threads need cross-origin isolation (COOP/COEP headers, see next.config.ts)
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const GUITAR_MODEL = "/model/guitar.v1.onnx";
const GUITAR_WEIGHTS = "/model/guitar.v1.f16";


let chords: Promise<{ session: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;
let chordsReady = false;
/** download progress of the chord model, 0..1 */
let chordsLoaded = 0;
let guitar: Promise<{ notes: ort.InferenceSession; strings: ort.InferenceSession }> | null = null;
/** download progress of the note model's weights, 0..1 */
let guitarLoaded = 0;
let guitarReady = false;


function loadChords() {
  chords ??= (async () => {
    const [model, basisBuf, meta] = await Promise.all([
      download("/model/btc170.v1.onnx", (p) => (chordsLoaded = p)),
      fetch("/model/cqt_basis.v1.bin").then((r) => r.arrayBuffer()),
      fetch("/model/btc170.v1.json").then((r) => r.json() as Promise<ModelMeta>),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    chordsReady = true;
    return { session, basis: parseBasis(basisBuf), meta };
  })();
  chords.catch(() => (chords = null));
  return chords;
}

function loadGuitar() {
  guitar ??= (async () => {
    const [graph, half, stringsModel] = await Promise.all([
      fetch(GUITAR_MODEL).then((r) => r.arrayBuffer()),
      download(GUITAR_WEIGHTS, (p) => (guitarLoaded = p)),
      fetch("/model/strings.v2.onnx").then((r) => r.arrayBuffer()),
    ]);
    const strings = await ort.InferenceSession.create(stringsModel, { executionProviders: ["wasm"] });
    // weights ship as float16 and run as float32
    const weights = new Uint8Array(halfToFloat(new Uint16Array(half)).buffer);
    const externalData = [{ path: "guitar.data", data: weights }];
    if ("gpu" in navigator) {
      try {
        return { notes: await ort.InferenceSession.create(graph, { executionProviders: ["webgpu"], externalData }), strings };
      } catch {}
    }
    return { notes: await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], externalData }), strings };
  })();
  guitar.catch(() => (guitar = null));
  return guitar;
}

async function download(url: string, onProgress: (p: number) => void): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Couldn't load ${url} (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  const out = new Uint8Array(total || 50_000_000);
  let buf = out;
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (got + value.length > buf.length) {
      const bigger = new Uint8Array(Math.max(buf.length * 2, got + value.length));
      bigger.set(buf.subarray(0, got));
      buf = bigger;
    }
    buf.set(value, got);
    got += value.length;
    if (total) onProgress(got / total);
  }
  onProgress(1);
  return buf.buffer.slice(0, got);
}

const post = (m: WorkerMessage) => postMessage(m);

// one request at a time keeps live updates from piling up behind each other
let queue = Promise.resolve();

onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  // tabs share the note model by taking turns (see `turn`), so they don't wait in the queue
  if (req.type === "notes") void handle(req);
  else queue = queue.then(() => handle(req)).catch(() => {});
};

// Tabs being made, oldest first. The newest one (the song on screen) gets the note model; older
// ones pause between segments until it is done.
const tabs: number[] = [];
let wakers: (() => void)[] = [];
function tabsChanged() {
  const w = wakers;
  wakers = [];
  w.forEach((f) => f());
}
async function turn(id: number) {
  // the model calls chain through microtasks; a macrotask break lets a new song's request in
  await new Promise((r) => setTimeout(r, 0));
  while (tabs.at(-1) !== id) {
    post({ id, type: "progress", stage: "paused", p: 0 });
    await new Promise<void>((r) => wakers.push(r));
  }
}

async function handle(req: WorkerRequest) {
  try {
    if (req.type === "load") {
      await loadChords();
      return post({ id: req.id, type: "loaded" });
    }
    if (req.type === "prefetch") {
      // the big download runs in the background
      void loadGuitar().catch(() => {});
      return post({ id: req.id, type: "loaded" });
    }
    if (req.type === "notes") return await notes(req);
    // first time only: report the chord model's download while it comes in
    const loading = chordsReady ? 0 : setInterval(() => post({ id: req.id, type: "progress", stage: "model", p: chordsLoaded }), 400);
    if (!chordsReady) post({ id: req.id, type: "progress", stage: "model", p: chordsLoaded });
    const { session, basis, meta } = await loadChords().finally(() => clearInterval(loading));
    const run = async (x: Float32Array) => {
      const out = await session.run({ x: new ort.Tensor("float32", x, [1, FRAMES_PER_CHUNK, N_BINS]) });
      return out.logp.data as Float32Array;
    };
    if (req.type === "live") {
      const { data, frames } = logCqt(req.samples.subarray(-SR * 10), basis);
      const x = new Float32Array(FRAMES_PER_CHUNK * N_BINS);
      const n = Math.min(frames, FRAMES_PER_CHUNK);
      for (let i = 0; i < n * N_BINS; i++) x[i] = (data[i] - meta.mean) / meta.std;
      const logp = (await run(x)).subarray(0, n * N_CLASSES);
      return post({ id: req.id, type: "live", frames: viterbi(logp, n, N_CLASSES, 4), hop: HOP / SR });
    }
    const pass = await analyzeChords(req.samples, basis, meta, run, (stage, p) => post({ id: req.id, type: "progress", stage, p }));
    post({ id: req.id, type: "chords", result: pass.result, frames: pass.frames, rhythm: pass.rhythm });
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

/** seconds between tab updates while the notes come in */
const PARTIAL_EVERY = 2.5;

async function notes(req: Extract<WorkerRequest, { type: "notes" }>) {
  tabs.push(req.id);
  tabsChanged();
  try {
    await tab(req);
  } finally {
    tabs.splice(tabs.indexOf(req.id), 1);
    tabsChanged();
  }
}

async function tab(req: Extract<WorkerRequest, { type: "notes" }>) {
  const y = req.samples;
  // first time only: the note model may still be downloading
  const loading = guitarReady ? 0 : setInterval(() => post({ id: req.id, type: "progress", stage: "model", p: guitarLoaded }), 250);
  const models = await loadGuitar().finally(() => clearInterval(loading));
  guitarReady = true;
  const runGuitar = async (x: Float32Array, n: number) => {
    await turn(req.id);
    const out = await models.notes.run({ audio: new ort.Tensor("float32", x, [n, SEGMENT]) });
    return { onset: out.onset.data as Float32Array, offset: out.offset.data as Float32Array, frame: out.frame.data as Float32Array, velocity: out.velocity.data as Float32Array };
  };
  const runStrings = async (patches: Float32Array, midi: Float32Array, n: number) => {
    const out = await models.strings.run({ patch: new ort.Tensor("float32", patches, [n, NF, NB]), midi: new ort.Tensor("float32", midi, [n]) });
    return out.logits.data as Float32Array;
  };
  // string probabilities are kept per note, so each update only works out the new ones
  const known = new Map<string, Float32Array>();
  const probsFor = async (ns: Note[]) => {
    const fresh = ns.filter((n) => !known.has(`${n.start}:${n.midi}`));
    const p = await stringProbs(y, fresh, runStrings);
    fresh.forEach((n, i) => known.set(`${n.start}:${n.midi}`, p.subarray(i * 6, i * 6 + 6)));
    const out = new Float32Array(ns.length * 6);
    ns.forEach((n, i) => out.set(known.get(`${n.start}:${n.midi}`)!, i * 6));
    return out;
  };
  // every note down to the candidate threshold, each with its onset confidence (the page shows as many
  // as its slider asks for)
  const heard = async (a: GuitarActivations, upTo = Infinity) => {
    const notes = decodeGuitarNotes(a, { ...DEFAULT_GUITAR_NOTES, onset: CANDIDATE_ONSET }).filter((n) => n.start < upTo);
    return { notes, probs: await probsFor(notes) };
  };
  let last = performance.now();
  const acts = await guitarActivations(resampleTo(y, SR, GUITAR_SR), runGuitar, async (p, sofar) => {
    post({ id: req.id, type: "progress", stage: "notes", p });
    if (p >= 1 || performance.now() - last < PARTIAL_EVERY * 1000) return;
    last = performance.now();
    // notes near the edge may still be ringing on, so the update stops a second short of it
    const upTo = sofar.frames / 100 - 1;
    const h = await heard(sofar, upTo);
    post({ id: req.id, type: "partial", notes: noteRows(h.notes, h.probs), upTo });
  });
  const h = await heard(acts);
  post({ id: req.id, type: "done", result: withNotes({ frames: req.frames, rhythm: req.rhythm, duration: y.length / SR }, h.notes, h.probs) });
}
