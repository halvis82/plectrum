// Web Worker for chords and live listening: the small chord model on the plain WebAssembly runtime
// (half the download of the WebGPU-capable one the tab worker needs), so a song's chords can start as
// soon as possible. The tab runs in worker.ts.
import * as ort from "onnxruntime-web/wasm";
import { analyzeChords, type ModelMeta } from "./analyze";
import { FRAMES_PER_CHUNK, HOP, N_BINS, SR, logCqt, parseBasis, type CqtBasis } from "./cqt";
import { N_CLASSES, viterbi } from "./decode";
import { download, type WorkerMessage, type WorkerRequest } from "./worker-shared";
import { halfToFloat } from "./guitar";

// served from this site by scripts/copy-ort.mjs
ort.env.wasm.wasmPaths = `/ort/${ort.env.versions.web}/`;
// threads need cross-origin isolation (COOP/COEP headers, see next.config.ts)
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

let chords: Promise<{ session: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;
let ready = false;
/** download progress of the chord model, 0..1 */
let loaded = 0;

function loadChords() {
  chords ??= (async () => {
    // the weights ship as float16 (scripts/chords_half.py) and run as float32
    const [graph, half, basisBuf, meta] = await Promise.all([
      fetch("/model/btc170.v2.onnx").then((r) => r.arrayBuffer()),
      download("/model/btc170.v2.f16", (p) => (loaded = p)),
      fetch("/model/cqt_basis.v1.bin").then((r) => r.arrayBuffer()),
      fetch("/model/btc170.v1.json").then((r) => r.json() as Promise<ModelMeta>),
    ]);
    const weights = new Uint8Array(halfToFloat(new Uint16Array(half)).buffer);
    const session = await ort.InferenceSession.create(graph, { executionProviders: ["wasm"], externalData: [{ path: "btc170.v2.data", data: weights }] });
    ready = true;
    return { session, basis: parseBasis(basisBuf), meta };
  })();
  chords.catch(() => (chords = null));
  return chords;
}

const post = (m: WorkerMessage) => postMessage(m);

// one analysis at a time keeps live updates from piling up behind each other; loading is not queued
let queue = Promise.resolve();
onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "load") {
    loadChords().then(
      () => post({ id: req.id, type: "loaded" }),
      (err) => post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  queue = queue.then(() => handle(req)).catch(() => {});
};

async function handle(req: WorkerRequest) {
  try {
    if (req.type !== "chords" && req.type !== "live") throw new Error(`The chord worker can't do "${req.type}"`);
    // first time only: report the chord model's download while it comes in
    const loading = ready ? 0 : setInterval(() => post({ id: req.id, type: "progress", stage: "model", p: loaded }), 300);
    if (!ready) post({ id: req.id, type: "progress", stage: "model", p: loaded });
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
