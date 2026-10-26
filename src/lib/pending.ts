"use client";
// Tabs still being worked out for songs that were just saved with their chords. The analysis
// worker keeps going after the page moves on to the song, so the song page picks up the progress
// here and the finished notes are saved to the song.

import { useSyncExternalStore } from "react";
import type { Analysis } from "./analysis/analyze";

/** `analysis`: the finished one, notes and the chords decided with them */
export type PendingNotes = { label: string; p: number | undefined; analysis?: Analysis; error?: string };

const jobs = new Map<string, PendingNotes>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setPending(id: string, patch: Partial<PendingNotes>) {
  jobs.set(id, { label: "Catching every note", p: undefined, ...jobs.get(id), ...patch });
  emit();
}

// closing the page would lose a tab that's still being worked out, so the browser asks first
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (e) => {
    if ([...jobs.values()].some((j) => !j.analysis && !j.error)) e.preventDefault();
  });

export function usePendingNotes(id: string): PendingNotes | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => jobs.get(id) ?? null,
    () => null,
  );
}
