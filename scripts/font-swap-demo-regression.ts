import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { appFaces } from "./app-faces.ts";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// All files and HTTP traffic stay in this disposable, loopback-only app; no herdr session
// is opened.
const repo = join(import.meta.dir, "..");

interface View { top: number; gap: number; height: number; window: number }
const viewOf = (page: Page): Promise<View> => page.evaluate(() => {
  const node = document.querySelector<HTMLElement>(".chat-view")!;
  return { top: node.scrollTop, gap: Math.round(node.scrollHeight - node.clientHeight - node.scrollTop), height: node.scrollHeight, window: node.clientHeight };
});
const frames = (page: Page): Promise<void> => page.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const loadedFaces = (page: Page, family: string): Promise<number> => page.evaluate((name) => [...document.fonts].filter((face) => face.family.replace(/["']/g, "") === name && face.status === "loaded").length, family);

await withDemoBrowser({ tempPrefix: "herdr-font-swap-demo-" }, async ({ app, newContext, baseUrl }) => {
  const index = join(app, "index.html");
  // An installed Pretendard fallback can have identical metrics to the held web
  // face. Use a visibly different fallback so this fixture must exercise reflow.
  writeFileSync(index, readFileSync(index, "utf8").replace(/<html\b/, () => `<html style='--font-ui: "Pretendard Variable", monospace'`));
  // a request this script holds must be the only way to the face, on a developer's desktop that
  // has the font as on CI that has not: the built faces name their files alone, no installed copy
  const installed = readdirSync(join(app, "assets")).filter((entry) => entry.endsWith(".css") && /local\(/.test(readFileSync(join(app, "assets", entry), "utf8")));
  assert.deepEqual(installed, [], "the built stylesheet names no installed face before a file");

  const url = `${baseUrl}?pane=${encodeURIComponent(panes.web)}`;
  const open = async (stall: RegExp | null, height = 844, width = 390): Promise<{ page: Page; errors: string[]; held: () => number; release: () => void; close: () => Promise<void> }> => {
    const context = await newContext({ viewport: { width, height }, hasTouch: true, isMobile: true });
    await context.addInitScript(() => {
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem("ovis:ui-font", JSON.stringify('"Pretendard Variable", monospace'));
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let asked = 0;
    let release = (): void => undefined;
    const released = new Promise<void>((done) => { release = done; });
    await page.route("**/*.woff2", async (route) => {
      asked += 1;
      if (stall !== null && stall.test(route.request().url())) return;
      await released;
      await route.continue().catch(() => undefined);
    });
    await page.goto(url);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    await page.locator(".terminal-stack.is-chat").waitFor();
    await page.locator(".chat-turn").first().waitFor();
    assert.deepEqual(await page.locator(".chat-view").evaluate((node) => {
      const style = getComputedStyle(node);
      return [style.paddingTop, style.paddingBottom, getComputedStyle(node.querySelector(".chat-transcript")!).display];
    }), ["0px", "0px", "block"], "production CSS keeps spacing inside measured virtual rows");
    await page.waitForFunction(() => {
      const node = document.querySelector(".chat-view");
      return node !== null && node.scrollHeight - node.clientHeight - node.scrollTop <= 1;
    }, undefined, { timeout: 10_000 }).catch(async (error: unknown) => {
      console.error("CHAT_GEOMETRY", await page.locator(".chat-view").evaluate((node) => ({
        top: node.scrollTop, height: node.scrollHeight, viewport: node.clientHeight,
        nodes: [node, ...node.querySelectorAll("div")].map((item) => {
          const style = getComputedStyle(item), rect = item.getBoundingClientRect();
          return { class: item.className, inline: item.getAttribute("style"), top: rect.top, height: rect.height, padding: style.padding, margin: style.margin, position: style.position };
        }),
      })));
      throw error;
    });
    return { page, errors, held: () => asked, release, close: () => { release(); return context.close(); } };
  };

  {
    const { page, errors, held, release, close } = await open(null, 480);
    try {
      assert.ok(held() > 0, "the first drawing asked for a face");
      assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "the conversation is first drawn before the face comes");
      assert.equal(await loadedFaces(page, "JetBrains Mono Web"), 0, "and before the code face comes");
      const before = await viewOf(page);
      assert.ok(before.height > before.window + 48, `the conversation is longer than its window (${before.height} in ${before.window})`);
      assert.ok(before.gap <= 1, `an opened conversation is at its end (gap ${before.gap})`);
      release();
      await appFaces(page);
      await page.waitForFunction((height) => document.querySelector(".chat-view")?.scrollHeight !== height, before.height, { timeout: 10_000 }).catch(async (error: unknown) => {
        console.error("FONT_GEOMETRY", await page.locator(".chat-view").evaluate((node) => ({
          height: node.scrollHeight, top: node.scrollTop, viewport: node.clientHeight,
          rows: [...node.querySelectorAll("[data-chat-row]")].map((row) => ({ height: row.getBoundingClientRect().height, text: row.textContent, font: getComputedStyle(row).fontFamily })),
          paragraphs: [...node.querySelectorAll("p")].map((p) => ({ height: p.getBoundingClientRect().height, width: p.getBoundingClientRect().width, font: getComputedStyle(p).fontFamily, size: getComputedStyle(p).fontSize })),
          fonts: [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
        })));
        throw error;
      });
      const after = await viewOf(page);
      assert.notEqual(after.height, before.height, `the faces redrew the conversation at another height (${before.height} -> ${after.height})`);
      assert.ok(after.gap <= 1, `a reader at the end is still there after the faces came (gap ${after.gap}, height ${before.height} -> ${after.height})`);
      assert.deepEqual(errors, []);
      console.log(`PASS a reader at the end stays at the end when the faces swap in (height ${before.height} -> ${after.height})`);
    } finally { await close(); }
  }

  {
    // one file never comes: the set's "loadingdone" does not fire, and the face that did come still counts
    const { page, errors, release, close } = await open(/JetBrainsMono/, 480);
    try {
      assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "the conversation is first drawn before the face comes");
      const before = await viewOf(page);
      assert.ok(before.height > before.window + 48, `the conversation is longer than its window (${before.height} in ${before.window})`);
      assert.ok(before.gap <= 1, `an opened conversation is at its end (gap ${before.gap})`);
      release();
      await page.waitForFunction(() => [...document.fonts].some((face) => face.family.replace(/["']/g, "") === "Pretendard Variable" && face.status === "loaded"), null, { timeout: 10_000 });
      await frames(page);
      assert.equal(await page.evaluate(() => document.fonts.status), "loading", "another face is still on its way");
      assert.equal(await loadedFaces(page, "JetBrains Mono Web"), 0);
      await page.waitForFunction((height) => document.querySelector(".chat-view")?.scrollHeight !== height, before.height, { timeout: 10_000 });
      const after = await viewOf(page);
      assert.notEqual(after.height, before.height, `the face redrew the conversation at another height (${before.height} -> ${after.height})`);
      assert.ok(after.gap <= 1, `a face that came is followed while another is still on its way (gap ${after.gap}, height ${before.height} -> ${after.height})`);
      assert.deepEqual(errors, []);
      console.log(`PASS a face that arrived is followed while another file is still in flight (height ${before.height} -> ${after.height})`);
    } finally { await close(); }
  }

  {
    const { page, errors, release, close } = await open(null, 480);
    try {
      await page.evaluate(() => { document.querySelector(".chat-view")!.scrollTop = 0; });
      await frames(page);
      const up = await viewOf(page);
      assert.ok(up.top === 0 && up.gap > 48, `the reader is away from the end (gap ${up.gap})`);
      assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "and reads the first drawing, before the face comes");
      release();
      await appFaces(page);
      const after = await viewOf(page);
      assert.equal(after.top, 0, "a reader who scrolled up is left where they read");
      assert.ok(after.gap > 48, "and that was away from the end");
      assert.deepEqual(errors, []);
      console.log("PASS a reader who scrolled up is not pulled to the end when the faces swap in");
    } finally { await close(); }
  }

  const labels = ["second", "a long tab name for review", "deploy", "release notes draft", "perf investigation", "docs"];
  for (const scrolled of [false, true]) {
    const { page, errors, release, close } = await open(null, 900, 700);
    try {
      const workspace = panes.web.split(":")[0]!;
      for (const label of labels) {
        const made = await page.evaluate(async (body) => (await fetch("/api/tab/create", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).status, { workspace_id: workspace, label });
        assert.equal(made, 200, `the demo makes the tab "${label}"`);
      }
      const strip = page.locator(".tab-strip");
      const stripOf = (): Promise<{ left: number; max: number; open: boolean }> => strip.evaluate((node) => {
        const view = node.getBoundingClientRect();
        const item = node.querySelector(".tab-strip-item.is-active")!.getBoundingClientRect();
        const end = node.querySelector(".tab-strip-add")!.getBoundingClientRect().left;
        return { left: node.scrollLeft, max: node.scrollWidth - node.clientWidth, open: item.left >= view.left - 1 && item.right <= end + 1 };
      });
      const tabs = strip.locator('[role="tab"]');
      await tabs.nth(labels.length).waitFor();
      await strip.evaluate((node) => { node.scrollLeft = node.scrollWidth; });
      await frames(page);
      await tabs.nth(labels.length).tap();
      await strip.locator('[role="tab"][aria-selected="true"]', { hasText: "docs" }).waitFor();
      await frames(page);
      const opened = await stripOf();
      assert.ok(opened.open && opened.left > 48, `the last tab is open and in view, at the strip's far end (${JSON.stringify(opened)})`);
      assert.equal(await loadedFaces(page, "Pretendard Variable"), 0, "and is drawn before the face comes");

      if (scrolled) {
        await strip.evaluate((node) => { node.scrollLeft = 0; });
        await frames(page);
        const looking = await stripOf();
        assert.ok(looking.left === 0 && !looking.open, `the open tab is out of view, where the reader left the strip (${JSON.stringify(looking)})`);
      }
      release();
      await appFaces(page);
      const after = await stripOf();
      assert.notEqual(after.max, opened.max, `the faces redrew the tabs' names at another width (${opened.max} -> ${after.max})`);
      if (scrolled) {
        assert.equal(after.left, 0, "a strip the reader scrolled is left there when the faces come");
        assert.equal(after.open, false);
        await tabs.nth(0).tap();
        await strip.locator('[role="tab"][aria-selected="true"]').first().waitFor();
        await page.waitForFunction(() => document.querySelector('.tab-strip [role="tab"]')?.getAttribute("aria-selected") === "true");
        await frames(page);
        assert.ok((await stripOf()).open, "and a tab opened after that is in view");
      } else {
        assert.ok(after.open, `the open tab is in view again, the reader's scroll before they opened it forgotten (${JSON.stringify(after)})`);
      }
      assert.deepEqual(errors, []);
      console.log(scrolled
        ? "PASS a tab strip the reader scrolled away from the open tab stays put when the faces swap in"
        : `PASS a tab strip follows its open tab when the faces swap in, also after a scroll that ended in opening it (scrollLeft ${opened.left} -> ${after.left})`);
    } finally { await close(); }
  }
});
