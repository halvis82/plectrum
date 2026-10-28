"use client";
// A song's edits with undo/redo, saved to the server shortly after each change.

import { useCallback, useEffect, useRef, useState } from "react";
import { ownerHeaders } from "./access";
import type { Edits } from "./edits";

export type SaveState = "saved" | "saving" | "unsaved" | "error";

export function useEdits(songId: string, initial: Edits | null) {
  const [edits, setEdits] = useState<Edits | null>(initial);
  const past = useRef<(Edits | null)[]>([]);
  const future = useRef<(Edits | null)[]>([]);
  const [save, setSave] = useState<SaveState>("saved");
  const timer = useRef(0);
  const latest = useRef(edits);
  const [history, setHistory] = useState({ undo: 0, redo: 0 });

  const persist = useCallback(
    async (e: Edits | null) => {
      setSave("saving");
      try {
        const r = await fetch(`/api/songs/${songId}/edits`, { method: "PUT", headers: { "content-type": "application/json", ...ownerHeaders(songId) }, body: JSON.stringify(e), keepalive: JSON.stringify(e).length < 60000 });
        // a newer change is already waiting: its save will report
        if (latest.current !== e) return;
        setSave(r.ok ? "saved" : "error");
      } catch {
        if (latest.current === e) setSave("error");
      }
    },
    [songId],
  );

  const schedule = useCallback(
    (e: Edits | null) => {
      latest.current = e;
      setSave("unsaved");
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void persist(e), 700);
    },
    [persist],
  );

  // the current edits, read synchronously so a change never runs inside a state updater
  const cur = useRef(edits);
  /** edits shown but not saved (see `seed`), and what was saved before them */
  const seeded = useRef<{ from: Edits | null; to: Edits } | null>(null);
  const commit = useCallback(
    (next: Edits | null) => {
      cur.current = next;
      setEdits(next);
      // undoing back to the seed saves what was there before it
      schedule(seeded.current && next === seeded.current.to ? seeded.current.from : next);
      setHistory({ undo: past.current.length, redo: future.current.length });
    },
    [schedule],
  );

  /** Applies a change (one undo step). `merge` folds it into the previous step (a drag in progress). */
  const change = useCallback(
    (fn: (e: Edits) => Edits | null, merge = false) => {
      const before = cur.current;
      const next = fn(before ?? { v: 1 });
      if (!merge) {
        past.current.push(before);
        if (past.current.length > 200) past.current.shift();
        future.current = [];
      }
      commit(next);
    },
    [commit],
  );

  /** Shows `e` without saving it: it is saved with the first change made to it, and `unseed` drops it
   * again if none was. Opening the editor and leaving changes nothing for anyone. */
  const seed = useCallback((e: Edits) => {
    seeded.current = { from: cur.current, to: e };
    cur.current = e;
    setEdits(e);
  }, []);
  const unseed = useCallback(() => {
    if (seeded.current && cur.current === seeded.current.to) {
      cur.current = seeded.current.from;
      setEdits(seeded.current.from);
    }
    seeded.current = null;
  }, []);

  const undo = useCallback(() => {
    if (!past.current.length) return;
    future.current.push(cur.current);
    commit(past.current.pop()!);
  }, [commit]);

  const redo = useCallback(() => {
    if (!future.current.length) return;
    past.current.push(cur.current);
    commit(future.current.pop()!);
  }, [commit]);

  // leaving with a save still waiting: send it now
  useEffect(() => {
    const flush = () => {
      if (save === "unsaved") {
        clearTimeout(timer.current);
        void persist(latest.current);
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
    };
  }, [save, persist]);

  return { edits, change, seed, unseed, undo, redo, canUndo: history.undo > 0, canRedo: history.redo > 0, save, retry: () => void persist(latest.current) };
}
