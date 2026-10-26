import { Innertube, UniversalCache } from "youtubei.js";
import { getSetting } from "@/lib/server/settings";
import { tvFetch } from "@/lib/server/youtube-audio";
import { decipherUrl } from "@/lib/server/ejs";
import { poMinter } from "@/lib/server/potoken";

export const maxDuration = 120;

// Temporary diagnostics: inspect the TV stream URL and how googlevideo answers it.
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  if (sp.get("token") !== process.env.ADMIN_TOKEN) return new Response("Forbidden", { status: 403 });
  const id = sp.get("id") ?? "IXdNnw99-Ic";
  if (sp.get("step") === "uber") {
    const t = await getSetting<{ access_token: string }>("yt_oauth");
    const yt0 = await Innertube.create({ retrieve_player: false, cache: new UniversalCache(false) });
    await yt0.session.signIn(t as never);
    const access = (yt0.session.oauth.oauth2_tokens as { access_token: string }).access_token;
    const r = await fetch("https://accounts.google.com/accounts/OAuthLogin?source=ChromiumBrowser&issueuberauth=1", { headers: { authorization: `Bearer ${access}` } });
    return Response.json({ status: r.status, body: (await r.text()).slice(0, 200).replace(/[A-Za-z0-9_-]{30,}/g, "<token>") });
  }
  const tokens = await getSetting<Parameters<Innertube["session"]["signIn"]>[0]>("yt_oauth");
  const yt = await Innertube.create({ retrieve_player: true, cache: new UniversalCache(false), fetch: tvFetch });
  if (tokens) await yt.session.signIn(tokens);
  const info = await yt.getBasicInfo(id, { client: "TV" });
  const fmts = (info.streaming_data?.adaptive_formats ?? []).filter((f) => f.has_audio && !f.has_video);
  const f = fmts.find((x) => x.mime_type.startsWith("audio/mp4")) ?? fmts[0];
  const raw = f as unknown as { url?: string; signature_cipher?: string; cipher?: string };
  const out: Record<string, unknown> = {
    status: info.playability_status?.status,
    itag: f?.itag,
    hasUrl: !!raw.url,
    hasCipher: !!(raw.signature_cipher || raw.cipher),
    playerId: yt.session.player?.player_id,
    sts: yt.session.player?.signature_timestamp,
  };
  const sc = raw.signature_cipher || raw.cipher;
  if (sc) {
    const p = new URLSearchParams(sc);
    out.cipherKeys = [...p.keys()].join(",");
    out.cipherSigLen = p.get("s")?.length;
    out.cipherSp = p.get("sp");
    const inner = new URL(p.get("url")!);
    out.rawN = inner.searchParams.get("n");
  }
  if (raw.url) {
    const u = new URL(raw.url);
    out.rawKeys = [...u.searchParams.keys()].join(",");
    out.rawN = u.searchParams.get("n");
  }
  const url = await f.decipher(yt.session.player);
  const d = new URL(url);
  out.decKeys = [...d.searchParams.keys()].join(",");
  out.decN = d.searchParams.get("n");
  out.host = d.host;
  out.urlIp = d.searchParams.get("ip");
  out.egress = await Promise.all([1, 2, 3, 4].map(() => fetch("https://api.ipify.org").then((r) => r.text())));
  const TV_UA = "Mozilla/5.0 (SMART-TV; Linux; Tizen 2.4.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/2.4.0 TV Safari/538.1";
  const tries: Record<string, Record<string, string>> = {
    none: {},
    tvUa: { "user-agent": TV_UA },
    tvUaOrigin: { "user-agent": TV_UA, origin: "https://www.youtube.com", referer: "https://www.youtube.com/" },
  };
  for (const [k, h] of Object.entries(tries)) {
    const r = await fetch(url, { headers: { ...h, range: "bytes=0-1023" } });
    out[`get_${k}`] = r.status;
    const r2 = await fetch(`${url}&range=0-1023`, { method: "POST", headers: h, body: "x\0" });
    out[`post_${k}`] = r2.status;
  }
  try {
    const ejsUrl = await decipherUrl(yt.session.player!.player_id, raw);
    const e = new URL(ejsUrl);
    out.ejsN = e.searchParams.get("n");
    out.ejsSigSame = e.searchParams.get("sig") === d.searchParams.get("sig");
    const r403 = await fetch(ejsUrl, { headers: { range: "bytes=0-1023" } });
    out.ejs_get = r403.status;
    out.ejs_body = (await r403.text()).slice(0, 300);
    out.ejs_headers = Object.fromEntries([...r403.headers].filter(([k]) => !/date|alt-svc|server/.test(k)));
    out.urlParams = Object.fromEntries([...new URL(ejsUrl).searchParams].filter(([k]) => ["c", "cver", "rqh", "xpc", "spc", "svpuc", "sefc", "met", "source", "gir", "bui", "ei", "mime"].includes(k)));
    out.ejs_get_tvUa = (await fetch(ejsUrl, { headers: { range: "bytes=0-1023", "user-agent": TV_UA } })).status;
    const m = await poMinter();
    const visitor = yt.session.context.client.visitorData ?? "";
    for (const [k, binding] of Object.entries({ video: id, visitor })) {
      if (!binding) continue;
      const pot = await m.mintAsWebsafeString(binding);
      out[`pot_${k}`] = (await fetch(`${ejsUrl}&pot=${encodeURIComponent(pot)}`, { headers: { range: "bytes=0-1023" } })).status;
      out[`pot_${k}_tvUa`] = (await fetch(`${ejsUrl}&pot=${encodeURIComponent(pot)}`, { headers: { range: "bytes=0-1023", "user-agent": TV_UA } })).status;
    }
  } catch (err) {
    out.ejsError = String(err).slice(0, 300);
  }
  return Response.json(out);
}
