// Transcribes speech and singing with Whisper (base, multilingual; transformers.js) and word times, for
// songs and lessons whose words aren't in a lyrics database. Runs on WebGPU when there is one.
import { env, pipeline, type AutomaticSpeechRecognitionPipeline } from "@huggingface/transformers";
import type { CaptionLine } from "./captions";

export type WhisperRequest = { samples: Float32Array };
export type WhisperMessage =
  | { type: "progress"; stage: "model" | "words"; p: number }
  | { type: "done"; lines: CaptionLine[]; lang: string | null }
  | { type: "error"; message: string };

env.allowLocalModels = false;
// its runtime is served from this site like the app's own (scripts/copy-ort.mjs)
const onnx = env.backends.onnx as { versions?: { web?: string }; wasm?: { wasmPaths?: string } };
if (onnx.wasm && onnx.versions?.web) onnx.wasm.wasmPaths = `/ort/${onnx.versions.web}/`;

const MODEL = "onnx-community/whisper-base_timestamped";
const SR = 16000;
const WINDOW = 28; // seconds per call (Whisper hears 30)
const STEP = 26;

let asr: Promise<AutomaticSpeechRecognitionPipeline> | null = null;
const post = (m: WhisperMessage) => postMessage(m);

function load() {
  asr ??= (async () => {
    const files = new Map<string, number>();
    const progress_callback = (e: { status: string; file?: string; progress?: number }) => {
      if (e.status === "progress" && e.file) {
        files.set(e.file, (e.progress ?? 0) / 100);
        const ps = [...files.values()];
        post({ type: "progress", stage: "model", p: ps.reduce((a, b) => a + b, 0) / Math.max(3, ps.length) });
      }
    };
    const gpu = "gpu" in navigator && !!(await (navigator as unknown as { gpu: { requestAdapter: () => Promise<unknown> } }).gpu.requestAdapter().catch(() => null));
    // (pipeline's own overloads are too many for TypeScript to resolve here)
    const make = pipeline as unknown as (task: string, model: string, o: object) => Promise<AutomaticSpeechRecognitionPipeline>;
    return (await make("automatic-speech-recognition", MODEL, {
      device: gpu ? "webgpu" : "wasm",
      dtype: gpu ? { encoder_model: "fp32", decoder_model_merged: "fp32" } : { encoder_model: "q8", decoder_model_merged: "q8" },
      progress_callback,
    }));
  })();
  asr.catch(() => (asr = null));
  return asr;
}

/** what Whisper says over music without words */
const NOISE = /^[\s♪♫.,!?¡¿\-–—]*$|^\s*[\[(].*[\])]\s*$|^\s*(thank you|thanks for watching|subtitles by.*|subtítulos.*|gracias)[.!]*\s*$/i;

onmessage = async (e: MessageEvent<WhisperRequest>) => {
  try {
    const y = e.data.samples;
    const pipe = await load();
    post({ type: "progress", stage: "words", p: 0 });
    const words: { t: number; end: number; text: string }[] = [];
    let lang: string | null = null;
    const n = Math.max(1, Math.ceil((y.length / SR - (WINDOW - STEP)) / STEP));
    for (let k = 0; k < n; k++) {
      const from = k * STEP;
      const chunk = y.subarray(from * SR, Math.min(y.length, (from + WINDOW) * SR));
      // quiet stretches have no words; skip the model there
      let energy = 0;
      for (let i = 0; i < chunk.length; i += 16) energy += chunk[i] * chunk[i];
      if (chunk.length < SR || energy / (chunk.length / 16) < 1e-6) continue;
      const out = (await pipe(chunk, { return_timestamps: "word", task: "transcribe" } as Parameters<AutomaticSpeechRecognitionPipeline>[1])) as {
        text: string;
        chunks?: { text: string; timestamp: [number, number | null] }[];
        language?: string;
      };
      lang ??= out.language ?? null;
      if (!out.chunks || NOISE.test(out.text)) continue;
      // overlapping windows: each keeps the words that start in its own share
      const keepFrom = k === 0 ? 0 : (WINDOW - STEP) / 2;
      const keepTo = k === n - 1 ? Infinity : STEP + (WINDOW - STEP) / 2;
      for (const c of out.chunks) {
        const [a, b] = c.timestamp;
        if (a < keepFrom || a >= keepTo || NOISE.test(c.text)) continue;
        words.push({ t: from + a, end: from + (b ?? a + 0.3), text: c.text.trim() });
      }
      post({ type: "progress", stage: "words", p: (k + 1) / n });
    }
    post({ type: "done", lines: toLines(words), lang });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};

/** Words into caption lines: a new line after a pause, at the end of a sentence, or after 10 words. */
function toLines(words: { t: number; end: number; text: string }[]): CaptionLine[] {
  const lines: CaptionLine[] = [];
  let cur: { t: number; end: number; words: string[] } | null = null;
  for (const w of words) {
    if (cur && (w.t - cur.end > 0.8 || cur.words.length >= 10 || /[.!?]$/.test(cur.words.at(-1) ?? ""))) {
      lines.push({ t: cur.t, end: cur.end, text: cur.words.join(" ") });
      cur = null;
    }
    cur ??= { t: w.t, end: w.end, words: [] };
    cur.words.push(w.text);
    cur.end = w.end;
  }
  if (cur) lines.push({ t: cur.t, end: cur.end, text: cur.words.join(" ") });
  // the same short phrase over and over is Whisper stuck on a loop
  return lines.filter((l, i) => !(i >= 2 && l.text === lines[i - 1].text && l.text === lines[i - 2].text));
}
