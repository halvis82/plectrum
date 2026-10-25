"use client";

import { useState } from "react";

export function SongHeader({ id, title, artist }: { id: string; title: string; artist: string | null }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(title);
  const [a, setA] = useState(artist ?? "");
  const [saved, setSaved] = useState({ title, artist: artist ?? "" });
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/songs/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: t, artist: a }),
    });
    if (!r.ok) return setError((await r.json()).error ?? "Couldn't save");
    setSaved({ title: t.trim(), artist: a.trim() });
    setEditing(false);
    setError(null);
    // lyrics are looked up by title/artist, so reload to refetch them
    location.reload();
  }

  if (editing) {
    return (
      <form onSubmit={save} className="mb-4 flex flex-col sm:flex-row gap-2">
        <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Title" className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold" autoFocus />
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="Artist" className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5" />
        <div className="flex gap-2">
          <button className="rounded-xl bg-accent text-accent-fg px-4 py-2.5 font-medium">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="rounded-xl border border-line px-4 py-2.5">Cancel</button>
        </div>
        {error && <p className="text-sm text-accent">{error}</p>}
      </form>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">{saved.title}</h1>
        {saved.artist && <p className="text-muted">{saved.artist}</p>}
      </div>
      <button onClick={() => setEditing(true)} className="mt-1 text-sm text-muted underline shrink-0">Rename</button>
    </div>
  );
}
