// Pastes each link into the home page, waits for the song page, checks the tab and the audio, and prints each song page URL.
import { chromium } from "playwright";
const [, , base, shots, ...links] = process.argv;
const browser = await chromium.launch({ headless: true });
for (const link of links) {
  const tag = new URL(link).hostname.replace(/^www\./, "").split(".")[0] + "-" + link.length;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on("pageerror", (e) => console.log("  pageerror:", e.message));
  const t0 = Date.now();
  try {
    await page.goto(base, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    await page.fill('input[type="url"]', link);
    await page.press('input[type="url"]', "Enter");
    const r = await Promise.race([
      page.waitForURL(/\/song\//, { timeout: 280000 }).then(() => "ok"),
      page.waitForSelector("p.bg-accent-soft", { timeout: 280000 }).then(async (el) => "error: " + (await el.textContent())),
    ]);
    const note = await page.locator("p.text-xs.text-muted.mt-2").first().textContent({ timeout: 500 }).catch(() => null);
    if (r !== "ok") {
      console.log(`❌ ${link}\n   ${r} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      await page.screenshot({ path: `${shots}/${tag}-error.png` });
      continue;
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(0);
    // the tab streams in after the song opens
    await page.waitForSelector('[role="img"][aria-label^="Bar"]', { timeout: 300000 });
    const bars = await page.locator('[role="img"][aria-label^="Bar"]').count();
    const title = await page.locator("h1").first().textContent();
    await page.waitForSelector("audio", { timeout: 60000 }).catch(() => {});
    const audio = await page.evaluate(async () => {
      const a = document.querySelector("audio");
      if (!a) return "none";
      for (let i = 0; i < 40 && a.readyState < 1 && !a.error; i++) await new Promise((r) => setTimeout(r, 500));
      return a.error ? "error" : `${a.duration.toFixed(0)}s`;
    });
    await page.screenshot({ path: `${shots}/${tag}.png` });
    console.log(`✅ ${link}\n   "${title}" ${secs}s, ${bars} tab bars, audio ${audio}${note ? `\n   note: ${note}` : ""}\n   ${page.url()}`);
  } catch (e) {
    console.log(`❌ ${link}\n   ${e.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
