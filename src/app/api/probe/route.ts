import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";
import { Innertube, Platform, type Types } from "youtubei.js";

export const maxDuration = 60;

Platform.shim.eval = async (data: Types.BuildScriptResult) => new Function(data.output)();

async function minter() {
  const requestKey = "O43z0dpjhgX20SCx4KAo";
  const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", {
    url: "https://www.youtube.com/", referrer: "https://www.youtube.com/",
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, origin: dom.window.origin });
  if (!Reflect.has(globalThis, "navigator")) Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
  const challenge = await getChallenge({ fetchFunction: fetch, requestKey });
  const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (!js) throw new Error("no interpreter");
  new Function(js)();
  const bg = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
  const sig: WebPoSignalOutput = [];
  const resp = await bg.snapshot({ webPoSignalOutput: sig });
  const it = await fetch(buildURL("GenerateIT", true), { method: "POST", headers: getHeaders(), body: JSON.stringify([requestKey, resp]) });
  const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await it.json()) as [string, number, number, string];
  return WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken }, sig);
}

export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const id = sp.get("id") || "bx1Bh8ZvH84";
  const clients = (sp.get("c") || "WEB,MWEB,YTMUSIC,WEB_EMBEDDED,IOS").split(",");
  const out: string[] = [];
  try {
    const m = await minter();
    const base = await Innertube.create({ retrieve_player: false });
    const visitor = base.session.context.client.visitorData!;
    const sessionPot = await m.mintAsWebsafeString(visitor);
    const contentPot = await m.mintAsWebsafeString(id);
    out.push(`minted ok visitor=${visitor.slice(0, 10)}`);
    for (const client of clients) {
      try {
        const yt = await Innertube.create({ po_token: sessionPot, visitor_data: visitor, retrieve_player: true });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const info = await yt.getBasicInfo(id, { client: client as any, po_token: contentPot });
        const ps = info.playability_status;
        let res = "";
        if (ps?.status === "OK") {
          const f = info.chooseFormat({ type: "audio", quality: "best" });
          const url = `${await f.decipher(yt.session.player)}&pot=${encodeURIComponent(contentPot)}`;
          const r = await fetch(url, { headers: { range: "bytes=0-99999" } });
          res = `${f.mime_type} ${r.status} ${(await r.arrayBuffer()).byteLength}`;
        }
        out.push(`${client} ${ps?.status} ${ps?.reason ?? ""} ${res}`);
      } catch (e) {
        out.push(`${client} ERR ${String(e).slice(0, 200)}`);
      }
    }
  } catch (e) {
    out.push(`MINT ERR ${String(e).slice(0, 300)}`);
  }
  return new Response(out.join("\n"));
}
