// What the analysis workers (chords.worker.ts, worker.ts) and the page say to each other.
import type { Analysis, ChordFrames, NoteRow, Rhythm } from "./analyze";

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

/** Fetches a file with progress (0..1) as it arrives. Model files come down at low network priority,
 * so the page and the song's own audio never wait behind them. */
export async function download(url: string, onProgress: (p: number) => void, priority: RequestPriority = "auto"): Promise<ArrayBuffer> {
  const res = await fetch(url, { priority });
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

