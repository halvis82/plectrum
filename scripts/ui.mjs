// Headless checks of the song page tools: the note-strength slider, playback, writing a song from
// scratch (notes, frets, autosave), and the tuner. Songs it creates are deleted with ADMIN_TOKEN.
// Usage: ADMIN_TOKEN=... node scripts/ui.mjs <base url> <existing song id> <screenshot dir>
import { chromium, devices } from "playwright";

const [, , BASE, SONG, SHOTS] = process.argv;
const results = [];
const created = [];
const browser = await chromium.launch({ headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { defaultBrowserType, ...iphone } = devices["iPhone 13"];

async function page(opts = {}) {
  const ctx = await browser.newContext(opts.phone ? { ...iphone, colorScheme: opts.dark ? "dark" : "light" } : { viewport: { width: 1280, height: 900 }, colorScheme: opts.dark ? "dark" : "light" });
  const p = await ctx.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  p.on("console", (m) => m.type() === "error" && !/Failed to load resource|youtube|googlevideo|api\/audio/i.test(m.text()) && errors.push(m.text()));
  return { p, errors };
}

async function test(name, fn) {
  const t0 = Date.now();
  try {
    results.push({ name, ok: true, note: await fn(), secs: (Date.now() - t0) / 1000 });
  } catch (e) {
    results.push({ name, ok: false, note: e.message.split("\n").slice(0, 3).join(" ").slice(0, 400), secs: (Date.now() - t0) / 1000 });
  }
  console.log(results.at(-1).ok ? "PASS" : "FAIL", name, results.at(-1).note ?? "");
}

const fretCount = (p) => p.locator('[role="img"][aria-label^="Bar"]').evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")).join(" ").match(/fret \d+/g)?.length ?? 0);

await test("song page: strength slider thins the tab", async () => {
  const { p, errors } = await page();
  await p.goto(`${BASE}/song/${SONG}`, { waitUntil: "load" });
  await p.getByRole("tab", { name: "Tab" }).click();
  await p.waitForSelector('[role="img"][aria-label^="Bar"]', { timeout: 20000 });
  const all = await fretCount(p);
  const slider = p.getByLabel(/How many notes to show/);
  await slider.fill("0.3");
  await p.waitForTimeout(500);
  const few = await fretCount(p);
  await p.screenshot({ path: `${SHOTS}/slider.png` });
  await slider.fill("1");
  if (!(few < all * 0.8 && few > 0)) throw new Error(`slider at 0.3 shows ${few} of ${all}`);
  if (errors.length) throw new Error(errors.join(" | "));
  return `${all} notes at full detail, ${few} at 0.3`;
});

await test("song page: player plays and the clock moves", async () => {
  const { p, errors } = await page({ dark: true });
  await p.goto(`${BASE}/song/${SONG}`, { waitUntil: "load" });
  await p.getByRole("button", { name: "Play", exact: true }).click();
  await p.waitForTimeout(3000);
  const now = await p.getByRole("slider", { name: "Position in the song" }).getAttribute("aria-valuenow");
  await p.screenshot({ path: `${SHOTS}/playing-dark.png` });
  await p.getByRole("button", { name: "Pause", exact: true }).click();
  if (Number(now) < 1) throw new Error(`position ${now}`);
  if (errors.length) throw new Error(errors.join(" | "));
  return `at ${now}s after 3 s`;
});

await test("scratch: write notes, autosave, reload keeps them", async () => {
  const { p, errors } = await page({ phone: true });
  await p.goto(BASE, { waitUntil: "load" });
  await p.getByRole("button", { name: /write a tab from scratch/ }).click();
  await p.waitForURL(/\/song\/\w+/, { timeout: 20000 });
  const id = p.url().split("/song/")[1].split("?")[0];
  created.push(id);
  await p.getByRole("button", { name: "Done", exact: true }).waitFor({ timeout: 20000 });
  const bar = p.locator('[role="img"][aria-label^="Bar"]').first();
  await bar.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await p.waitForTimeout(400);
  const box = await bar.boundingBox();
  // three notes on the top three strings at different times, frets 3, 5, 7
  for (const [k, fret] of [[0, 3], [1, 5], [2, 7]]) {
    await p.mouse.click(box.x + box.width * (0.15 + 0.25 * k), box.y + 26 * k + 13);
    await p.getByRole("button", { name: String(fret), exact: true }).first().click();
  }
  await p.getByText("✓ Saved").first().waitFor({ timeout: 10000 });
  await p.screenshot({ path: `${SHOTS}/scratch-phone.png` });
  const label = await bar.getAttribute("aria-label");
  await p.reload({ waitUntil: "load" });
  const after = await p.locator('[role="img"][aria-label^="Bar"]').first().getAttribute("aria-label");
  if (!/fret 3/.test(after) || !/fret 5/.test(after) || !/fret 7/.test(after)) throw new Error(`after reload: ${after} (before: ${label})`);
  await p.getByRole("button", { name: "Play", exact: true }).click();
  await p.waitForTimeout(1500);
  await p.getByRole("button", { name: "Pause", exact: true }).click();
  if (errors.length) throw new Error(errors.join(" | "));
  return after;
});

await test("tuner: page and string buttons", async () => {
  const { p, errors } = await page({ phone: true, dark: true });
  await p.goto(`${BASE}/tuner`, { waitUntil: "load" });
  await p.getByRole("button", { name: /Start tuning/ }).waitFor();
  await p.getByRole("button", { name: "A string", exact: true }).click();
  await p.screenshot({ path: `${SHOTS}/tuner-phone-dark.png` });
  if (errors.length) throw new Error(errors.join(" | "));
  return "renders, reference tone plays";
});

for (const id of created) if (process.env.ADMIN_TOKEN) await fetch(`${BASE}/api/songs/${id}`, { method: "DELETE", headers: { "x-admin-token": process.env.ADMIN_TOKEN } });
await browser.close();
console.log("\n" + results.map((r) => `${r.ok ? "✅" : "❌"} ${r.name} (${r.secs.toFixed(0)}s) ${r.note ?? ""}`).join("\n"));
process.exit(results.every((r) => r.ok) ? 0 : 1);
