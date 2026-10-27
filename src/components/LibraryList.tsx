"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { SongSummary } from "@/lib/server/db";

const ICON: Record<string, string> = { youtube: "▶", spotify: "♫", apple: "♫", deezer: "♫", soundcloud: "☁", upload: "📁", record: "🎙️", tab: "▶", scratch: "✎" };

export function LibraryList({ initial }: { initial: SongSummary[] }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<SongSummary[]>([]);
  const songs = q.trim() ? results : initial;

  useEffect(() => {
    if (!q.trim()) return;
    const t = setTimeout(async () => {
      const r = await fetch(`/api/songs?q=${encodeURIComponent(q.trim())}`);
      if (r.ok) setResults(await r.json());
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div>
      <input
        type="search"
        placeholder="Search songs or artists"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className="w-full sm:max-w-sm rounded-xl border border-line bg-surface px-3.5 py-2.5 mb-4 outline-none transition focus:border-accent"
      />
      {songs.length === 0 ? (
        <p className="text-sm text-muted">{q ? "Nothing matches that." : "No songs yet. Catch the first one above."}</p>
      ) : (
        <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {songs.map((s) => (
            <li key={s.id}>
              <Link href={`/song/${s.id}`} className="flex gap-3 items-center rounded-2xl bg-surface border border-line p-2.5 hover:border-accent/60 hover:shadow-sm active:scale-[0.99] transition">
                {s.youtube_id ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`https://i.ytimg.com/vi/${s.youtube_id}/mqdefault.jpg`} alt="" className="h-12 w-20 rounded-lg object-cover bg-surface-2 shrink-0" loading="lazy" />
                ) : (
                  <span className="h-12 w-20 rounded-lg bg-surface-2 grid place-items-center shrink-0" aria-hidden>{ICON[s.source] ?? "♪"}</span>
                )}
                <span className="min-w-0">
                  <span className="block font-medium truncate">{s.title}</span>
                  <span className="block text-sm text-muted truncate">
                    {[s.artist, s.song_key, s.bpm ? `${Math.round(s.bpm)} BPM` : null].filter(Boolean).join(" · ")}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
