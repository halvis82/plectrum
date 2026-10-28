"use client";

import { useEffect, useRef, useState } from "react";
import { setAdminPrompt, signIn } from "@/lib/access";

/** Asks for the admin password when someone tries to change a song another browser made. */
export function AdminPrompt() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const answer = useRef<((ok: boolean) => void) | null>(null);

  useEffect(() => {
    setAdminPrompt(
      () =>
        new Promise<boolean>((resolve) => {
          answer.current?.(false);
          answer.current = resolve;
          setPassword("");
          setError(null);
          setOpen(true);
        }),
    );
    return () => setAdminPrompt(null);
  }, []);

  const close = (ok: boolean) => {
    answer.current?.(ok);
    answer.current = null;
    setOpen(false);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    const err = await signIn(password);
    setBusy(false);
    if (err) return setError(err);
    close(true);
  }

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => close(false)}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-5 shadow-lg" role="dialog" aria-label="Admin password">
        <h2 className="text-lg font-semibold">This song isn&apos;t yours</h2>
        <p className="mt-1 text-sm text-muted">Only the person who added it can change it. An admin can sign in to change it anyway.</p>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Admin password" autoFocus autoComplete="current-password" className="mt-4 w-full rounded-xl border border-line bg-bg px-3 py-2.5 outline-none focus:border-accent" />
        {error && <p className="mt-2 text-sm text-red-600">{error}</p>}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => close(false)} className="btn">
            Cancel
          </button>
          <button disabled={busy || !password} className="btn btn-primary">
            {busy ? "Checking…" : "Sign in"}
          </button>
        </div>
      </form>
    </div>
  );
}
