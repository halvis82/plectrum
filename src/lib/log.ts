"use client";
// Diagnostics (see /api/log): each song's steps with their times, and any failure.

const session = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 12) : String(Math.random()).slice(2, 14);

let device: Record<string, unknown> | null = null;
async function deviceInfo() {
  if (device) return device;
  const nav = navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> }; deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number } };
  const gpu = nav.gpu ? !!(await nav.gpu.requestAdapter().catch(() => null)) : false;
  device = {
    ua: navigator.userAgent.slice(0, 200),
    cores: navigator.hardwareConcurrency,
    memory: nav.deviceMemory ?? null,
    gpu,
    isolated: self.crossOriginIsolated,
    net: nav.connection ? `${nav.connection.effectiveType ?? ""} ${nav.connection.downlink ?? ""}Mbps` : null,
  };
  return device;
}

export function logEvent(kind: string, data: Record<string, unknown> = {}) {
  void (async () => {
    try {
      const body = JSON.stringify({ session, kind, data: { ...data, device: await deviceInfo() } });
      await fetch("/api/log", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: body.length < 60000 });
    } catch {}
  })();
}
