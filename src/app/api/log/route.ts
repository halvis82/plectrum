import { sql } from "@/lib/server/db";

/** Diagnostics from browsers: how long each step of a song took and what went wrong, so failures on
 * real devices can be found. No audio, titles or personal data: just steps, times, errors and the
 * browser's capabilities. */
export async function POST(req: Request) {
  const raw = await req.text();
  if (raw.length > 20_000) return new Response(null, { status: 413 });
  let body: { session?: unknown; kind?: unknown; data?: unknown };
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  const session = typeof body.session === "string" ? body.session.slice(0, 40) : null;
  const kind = typeof body.kind === "string" ? body.kind.slice(0, 40) : null;
  if (!kind) return new Response(null, { status: 400 });
  await sql`insert into events (session, kind, data) values (${session}, ${kind}, ${JSON.stringify(body.data ?? null)})`;
  // old diagnostics are dropped now and then
  if (Math.random() < 0.01) await sql`delete from events where at < now() - interval '30 days'`;
  return new Response(null, { status: 204 });
}
