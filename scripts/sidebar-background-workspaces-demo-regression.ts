import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// Only this disposable demo fixture is rewritten; no live session is read.
const evidence = process.env["UI_EVIDENCE_DIR"];
const TAGGED = ["w1J", "w1H"];
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const tagged = new Set(${JSON.stringify(TAGGED)});
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const workspace of copy.snapshot?.workspaces ?? []) if (tagged.has(workspace.workspace_id)) workspace.tokens = { role: "background" };
    if (localStorage.getItem("test:blocked") === "1") for (const pane of copy.snapshot?.panes ?? []) if (pane.workspace_id === "w1L") pane.agent_status = "blocked";
    return copy;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") message.machines = roster(message.machines);
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
})();`;

const rows = (page: Page) => page.locator(".machine-workspaces li.workspace-group").evaluateAll((items) => items.map((item) => (item as HTMLElement).dataset.workspace));
const heading = (page: Page) => page.locator(".workspace-background-toggle");

await withDemoBrowser({ tempPrefix: "herdr-sidebar-background-", prefix: "/", afterTransport: '<script src="./sidebar-background.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  writeFileSync(join(app, "sidebar-background.js"), patch);
  for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
    const label = `${phone ? "phone" : "desktop"} ${theme}`;
    const width = phone ? 390 : 1280;
    const context = await newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme }
      : { viewport: { width: 1280, height: 900 }, colorScheme: theme });
    try {
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async (apart: boolean, pane = panes.shell, blocked = false) => {
        await page.goto(`${baseUrl}`);
        await page.evaluate(([value, on, block]) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value, sidebarBackgroundWorkspaces: on }));
          localStorage.setItem("test:blocked", block ? "1" : "0");
        }, [theme, apart, blocked] as const);
        await page.goto(`${baseUrl}?pane=${encodeURIComponent(pane)}`);
        if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await page.locator(`.machine-workspaces li.workspace-group[data-workspace="w1C"]`).waitFor();
      };
      const shot = async (name: string) => {
        if (!evidence) return;
        mkdirSync(evidence, { recursive: true });
        await page.locator(".machine-workspaces").first().screenshot({ path: join(evidence, `background-workspaces-${name}-${width}-${theme}.png`) });
      };

      await open(false);
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H", "w1J", "w1K", "w1L"], "off by default, the list keeps herdr's order");
      assert.equal(await heading(page).count(), 0, "off, no heading");

      await open(true);
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H"], "a folded part hides cli-tools and its worktrees; flaky-retry-test stays with checkout-api");
      assert.equal(await heading(page).getAttribute("aria-expanded"), "false");
      assert.equal((await heading(page).textContent())?.replace(/\s+/g, " ").trim(), "Background workspaces1", "the heading says what it holds and how many");
      assert.equal(await page.locator(".workspace-list-background").getAttribute("aria-label"), "Background workspaces", "the list says its group");
      const fits = await heading(page).evaluate((button) => {
        const list = button.closest(".machine-workspaces")!.getBoundingClientRect();
        const box = button.getBoundingClientRect();
        return box.height >= 24 && box.left >= list.left - 0.5 && box.right <= list.right + 0.5 && button.scrollWidth <= button.clientWidth;
      });
      assert.ok(fits, "the heading sits inside the list, unclipped");
      await shot("folded");

      await heading(page).focus();
      await page.keyboard.press("Enter");
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H", "w1J", "w1K", "w1L"]);
      assert.equal(await heading(page).getAttribute("aria-expanded"), "true");
      assert.equal(await page.evaluate(() => localStorage.getItem("ovis:workspaces-background-collapsed:local")), "0");
      await shot("open");
      await page.keyboard.press("Enter");
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H"]);

      await open(true, panes.cli);
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H", "w1J", "w1K", "w1L"], "the open tagged workspace stays in sight");
      await open(true, panes.shell, true);
      assert.deepEqual(await rows(page), ["w1C", "w1D", "w1H", "w1J", "w1K", "w1L"], "a question is never folded away");
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: off keeps herdr's order; on, tagged workspaces stand after the others under a folded heading with their count, the open one and a question in sight`);
    } finally { await context.close(); }
  }
});
