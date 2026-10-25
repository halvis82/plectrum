// Web Worker: runs chord analysis off the main thread. Stays alive between requests so the
// model loads once per capture session.
import * as ort from "onnxruntime-web/wasm";
import { analyze, type Analysis, type ModelMeta } from "./analyze";
import { FRAMES_PER_CHUNK, HOP, N_BINS, SR, logCqt, parseBasis, type CqtBasis } from "./cqt";
import { N_CLASSES, viterbi } from "./decode";

export type WorkerRequest =
  | { id: number; type: "load" }
  | { id: number; type: "analyze"; samples: Float32Array }
  /** up to 10 s of 22.05 kHz audio; returns one chord class per CQT frame */
  | { id: number; type: "live"; samples: Float32Array };

export type WorkerMessage =
  | { id: number; type: "progress"; stage: "model" | "features" | "chords" | "beats"; p: number }
  | { id: number; type: "done"; result: Analysis }
  | { id: number; type: "live"; frames: Int32Array; hop: number }
  | { id: number; type: "loaded" }
  | { id: number; type: "error"; message: string };

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = 1;

let loaded: Promise<{ session: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;

function load() {
  loaded ??= (async () => {
    const [model, basisBuf, meta] = await Promise.all([
      fetch("/model/btc170.v1.onnx").then((r) => r.arrayBuffer()),
      fetch("/model/cqt_basis.v1.bin").then((r) => r.arrayBuffer()),
      fetch("/model/btc170.v1.json").then((r) => r.json() as Promise<ModelMeta>),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    return { session, basis: parseBasis(basisBuf), meta };
  })();
  loaded.catch(() => (loaded = null));
  return loaded;
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
      await load();
      return post({ id: req.id, type: "loaded" });
    }
    post({ id: req.id, type: "progress", stage: "model", p: 0 });
    const { session, basis, meta } = await load();
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
    post({ id: req.id, type: "progress", stage: "model", p: 1 });
    const result = await analyze(req.samples, basis, meta, run, (stage, p) => post({ id: req.id, type: "progress", stage, p }));
    post({ id: req.id, type: "done", result });
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}
