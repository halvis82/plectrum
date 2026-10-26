import { Innertube, UniversalCache } from "youtubei.js";
import { getSetting, setSetting } from "@/lib/server/settings";

/**
 * One-time YouTube sign-in with Google's device flow (like signing in a TV), in two steps so the
 * code stays valid for its full lifetime:
 *   GET ?token=ADMIN_TOKEN&step=start -> { url, code }   (enter the code at google.com/device)
 *   GET ?token=ADMIN_TOKEN&step=poll  -> { status: "pending" | "done" | "expired" }
 * The tokens land in the settings table, where the audio route picks them up.
 */
type Pending = { device_code: string; client: { client_id: string; client_secret: string }; expires: number };

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (!process.env.ADMIN_TOKEN || sp.get("token") !== process.env.ADMIN_TOKEN) return new Response("Forbidden", { status: 403 });

  if (sp.get("step") === "start") {
    const yt = await Innertube.create({ retrieve_player: false, cache: new UniversalCache(false) });
    const oauth = yt.session.oauth;
    oauth.client_id ??= await oauth.getClientID();
    const codes = await oauth.getDeviceAndUserCode();
    await setSetting("yt_oauth_pending", { device_code: codes.device_code, client: oauth.client_id!, expires: Date.now() + codes.expires_in * 1000 } satisfies Pending);
    return Response.json({ url: codes.verification_url, code: codes.user_code, expiresIn: codes.expires_in });
  }

  const pending = await getSetting<Pending>("yt_oauth_pending");
  if (!pending || pending.expires < Date.now()) return Response.json({ status: "expired" });
  const res = await fetch("https://www.youtube.com/o/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...pending.client, code: pending.device_code, grant_type: "http://oauth.net/grant_type/device/1.0" }),
  });
  const body = await res.json();
  if (!body.access_token) return Response.json({ status: body.error === "authorization_pending" || body.error === "slow_down" ? "pending" : `error: ${body.error}` });
  await setSetting("yt_oauth", {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expiry_date: new Date(Date.now() + body.expires_in * 1000).toISOString(),
    client: pending.client,
  });
  await setSetting("yt_oauth_pending", { ...pending, expires: 0 });
  return Response.json({ status: "done" });
}
