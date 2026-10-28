"use client";

import { useEffect, useState } from "react";
import { allLocalAudio } from "@/lib/audio";
import { HOME, OLD_HOSTS, type Handover } from "@/lib/moved";

const go = () => location.replace(HOME + location.pathname + location.search);

/** On an old address: straight on to the new one, or first carry over the audio saved on this device
 * (only a window this page opens can receive it, so that takes a click). */
export function Moved() {
  const [audio, setAudio] = useState<[string, Blob][] | null>(null);
  const [state, setState] = useState<"ask" | "moving" | "blocked">("ask");

  useEffect(() => {
    if (!OLD_HOSTS.includes(location.host)) return;
    void allLocalAudio().then((a) => (a.length ? setAudio(a) : go()));
  }, []);

  if (!audio) return null;

  const move = () => {
    const prefs: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)!;
      prefs.push([k, localStorage.getItem(k)!]);
    }
    const w = window.open(`${HOME}/move`, "_blank");
    if (!w) return setState("blocked");
    setState("moving");
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== HOME || e.source !== w) return;
      if (e.data === "ready") w.postMessage({ type: "handover", audio, prefs } satisfies Handover, HOME);
      if (e.data === "done") {
        removeEventListener("message", onMessage);
        go();
      }
    };
    addEventListener("message", onMessage);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-bg/95 p-4">
      <div className="max-w-md rounded-2xl border border-line bg-surface p-6 shadow-lg">
        <h2 className="text-lg font-semibold">ChordCatch is now Strum</h2>
        <p className="mt-2 text-sm text-muted">
          It lives at strum.vercel.app now. This device has the audio of {audio.length === 1 ? "1 recording or upload" : `${audio.length} recordings and uploads`}, which only this address can read, so bring it along first.
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <button onClick={move} disabled={state === "moving"} className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-60">
            {state === "moving" ? "Moving…" : "Move it to Strum"}
          </button>
          <button onClick={go} className="rounded-full border border-line px-4 py-2 text-sm">
            Go without it
          </button>
        </div>
        {state === "blocked" && <p className="mt-3 text-sm text-red-600">The browser blocked the new window. Allow pop-ups for this site and try again.</p>}
      </div>
    </div>
  );
}
