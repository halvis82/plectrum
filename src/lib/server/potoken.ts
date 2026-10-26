import "server-only";
import { BotGuardClient, getChallenge } from "bgutils-js/botguard";
import type { WebPoSignalOutput } from "bgutils-js/shared-types";
import { buildURL, getHeaders } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import { JSDOM } from "jsdom";

// BotGuard-attested proof-of-origin tokens (github.com/LuanRT/BgUtils), minted in a JSDOM sandbox.
let minter: Promise<WebPoMinter> | null = null;

export function poMinter() {
  minter ??= (async () => {
    const requestKey = "O43z0dpjhgX20SCx4KAo";
    const dom = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { url: "https://www.youtube.com/", referrer: "https://www.youtube.com/" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, location: dom.window.location, origin: dom.window.origin });
    if (!Reflect.has(globalThis, "navigator")) Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator });
    const challenge = await getChallenge({ fetchFunction: fetch, requestKey });
    const js = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
    if (!js) throw new Error("BotGuard interpreter missing");
    new Function(js)();
    const bg = await BotGuardClient.create({ program: challenge.program, globalName: challenge.globalName, globalObject: globalThis });
    const signals: WebPoSignalOutput = [];
    const snapshot = await bg.snapshot({ webPoSignalOutput: signals });
    const res = await fetch(buildURL("GenerateIT", true), { method: "POST", headers: getHeaders(), body: JSON.stringify([requestKey, snapshot]) });
    const [integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken] = (await res.json()) as [string, number, number, string];
    return WebPoMinter.create({ integrityToken, estimatedTtlSecs, mintRefreshThreshold, websafeFallbackToken }, signals);
  })().catch((e) => {
    minter = null;
    throw e;
  });
  return minter;
}
