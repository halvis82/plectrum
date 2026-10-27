"use client";

import { useEffect, useRef } from "react";
import { MAX_FRET, TECHNIQUES, type Technique } from "@/lib/edits";
import type { SaveState } from "@/lib/useEdits";
import type { SheetNote } from "./TabSheet";

const TECH_LABEL = ["None", "Hammer-on", "Pull-off", "Slide", "Bend"];

export type NoteActions = {
  setFret: (f: number) => void;
  moveString: (delta: number) => void;
  nudge: (dir: number) => void;
  lengthen: (dir: number) => void;
  setTech: (t: Technique) => void;
  remove: () => void;
  hear: () => void;
};

/** Editing controls above the player: for the selected note, or how-to and undo when none is. */
export function EditToolbar({
  note,
  stringName,
  actions,
  undo,
  redo,
  canUndo,
  canRedo,
  save,
  retry,
  snap,
  setSnap,
  done,
  deselect,
  empty,
}: {
  note: SheetNote | null;
  stringName: string;
  actions: NoteActions;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  save: SaveState;
  retry: () => void;
  snap: number;
  setSnap: (n: number) => void;
  done: () => void;
  deselect: () => void;
  /** no notes yet: show how to start */
  empty: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  // keep the chosen fret in view
  useEffect(() => {
    const el = strip.current?.querySelector<HTMLElement>("[data-on]");
    el?.scrollIntoView({ block: "nearest", inline: "center", behavior: "smooth" });
  }, [note?.fret, note?.id]);

  // keyboard: digits type a fret, arrows move, delete removes, h/p/s/b set the technique
  const typed = useRef<{ v: string; at: number }>({ v: "", at: 0 });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (/INPUT|TEXTAREA|SELECT/.test(el.tagName)) return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        return e.shiftKey ? redo() : undo();
      }
      if (!note) return;
      if (/^\d$/.test(e.key)) {
        const now = Date.now();
        const v = now - typed.current.at < 700 ? typed.current.v + e.key : e.key;
        typed.current = { v: Number(v) <= MAX_FRET ? v : e.key, at: now };
        actions.setFret(Number(typed.current.v));
      } else if (e.key === "ArrowLeft") actions.nudge(-1);
      else if (e.key === "ArrowRight") actions.nudge(1);
      else if (e.key === "ArrowUp") actions.moveString(1);
      else if (e.key === "ArrowDown") actions.moveString(-1);
      else if (e.key === "Delete" || e.key === "Backspace") actions.remove();
      else if (e.key === "Escape") deselect();
      else if (e.key === "h") actions.setTech(note.tech === 1 ? 0 : 1);
      else if (e.key === "p") actions.setTech(note.tech === 2 ? 0 : 2);
      else if (e.key === "s") actions.setTech(note.tech === 3 ? 0 : 3);
      else if (e.key === "b") actions.setTech(note.tech === 4 ? 0 : 4);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [note, actions, undo, redo, deselect]);

  return (
    <div data-dock className="pointer-events-auto mb-2 rounded-2xl border border-accent/50 bg-surface/95 backdrop-blur shadow-lg p-2 sm:p-2.5 text-sm">
      <div className="flex items-center gap-1">
        <span className="font-semibold text-accent px-1 hidden sm:inline">Editing</span>
        <button onClick={undo} disabled={!canUndo} className="btn btn-ghost btn-sm px-2" aria-label="Undo" title="Undo (Ctrl+Z)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M9 14L4 9l5-5" />
            <path d="M4 9h11a5 5 0 0 1 0 10h-3" />
          </svg>
        </button>
        <button onClick={redo} disabled={!canRedo} className="btn btn-ghost btn-sm px-2" aria-label="Redo" title="Redo (Shift+Ctrl+Z)">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 14l5-5-5-5" />
            <path d="M20 9H9a5 5 0 0 0 0 10h3" />
          </svg>
        </button>
        <label className="flex items-center gap-1 text-xs text-muted ml-1" title="Where new and moved notes land">
          <span className="hidden sm:inline">Snap</span>
          <select value={snap} onChange={(e) => setSnap(Number(e.target.value))} className="select text-xs py-1" aria-label="Snap notes to">
            <option value={4}>16ths</option>
            <option value={2}>8ths</option>
            <option value={3}>triplets</option>
            <option value={1}>beats</option>
            <option value={0}>off</option>
          </select>
        </label>
        <span className="flex-1" />
        <SaveBadge save={save} retry={retry} />
        <button onClick={done} className="btn btn-primary btn-sm">
          Done
        </button>
      </div>

      {note ? (
        <div className="mt-2 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted shrink-0 leading-tight">
              Fret
              <br />
              <b className="text-fg">{stringName}</b> string
            </span>
            <div ref={strip} className="flex gap-1 overflow-x-auto no-scrollbar flex-1 py-0.5">
              {Array.from({ length: MAX_FRET + 1 }, (_, f) => (
                <button
                  key={f}
                  data-on={f === note.fret ? "" : undefined}
                  onClick={() => actions.setFret(f)}
                  className={`shrink-0 h-9 min-w-9 rounded-lg font-mono font-semibold tabular-nums border ${f === note.fret ? "bg-accent text-accent-fg border-accent" : "border-line bg-bg"}`}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar -mx-1 px-1">
            <Group label="Move">
              <IconBtn label="Earlier" onClick={() => actions.nudge(-1)}>←</IconBtn>
              <IconBtn label="Later" onClick={() => actions.nudge(1)}>→</IconBtn>
            </Group>
            <Group label="Length">
              <IconBtn label="Shorter" onClick={() => actions.lengthen(-1)}>−</IconBtn>
              <IconBtn label="Longer" onClick={() => actions.lengthen(1)}>+</IconBtn>
            </Group>
            <Group label="String">
              <IconBtn label="Higher string" onClick={() => actions.moveString(1)}>↑</IconBtn>
              <IconBtn label="Lower string" onClick={() => actions.moveString(-1)}>↓</IconBtn>
            </Group>
            <div className="flex shrink-0 rounded-lg bg-surface-2 p-0.5" role="group" aria-label="Technique">
              {([1, 2, 3, 4] as Technique[]).map((k) => (
                <button
                  key={k}
                  onClick={() => actions.setTech(note.tech === k ? 0 : k)}
                  title={TECH_LABEL[k]}
                  aria-label={TECH_LABEL[k]}
                  aria-pressed={note.tech === k}
                  className={`h-8 min-w-8 px-2 rounded-md font-mono ${note.tech === k ? "bg-accent text-accent-fg" : "text-muted"}`}
                >
                  {TECHNIQUES[k]}
                </button>
              ))}
            </div>
            <IconBtn label="Hear this note" onClick={actions.hear}>🔊</IconBtn>
            <IconBtn label="Delete this note" onClick={actions.remove} className="text-red-500">
              🗑
            </IconBtn>
            <IconBtn label="Let go of this note" onClick={deselect}>✕</IconBtn>
          </div>
          <p className="text-xs text-muted hidden sm:block">
            {note.tech ? `${TECH_LABEL[note.tech]} into this note. ` : ""}Drag the note to move it, its dot to make it ring longer. Keys: digits for the fret, arrows to move, h p s b for hammer-on, pull-off, slide, bend.
          </p>
        </div>
      ) : (
        <p className={`mt-1.5 text-xs text-muted px-1 ${empty ? "" : "hidden sm:block"}`}>
          Tap a string to add a note, tap a note to change it, tap a chord name to change the chord. Changes save on their own.
        </p>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-line p-0.5" role="group" aria-label={label}>
      <span className="text-[10px] uppercase tracking-wide text-muted px-1 hidden sm:inline">{label}</span>
      {children}
    </div>
  );
}

function IconBtn({ label, onClick, children, className = "" }: { label: string; onClick: () => void; children: React.ReactNode; className?: string }) {
  return (
    <button onClick={onClick} aria-label={label} title={label} className={`shrink-0 h-8 min-w-8 px-1.5 rounded-md hover:bg-surface-2 active:scale-95 transition ${className}`}>
      {children}
    </button>
  );
}

export function SaveBadge({ save, retry }: { save: SaveState; retry: () => void }) {
  if (save === "error")
    return (
      <button onClick={retry} className="text-xs text-red-500 underline">
        Not saved, retry
      </button>
    );
  return <span className="text-xs text-muted tabular-nums">{save === "saved" ? "✓ Saved" : "Saving…"}</span>;
}
