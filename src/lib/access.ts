"use client";
// Changing a song takes its owner key (kept by the browser that made it) or an admin session (the
// password, asked for only when someone tries to change a song that isn't theirs). The server checks
// both (src/lib/server/access.ts); this decides when to ask.

const KEY = (id: string) => `plectrum:owner:${id}`;

/** A new owner key for a song this browser is about to make, remembered before it is sent. */
export function newOwnerKey(id: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, (c) => ({ "+": "-", "/": "_", "=": "" })[c]!);
  try {
    localStorage.setItem(KEY(id), key);
  } catch {}
  return key;
}

function ownerKey(id: string) {
  try {
    return localStorage.getItem(KEY(id));
  } catch {
    return null;
  }
}

/** Headers that prove this browser made the song (none if it didn't). */
export function ownerHeaders(id: string): Record<string, string> {
  const key = ownerKey(id);
  return key ? { "x-owner-key": key } : {};
}

let admin: Promise<boolean> | null = null;
const adminSession = () => (admin ??= fetch("/api/admin/session").then((r) => r.json()).then((b) => !!b.admin).catch(() => false));

/** the password prompt (see AdminPrompt), resolving true once signed in */
let prompt: (() => Promise<boolean>) | null = null;
export function setAdminPrompt(p: typeof prompt) {
  prompt = p;
}

/** Signs in with the password: null when it worked, else what went wrong. */
export async function signIn(password: string): Promise<string | null> {
  const r = await fetch("/api/admin/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) }).catch(() => null);
  if (!r) return "Couldn't reach the server";
  if (r.ok) {
    admin = Promise.resolve(true);
    return null;
  }
  return (await r.json().catch(() => ({}))).error ?? "Couldn't sign in";
}

/** Whether this browser may change the song, asking for the admin password if it isn't its own. */
export async function mayChange(id: string): Promise<boolean> {
  if (ownerKey(id) || (await adminSession())) return true;
  return prompt ? prompt() : false;
}
