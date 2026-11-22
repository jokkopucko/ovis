import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { openLens } from "./header-lens.ts";

const TOUCH_TARGET = 44;
const CLEARANCE = 6;

export async function checkHeaderLensSwitch(browser: Browser, origin: string, evidence?: string): Promise<void> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-lens-switch-")));
  let workspaceId: string | null = null;
  try {
    const created = await workspaceCreate({ cwd: root, label: "ovis-test-lens-switch" });
    workspaceId = created.workspace.workspace_id;
    for (const size of [
      { label: "folded 412x915", width: 412, height: 915, inset: 0 },
      { label: "notched 412x915", width: 412, height: 915, inset: 28 },
      { label: "unfolded 720x870", width: 720, height: 870, inset: 0 },
      { label: "landscape 740x360", width: 740, height: 360, inset: 0 },
      { label: "compact density 412x915", width: 412, height: 915, inset: 0, density: "compact" },
    ] as Array<{ label: string; width: number; height: number; inset: number; density?: string }>) {
      const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: "en-US" });
      try {
        await context.addInitScript((density) => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", ...(density ? { density } : {}) }));
        }, size.density ?? null);
        const page = await context.newPage();
        if (size.inset > 0) {
          const cdp = await context.newCDPSession(page);
          await cdp.send("Emulation.setSafeAreaInsetsOverride" as never, { insets: { top: size.inset, topMax: size.inset, left: 0, leftMax: 0, bottom: 0, bottomMax: 0, right: 0, rightMax: 0 } } as never);
        }
        await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
        if (size.width <= 640) {
          const toggle = page.locator(".app-header .lens-toggle");
          await toggle.waitFor();
          const placed = await page.evaluate(() => {
            const header = document.querySelector(".app-header")!;
            return { header: header.getBoundingClientRect().toJSON() as DOMRect, button: document.querySelector(".app-header .lens-toggle")!.getBoundingClientRect().toJSON() as DOMRect,
              insetTop: parseFloat(getComputedStyle(header).paddingTop), track: document.querySelector(".app-header .view-switch") !== null, counts: document.querySelector(".app-header .header-counts") !== null };
          });
          const bar = { top: placed.header.top + placed.insetTop, bottom: placed.header.bottom };
          assert.ok(Math.abs(placed.insetTop - size.inset) <= 0.5, `${size.label}: the header's top padding is the emulated safe-area inset, ${size.inset}px (${placed.insetTop}px)`);
          assert.equal(placed.track, false, `${size.label}: a phone draws no two-option track`);
          assert.equal(placed.counts, false, `${size.label}: a phone's header counts no running or finished sessions`);
          assert.ok(placed.button.width >= TOUCH_TARGET - 0.5 && placed.button.height >= TOUCH_TARGET - 0.5, `${size.label}: the lens button is a finger's ${TOUCH_TARGET}px (${JSON.stringify(placed.button)})`);
          assert.ok(placed.button.top >= bar.top - 0.5 && placed.button.bottom <= bar.bottom + 0.5, `${size.label}: the lens button stays inside the bar`);
          for (let press = 0; press < 2; press++) {
            const before = await toggle.getAttribute("data-view");
            const after = before === "chat" ? "terminal" : "chat";
            assert.equal(await toggle.getAttribute("aria-label"), `Switch to ${after}`, `${size.label}: the button names the lens a press opens`);
            await toggle.tap();
            await page.locator(`.app-header .lens-toggle[data-view="${after}"]`).waitFor();
            assert.equal(await toggle.getAttribute("aria-label"), `Switch to ${before}`, `${size.label}: after a press the button names the lens it left`);
          }
          if (evidence) await page.screenshot({ path: join(evidence, `lens-switch-${size.label.replace(/\s+/g, "-")}.png`), clip: { x: 0, y: 0, width: size.width, height: 140 } });
          continue;
        }
        await page.locator(".app-header .view-switch").waitFor();
        const geometry = await page.evaluate(() => {
          const box = (node: Element) => node.getBoundingClientRect();
          const header = document.querySelector(".app-header")!;
          const track = document.querySelector(".app-header .view-switch")!;
          const options = [...track.querySelectorAll(":scope > button")].map((button) => {
            const own = box(button);
            const expander = getComputedStyle(button, "::before");
            const grow = expander.content === "none" ? 0 : -parseFloat(expander.top);
            return { top: own.top - grow, bottom: own.bottom + grow, width: own.width };
          });
          return { header: box(header), track: box(track), options, insetTop: parseFloat(getComputedStyle(header).paddingTop),
            density: document.documentElement.dataset["density"] ?? null, controlH: parseFloat(getComputedStyle(track).getPropertyValue("--control-h")) };
        });
        assert.ok(Math.abs(geometry.insetTop - size.inset) <= 0.5, `${size.label}: the header's top padding is the emulated safe-area inset, ${size.inset}px (${geometry.insetTop}px)`);
        assert.equal(geometry.density, size.density ?? "comfortable", `${size.label}: the page runs in the ${size.density ?? "comfortable"} density`);
        const bar = { top: geometry.header.top + geometry.insetTop, bottom: geometry.header.bottom };
        assert.ok(geometry.track.top - bar.top >= CLEARANCE && bar.bottom - geometry.track.bottom >= CLEARANCE,
          `${size.label}: the switch leaves room above and below in the bar (${JSON.stringify({ bar, track: geometry.track })})`);
        assert.ok(Math.abs(geometry.track.height - geometry.controlH) <= 0.5, `${size.label}: the track is the density's --control-h, ${geometry.controlH}px (${geometry.track.height}px)`);
        for (const option of geometry.options) {
          assert.ok(option.bottom - option.top >= TOUCH_TARGET - 0.5, `${size.label}: an option's touch target is ${TOUCH_TARGET}px tall (${option.bottom - option.top})`);
          assert.ok(option.width >= TOUCH_TARGET - 0.5, `${size.label}: an option is a finger wide (${option.width})`);
          assert.ok(option.top >= bar.top - 0.5 && option.bottom <= bar.bottom + 0.5, `${size.label}: the touch target stays inside the bar`);
        }
        if (evidence) await page.screenshot({ path: join(evidence, `lens-switch-${size.label.replace(/\s+/g, "-")}.png`), clip: { x: 0, y: 0, width: size.width, height: 140 } });
      } finally { await context.close(); }
    }
    {
      const context = await browser.newContext({ viewport: { width: 720, height: 870 }, isMobile: true, hasTouch: true, locale: "en-US" });
      try {
        await context.addInitScript(() => {
          if (localStorage.getItem("ovis:settings") === null) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          const qa = window as unknown as { holdMedia: boolean; wideClicks: number; heldMedia: Array<() => void>; releaseMedia: () => void };
          qa.holdMedia = false;
          qa.wideClicks = 0;
          qa.heldMedia = [];
          qa.releaseMedia = () => { qa.holdMedia = false; for (const run of qa.heldMedia.splice(0)) run(); };
          const add = MediaQueryList.prototype.addEventListener;
          MediaQueryList.prototype.addEventListener = function (this: MediaQueryList, type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
            if (type !== "change" || !listener) return add.call(this, type, listener, options);
            const query = this;
            const wrapped = (event: Event) => {
              const deliver = () => typeof listener === "function" ? listener.call(query, event) : listener.handleEvent(event);
              if (qa.holdMedia) qa.heldMedia.push(deliver);
              else deliver();
            };
            return add.call(this, type, wrapped, options);
          } as typeof MediaQueryList.prototype.addEventListener;
          const matchMediaOwn = window.matchMedia.bind(window);
          window.matchMedia = (query: string) => {
            if (qa.holdMedia && query === "(max-width: 640px)") queueMicrotask(qa.releaseMedia);
            return matchMediaOwn(query);
          };
          document.addEventListener("click", (event) => {
            if ((event.target as Element | null)?.closest?.(".app-header .view-switch")) { qa.wideClicks += 1; if (qa.holdMedia) qa.releaseMedia(); }
          }, true);
        });
        const page = await context.newPage();
        await page.goto(`${origin}/?pane=${encodeURIComponent(created.root_pane.pane_id)}`);
        await page.locator(".app-header .view-switch").waitFor();
        await page.evaluate(() => { (window as unknown as { holdMedia: boolean }).holdMedia = true; });
        await page.setViewportSize({ width: 412, height: 915 });
        assert.equal(await page.evaluate(() => matchMedia("(min-width: 641px)").matches), false, "the page is a phone's width");
        assert.equal(await page.locator(".app-header .view-switch").count(), 1, "the wide switch is still drawn: its change is held");
        await openLens(page, "terminal");
        await page.locator('.app-header .lens-toggle[data-view="terminal"]').waitFor();
        assert.equal(await page.evaluate(() => (window as unknown as { wideClicks: number }).wideClicks), 0, "openLens never clicks the wide switch a phone's width no longer shows");
      } finally { await context.close(); }
    }
    console.log("PASS the touch header's Chat/Terminal switch: from 641px a compact track with room above and below and 44px touch targets inside the bar, on a phone one 44px button inside the bar that switches the lens and no session counts, folded, unfolded, landscape, under a notch and in the compact density");
  } finally {
    if (workspaceId) await workspaceClose(workspaceId).catch(() => {});
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await import("./test-herdr.ts");
  const { chromium } = await import("playwright-core");
  const { createServer } = await import("../server/index.ts");
  const { UsageService } = await import("../server/usage.ts");
  const state = mkdtempSync(join(tmpdir(), "ovis-lens-switch-state-"));
  const evidence = process.env["UI_EVIDENCE_DIR"];
  if (evidence) mkdirSync(evidence, { recursive: true });
  const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    await checkHeaderLensSwitch(browser, `http://127.0.0.1:${server.port}`, evidence);
  } finally {
    await browser.close();
    server.stop();
    rmSync(state, { recursive: true, force: true });
  }
}
