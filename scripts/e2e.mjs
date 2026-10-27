// End-to-end checks in headless Chromium. Uses a fake microphone fed from a WAV file, so no
// real devices or OS permission prompts are involved (the app never offers tab capture to
// HeadlessChrome). Songs created by the run are deleted afterwards with ADMIN_TOKEN.
//
// Usage: ADMIN_TOKEN=... node scripts/e2e.mjs <base url> <fake-mic.wav> <upload file> <screenshot dir> [only]
import { chromium, devices } from "playwright";

const [, , BASE, MIC_WAV, UPLOAD, SHOTS, ONLY] = process.argv;
const created = [];
// links already in the library open the saved song; those songs are never deleted afterwards
const before = new Set((await fetch(`${BASE}/api/songs`).then((r) => r.json())).map((s) => s.id));
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

const input = (page) => page.getByLabel("Song link");

async function paste(page, text) {
  await input(page).click();
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press("ControlOrMeta+V");
}

async function songId(page) {
  await page.waitForURL(/\/song\//, { timeout: 300000 });
  const id = page.url().split("/song/")[1];
  if (!before.has(id)) created.push(id);
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

/** The Tab view (the default when notes exist) shows bars with fretted notes. A new song opens with
 * its chords while the notes are still coming, so this waits for them, then reloads to check the
 * notes were saved to the song. */
async function tabNotes(page) {
  const count = async (timeout) => {
    await page.waitForSelector('[role="img"][aria-label^="Bar"]', { timeout });
    const labels = await page.locator('[role="img"][aria-label^="Bar"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    return { bars: labels.length, notes: labels.join(" ").match(/fret \d+/g)?.length ?? 0 };
  };
  const t0 = Date.now();
  // the tab streams in; wait for the finished one (bars too, as the progress line can appear a moment after the page)
  await page.waitForFunction(() => {
    const pane = document.querySelector("[data-pane]");
    return pane?.querySelector('[role="img"][aria-label^="Bar"]') && !/Catching every note|Loading the models|ready up to|Paused while/.test(pane.textContent ?? "");
  }, null, { timeout: 300000 });
  const live = await count(20000);
  const secs = (Date.now() - t0) / 1000;
  if (!live.notes) throw new Error("tab has no notes");
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "networkidle" });
  const saved = await count(20000);
  if (saved.notes !== live.notes) throw new Error(`saved tab has ${saved.notes} notes, ${live.notes} were shown`);
  return `${live.bars} tab bars, ${live.notes} notes (tab ${secs.toFixed(0)}s after the chords, saved)`;
}

// ---------- tests ----------

async function linkFlow(page, link, shot) {
  const t0 = Date.now();
  await paste(page, link);
  const id = await songId(page);
  const secs = (Date.now() - t0) / 1000;
  await page.waitForSelector("figure", { timeout: 20000 });
  const audio = page.locator("audio");
  await audio.waitFor({ state: "attached", timeout: 15000 });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(5000);
  const t = await audio.evaluate((a) => a.currentTime);
  const marks = await page.locator(".bg-now:visible").count();
  await page.screenshot({ path: `${SHOTS}/${shot}-song.png` });
  if (t < 2) throw new Error(`audio not playing (t=${t})`);
  if (!marks) throw new Error("no beat highlight while playing");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  return `${secs.toFixed(1)}s paste-to-chords, plays from server (t=${t.toFixed(1)}s), ${await tabNotes(page)}, song ${id}`;
}

await test("youtube: paste -> server audio -> chords -> plays", async () => {
  const { page, errors } = await newPage();
  const note = await linkFlow(page, "https://www.youtube.com/watch?v=hTWKbfoikeg", "yt");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return note;
});

await test("vevo official video: server fetch works", async () => {
  const { page, errors } = await newPage();
  const note = await linkFlow(page, "https://www.youtube.com/watch?v=bx1Bh8ZvH84", "vevo");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return note;
});

await test("spotify: paste -> matched YouTube audio -> chords", async () => {
  const { page, errors } = await newPage();
  const note = await linkFlow(page, "https://open.spotify.com/track/1qPbGZqppFwLwcBC1JQ6Vr?si=x", "spotify");
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return note;
});

await test("typed link: starts on its own", async () => {
  const { page } = await newPage();
  await input(page).fill("https://youtu.be/hTWKbfoikeg");
  return `song ${await songId(page)}`;
});

await test("library link: opens the saved song without analyzing again", async () => {
  const { page } = await newPage();
  const t0 = Date.now();
  await paste(page, "https://www.youtube.com/watch?v=IXdNnw99-Ic");
  const id = await songId(page);
  if (!before.has(id)) throw new Error(`analyzed again as ${id}`);
  return `${((Date.now() - t0) / 1000).toFixed(1)}s to song ${id}, ${await tabNotes(page)}`;
});

await test("upload: file analyzed and saved, local playback", async () => {
  const { page, errors } = await newPage();
  const t0 = Date.now();
  await page.setInputFiles('input[type="file"]', UPLOAD);
  const id = await songId(page);
  const secs = (Date.now() - t0) / 1000;
  await page.waitForSelector("audio", { state: "attached", timeout: 15000 });
  const tab = await tabNotes(page);
  await page.screenshot({ path: `${SHOTS}/upload-song.png`, fullPage: false });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `${secs.toFixed(1)}s for a 4:17 song, ${tab}, song ${id}`;
});

await test("listen (mic) on a phone: silent start, live chords, done", async () => {
  const { page, errors } = await newPage(true);
  await page.getByRole("button", { name: /Listen/ }).click();
  const r = await liveCaptureFlow(page, 15, "listen");
  const id = await songId(page);
  const tab = await tabNotes(page);
  await page.screenshot({ path: `${SHOTS}/listen-song.png` });
  if (errors.length) throw new Error("page errors: " + errors.join(" | "));
  return `first live chord after ${r.firstChordAfter.toFixed(1)}s, ${tab}, song ${id}`;
});

await test("song page on another device: play-along clock works", async () => {
  const id = created.find(Boolean);
  if (!id) throw new Error("no song created earlier");
  const upload = results.find((r) => r.name.startsWith("upload"))?.note?.match(/song (\w+)/)?.[1];
  const { page } = await newPage(true);
  await page.goto(`${BASE}/song/${upload ?? id}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForTimeout(4000);
  const marks = await page.locator(".bg-now:visible").count();
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
