// Web Worker: runs the analysis off the main thread. Stays alive between requests so models load
// once per session. The chord model loads first (live listening needs only it); the guitar note
// model is large, so it downloads in the background and runs on the GPU (WebGPU) when there is one.
// the "all" build: the WebGPU-only bundle (onnxruntime-web 1.30) ran the guitar model 7x slower
import * as ort from "onnxruntime-web/all";
import { analyze, type Analysis, type ModelMeta } from "./analyze";
import { FRAMES_PER_CHUNK, HOP, N_BINS, SR, logCqt, parseBasis, type CqtBasis } from "./cqt";
import { N_CLASSES, viterbi } from "./decode";
import { GUITAR_SR, SEGMENT, decodeGuitarNotes, guitarActivations, halfToFloat, resampleTo } from "./guitar";
import { NB, NF } from "./strings";

export type WorkerRequest =
  | { id: number; type: "load" }
  /** start downloading the note model */
  | { id: number; type: "prefetch" }
  | { id: number; type: "analyze"; samples: Float32Array }
  /** up to 10 s of 22.05 kHz audio; returns one chord class per CQT frame */
  | { id: number; type: "live"; samples: Float32Array };

export type WorkerMessage =
  | { id: number; type: "progress"; stage: "model" | "features" | "chords" | "beats" | "notes"; p: number }
  | { id: number; type: "done"; result: Analysis }
  | { id: number; type: "live"; frames: Int32Array; hop: number }
  | { id: number; type: "loaded" }
  | { id: number; type: "error"; message: string };

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
// threads need cross-origin isolation (COOP/COEP headers, see next.config.ts)
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const GUITAR_MODEL = "/model/guitar.v1.onnx";
const GUITAR_WEIGHTS = "/model/guitar.v1.f16";

let chords: Promise<{ session: ort.InferenceSession; strings: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;
let guitar: Promise<ort.InferenceSession> | null = null;
/** download progress of the note model's weights, 0..1 */
let guitarLoaded = 0;

function loadChords() {
  chords ??= (async () => {
    const [model, stringsModel, basisBuf, meta] = await Promise.all([
      fetch("/model/btc170.v1.onnx").then((r) => r.arrayBuffer()),
      fetch("/model/strings.v1.onnx").then((r) => r.arrayBuffer()),
      fetch("/model/cqt_basis.v1.bin").then((r) => r.arrayBuffer()),
      fetch("/model/btc170.v1.json").then((r) => r.json() as Promise<ModelMeta>),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    const strings = await ort.InferenceSession.create(stringsModel, { executionProviders: ["wasm"] });
    return { session, strings, basis: parseBasis(basisBuf), meta };
  })();
  chords.catch(() => (chords = null));
  return chords;
}

function loadGuitar() {
  guitar ??= (async () => {
    const [graph, half] = await Promise.all([fetch(GUITAR_MODEL).then((r) => r.arrayBuffer()), download(GUITAR_WEIGHTS, (p) => (guitarLoaded = p))]);
    // weights ship as float16 and run as float32
    const weights = new Uint8Array(halfToFloat(new Uint16Array(half)).buffer);
    const externalData = [{ path: "guitar.data", data: weights }];
    if ("gpu" in navigator) {
      try {
        return await ort.InferenceSession.create(graph, { executionProviders: ["webgpu"], externalData });
      } catch {}
    }
    return await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], externalData });
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
  queue = queue.then(() => handle(req)).catch(() => {});
};

async function handle(req: WorkerRequest) {
  try {
    if (req.type === "load") {
      await loadChords();
      return post({ id: req.id, type: "loaded" });
    }
    if (req.type === "prefetch") {
      // the big download runs in the background without holding up live chords
      void loadGuitar().catch(() => {});
      return post({ id: req.id, type: "loaded" });
    }
    post({ id: req.id, type: "progress", stage: "model", p: 0 });
    const { session, strings, basis, meta } = await loadChords();
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
    // first time only: the note model may still be downloading
    const loading = setInterval(() => post({ id: req.id, type: "progress", stage: "model", p: guitarLoaded }), 250);
    const notes = await loadGuitar().finally(() => clearInterval(loading));
    post({ id: req.id, type: "progress", stage: "model", p: 1 });
    const transcribe = async (y: Float32Array, onProgress: (p: number) => void) => {
      const runGuitar = async (x: Float32Array, n: number) => {
        const out = await notes.run({ audio: new ort.Tensor("float32", x, [n, SEGMENT]) });
        return {
          onset: out.onset.data as Float32Array,
          offset: out.offset.data as Float32Array,
          frame: out.frame.data as Float32Array,
          velocity: out.velocity.data as Float32Array,
        };
      };
      return decodeGuitarNotes(await guitarActivations(resampleTo(y, SR, GUITAR_SR), runGuitar, onProgress));
    };
    const runStrings = async (patches: Float32Array, midi: Float32Array, n: number) => {
      const out = await strings.run({ patch: new ort.Tensor("float32", patches, [n, NF, NB]), midi: new ort.Tensor("float32", midi, [n]) });
      return out.logits.data as Float32Array;
    };
    const result = await analyze(req.samples, basis, meta, run, (stage, p) => post({ id: req.id, type: "progress", stage, p }), undefined, transcribe, runStrings);
    post({ id: req.id, type: "done", result });
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
