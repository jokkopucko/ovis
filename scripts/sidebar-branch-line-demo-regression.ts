import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Locator, type Page } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";
import { serveDemo } from "./demo-server.ts";

// Only this disposable demo fixture is rewritten; no live session is read.
const app = mkdtempSync(join(tmpdir(), "herdr-sidebar-branch-line-"));
const evidence = process.env["UI_EVIDENCE_DIR"];
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const marks = {
    w1C: { repo_key: "api", repo_name: "checkout-api", repo_root: "/tmp/checkout-api", checkout_path: "/tmp/checkout-api", is_linked_worktree: false },
    w1D: { repo_key: "api", repo_name: "checkout-api", repo_root: "/tmp/checkout-api", checkout_path: "/tmp/checkout-api-web", is_linked_worktree: true },
    w1H: { repo_key: "api", repo_name: "checkout-api", repo_root: "/tmp/checkout-api", checkout_path: "/tmp/checkout-api-flaky", is_linked_worktree: true },
    w1J: null, w1K: null, w1L: null,
  };
  const roster = (machines) => machines.map((machine) => {
    const copy = structuredClone(machine);
    for (const workspace of copy.snapshot?.workspaces ?? []) if (workspace.workspace_id in marks) workspace.worktree = marks[workspace.workspace_id];
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
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    const path = url.pathname.replace(/^\\/api\\/machines\\/[^/]+/, "/api");
    if (path === "/api/machines") return json({ machines: roster((await (await fetchDemo(input, init)).json()).machines) });
    // the sidebar's one read for every repository (#2661): each workspace answered by the list below
    if (path === "/api/worktree/inventory") {
      const entries = [];
      for (const id of url.searchParams.getAll("workspace_id")) {
        const answer = await window.fetch(url.pathname.slice(0, -"inventory".length) + "list?workspace_id=" + encodeURIComponent(id), init);
        const body = await answer.json();
        entries.push(answer.ok ? { workspace_id: id, listing: body } : { workspace_id: id, error: { status: answer.status, code: "not_git_repository", message: String(body.error) } });
      }
      return json({ entries });
    }
    if (path === "/api/worktree/list") {
      const id = url.searchParams.get("workspace_id");
      const entry = (open, checkout, branch, linked) => ({ path: checkout, branch, label: checkout, is_linked_worktree: linked, is_bare: false, is_detached: false, is_prunable: false, open_workspace_id: open });
      if (id === "w1C" || id === "w1D" || id === "w1H") return json({
        source: { repo_key: "api", repo_name: "checkout-api", repo_root: "/tmp/checkout-api", source_checkout_path: marks[id].checkout_path, source_workspace_id: id },
        worktrees: [entry("w1C", "/tmp/checkout-api", "main", false), entry("w1D", "/tmp/checkout-api-web", "feature/web", true), entry("w1H", "/tmp/checkout-api-flaky", "flaky-retry-test", true)],
      });
      if (id === "w1J") return json({
        source: { repo_key: "infra", repo_name: "infra", repo_root: "/tmp/infra", source_checkout_path: "/tmp/infra/", source_workspace_id: null },
        worktrees: [entry(null, "/tmp/infra", "develop", false)],
      });
      return json({ error: "not a git repository" }, 400);
    }
    return fetchDemo(input, init);
  };
})();`;

const row = (page: Page, id: string) => page.locator(`.workspace-group[data-workspace="${id}"]`);
const height = (page: Page, id: string) => row(page, id).locator(":scope > .workspace-header").evaluate((header) => header.getBoundingClientRect().height);

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "sidebar-branch-line.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./sidebar-branch-line.js"></script><script type="module"'));
  const server = serveDemo(app, { prefix: "/" });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) for (const theme of ["dark", "light"] as const) {
        const context = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US", colorScheme: theme }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US", colorScheme: theme });
        try {
          await context.addInitScript((value) => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: value })), theme);
          const page = await context.newPage();
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
          if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          const branchOf = (id: string) => row(page, id).locator(":scope > .workspace-header .workspace-branch-tail");
          const shown = async (id: string) => {
            if (!phone) {
              await branchOf(id).waitFor({ state: "attached" });
              assert.equal(await branchOf(id).isVisible(), false, `${id} at rest hides its branch under a mouse`);
              await row(page, id).locator(":scope > .workspace-header").hover();
            }
            await branchOf(id).waitFor();
          };
          await shown("w1J");
          await shown("w1D");
          assert.equal(await branchOf("w1C").count(), 0, "a repository on its default branch says no branch");
          assert.equal(await branchOf("w1J").textContent(), "develop", "a git folder herdr has not marked says its branch");
          assert.equal(await branchOf("w1D").textContent(), "web", "a worktree says its branch without the feature/ prefix");
          for (const id of ["w1D", "w1H"]) assert.equal(await page.locator(`.worktree-children .workspace-group[data-workspace="${id}"]`).count(), 1, `${id} sits under its repository`);
          const one = await height(page, "w1K");
          for (const id of ["w1C", "w1J", "w1D"]) assert.equal(await height(page, id), one, `${id} keeps one line's height, its branch beside its name`);
          const gap = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-2")));
          const cell = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--space-6")));
          const measure = (item: Locator, parts: { start: string; after?: string; state: string; menu: string }) => item.evaluate((node, parts) => {
            const rect = (selector: string) => node.querySelector(selector)!.getBoundingClientRect();
            const start = rect(parts.start), state = rect(parts.state), menu = node.querySelector(parts.menu)!, menuRect = menu.getBoundingClientRect();
            const after = parts.after ? rect(parts.after) : null;
            return {
              startLeft: start.left, startRight: start.right, afterLeft: after?.left ?? null, gap: after ? after.left - start.right : null,
              stateToEnd: node.getBoundingClientRect().right - state.right, stateWidth: state.width,
              stateShown: getComputedStyle(node.querySelector(parts.state)!).visibility !== "hidden",
              menuShown: getComputedStyle(menu).visibility !== "hidden" && menuRect.width > 0,
              menuOverState: menuRect.left >= state.left - 0.5 && menuRect.right <= state.right + 0.5,
              menuBeforeState: Math.abs(node.querySelector(`${parts.menu} button`)!.getBoundingClientRect().right - state.left) <= 0.5,
            };
          }, parts);
          const header = row(page, "w1D").locator(":scope > .workspace-header");
          const headerParts = { start: ".workspace-name", after: ".workspace-branch-tail", state: ".workspace-select > .sidebar-pane-meta", menu: ".workspace-actions" };
          const agent = page.locator(".agents-sidebar .agent-item:not([hidden])").first();
          const agentParts = { start: ".agent-title", state: ".agent-row-state", menu: ".agent-actions" };
          const agentsToggle = page.locator(".agent-section-toggle");
          if (await agentsToggle.getAttribute("aria-expanded") !== "true") await agentsToggle.click();
          await agent.waitFor();
          if (!phone) await page.mouse.move(1270, 890);
          for (const [what, item, parts] of [["w1D", header, headerParts], ["the first agent", agent, agentParts]] as const) {
            const rest = await measure(item, parts);
            if (rest.gap !== null) assert.ok(Math.abs(rest.gap - gap) <= 0.5, `${what}: the branch starts a gap after the name (${rest.gap}px)`);
            assert.ok(Math.abs(rest.stateToEnd) <= 0.5 && Math.abs(rest.stateWidth - cell) <= 0.5, `${what}: the state is a ${cell}px cell at the row's end (${rest.stateWidth}px, ${rest.stateToEnd}px short)`);
            assert.equal(rest.stateShown, true, `${what}: the state is in sight at rest`);
            if (phone) {
              assert.equal(rest.menuShown && !rest.menuOverState, true, `${what}: a finger's ⋯ stays in the row, beside the state`);
              continue;
            }
            assert.equal(rest.menuShown, false, `${what}: a mouse's row hides its ⋯ at rest`);
            await item.hover();
            const hovered = await measure(item, parts);
            assert.deepEqual([hovered.startLeft, hovered.startRight, hovered.afterLeft], [rest.startLeft, rest.startRight, rest.afterLeft], `${what}: the name and branch stay put under the pointer`);
            assert.equal(hovered.menuShown && hovered.menuBeforeState && !hovered.menuOverState && hovered.stateShown, true, `${what}: the ⋯ shows just before the state, which stays in sight`);
            await page.mouse.move(1270, 890);
          }
          // herdr's tree: the first worktree's branch runs on (a tee), the last one's stops halfway (an elbow)
          const branch = (id: string) => row(page, id).locator(":scope > .workspace-header").evaluate((header) => {
            const stem = getComputedStyle(header, "::before"), arm = getComputedStyle(header, "::after");
            const box = header.getBoundingClientRect();
            return { stem: box.height - parseFloat(stem.bottom) - parseFloat(stem.top), arm: parseFloat(arm.width), height: box.height };
          });
          const tee = await branch("w1D"), elbow = await branch("w1H");
          assert.equal(tee.stem, tee.height, "a worktree with a sibling below draws its branch the row's full height");
          assert.equal(elbow.stem, elbow.height / 2, "the last worktree's branch stops at its middle");
          assert.ok(tee.arm > 0 && elbow.arm > 0, "each worktree's branch reaches toward its row");
          if (evidence) {
            mkdirSync(evidence, { recursive: true });
            await page.locator(".machine-workspaces").first().screenshot({ path: join(evidence, `branch-line-${phone ? "phone" : "desktop"}-${theme}.png`) });
          }
          assert.deepEqual(errors, []);
          console.log(`PASS ${phone ? "phone" : "desktop"} ${theme}: every row is one line, a non-default branch dim right after its name, the state at its end with the ⋯ just before it under a pointer`);
        } finally { await context.close(); }
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      try {
        await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", sidebarRows: "two" })));
        const page = await context.newPage();
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".workspace-copy.is-two-line").first().waitFor();
        assert.equal(await page.locator(".workspace-branch-tail").count(), 0, "Two lines keeps its own task rows");
        console.log("PASS Two lines keeps its task rows and draws no branch at the row's end");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(true); }
} finally {
  rmSync(app, { recursive: true, force: true });
}
