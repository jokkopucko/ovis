import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { withDemoBrowser } from "./demo-browser.ts";

// Only this disposable demo fixture is rewritten; no live session is read.
const evidence = process.env["UI_EVIDENCE_DIR"];
const REVIEW = "w1C:p2";
const MOVED = ["w1J", "w1K", "w1L"];
const patch = `(() => {
  const EventSourceDemo = window.EventSource;
  const moved = new Set(${JSON.stringify(MOVED)});
  const roster = (machines) => {
    const out = structuredClone(machines);
    const local = out.find((machine) => machine.id === "local");
    const snapshot = local?.snapshot;
    if (!snapshot) return out;
    const shell = snapshot.panes.find((pane) => pane.pane_id === ${JSON.stringify(panes.shell)});
    if (shell && !snapshot.panes.some((pane) => pane.pane_id === ${JSON.stringify(REVIEW)})) {
      snapshot.panes.push({ ...structuredClone(shell), pane_id: ${JSON.stringify(REVIEW)}, terminal_id: "term_review", focused: false, label: "Review the refund path", agent: "codex", agent_status: "done" });
    }
    // the worktree agent carries every count a row can draw: its background tasks, a plan and its context
    const flaky = snapshot.panes.find((pane) => pane.pane_id === ${JSON.stringify(panes.flaky)});
    if (flaky) Object.assign(flaky, { background_tasks: 2, plan: { done: 1, total: 3, current: null }, context: { used: 120000, window: 200000 } });
    const remote = structuredClone(local);
    Object.assign(remote, { id: "build-box", name: "build-box", kind: "ssh", target: "build-box" });
    const keep = (snap, inRemote) => {
      snap.workspaces = snap.workspaces.filter((workspace) => moved.has(workspace.workspace_id) === inRemote);
      snap.tabs = snap.tabs.filter((tab) => moved.has(tab.workspace_id) === inRemote);
      snap.panes = snap.panes.filter((pane) => moved.has(pane.workspace_id) === inRemote);
      snap.agents = snap.agents.filter((agent) => snap.panes.some((pane) => pane.pane_id === agent.pane_id));
    };
    keep(remote.snapshot, true);
    keep(snapshot, false);
    return [...out, remote];
  };
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

const group = (page: Page, machine: string) => page.locator(`.machine-group[aria-label="PC ${machine}"]`);
const tree = (page: Page, machine: string) => group(page, machine).evaluate((section) =>
  [...section.querySelectorAll<HTMLElement>(".workspace-group[data-workspace]")].map((row) =>
    [row.dataset.workspace!, ...[...row.querySelectorAll<HTMLElement>(":scope > .workspace-agents > .workspace-agent")].map((agent) => agent.dataset.agentPane!)]));
const agent = (page: Page, machine: string, pane: string) => group(page, machine).locator(`.workspace-agent[data-agent-pane="${pane}"]`);

await withDemoBrowser({ tempPrefix: "herdr-sidebar-agent-tree-", prefix: "/", afterTransport: '<script src="./sidebar-agent-tree.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  writeFileSync(join(app, "sidebar-agent-tree.js"), patch);
  for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
    const label = `${phone ? "phone" : "desktop"} ${theme}`;
    const context = await newContext(phone
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: theme }
      : { viewport: { width: 1280, height: 900 }, colorScheme: theme });
    try {
      await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })), theme);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const open = async () => {
        await page.goto(`${baseUrl}?pane=${encodeURIComponent(panes.shell)}`);
        if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
        await group(page, "build-box").locator(".workspace-group").first().waitFor();
      };

      await open();
      assert.equal(await page.locator(".workspace-agents").count(), 0, "off by default, no agent hangs under a workspace");
      assert.deepEqual(await tree(page, "workstation"), [["w1C"], ["w1D"], ["w1H"]]);

      await page.evaluate(() => localStorage.setItem("ovis:sidebar-agent-tree", "true"));
      await open();
      await agent(page, "workstation", panes.api).waitFor();
      assert.deepEqual(await tree(page, "workstation"), [["w1C", panes.api, REVIEW], ["w1D", panes.web], ["w1H", panes.flaky]], "each workspace lists its agents, a shell none, a worktree its own");
      assert.deepEqual(await tree(page, "build-box"), [["w1J", panes.omp], ["w1K", panes.cli], ["w1L", panes.hermes]], "each PC its own");
      assert.equal(await group(page, "workstation").locator(`.workspace-agents[aria-label="Agents in checkout-api"] > li`).count(), 2, "the list names its workspace, and a screen reader counts its rows");
      assert.equal((await agent(page, "workstation", REVIEW).locator(".workspace-agent-place").textContent())?.trim(), "release", "the tab's name where the workspace has several");
      assert.equal(await agent(page, "workstation", panes.web).locator("[data-status]").getAttribute("data-status"), "blocked", "the agent's state in the trailing cell");
      assert.ok(await page.locator(`.agent-list .agent-item[data-pane="${panes.api}"]`).count() > 0, "the Agents list is still there");
      const fit = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>(".machine-list")!;
        const box = list.getBoundingClientRect();
        const rows = [...document.querySelectorAll<HTMLElement>(".workspace-agent")].map((row) => row.getBoundingClientRect());
        const header = document.querySelector<HTMLElement>(".worktree-children .workspace-header")!.getBoundingClientRect();
        return { overflow: list.scrollWidth - list.clientWidth, inside: rows.every((row) => row.left >= box.left - 0.5 && row.right <= box.right + 0.5), heights: [...new Set(rows.map((row) => Math.round(row.height)))], header: Math.round(header.height) };
      });
      assert.equal(fit.overflow, 0, "no sideways scroll");
      assert.ok(fit.inside, "the rows stay inside the list");
      assert.deepEqual(fit.heights, [fit.header], "an agent row is a one-line workspace row's height");

      await agent(page, "workstation", panes.web).locator("button").click();
      if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
      await page.waitForFunction((pane) => document.querySelector(`.workspace-agent[data-agent-pane="${pane}"]`)?.classList.contains("is-selected"), panes.web);
      const fills = await page.evaluate((pane) => {
        const row = document.querySelector<HTMLElement>(`.workspace-agent[data-agent-pane="${pane}"]`)!;
        const header = row.closest(".workspace-group")!.querySelector<HTMLElement>(":scope > .workspace-header")!;
        return { row: getComputedStyle(row).backgroundColor, header: getComputedStyle(header).backgroundColor, current: row.querySelector("button")!.getAttribute("aria-current") };
      }, panes.web);
      assert.equal(fills.current, "true");
      assert.notEqual(fills.row, "rgba(0, 0, 0, 0)", "the agent's row is filled");
      assert.equal(fills.header, "rgba(0, 0, 0, 0)", "its workspace's row is not filled twice");

      const checkout = group(page, "workstation").locator('.workspace-group[data-workspace="w1C"] > .workspace-header .workspace-select');
      const where = await page.evaluate(() => sessionStorage.getItem("ovis:selection"));
      if (phone) await checkout.tap(); else await checkout.click();
      await page.waitForFunction(() => document.querySelector('.workspace-group[data-workspace="w1C"] > .workspace-agents') === null);
      assert.deepEqual((await tree(page, "workstation"))[0], ["w1C"], "the agents are put away");
      assert.equal(await checkout.getAttribute("aria-expanded"), "false");
      assert.equal((await group(page, "workstation").locator('.workspace-group[data-workspace="w1C"] .workspace-fold-count').textContent())?.trim(), "+3", "the row counts what it put away: its two agents and the worktree not selected, one fold for both");
      assert.equal(await page.evaluate(() => sessionStorage.getItem("ovis:selection")), where, "folding opened nothing");
      if (phone) assert.equal(await page.locator('#drawer-toggle').getAttribute("aria-expanded"), "true", "the drawer stays open");
      if (evidence) await page.locator(".sidebar-shell").screenshot({ path: join(evidence, `agent-tree-folded-${phone ? "390" : "1280"}-${theme}.png`) });
      await open();
      assert.deepEqual((await tree(page, "workstation"))[0], ["w1C"], "the fold is kept on this device");
      await checkout.focus();
      await page.keyboard.press("ArrowRight");
      await agent(page, "workstation", panes.api).waitFor();
      assert.equal(await checkout.getAttribute("aria-expanded"), "true", "Right unfolds");
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        await page.locator(".sidebar-shell").screenshot({ path: join(evidence, `agent-tree-${phone ? "390" : "1280"}-${theme}.png`) });
      }
      if (!phone) {
        await page.evaluate(() => { localStorage.setItem("ovis:sidebar-width", "240"); localStorage.setItem("ovis:sidebar-context", "true"); });
        await open();
        await agent(page, "workstation", panes.flaky).locator(".context-count").waitFor();
        assert.ok(Math.abs((await page.locator(".sidebar-shell").boundingBox())!.width - 240) <= 1, "the sidebar at its narrowest");
        const narrow = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>(".workspace-agent-select")].map((row) => {
          const title = row.querySelector(".workspace-agent-title")!.getBoundingClientRect();
          const state = row.querySelector(".sidebar-pane-meta")!.getBoundingClientRect();
          const group = row.querySelector(".workspace-agent-badges")?.getBoundingClientRect();
          const counts = [...row.querySelectorAll(".background-count, .plan-count, .context-count")].map((count) => Math.min(count.getBoundingClientRect().right, group?.right ?? Infinity));
          return { pane: row.parentElement!.dataset.agentPane!, title: title.width, counts: counts.length, clear: counts.every((right) => right <= state.left + 0.5) && title.right <= state.left + 0.5 };
        }));
        assert.ok(narrow.some((row) => row.counts > 0), "the demo draws counts on some agent rows");
        for (const row of narrow) {
          assert.ok(row.title >= 40, `${row.pane}: the title keeps some width at 240 px (${row.title})`);
          assert.ok(row.clear, `${row.pane}: nothing reaches the state cell at 240 px`);
        }
        if (evidence) await page.locator(".machine-list").screenshot({ path: join(evidence, `agent-tree-240-${theme}.png`) });
        await page.evaluate(() => { localStorage.removeItem("ovis:sidebar-width"); localStorage.removeItem("ovis:sidebar-context"); });
      }
      assert.deepEqual(errors, []);
      console.log(`PASS ${label}: off by default; on, each PC lists its workspaces and their agents, opens one in place, folds a row's agents from the row and keeps the Agents list`);
    } finally { await context.close(); }
  }
});
