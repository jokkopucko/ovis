/** Usage: bun scripts/sidebar-spacing-demo-regression.ts */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { withDemoBrowser } from "./demo-browser.ts";

const spacing = 16;

// the demo's one PC as two, each with the demo's own roster: only this disposable fixture rewrites it (as
// scripts/hide-pc-demo-regression.ts does)
const twoPcs = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  let last = null;
  const roster = (original) => ["local", "work"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : "Work PC";
    machine.state = "connected";
    return machine;
  });
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1;
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname.endsWith("/api/machines")) { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ ...value, machines: roster(last) }); }
    const match = url.pathname.match(/\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (match && path === "/api/session" && last) return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

const closeAgentWorkspaces = (page: Page) => page.evaluate(async () => {
  for (let closed = 0; closed < 32; closed++) {
    const { snapshot } = await (await fetch("/api/session")).json() as { snapshot: { panes: Array<{ pane_id: string; workspace_id: string; agent: string | null }>; agents: Array<{ pane_id: string }> } };
    const agentPanes = new Set(snapshot.agents.map((agent) => agent.pane_id));
    const pane = snapshot.panes.find((candidate) => agentPanes.has(candidate.pane_id) || (candidate.agent ?? "").trim() !== "");
    if (!pane) return closed;
    const response = await fetch("/api/workspace/close", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workspace_id: pane.workspace_id, close_group: true }) });
    if (!response.ok) throw new Error(`closing workspace ${pane.workspace_id} answered ${response.status}`);
  }
  throw new Error("the demo still lists an agent workspace after 32 closes");
});

const layout = (page: Page) => page.evaluate(() => {
  const box = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
  const list = document.querySelector<HTMLElement>(".machine-list")!;
  const contents = document.querySelector<HTMLElement>(".agent-list-contents")!;
  const rows = [...document.querySelectorAll<HTMLElement>(".machine-group:not([hidden])")].at(-1)!.getBoundingClientRect();
  const agents = box(".agents-sidebar");
  return {
    lineHeight: document.querySelector(".sidebar-split")?.getBoundingClientRect().height ?? 0,
    shellHeight: box(".sidebar-shell").height,
    rowsBottom: Math.min(rows.bottom, list.getBoundingClientRect().bottom),
    pcsCut: list.scrollHeight - list.clientHeight > 1,
    agentsTop: agents.top,
    agentsBottom: agents.bottom,
    agentsHeight: agents.height,
    agentsCut: !contents.hidden && contents.scrollHeight - contents.clientHeight > 1,
    footerTop: box(".sidebar-footer").top,
  };
});

await withDemoBrowser({ tempPrefix: "herdr-sidebar-spacing-demo-", prefix: "/app/", afterTransport: '\n    <script src="./two-pcs.js"></script>' }, async ({ app, newContext, baseUrl }) => {
  writeFileSync(join(app, "two-pcs.js"), twoPcs);

  for (const [mobile, empty] of [[false, false], [true, false], [false, true], [true, true]] as const) {
    const label = `${mobile ? "390px" : "desktop"}${empty ? " with no agents" : ""}`;
    const context = await newContext({
      viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 },
      isMobile: mobile,
      hasTouch: mobile,
    });
    await context.addInitScript(() => { localStorage.removeItem("ovis:pc-collapsed:local"); localStorage.removeItem("ovis:pc-collapsed:work"); });
    const page = await context.newPage();
    await page.goto(baseUrl);
    await page.locator(".conn-live").waitFor({ state: "attached" });
    if (empty) assert.ok(await closeAgentWorkspaces(page) > 0, `${label} closed the demo's agent workspaces`);
    if (mobile) await page.locator(".drawer-toggle").tap();
    const machineToggles = page.locator(".machine-toggle");
    const machineToggle = machineToggles.first();
    const agentToggle = page.locator(".agents-sidebar .agent-section-toggle");
    await machineToggles.nth(1).waitFor();
    if (empty) await page.locator(".agents-sidebar.is-empty .agent-empty").waitFor({ state: "attached" });
    if (await agentToggle.getAttribute("aria-expanded") !== "true") await agentToggle.click();
    if (!empty) {
      const resting = page.locator(".agents-sidebar .agent-resting-label .agent-background-toggle");
      await resting.click();
      assert.equal(await resting.getAttribute("aria-expanded"), "true", `${label} the resting line opens`);
    }
    const before = await page.locator(".agents-sidebar .agent-title").allTextContents();
    assert.equal(before.length > 0, !empty, `${label} ${empty ? "has no agent rows" : "has agent rows"} before folding`);
    assert.equal(await machineToggle.getAttribute("aria-expanded"), "true");

    const open = await layout(page);
    if (!empty) assert.ok(open.pcsCut, `${label} the two open PCs are longer than their list`);
    if (open.agentsCut) assert.ok(Math.abs(open.agentsHeight - open.shellHeight / 2) <= 1, `${label} with both lists long Agents takes half the sidebar (${open.agentsHeight}px of ${open.shellHeight}px)`);
    else assert.ok(open.agentsHeight <= open.shellHeight / 2 + 1, `${label} Agents with few rows takes no more than half the sidebar`);
    assert.ok(Math.abs(open.agentsBottom - open.footerTop) <= 1, `${label} Agents sits on the footer while the PCs are long`);
    assert.ok(!open.pcsCut || open.agentsTop - open.rowsBottom <= open.lineHeight + 1, `${label} the PC rows reach Agents while they are long`);

    await machineToggles.nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-workspaces").length === 1);
    const short = await layout(page);
    assert.ok(Math.abs(short.agentsBottom - short.footerTop) <= 1, `${label} Agents sits on the footer under one open PC`);
    if (!short.pcsCut && short.agentsCut) {
      assert.ok(short.agentsTop - short.rowsBottom <= spacing + short.lineHeight, `${label} Agents takes the height the PCs leave free (${short.agentsTop - short.rowsBottom}px left between them)`);
    } else if (!short.pcsCut && !short.agentsCut) {
      assert.ok(short.agentsTop - short.rowsBottom > spacing, `${label} with both lists short the gap lies above Agents, not under it`);
    }
    await machineToggles.nth(1).click();
    await page.waitForFunction(() => document.querySelectorAll(".machine-workspaces").length === 2);

    for (const toggle of await machineToggles.all()) await toggle.click();
    await page.waitForFunction(() => !document.querySelector(".machine-workspaces"));
    const metrics = await page.evaluate(() => {
      const box = (selector: string) => document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      const shell = box(".sidebar-shell")!;
      const machine = [...document.querySelectorAll<HTMLElement>(".machine-group")].at(-1)!.getBoundingClientRect();
      const list = box(".machine-list")!;
      const agents = box(".agents-sidebar")!;
      const contents = document.querySelector<HTMLElement>(".agent-list-contents")!;
      const footer = box(".sidebar-footer")!;
      return {
        lineHeight: box(".sidebar-split")?.height ?? 0,
        shellHeight: shell.height,
        machineBottom: machine.bottom,
        listBottom: list.bottom,
        agentsTop: agents.top,
        agentsBottom: agents.bottom,
        footerTop: footer.top,
        contentsCut: contents.scrollHeight - contents.clientHeight,
        contentsOverflow: getComputedStyle(contents).overflowY,
        footerBottom: footer.bottom,
        shellBottom: shell.bottom,
      };
    });
    if (metrics.contentsCut > 1) assert.ok(metrics.agentsTop - metrics.machineBottom <= spacing + metrics.lineHeight, `${label} folded PC gap is ${metrics.agentsTop - metrics.machineBottom}px`);
    assert.ok(metrics.listBottom - metrics.machineBottom <= spacing, `${label} folded list padding is ${metrics.listBottom - metrics.machineBottom}px`);
    assert.ok(metrics.contentsCut <= 1 || Math.abs(metrics.agentsBottom - metrics.footerTop) <= 1, `${label} Agents cuts rows only once it reaches the footer (${metrics.contentsCut}px cut, ${metrics.footerTop - metrics.agentsBottom}px left)`);
    assert.ok(Math.abs(metrics.agentsBottom - metrics.footerTop) <= 1, `${label} Agents ends above the footer`);
    assert.equal(metrics.contentsOverflow, "auto", `${label} Agents keeps scroll ownership`);
    assert.equal(Math.round(metrics.footerBottom), Math.round(metrics.shellBottom), `${label} footer stays at the bottom`);
    assert.deepEqual(await page.locator(".agents-sidebar .agent-title").allTextContents(), before, `${label} agent order is unchanged`);
    if (!mobile && !empty) {
      const agent = page.locator('.agents-sidebar .agent-item[data-machine="local"] .agent-select').first();
      await agent.click();
      await page.locator('.agents-sidebar .agent-item[data-machine="local"] .agent-select[aria-current="true"]').waitFor();
      assert.deepEqual(await machineToggles.evaluateAll((toggles) => toggles.map((toggle) => toggle.getAttribute("aria-expanded"))), ["false", "false"], `${label} picking an agent keeps its PC folded`);
    }

    await agentToggle.click();
    assert.equal(await agentToggle.getAttribute("aria-expanded"), "false");
    assert.equal(await page.locator(".agent-list-contents").getAttribute("hidden"), "");
    console.log(`PASS ${label} sidebar spacing after folding the PC section`);
    await context.close();
  }
});
