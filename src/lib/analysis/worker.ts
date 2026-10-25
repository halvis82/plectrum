// Web Worker: runs the full chord analysis off the main thread.
import * as ort from "onnxruntime-web";
import { analyze, type ModelMeta } from "./analyze";
import { parseBasis, type CqtBasis } from "./cqt";

export type WorkerRequest = { type: "analyze"; samples: Float32Array };
export type WorkerMessage =
  | { type: "progress"; stage: "model" | "features" | "chords" | "beats"; p: number }
  | { type: "done"; result: Awaited<ReturnType<typeof analyze>> }
  | { type: "error"; message: string };

ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/`;
ort.env.wasm.numThreads = 1;

let loaded: Promise<{ session: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;

function load() {
  loaded ??= (async () => {
    const [model, basisBuf, meta] = await Promise.all([
      fetch("/model/btc170.onnx").then((r) => r.arrayBuffer()),
      fetch("/model/cqt_basis.bin").then((r) => r.arrayBuffer()),
      fetch("/model/btc170.json").then((r) => r.json() as Promise<ModelMeta>),
    ]);
    const session = await ort.InferenceSession.create(model, { executionProviders: ["wasm"] });
    return { session, basis: parseBasis(basisBuf), meta };
  })();
  return loaded;
}

const post = (m: WorkerMessage) => postMessage(m);

onmessage = async (e: MessageEvent<WorkerRequest>) => {
  try {
    post({ type: "progress", stage: "model", p: 0 });
    const { session, basis, meta } = await load();
    post({ type: "progress", stage: "model", p: 1 });
    const result = await analyze(e.data.samples, basis, meta, async (x) => {
      const out = await session.run({ x: new ort.Tensor("float32", x, [1, 108, 144]) });
      return out.logp.data as Float32Array;
    }, (stage, p) => post({ type: "progress", stage, p }));
    post({ type: "done", result });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
