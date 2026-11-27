import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// Chromium runs with its scrollbars drawn (Playwright's headless default hides them), as a desktop
// browser draws them: a press on the list's scrollbar drags that scrollbar, a press on the strip
// beside it resizes the sidebar, and nothing moves meanwhile.
const evidence = process.env["UI_EVIDENCE_DIR"] || null;

interface Edge { list: { top: number; right: number; height: number; clientWidth: number }; bar: number; sidebar: number; grip: { left: number; right: number; width: number } }
const edge = (page: Page): Promise<Edge> => page.evaluate(() => {
  const list = document.querySelector<HTMLElement>(".sidebar .machine-list")!;
  const box = list.getBoundingClientRect();
  const border = parseFloat(getComputedStyle(list).borderRightWidth);
  const grip = document.querySelector(".sidebar-resizer")!.getBoundingClientRect();
  return {
    list: { top: box.top, right: box.right - border, height: box.height, clientWidth: list.clientWidth },
    bar: list.offsetWidth - list.clientWidth - list.clientLeft - border,
    sidebar: Math.round(document.querySelector(".sidebar")!.getBoundingClientRect().width),
    grip: { left: grip.left, right: grip.right, width: grip.width },
  };
});
const HIT = `(([x, y]) => { const element = document.elementFromPoint(x, y); return element?.closest(".sidebar-resizer") ? "grip" : element?.closest(".machine-list") ? "list" : String(element?.className ?? "nothing"); })`;
const hit = (page: Page, x: number, y: number): Promise<string> => page.evaluate(`${HIT}([${x}, ${y}])`);
const waitForHit = (page: Page, x: number, y: number, want: "grip" | "list"): Promise<unknown> => page.waitForFunction(`${HIT}([${x}, ${y}]) === "${want}"`, undefined, { timeout: 5000 });

await withDemoBrowser({ tempPrefix: "herdr-sidebar-scrollbar-grip-", prefix: "/", ignoreDefaultArgs: ["--hide-scrollbars"] }, async ({ newContext, baseUrl }) => {
  for (const theme of ["dark", "light"] as const) {
    const context = await newContext({ viewport: { width: 1440, height: 380 }, colorScheme: theme });
    try {
      await context.addInitScript((settings) => {
        localStorage.setItem("ovis:settings", settings);
        localStorage.setItem("ovis:pane-lifetime:local", "demo-local");
      }, JSON.stringify({ language: "en", theme }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.api)}`);
      await page.locator(".conn-live").waitFor({ state: "attached" });
      await page.locator(".sidebar-resizer").waitFor();
      await page.waitForFunction(() => { const list = document.querySelector<HTMLElement>(".sidebar .machine-list"); return list !== null && list.scrollHeight > list.clientHeight; });

      const start = await edge(page);
      assert.ok(start.bar > 0, `${theme}: the PCs list draws a scrollbar (${start.bar}px)`);
      assert.ok(start.grip.left < start.list.right - start.bar, `${theme}: the grip's box reaches over the scrollbar (grip from ${start.grip.left}px, scrollbar ${start.list.right - start.bar}-${start.list.right}px)`);

      const barX = start.list.right - start.bar / 2;
      const barY = start.list.top + start.bar + 10;
      await page.mouse.move(barX - 60, barY);
      await page.mouse.move(barX, barY, { steps: 4 });
      await waitForHit(page, barX, barY, "list");
      await page.mouse.down();
      await page.mouse.move(barX, barY + 60, { steps: 6 });
      await page.mouse.up();
      await page.waitForFunction(() => document.querySelector<HTMLElement>(".sidebar .machine-list")!.scrollTop > 0, undefined, { timeout: 5000 });
      const scrolled = await edge(page);
      assert.equal(scrolled.sidebar, start.sidebar, `${theme}: dragging the scrollbar leaves the sidebar's width`);
      assert.deepEqual([scrolled.grip, scrolled.list.clientWidth], [start.grip, start.list.clientWidth], `${theme}: the grip and the list keep their boxes`);
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.screenshot({ path: join(evidence, `sidebar-scrollbar-grip-${theme}.png`), clip: { x: start.list.right - 160, y: 0, width: 240, height: 380 } });
      }

      const stripX = start.list.right + (start.grip.right - start.list.right) / 2;
      await page.mouse.move(stripX, barY, { steps: 3 });
      await waitForHit(page, stripX, barY, "grip");
      await page.mouse.down();
      await page.mouse.move(stripX + 30, barY, { steps: 3 });
      await page.mouse.up();
      await page.waitForFunction((was) => Math.round(document.querySelector(".sidebar")!.getBoundingClientRect().width) !== was, start.sidebar, { timeout: 5000 });
      const resized = await edge(page);
      assert.equal(resized.sidebar, start.sidebar + 30, `${theme}: the strip beside the scrollbar resizes`);

      const below = start.list.top + start.list.height + 40;
      assert.equal(await hit(page, resized.grip.left + 2, below), "grip", `${theme}: away from a scrollbar the grip takes its sidebar side too`);
      assert.deepEqual(errors, []);
      console.log(`PASS ${theme}: the PCs list's ${start.bar}px scrollbar under the grip scrolls the list (sidebar stays ${start.sidebar}px); the strip beside it resizes to ${resized.sidebar}px`);
    } finally { await context.close(); }
  }
});
