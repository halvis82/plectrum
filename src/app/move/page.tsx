"use client";

import { useEffect, useState } from "react";
import { saveLocalAudio } from "@/lib/audio";
import { OLD_HOSTS, type Handover } from "@/lib/moved";

/** Opened by an old address (see Moved): takes the audio and settings it saved and keeps them here. */
export default function MovePage() {
  const [text, setText] = useState("This page receives what an old ChordCatch address saved on this device.");

  useEffect(() => {
    const from = window.opener as Window | null;
    if (!from) return;
    const onMessage = async (e: MessageEvent<Handover>) => {
      if (!OLD_HOSTS.includes(new URL(e.origin).host) || e.source !== from || e.data?.type !== "handover") return;
      removeEventListener("message", onMessage);
      setText("Moving…");
      for (const [id, blob] of e.data.audio) await saveLocalAudio(id, blob);
      for (const [k, v] of e.data.prefs) if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      from.postMessage("done", e.origin);
      window.close();
      setText("Done. You can close this window.");
    };
    addEventListener("message", onMessage);
    // the old page answers whichever old address it is on
    from.postMessage("ready", "*");
  }, []);

  return <p className="py-16 text-center text-muted">{text}</p>;
}
