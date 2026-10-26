import { publicUrl } from "@/lib/server/media";

// Cover art from other sites, served from this origin: Safari's cross-origin isolation
// (require-corp) blocks images from hosts that don't send CORP or CORS headers.
export async function GET(req: Request) {
  const u = publicUrl(new URL(req.url).searchParams.get("u") ?? "");
  if (!u) return new Response(null, { status: 400 });
  const res = await fetch(u, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  const type = res?.headers.get("content-type") ?? "";
  if (!res?.ok || !type.startsWith("image/")) return new Response(null, { status: 502 });
  const body = await res.arrayBuffer();
  if (body.byteLength > 3_000_000) return new Response(null, { status: 413 });
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}
