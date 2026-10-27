// Web Worker for chords and live listening: the small chord model on the plain WebAssembly runtime
// (half the download of the WebGPU-capable one the tab worker needs), so a song's chords can start as
// soon as possible. The tab runs in worker.ts. Started with the name "single", it uses one thread.
import { chordEngine } from "./chord-engine";
import type { WorkerMessage, WorkerRequest } from "./worker-shared";

const engine = chordEngine(self.name === "single" ? 1 : 4);
const post = (m: WorkerMessage) => postMessage(m);

// one analysis at a time keeps live updates from piling up behind each other; loading is not queued
let queue = Promise.resolve();
onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  if (req.type === "load") {
    engine.load().then(
      () => post({ id: req.id, type: "loaded" }),
      (err) => post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  queue = queue.then(() => handle(req)).catch(() => {});
};

async function handle(req: WorkerRequest) {
  try {
    if (req.type === "live") return post({ id: req.id, type: "live", ...(await engine.live(req.samples)) });
    if (req.type !== "chords") throw new Error(`The chord worker can't do "${req.type}"`);
    const pass = await engine.chords(req.samples, (stage, p) => post({ id: req.id, type: "progress", stage, p }));
    post({ id: req.id, type: "chords", result: pass.result, frames: pass.frames, rhythm: pass.rhythm });
  } catch (err) {
    post({ id: req.id, type: "error", message: err instanceof Error ? err.message : String(err) });
  }
}

// the page knows the worker started (an error before this means it never could)
post({ id: 0, type: "loaded" });
