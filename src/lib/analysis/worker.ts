// Web Worker for the note-by-note tab (see notes-engine.ts). Chords and live listening run in
// chords.worker.ts. It stays alive between requests so the models load once per visit. Started with the
// name "single" (the retry after a crash), it uses one thread, which needs the least memory.
import { notesEngine } from "./notes-engine";
import type { WorkerMessage, WorkerRequest } from "./worker-shared";

export type { WorkerMessage, WorkerRequest } from "./worker-shared";

const handle = notesEngine(self.name === "single" ? 1 : 4, (m) => postMessage(m));
onmessage = (e: MessageEvent<WorkerRequest>) => handle(e.data);

// the page knows the worker started (an error before this means it never could)
postMessage({ id: 0, type: "loaded" } satisfies WorkerMessage);
