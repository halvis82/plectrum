import { ADMIN_COOKIE, adminSession, isAdmin, passwordOk } from "@/lib/server/access";
import { sql } from "@/lib/server/db";

/** wrong passwords allowed per address in the window below */
const TRIES = 8;
const WINDOW_MINUTES = 15;

export async function GET(req: Request) {
  return Response.json({ admin: isAdmin(req) });
}

/** Signs in as admin for this browser session: { password }. */
export async function POST(req: Request) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
  const [{ n }] = (await sql`select count(*)::int n from admin_attempts where ip = ${ip} and at > now() - make_interval(mins => ${WINDOW_MINUTES})`) as { n: number }[];
  if (n >= TRIES) return Response.json({ error: "Too many tries. Wait a few minutes and try again." }, { status: 429 });
  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  if (typeof body.password !== "string" || !passwordOk(body.password)) {
    await sql`insert into admin_attempts (ip) values (${ip})`;
    return Response.json({ error: "Wrong password" }, { status: 403 });
  }
  // no Max-Age: the browser drops it when the session ends
  return new Response(null, { status: 204, headers: { "set-cookie": `${ADMIN_COOKIE}=${adminSession()}; Path=/; HttpOnly; Secure; SameSite=Strict` } });
}
