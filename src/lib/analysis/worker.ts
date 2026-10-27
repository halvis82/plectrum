// Web Worker for the note-by-note tab (large model, on the GPU via WebGPU when there is one), one song
// at a time. Chords and live listening run in chords.worker.ts. It stays alive between requests so the
// models load once per visit.
// the "all" build: the WebGPU-only bundle (onnxruntime-web 1.30) ran the guitar model 7x slower
import * as ort from "onnxruntime-web/all";
import { noteRows, withNotes } from "./analyze";
import { SR } from "./cqt";
import { CANDIDATE_ONSET, DEFAULT_GUITAR_NOTES, GUITAR_SR, SEGMENT, decodeGuitarNotes, guitarActivations, halfToFloat, resampleTo, type GuitarActivations } from "./guitar";
import type { Note } from "./notes";
import { NB, NF, stringProbs } from "./strings";

import { download, type WorkerMessage, type WorkerRequest } from "./worker-shared";

export type { WorkerMessage, WorkerRequest } from "./worker-shared";

// served from this site by scripts/copy-ort.mjs
ort.env.wasm.wasmPaths = `/ort/${ort.env.versions.web}/`;
// threads need cross-origin isolation (COOP/COEP headers, see next.config.ts)
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const GUITAR_MODEL = "/model/guitar.v1.onnx";
const GUITAR_WEIGHTS = "/model/guitar.v1.f16";


let guitar: Promise<{ notes: ort.InferenceSession; strings: ort.InferenceSession }> | null = null;
/** download progress of the note model's weights, 0..1 */
let guitarLoaded = 0;
let guitarReady = false;


function loadGuitar() {
  guitar ??= (async () => {
    // all at low priority (see download); the runtime's own 28 MB file too, fetched here first so that
    // when onnxruntime asks for it, it comes from the cache
    const runtime = fetch(`${ort.env.wasm.wasmPaths}ort-wasm-simd-threaded.jsep.wasm`, { priority: "low" }).then((r) => r.arrayBuffer()).catch(() => null);
    const [graph, half, stringsModel] = await Promise.all([
      fetch(GUITAR_MODEL, { priority: "low" }).then((r) => r.arrayBuffer()),
      download(GUITAR_WEIGHTS, (p) => (guitarLoaded = p), "low"),
      fetch("/model/strings.v2.onnx", { priority: "low" }).then((r) => r.arrayBuffer()),
    ]);
    await runtime;
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

const post = (m: WorkerMessage) => postMessage(m);

onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "prefetch") {
    // the big download runs in the background
    void loadGuitar().catch(() => {});
    return post({ id: req.id, type: "loaded" });
  }
  // tabs share the note model by taking turns (see `turn`)
  if (req.type === "notes") void notes(req).catch((err) => post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) }));
  else post({ id: req.id, type: "error", message: `The tab worker can't do "${req.type}"` });
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
