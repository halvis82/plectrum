// Who may change a song: the browser that made it (it keeps the song's owner key) or an admin (the
// password, see /api/admin/session). Everyone can read the library and make songs of their own.
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { sql } from "./db";

export const ADMIN_COOKIE = "plectrum_admin";
/** an admin session lasts until the browser closes, and never longer than this */
const SESSION_HOURS = 12;

export const ownerHash = (key: string) => createHash("sha256").update(key).digest("hex");

const sign = (issued: string) => createHmac("sha256", process.env.ADMIN_TOKEN ?? "").update(`admin:${issued}`).digest("base64url");

function same(a: string, b: string) {
  const x = createHash("sha256").update(a).digest();
  const y = createHash("sha256").update(b).digest();
  return timingSafeEqual(x, y);
}

export function passwordOk(password: string) {
  const want = process.env.ADMIN_PASSWORD;
  return !!want && same(password, want);
}

/** the cookie value for a new admin session */
export function adminSession() {
  const issued = String(Date.now());
  return `${issued}.${sign(issued)}`;
}

export function isAdmin(req: Request) {
  if (!process.env.ADMIN_TOKEN) return false;
  // scripts send the token itself
  const token = req.headers.get("x-admin-token");
  if (token) return same(token, process.env.ADMIN_TOKEN);
  const cookie = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${ADMIN_COOKIE}=([^;]+)`))?.[1];
  if (!cookie) return false;
  const [issued, sig] = cookie.split(".");
  return !!sig && same(sig, sign(issued)) && Date.now() - Number(issued) < SESSION_HOURS * 3600_000;
}

/** The admin, or the browser holding the song's owner key (header x-owner-key). */
export async function canChange(req: Request, id: string) {
  if (isAdmin(req)) return true;
  const key = req.headers.get("x-owner-key");
  if (!key) return false;
  const rows = await sql`select 1 from songs where id = ${id} and owner_hash = ${ownerHash(key)}`;
  return rows.length > 0;
}

export const forbidden = () => Response.json({ error: "Forbidden" }, { status: 403 });
