// End-to-end checks in headless Chromium. Uses a fake microphone fed from a WAV file, so no
// real devices or OS permission prompts are involved (the app never offers tab capture to
// HeadlessChrome). Songs created by the run are deleted afterwards with ADMIN_TOKEN.
//
// Usage: ADMIN_TOKEN=... node scripts/e2e.mjs <base url> <fake-mic.wav> <upload file> <screenshot dir> [only]
import { chromium, devices } from "playwright";

const [, , BASE, MIC_WAV, UPLOAD, SHOTS, ONLY] = process.argv;
const created = [];
const results = [];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];
const browser = await chromium.launch({
  headless: true,
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${MIC_WAV}`, "--autoplay-policy=no-user-gesture-required"],
});

let lastPage = null;
async function newPage(phone = false) {
  const ctx = await browser.newContext(phone ? iphone : { viewport: { width: 1280, height: 900 } });
  await ctx.grantPermissions(["microphone", "clipboard-read", "clipboard-write"], { origin: BASE });
  const page = await ctx.newPage();
  lastPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/youtube|googlevideo|doubleclick|google\.com|gstatic|ERR_BLOCKED|Failed to load resource/i.test(m.text() + m.location().url) && errors.push(m.text()));
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  return { page, ctx, errors };
}

async function test(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, secs: (Date.now() - t0) / 1000, note });
  } catch (e) {
    await lastPage?.screenshot({ path: `${SHOTS}/FAIL-${name.split(":")[0].replace(/\W+/g, "-")}.png` }).catch(() => {});
    const body = await lastPage?.locator("section").first().innerText().catch(() => "");
    if (body) console.log("  page:", body.replace(/\s+/g, " ").slice(0, 300));
    results.push({ name, ok: false, secs: (Date.now() - t0) / 1000, note: e.message.split("\n")[0].slice(0, 200) });
  }
  console.log(results.at(-1).ok ? "PASS" : "FAIL", name, results.at(-1).note ?? "");
}

const input = (page) => page.getByLabel("YouTube or Spotify link");

async function paste(page, text) {
  await input(page).click();
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+V");
}

async function songId(page) {
  await page.waitForURL(/\/song\//, { timeout: 120000 });
  const id = page.url().split("/song/")[1];
  created.push(id);
  return id;
}

async function liveCaptureFlow(page, secs, shot) {
  await page.getByText(/Listening \d|Waiting for music/).first().waitFor({ timeout: 45000 });
  const tStart = Date.now();
  await page.waitForFunction(() => /\b[A-G][#b]?(m|7|maj7|sus|dim|aug|6)*\b/.test(document.querySelector(".text-5xl")?.textContent ?? ""), null, { timeout: 30000 });
  const firstChordAfter = (Date.now() - tStart) / 1000;
  await page.waitForTimeout(secs * 1000);
  await page.screenshot({ path: `${SHOTS}/${shot}-capturing.png` });
  const liveNow = await page.locator(".text-5xl").first().innerText();
  await page.getByRole("button", { name: /Stop here and save|Done, show the chords/ }).click();
  return { firstChordAfter, liveNow };
}

// ---------- tests ----------

await test("youtube: paste starts capture, live chords, saves, song page plays", async () => {
  const { page, errors } = await newPage();
  await paste(page, "https://www.youtube.com/watch?v=IXdNnw99-Ic");
  const { firstChordAfter, liveNow } = await liveCaptureFlow(page, 20, "yt");
  const id = await songId(page);
  await page.waitForSelector("figure", { timeout: 20000 });
  await page.waitForSelector("iframe[src*='youtube-nocookie']", { timeout: 20000 });
  await page.waitForTimeout(4000);
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(5000);
  const beatMarks = await page.locator(".bg-now").count();
  await page.screenshot({ path: `${SHOTS}/yt-song.png`, fullPage: false });
  if (!beatMarks) throw new Error("no beat highlight while playing");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `first live chord after ${firstChordAfter.toFixed(1)}s (${liveNow}), song ${id}`;
});

await test("vevo-blocked video: falls back to another upload and captures", async () => {
  const { page, errors } = await newPage();
  await paste(page, "https://www.youtube.com/watch?v=bx1Bh8ZvH84");
  await page.getByText(/another upload of the same song/).waitFor({ timeout: 40000 });
  await liveCaptureFlow(page, 8, "vevo");
  const id = await songId(page);
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `song ${id}`;
});

await test("spotify: paste resolves to YouTube and captures", async () => {
  const { page, errors } = await newPage();
  await paste(page, "https://open.spotify.com/track/1qPbGZqppFwLwcBC1JQ6Vr?si=x");
  await page.getByText("Wonderwall").first().waitFor({ timeout: 20000 });
  await liveCaptureFlow(page, 8, "spotify");
  const id = await songId(page);
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `song ${id}`;
});

await test("typed link: resolves without Go, Start button captures", async () => {
  const { page } = await newPage();
  await input(page).fill("https://youtu.be/IXdNnw99-Ic");
  await page.getByRole("button", { name: "▶ Start" }).waitFor({ timeout: 20000 });
  await page.getByRole("button", { name: "▶ Start" }).click();
  await liveCaptureFlow(page, 5, "typed");
  return `song ${await songId(page)}`;
});

await test("upload: file analyzed and saved, local playback", async () => {
  const { page, errors } = await newPage();
  const t0 = Date.now();
  await page.setInputFiles('input[type="file"]', UPLOAD);
  const id = await songId(page);
  const secs = (Date.now() - t0) / 1000;
  await page.waitForSelector("audio", { timeout: 15000 });
  await page.screenshot({ path: `${SHOTS}/upload-song.png`, fullPage: false });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `${secs.toFixed(1)}s for a 4:17 song, song ${id}`;
});

await test("listen (mic) on a phone: silent start, live chords, done", async () => {
  const { page, errors } = await newPage(true);
  await page.getByRole("button", { name: /Listen/ }).click();
  const r = await liveCaptureFlow(page, 15, "listen");
  const id = await songId(page);
  await page.screenshot({ path: `${SHOTS}/listen-song.png` });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `first live chord after ${r.firstChordAfter.toFixed(1)}s, song ${id}`;
});

await test("song page on another device: play-along clock works", async () => {
  const id = created.find(Boolean);
  if (!id) throw new Error("no song created earlier");
  const upload = results.find((r) => r.name.startsWith("upload"))?.note?.match(/song (\w+)/)?.[1];
  const { page } = await newPage(true);
  await page.goto(`${BASE}/song/${upload ?? id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Play" }).click();
  await page.waitForTimeout(4000);
  const marks = await page.locator(".bg-now").count();
  await page.screenshot({ path: `${SHOTS}/playalong.png` });
  if (!marks) throw new Error("beat highlight not moving");
  return "beat highlight moves without audio";
});

await test("bad link: friendly error", async () => {
  const { page } = await newPage();
  await paste(page, "https://www.youtube.com/watch?v=xxxxxxxxxxx");
  await page.getByText(/couldn't be found|could not be found|not found/i).waitFor({ timeout: 20000 });
  return "shown";
});

// ---------- cleanup + report ----------
for (const id of new Set(created)) {
  if (!process.env.ADMIN_TOKEN) break;
  await fetch(`${BASE}/api/songs/${id}`, { method: "DELETE", headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
}
await browser.close();
console.log("\n" + results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name} (${r.secs.toFixed(0)}s) ${r.note ?? ""}`).join("\n"));
process.exit(results.every((r) => r.ok) ? 0 : 1);
