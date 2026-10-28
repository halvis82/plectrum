"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { mayChange, ownerHeaders } from "@/lib/access";

export function SongHeader({ id, title, artist }: { id: string; title: string; artist: string | null }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(title);
  const [a, setA] = useState(artist ?? "");
  const [saved, setSaved] = useState({ title, artist: artist ?? "" });
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function remove() {
    if (!(await mayChange(id)) || !confirm(`Delete "${saved.title}" from the library for everyone? This can't be undone.`)) return;
    const r = await fetch(`/api/songs/${id}`, { method: "DELETE", headers: ownerHeaders(id) });
    if (!r.ok) return alert((await r.json().catch(() => ({}))).error ?? "Couldn't delete it");
    router.push("/");
    router.refresh();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/songs/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...ownerHeaders(id) },
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
        <input value={t} onChange={(e) => setT(e.target.value)} placeholder="Title" className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 text-lg font-semibold outline-none" autoFocus />
        <input value={a} onChange={(e) => setA(e.target.value)} placeholder="Artist" className="flex-1 rounded-xl border border-line bg-surface px-3 py-2.5 outline-none" />
        <div className="flex gap-2">
          <button className="btn btn-primary">Save</button>
          <button type="button" onClick={() => setEditing(false)} className="btn">
            Cancel
          </button>
        </div>
        {error && <p className="text-sm text-accent">{error}</p>}
      </form>
    );
  }
  return (
    <div className="mb-4 flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl sm:text-3xl font-bold tracking-tight leading-tight break-words">{saved.title}</h1>
        {saved.artist && <p className="text-muted mt-0.5">{saved.artist}</p>}
      </div>
      <button onClick={async () => (await mayChange(id)) && setEditing(true)} className="btn btn-ghost btn-sm px-2 text-muted shrink-0" aria-label="Rename" title="Rename">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
        </svg>
      </button>
      <button onClick={() => void remove()} className="btn btn-ghost btn-sm px-2 text-muted shrink-0" aria-label="Delete" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
        </svg>
      </button>
    </div>
  );
}
