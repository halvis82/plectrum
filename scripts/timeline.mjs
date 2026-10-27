// Times every step of a song in the real Chrome (headless, with WebGPU), as a person's browser runs it,
// then lists the slow requests. MBPS=<n> throttles the connection.
// Usage: node scripts/timeline.mjs <base url> link <url> | upload <file> | mic <seconds> <fake mic wav>
import { chromium } from "playwright";
const [, , BASE, KIND, ARG, WAV] = process.argv;
const b = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", ...(WAV ? [`--use-file-for-fake-audio-capture=${WAV}`] : [])],
});
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.grantPermissions(["microphone", "clipboard-read", "clipboard-write"], { origin: BASE });
const p = await ctx.newPage();
if (process.env.MBPS) {
  const cdp = await ctx.newCDPSession(p);
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 40, downloadThroughput: (Number(process.env.MBPS) * 1e6) / 8, uploadThroughput: 5e6 / 8 });
}
const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(6);
p.on("console", (m) => (m.type() === "error" || m.type() === "warning" || m.text().startsWith("[")) && console.log(ts(), "console." + m.type(), m.text().slice(0, 220)));
p.on("pageerror", (e) => console.log(ts(), "pageerror", e.message.slice(0, 220)));
p.on("crash", () => console.log(ts(), "PAGE CRASHED"));
p.on("worker", (w) => console.log(ts(), "worker", w.url().slice(-60)));
await p.goto(BASE, { waitUntil: "load" });
console.log(ts(), "gpu:", await p.evaluate(async () => ("gpu" in navigator ? !!(await navigator.gpu.requestAdapter()) : "none")), "isolated:", await p.evaluate(() => crossOriginIsolated));
if (KIND === "link") {
  await p.getByLabel("Song link").fill(ARG);
} else if (KIND === "upload") {
  await p.setInputFiles('input[type="file"]', ARG);
} else if (KIND === "mic") {
  await p.getByRole("button", { name: /Listen/ }).click();
  for (let k = 0; k < Number(ARG); k += 5) {
    await p.waitForTimeout(5000);
    console.log(ts(), "listening:", (await p.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 160));
  }
  await p.screenshot({ path: process.env.SHOT ?? "/tmp/mic.png" });
  await p.getByRole("button", { name: /Done, show the chords/ }).click();
}
let last = "";
for (let i = 0; i < 600; i++) {
  const txt = (await p.locator("main").innerText().catch(() => "")).replace(/\s+/g, " ");
  const m = txt.match(/(Loading the chord model[^%]*\d*%?|Finding the song|Getting the audio|Reading the audio|Preparing the recording|Loading the chord model[^%]*|Listening to the harmony|Recognizing chords|Finding the beat|Saving to the library|Loading the models[^…]*|Catching every note[^…]*|ready up to [0-9:]+ of [0-9:]+|Paused[^…]*)[^·]*?(\d+%)?/);
  const s = (p.url().includes("/song/") ? "[song page] " : "") + (m ? m[0].slice(0, 90) : txt.includes("Every note heard") || txt.includes("clearest of") ? "TAB DONE" : txt.slice(0, 80));
  if (s !== last) console.log(ts(), s), (last = s);
  if (s.includes("TAB DONE")) break;
  if (/couldn't|Couldn't|error|wrong/.test(txt) && !p.url().includes("/song/")) { console.log(ts(), "ERROR TEXT:", txt.slice(0, 300)); break; }
  await p.waitForTimeout(200);
}
console.log(ts(), "url", p.url());
console.log(await p.evaluate(() => performance.getEntriesByType("resource").filter((e) => /\/api\/|\/song\/|_rsc|model|ort/.test(e.name)).map((e) => `${(e.startTime / 1000).toFixed(1).padStart(6)}s +${(e.duration / 1000).toFixed(1)}s ttfb ${((e.responseStart - e.startTime) / 1000).toFixed(1)}s ${e.name.replace(location.origin, "").slice(0, 70)}`).join("\n")));
await b.close();
