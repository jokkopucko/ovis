/**
 * The add-to-home-screen line (components/InstallHint.tsx) on the unmodified app over the demo's
 * fixture transport, as each browser it is for sees it: an iPhone's Safari tab names the steps
 * with the share glyph, an Android tab installs in one tap once Chrome offers its prompt and names
 * the menu item before that, and a dismissal or an install keeps it away after a reload. The
 * installed iPhone app and a desktop browser never show it. No prompt reaches a real browser; all
 * files and HTTP traffic stay in this disposable, loopback-only app, and no herdr session is opened.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { KO } from "../src/lib/i18n.ko.ts";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

type Theme = "light" | "dark";
type Language = "en" | "ko";
interface Shot { file: string; width: number; height: number; theme: Theme; language: Language; state: string; sha256: string; capturedAt: string }

const EVIDENCE = process.env.UI_EVIDENCE_DIR;
const manifest: Shot[] = [];
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const HINT = '[data-testid="install-hint"]';
const DISMISSED = "ovis:install-hint-dismissed";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

/** The demo transport ends its opening turn on a 4500 ms timer; held, so every frame shows the same turn. */
const HOLD_DEMO_TURN = `<script>(() => { const later = window.setTimeout; window.__laterTimeout = later; window.setTimeout = (callback, ms, ...args) => ms === 4500 ? (window.__heldDemoTurn = callback, 0) : later(callback, ms, ...args); })();</script>`;
const RELEASE_TIMERS = `<script>window.setTimeout = window.__laterTimeout;</script>`;

declare global {
  interface Window { __heldDemoTurn?: () => void; __prompted?: number }
}

const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

async function capture(page: Page, theme: Theme, language: Language, state: string): Promise<void> {
  if (!EVIDENCE) return;
  const viewport = page.viewportSize()!;
  const file = `install-hint-${viewport.width}-${theme}${language === "ko" ? "-ko" : ""}-${state}.png`;
  const path = join(EVIDENCE, file);
  await page.screenshot({ path, animations: "disabled" });
  manifest.push({ file, width: viewport.width, height: viewport.height, theme, language, state, sha256: sha256(path), capturedAt: new Date().toISOString() });
}

/** Chrome's prompt, as the page receives it: prompt() is counted and the choice is accepted. */
const offerPrompt = (page: Page): Promise<void> => page.evaluate(() => {
  window.__prompted = 0;
  const event = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), {
    prompt: async () => { window.__prompted = (window.__prompted ?? 0) + 1; },
    userChoice: Promise.resolve({ outcome: "accepted", platform: "web" }),
  });
  window.dispatchEvent(event);
});

async function run(browser: Browser, origin: string, theme: Theme, language: Language): Promise<void> {
  const label = (text: string): string => language === "ko" ? KO[text] ?? text : text;
  const tag = `${theme} ${language}`;
  const contexts: BrowserContext[] = [];
  const open = async (userAgent: string, options: { desktop?: boolean; standalone?: boolean; context?: BrowserContext } = {}) => {
    let context = options.context;
    if (!context) {
      context = await browser.newContext({
        viewport: options.desktop ? DESKTOP : PHONE, userAgent, locale: language === "ko" ? "ko-KR" : "en-US",
        ...(options.desktop ? {} : { deviceScaleFactor: 3, isMobile: true, hasTouch: true }),
      });
      contexts.push(context);
      await context.addInitScript(([settings, standalone]) => {
        if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", settings);
        if (standalone) Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
      }, [JSON.stringify({ language, theme }), options.standalone === true] as const);
    }
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(origin);
    await page.locator(".conn-live").waitFor();
    assert.equal(await page.evaluate(() => typeof window.__heldDemoTurn), "function", `${tag}: the demo's turn is held`);
    assert.equal(await page.evaluate(() => document.documentElement.dataset["theme"]), theme, `${tag}: drawn in the ${theme} theme`);
    return { context, page, errors };
  };
  const hint = (page: Page) => page.locator(HINT);
  const dismiss = (page: Page) => hint(page).getByRole("button", { name: label("Dismiss"), exact: true });
  const fits = (page: Page): Promise<boolean> => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth
    && [...document.querySelectorAll<HTMLElement>('[data-testid="install-hint"]')].every((el) => el.scrollWidth <= el.clientWidth + 0.5));
  const [iosBefore, iosAfter] = label("Add to Home Screen for alerts: {glyph} Share → Add to Home Screen").split("{glyph}");
  try {
    // ---- iPhone Safari: the steps with the share glyph; dismissed, gone for good ----------------
    {
      const { context, page, errors } = await open(IPHONE);
      await hint(page).waitFor();
      assert.equal(await hint(page).getAttribute("data-install-hint"), "ios");
      assert.equal(await hint(page).locator("span").textContent(), `${iosBefore}${iosAfter}`);
      assert.equal(await hint(page).locator(".install-hint-glyph").count(), 1, `${tag}: the share glyph sits in the steps`);
      assert.ok(await fits(page), `${tag}: the line fits a 390 px phone`);
      const box = (await dismiss(page).boundingBox())!;
      assert.ok(box.width >= 44 && box.height >= 44, `${tag}: Dismiss is a finger-sized target`);
      await capture(page, theme, language, "ios");
      await dismiss(page).click();
      await hint(page).waitFor({ state: "detached" });
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), DISMISSED), "1");
      await page.close();
      const again = await open(IPHONE, { context });
      assert.equal(await hint(again.page).count(), 0, `${tag}: a dismissal keeps the line away after a reload`);
      assert.deepEqual([...errors, ...again.errors], []);
    }

    {
      const { page, errors } = await open(IPHONE, { standalone: true });
      assert.equal(await hint(page).count(), 0, `${tag}: the installed iPhone app shows no line`);
      assert.deepEqual(errors, []);
    }

    // ---- Android Chrome: the menu item, then one tap once Chrome offers its prompt ---------------
    {
      const { context, page, errors } = await open(ANDROID);
      await hint(page).waitFor();
      assert.equal(await hint(page).getAttribute("data-install-hint"), "android");
      assert.equal(await hint(page).locator("span").textContent(), label("Install the app for alerts: Menu → Install app"));
      assert.equal(await hint(page).getByRole("button", { name: label("Install"), exact: true }).count(), 0, `${tag}: no Install button without Chrome's prompt`);
      assert.ok(await fits(page));
      await capture(page, theme, language, "android-menu");
      await offerPrompt(page);
      const install = hint(page).getByRole("button", { name: label("Install"), exact: true });
      await install.waitFor();
      assert.equal(await hint(page).locator("span").textContent(), label("Install the app for alerts."));
      const box = (await install.boundingBox())!;
      assert.ok(box.height >= 44, `${tag}: Install is a finger-sized target`);
      assert.ok(await fits(page));
      await capture(page, theme, language, "android-install");
      await install.click();
      await page.waitForFunction(() => window.__prompted === 1);
      await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
      await hint(page).waitFor({ state: "detached" });
      assert.equal(await page.evaluate((key) => localStorage.getItem(key), DISMISSED), "1", `${tag}: an install is remembered`);
      await page.close();
      const again = await open(ANDROID, { context });
      assert.equal(await hint(again.page).count(), 0, `${tag}: after an install the line stays away`);
      assert.deepEqual([...errors, ...again.errors], []);
    }

    {
      const { page, errors } = await open(DESKTOP_UA, { desktop: true });
      await offerPrompt(page);
      assert.equal(await hint(page).count(), 0, `${tag}: a desktop browser shows no line, even with a prompt`);
      await capture(page, theme, language, "desktop");
      assert.deepEqual(errors, []);
    }
  } finally {
    for (const context of contexts) await context.close();
  }
  console.log(`PASS install hint ${tag}: iPhone steps with the share glyph, Android menu then one-tap Install, dismissal and install remembered, none in the home-screen app or on desktop`);
}

const app = mkdtempSync(join(tmpdir(), "herdr-install-hint-demo-"));
try {
  await buildDemoApp(app);
  const index = join(app, "index.html");
  const html = readFileSync(index, "utf8");
  assert.match(html, /<script type="module"/);
  writeFileSync(index, html.replace(/<script type="module"/, () => `${HOLD_DEMO_TURN}<script src="./demo-transport.js"></script>${RELEASE_TIMERS}\n    <script type="module"`));
  const server = serveDemo(app);
  try {
    if (EVIDENCE) mkdirSync(EVIDENCE, { recursive: true });
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      const origin = `http://127.0.0.1:${server.port}/herdr-web-ui/demo/app/`;
      for (const [theme, language] of [["light", "en"], ["dark", "en"], ["light", "ko"]] as const) await run(browser, origin, theme, language);
    } finally { await browser.close(); }
  } finally { server.stop(true); }
  if (EVIDENCE) writeFileSync(join(EVIDENCE, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
} finally {
  rmSync(app, { recursive: true, force: true });
}
