import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { appContext } from "./app-context.ts";
import { withDemoBrowser } from "./demo-browser.ts";

// A desktop Chromium turns no held touch into a contextmenu,
// so each long press is the touch-typed contextmenu the Android WebView sends for one (checked on
// an emulator in the PR). Loopback only; no herdr.
const evidence = process.env["UI_EVIDENCE_DIR"];

const PANE = panes.flaky;
const HREF = "https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/";
const WORDS = "the idempotency draft";
const MALFORMED = "http://127.0.0.1:99999/";
const README = `# Payments\n\nThe header is in [the draft](${HREF}).\n`;
const at = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const filler = (n: number): string => Array.from({ length: n }, (_, i) => `Step ${i + 1} reads the stored response and checks the key before it answers.`).join("\n\n");
const TURNS = [
  { role: "user", ts: at(30), parts: [{ kind: "text", text: "Which spec covers retried payments?" }] },
  { role: "assistant", ts: at(29), end_ts: at(28), parts: [{ kind: "text", text: filler(8) }] },
  { role: "user", ts: at(20), parts: [{ kind: "text", text: "Link it." }] },
  { role: "assistant", ts: at(19), end_ts: at(18), parts: [{ kind: "text", text: `Read [${WORDS}](${HREF}) first.\n\nIt names the header, and plain words here stay selectable.\n\nThe repository is https://github.com/example/payments for the code.\n\nThe local mirror was ${MALFORMED} once.` }] },
];

const harness = `<script>(() => {
  window.linkMenus = [];
  window.addEventListener("contextmenu", (event) => window.linkMenus.push({ prevented: event.defaultPrevented, pointerType: event.pointerType }));
  const demo = window.fetch;
  const pane = ${JSON.stringify(PANE)};
  const turns = ${JSON.stringify(TURNS)};
  const readme = ${JSON.stringify(README)};
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const path = url.searchParams.get("path") ?? "";
    if (path === "README.md" || path.endsWith("/README.md")) {
      if (url.pathname.endsWith("/fs/stat")) return Response.json({ path, name: "README.md", kind: "text", mime: "text/markdown", size: readme.length });
      if (url.pathname.endsWith("/fs/file")) return new Response(readme, { headers: { "content-type": "text/markdown" } });
    }
    if (url.pathname === "/api/pane/conversation" && url.searchParams.get("pane_id") === pane && !url.searchParams.has("before") && !url.searchParams.has("from")) {
      const response = await demo(input, init);
      if (!response.ok) return response;
      const body = await response.json();
      body.turns = structuredClone(turns);
      body.cursor = null;
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return demo(input, init);
  };
})();</script>`;

interface Setup { android: boolean; share?: boolean; language?: string }

async function open(browser: Browser, origin: string, url: string, setup: Setup, ready = ".chat-turn-agent .markdown a"): Promise<{ context: BrowserContext; page: Page; errors: string[] }> {
  const context = await appContext(browser, { viewport: { width: 390, height: 664 }, screen: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  // the address a link opens: answered here, so nothing leaves the machine
  await context.route(/^https:\/\/(datatracker\.ietf\.org|github\.com)\//, (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<title>opened</title>" }));
  await context.addInitScript(([paneId, { android, share, language }]) => {
    localStorage.setItem(`ovis:view:${paneId}`, "chat");
    if (language) localStorage.setItem("ovis:settings", JSON.stringify({ language }));
    if (android) (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, getPlatform: () => "android" };
    const shared: unknown[] = [];
    (window as unknown as { shared: unknown[] }).shared = shared;
    if (share) Object.defineProperty(navigator, "share", { configurable: true, value: (data: unknown) => { shared.push(data); return Promise.resolve(); } });
  }, [PANE, setup] as const);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await page.locator(".terminal-stack.is-chat").waitFor();
  await page.locator(ready).first().waitFor();
  return { context, page, errors };
}

const longPress = (page: Page, selector: string, text: string, pointerType = "touch"): Promise<boolean> => page.evaluate(([target, words, type]) => {
  const node = [...document.querySelectorAll<HTMLElement>(target)].find((element) => element.textContent?.includes(words));
  if (!node) throw new Error(`nothing at ${target} with "${words}"`);
  node.scrollIntoView({ block: "center" });
  const box = node.getClientRects()[0]!;
  const x = box.left + Math.min(box.width / 2, 40), y = box.top + box.height / 2;
  const under = document.elementFromPoint(x, y)!;
  return !under.dispatchEvent(new PointerEvent("contextmenu", { bubbles: true, cancelable: true, composed: true, pointerType: type, isPrimary: true, clientX: x, clientY: y }));
}, [selector, text, pointerType] as const);

const sheetAtRest = (page: Page): Promise<void> => page.locator(".row-sheet").evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)).then(() => undefined));

const sheetItems = (page: Page): Promise<string[]> => page.locator(".row-sheet .row-sheet-item .row-sheet-label").allTextContents();

let url = "";
let origin = "";
await withDemoBrowser({ tempPrefix: "herdr-link-menu-demo-", afterTransport: `\n    ${harness}` }, async ({ browser, origin: served }) => {
  origin = served;
  url = `${origin}/herdr-web-ui/demo/app/?pane=${encodeURIComponent(PANE)}`;
  const link = ".chat-turn-agent .markdown a";
  const words = ".chat-turn-agent .markdown p";

  {
    const { context, page, errors } = await open(browser, origin, url, { android: true });
    try {
      assert.equal(await longPress(page, link, WORDS), true, "the app cancels the WebView's long press on a link, which would only select its words");
      await page.locator(".row-sheet").waitFor();
      const native = await page.evaluate(() => typeof navigator.share === "function");
      assert.deepEqual(await sheetItems(page), native ? ["Copy link", "Open link", "Share link"] : ["Copy link", "Open link"], "Copy link and Open link, and Share link only where the WebView can share");
      assert.equal(await page.locator(".row-sheet-title").textContent(), WORDS, "the link's words are the sheet's title");
      assert.equal(await page.locator(".row-sheet-detail").textContent(), HREF, "its address is under them, whole");
      if (evidence) { await sheetAtRest(page); await page.screenshot({ path: join(evidence, "link-menu-390-android.png") }); }
      await page.locator(".row-sheet-item", { hasText: "Copy link" }).tap();
      await page.locator(".row-sheet").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HREF, "Copy link puts the address on the clipboard, not the words");
      console.log("PASS android: a long press on a link opens Copy link / Open link; Copy link copies the address");

      assert.equal(await longPress(page, link, WORDS), true);
      const opened = page.waitForEvent("popup");
      await page.locator(".row-sheet-item", { hasText: "Open link" }).tap();
      assert.equal((await opened).url(), HREF, "Open link opens the link's address");
      const tapped = page.waitForEvent("popup");
      await page.locator(link, { hasText: WORDS }).tap();
      assert.equal((await tapped).url(), HREF, "a tap on the link still opens it");
      assert.equal(await page.locator(".row-sheet").count(), 0, "a tap opens no sheet");
      console.log("PASS android: Open link opens the address as a tap does, and a tap still opens the link");

      assert.equal(await longPress(page, link, "github.com/example"), true);
      assert.equal(await page.locator(".row-sheet-title").textContent(), "github.com");
      assert.equal(await page.locator(".row-sheet-detail").textContent(), "https://github.com/example/payments", "a bare address shows whole under its host");
      await page.locator(".row-sheet-cancel").tap();
      await page.locator(".row-sheet").waitFor({ state: "detached" });

      assert.equal(await longPress(page, link, MALFORMED), true);
      await page.locator(".row-sheet").waitFor();
      assert.equal(await page.locator(".row-sheet-title").textContent(), MALFORMED, "a malformed address is its own title");
      assert.equal(await page.locator(".row-sheet-detail").count(), 0, "and is not repeated under itself");
      await page.locator(".row-sheet-item", { hasText: "Copy link" }).tap();
      await page.locator(".row-sheet").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), MALFORMED, "Copy link copies it as written");
      assert.equal(await page.locator(".terminal-stack.is-chat").count(), 1, "the app did not fall to its crash screen");
      console.log("PASS android: an address no URL parser takes gets its sheet and is copied as written");

      // other words keep the WebView's own long press (it selects them), and so does a mouse's menu on a link
      assert.equal(await longPress(page, words, "plain words here"), false, "a long press on other words is left to the WebView");
      assert.equal(await longPress(page, link, WORDS, "mouse"), false, "the contextmenu Android ends a dragged selection with is not the link's");
      assert.equal(await page.locator(".row-sheet").count(), 0, "neither opens the sheet");

      const transcript = page.locator(".chat-view-virtual, .chat-view").first();
      const before = await transcript.evaluate((node) => node.scrollTop);
      const box = (await page.locator(link, { hasText: WORDS }).boundingBox())!;
      const cdp = await context.newCDPSession(page);
      const x = Math.round(box.x + 20), y = Math.round(box.y + box.height / 2);
      let popups = 0;
      page.on("popup", () => { popups += 1; });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 10; step += 1) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 20 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForFunction(([node, from]) => document.querySelector<HTMLElement>(node)!.scrollTop !== from, [".chat-view-virtual, .chat-view", before] as const);
      assert.equal(await page.locator(".row-sheet").count(), 0, "a swipe opens no sheet");
      assert.equal(popups, 0, "a swipe opens no link");
      console.log("PASS android: other words and a mouse's menu keep their own long press; a swipe from a link scrolls");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page, errors } = await open(browser, origin, url, { android: true, share: true, language: "ko" });
    try {
      assert.equal(await longPress(page, link, WORDS), true);
      await page.locator(".row-sheet").waitFor();
      assert.deepEqual(await sheetItems(page), ["링크 복사", "링크 열기", "링크 공유"], "the sheet speaks the app's language");
      if (evidence) { await sheetAtRest(page); await page.screenshot({ path: join(evidence, "link-menu-390-android-ko-share.png") }); }
      await page.locator(".row-sheet-item", { hasText: "링크 공유" }).tap();
      await page.waitForFunction(() => (window as unknown as { shared: unknown[] }).shared.length === 1);
      assert.deepEqual(await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared), [{ url: HREF }], "Share link shares the address");
      console.log("PASS android: Share link shares the address where the WebView can share");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page, errors } = await open(browser, origin, `${url}&file=README.md`, { android: true }, ".file-viewer .markdown a");
    try {
      assert.equal(await page.locator(".file-viewer-scrim").count(), 1, "on a phone the file opens in its dialog");
      assert.equal(await longPress(page, ".file-viewer .markdown a", "the draft"), true);
      await page.locator(".row-sheet").waitFor();
      await sheetAtRest(page);
      if (evidence) await page.screenshot({ path: join(evidence, "link-menu-390-android-file-viewer.png") });
      // tap() presses only an item nothing covers: one under the file viewer fails here
      await page.locator(".row-sheet-item", { hasText: "Copy link" }).tap({ timeout: 3_000 });
      await page.locator(".row-sheet").waitFor({ state: "detached" });
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), HREF, "Copy link from a file preview copies its address");
      assert.equal(await page.locator(".file-viewer-scrim").count(), 1, "the preview stays open under the sheet");
      console.log("PASS android: a link in a file preview opens its sheet over the preview");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }

  {
    const { context, page, errors } = await open(browser, origin, url, { android: false });
    try {
      assert.equal(await longPress(page, link, WORDS), false, "a browser's long press on a link is its own");
      assert.equal(await page.locator(".row-sheet").count(), 0, "a browser gets no sheet");
      const menus = await page.evaluate(() => (window as unknown as { linkMenus: { prevented: boolean }[] }).linkMenus);
      assert.deepEqual(menus, [{ prevented: false, pointerType: "touch" }]);
      console.log("PASS browser: a long press on a link is left to the browser's own menu");
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  }
});
