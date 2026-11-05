/** Isolated real-component geometry regression: no herdr or user state. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { chromePath } from "./chrome-path.ts";

const root = mkdtempSync(join(tmpdir(), "ovis-artifacts-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
if (evidence) mkdirSync(evidence, { recursive: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;
try {
  const build = await Bun.build({
    entrypoints: ["scripts/artifacts-fixture.tsx"], outdir: root, target: "browser",
    define: { "process.env.NODE_ENV": '"development"' },
  });
  assert.ok(build.success, String(build.logs));
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/pane/artifacts") return Response.json({ artifacts: Array.from({ length: 40 }, (_, index) => ({
      url: `https://claude.ai/artifact/fixture-${index}`, title: `Published page ${index + 1}`, at: null,
    })) });
    if (path === "/") return new Response('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/artifacts-fixture.css"></head><body><div id="root"></div><script type="module" src="/artifacts-fixture.js"></script></body></html>', { headers: { "content-type": "text/html" } });
    const file = Bun.file(join(root, path.slice(1)));
    return await file.exists() ? new Response(file) : new Response(null, { status: 404 });
  } });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  for (const width of [390, 1440]) for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 500 }, isMobile: width === 390, hasTouch: width === 390, reducedMotion: "reduce" });
    try {
      await context.addInitScript((theme) => { localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme })); localStorage.setItem("ovis:composer-artifacts", "true"); }, theme);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      await page.goto(`http://127.0.0.1:${server.port}/`);
      await page.locator(".bg-tasks-toggle").click();
      const menu = page.locator(".bg-tasks-menu");
      await menu.waitFor({ state: "visible" });
      const bounds = await menu.evaluate((node) => {
        const box = node.getBoundingClientRect();
        const frame = document.querySelector("main")?.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, frameTop: frame?.top ?? 0, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight, viewportWidth: innerWidth, viewportHeight: innerHeight };
      });
      console.log(`${width} ${theme}: ${JSON.stringify(bounds)}`);
      if (evidence) await page.screenshot({ path: join(evidence, `artifacts-${width}-${theme}.png`) });
      assert.ok(bounds.top >= bounds.frameTop && bounds.bottom <= bounds.viewportHeight && bounds.left >= 0 && bounds.right <= bounds.viewportWidth, `menu outside pane: ${JSON.stringify(bounds)}`);
      assert.ok(bounds.scrollHeight > bounds.clientHeight, "long list scrolls inside the menu");
      await menu.evaluate((node) => { node.scrollTop = node.scrollHeight; });
      assert.ok(await menu.locator("a").last().isVisible());
      if (evidence) await page.screenshot({ path: join(evidence, `artifacts-${width}-${theme}-end.png`) });
      await page.keyboard.press("Escape");
      assert.equal(await menu.count(), 0);
    } finally { await context.close(); }
  }
  console.log("PASS artifacts menu: phone/desktop, light/dark, scrolling and Escape");
} finally {
  await browser?.close();
  server?.stop(true);
  rmSync(root, { recursive: true, force: true });
}
