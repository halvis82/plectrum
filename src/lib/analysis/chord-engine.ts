// The chord model on the plain WebAssembly runtime, used by chords.worker.ts and, when a worker can't
// run at all, by the page itself (see Analyzer in audio.ts).
import * as ort from "onnxruntime-web/wasm";
import { analyzeChords, type ModelMeta } from "./analyze";
import { FRAMES_PER_CHUNK, HOP, N_BINS, SR, logCqt, parseBasis, type CqtBasis } from "./cqt";
import { N_CLASSES, viterbi } from "./decode";
import { download, type WorkerMessage } from "./worker-shared";
import { halfToFloat } from "./guitar";

type Stage = Extract<WorkerMessage, { type: "progress" }>["stage"];

/** `threads`: 1 needs the least memory and no helper workers. */
export function chordEngine(threads: number) {
  // served from this site by scripts/copy-ort.mjs
  ort.env.wasm.wasmPaths = `/ort/${ort.env.versions.web}/`;
  // threads need cross-origin isolation (COOP/COEP headers, see next.config.ts)
  ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.max(1, Math.min(threads, navigator.hardwareConcurrency || 1)) : 1;
  ort.env.wasm.proxy = false;

  let model: Promise<{ session: ort.InferenceSession; basis: CqtBasis; meta: ModelMeta }> | null = null;
  let ready = false;
  /** download progress of the chord model, 0..1 */
  let loaded = 0;

  function load() {
    model ??= (async () => {
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
    model.catch(() => (model = null));
    return model;
  }

  /** The model, reporting its download while it comes in (the first time only). */
  async function withProgress(onProgress: (stage: Stage, p: number) => void) {
    if (ready) return load();
    const timer = setInterval(() => onProgress("model", loaded), 300);
    onProgress("model", loaded);
    return load().finally(() => clearInterval(timer));
  }

  const runner = (session: ort.InferenceSession) => async (x: Float32Array) => {
    const out = await session.run({ x: new ort.Tensor("float32", x, [1, FRAMES_PER_CHUNK, N_BINS]) });
    return out.logp.data as Float32Array;
  };

  return {
    load,
    /** chords and beats of a whole song (22.05 kHz mono) */
    async chords(samples: Float32Array, onProgress: (stage: Stage, p: number) => void) {
      const { session, basis, meta } = await withProgress(onProgress);
      return analyzeChords(samples, basis, meta, runner(session), onProgress);
    },
    /** one chord class per CQT frame for the last <=10 s */
    async live(samples: Float32Array) {
      const { session, basis, meta } = await load();
      const { data, frames } = logCqt(samples.subarray(-SR * 10), basis);
      const x = new Float32Array(FRAMES_PER_CHUNK * N_BINS);
      const n = Math.min(frames, FRAMES_PER_CHUNK);
      for (let i = 0; i < n * N_BINS; i++) x[i] = (data[i] - meta.mean) / meta.std;
      const logp = (await runner(session)(x)).subarray(0, n * N_CLASSES);
      return { frames: viterbi(logp, n, N_CLASSES, 4), hop: HOP / SR };
    },
  };
}
