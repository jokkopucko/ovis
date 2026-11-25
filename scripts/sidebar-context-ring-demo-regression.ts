import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// Only this disposable demo fixture is rewritten; no live session is read.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-context-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const contexts = {
    ${JSON.stringify(panes.api)}: { used: 120000, window: 200000 },
    ${JSON.stringify(panes.web)}: { used: 219640, window: 258400 },
    ${JSON.stringify(panes.omp)}: { used: 30000, window: null },
  };
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const pane of copy.snapshot?.panes ?? []) if (contexts[pane.pane_id]) pane.context = structuredClone(contexts[pane.pane_id]);
    return copy;
  });
  const sources = new Set();
  let last = [];
  window.__context = {
    // a roster with a pane's context changed, as a pane-status frame leaves it
    report(paneId, context) { contexts[paneId] = context; for (const source of sources) source.tell({ type: "machines", machines: roster(last) }); },
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(message.machines); }
        this.tell(message);
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    tell(message) { this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) })); }
    close() { this.inner.close(); this.readyState = 2; sources.delete(this); }
  };
})();`;

const row = (page: Page, pane: string) => page.locator(`.agent-list .agent-item[data-pane="${pane}"]`);
const ring = (page: Page, pane: string) => row(page, pane).locator(".context-count");

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "sidebar-context.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./sidebar-context.js"></script><script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
        const label = `${phone ? "phone" : "desktop"} ${theme}`;
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: theme });
        try {
          await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })), theme);
          // the demo's opening turn would finish the api agent on its own timer, and a resting agent folds under +N resting
          await context.addInitScript(() => Reflect.set(window, "__ovisDemoHoldTurn", true));
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          const open = async () => {
            await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.shell)}`);
            if (phone) {
              await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
              const toggle = page.locator(".agent-section-toggle");
              if (await toggle.getAttribute("aria-expanded") === "false") await toggle.click();
            }
            await row(page, panes.api).waitFor();
          };

          await open();
          assert.equal(await page.locator(".agent-list .context-count").count(), 0, "off by default, no row draws a ring");
          const heightOff = (await row(page, panes.api).boundingBox())!.height;

          await page.evaluate(() => localStorage.setItem("ovis:sidebar-context", "true"));
          await open();
          await ring(page, panes.api).waitFor();
          assert.equal(await ring(page, panes.api).getAttribute("aria-label"), "Context 40% left · 120k of 200k tokens", "the composer's words");
          assert.equal(await ring(page, panes.api).getAttribute("title"), "Context 40% left · 120k of 200k tokens", "and its tooltip");
          assert.equal((await ring(page, panes.api).textContent())?.trim(), "40%");
          assert.equal(await ring(page, panes.web).getAttribute("aria-label"), "Context 15% left · 220k of 258k tokens");
          assert.equal(await ring(page, panes.omp).count(), 0, "a window nothing names draws nothing");
          assert.equal(await ring(page, panes.shell).count(), 0, "a pane with no context draws nothing");
          const colors = await page.evaluate(([api, web]) => {
            const of = (pane: string) => getComputedStyle(document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .context-count`)!).color;
            const probe = document.createElement("span");
            probe.style.color = "var(--status-blocked)";
            document.body.append(probe);
            const blocked = getComputedStyle(probe).color;
            probe.remove();
            return { plain: of(api), low: of(web), blocked };
          }, [panes.api, panes.web] as const);
          assert.equal(colors.low, colors.blocked, "red at 20% left or less");
          assert.notEqual(colors.plain, colors.blocked, "plain above it");
          assert.equal((await row(page, panes.api).boundingBox())!.height, heightOff, "the row keeps its height");
          const inside = await row(page, panes.web).evaluate((item) => {
            const outer = item.getBoundingClientRect();
            const badge = item.querySelector(".context-count")!.getBoundingClientRect();
            return badge.width > 0 && badge.left >= outer.left && badge.right <= outer.right && badge.top >= outer.top && badge.bottom <= outer.bottom;
          });
          assert.ok(inside, "the ring is drawn inside its row");
          if (!phone) {
            for (const target of [panes.api, panes.web]) {
              const item = row(page, target);
              await item.hover();
              const clear = await item.evaluate((node) => {
                const badge = node.querySelector(".context-count")!.getBoundingClientRect();
                const button = node.querySelector(".agent-actions button")!.getBoundingClientRect();
                const state = node.querySelector(".agent-row-state")!.getBoundingClientRect();
                return {
                  badgeWidth: badge.width,
                  buttonWidth: button.width,
                  noOverlap: badge.right <= button.left + 0.5,
                  beforeState: Math.abs(button.right - state.left) <= 0.5,
                };
              });
              assert.ok(clear.badgeWidth > 0 && clear.buttonWidth > 0 && clear.noOverlap && clear.beforeState,
                `${label} (${target}): hover ⋯ sits beside the context ring without covering it (${JSON.stringify(clear)})`);
            }
            await page.mouse.move(1270, 890);
          }
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.locator(".agents-sidebar").screenshot({ path: join(evidence, `context-ring-${phone ? "390" : "1280"}-${theme}.png`) });
          }

          await page.evaluate((pane) => (window as unknown as { __context: { report(paneId: string, context: object | null): void } }).__context.report(pane, { used: 190000, window: 200000 }), panes.api);
          await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .context-count`)?.className === "context-count is-low", panes.api);
          assert.equal((await ring(page, panes.api).textContent())?.trim(), "5%");
          await page.evaluate((pane) => (window as unknown as { __context: { report(paneId: string, context: object | null): void } }).__context.report(pane, null), panes.api);
          await page.waitForFunction((pane) => document.querySelector(`.agent-list .agent-item[data-pane="${pane}"] .context-count`) === null, panes.api);
          assert.deepEqual(errors, []);
          console.log(`PASS ${label}: the ring is off by default; on, it draws the composer's words and threshold where a window is known, keeps the row's height and follows the roster`);
        } finally { await context.close(); }
      }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
