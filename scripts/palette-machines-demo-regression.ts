import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import panes from "../site/demo/fixtures/panes.json";
import { buildDemoApp } from "./demo-build.ts";
import { chromePath } from "./chrome-path.ts";

// All PCs deliberately reuse every herdr ID. Only this disposable demo fixture rewrites its
// roster; the app and its bound APIs are the production client. No live session is read.
const app = mkdtempSync(join(tmpdir(), "herdr-palette-machines-"));
const patch = `(() => {
  const fetchDemo = window.fetch.bind(window), EventSourceDemo = window.EventSource;
  const detachedRemote = new URLSearchParams(location.search).has("detached");
  const calls = window.paletteMachineCalls = { branches: [], plugins: [], focus: [], runs: [], closes: [], agents: [] };
  let last = null, offline = false, missing = false;
  const sources = new Set();
  const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  const roster = (original) => ["local", "remote", "offline"].map((id) => {
    const machine = structuredClone(original.find((item) => item.id === "local"));
    machine.id = id; machine.kind = id === "local" ? "local" : "ssh";
    machine.name = id === "local" ? "Laptop" : id === "remote" ? "Build PC" : "Old PC";
    machine.state = id === "offline" || (id === "remote" && offline) ? "disconnected" : "connected";
    if (id === "remote") machine.snapshot.panes.find((pane) => pane.pane_id === ${JSON.stringify(panes.api)}).label = "Remote migration";
    const workspace = machine.snapshot.workspaces[0];
    // the first workspace keeps one tab here, so closing it is closing the last tab: the demo's release shell tab is left out
    const shellTab = machine.snapshot.panes.find((pane) => pane.pane_id === ${JSON.stringify(panes.shell)})?.tab_id;
    machine.snapshot.panes = machine.snapshot.panes.filter((pane) => pane.tab_id !== shellTab);
    machine.snapshot.tabs = machine.snapshot.tabs.filter((tab) => tab.tab_id !== shellTab);
    machine.snapshot.layouts = machine.snapshot.layouts.filter((layout) => layout.tab_id !== shellTab);
    workspace.tab_count = machine.snapshot.tabs.filter((tab) => tab.workspace_id === workspace.workspace_id).length;
    workspace.worktree = { repo_key: "repo", repo_name: "project", repo_root: "/tmp/project", checkout_path: "/tmp/project/linked", is_linked_worktree: true };
    if (id === "remote" && missing) machine.snapshot.panes = machine.snapshot.panes.filter((pane) => pane.pane_id !== ${JSON.stringify(panes.api)});
    return machine;
  });
  window.setPaletteRemoteState = (gone, removed = false) => {
    offline = gone; missing = removed;
    for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify({ type: "machines", machines: roster(last) }) }));
  };
  window.EventSource = class extends EventTarget {
    constructor(url, options) {
      super(); this.inner = new EventSourceDemo(url, options); this.readyState = 1; sources.add(this);
      this.inner.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.type === "machines") { last = message.machines; message.machines = roster(last); }
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
      };
      this.inner.onerror = (event) => this.onerror?.(event);
      this.inner.onopen = (event) => this.onopen?.(event);
    }
    close() { sources.delete(this); this.inner.close(); this.readyState = 2; }
  };
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (url.pathname === "/api/machines") { const value = await (await fetchDemo(input, init)).json(); last = value.machines; return json({ machines: roster(last) }); }
    const match = url.pathname.match(/^\\/api\\/machines\\/([^/]+)(\\/.*)$/);
    const machine = match ? decodeURIComponent(match[1]) : "local";
    const path = match ? "/api" + match[2] : url.pathname;
    if (path === "/api/agents") {
      calls.agents.push(machine);
      if (machine === "remote") return json({ agents: [{ kind: "codex", label: "Codex" }, { kind: "letta", label: "Build PC agent" }] });
    }
    // the branch readers' one read per PC (#2661): each workspace answered by the list below
    if (path === "/api/worktree/inventory") {
      const entries = [];
      for (const id of url.searchParams.getAll("workspace_id")) {
        const answer = await window.fetch(url.pathname.slice(0, -"inventory".length) + "list?workspace_id=" + encodeURIComponent(id), init);
        entries.push({ workspace_id: id, listing: await answer.json() });
      }
      return json({ entries });
    }
    if (path === "/api/worktree/list") {
      calls.branches.push(machine);
      const id = url.searchParams.get("workspace_id");
      const detached = machine === "remote" && detachedRemote;
      return json({ source: { repo_key: "repo", source_workspace_id: id }, worktrees: [{ path: "/tmp/project/linked", branch: detached ? undefined : machine === "remote" ? "feature/remote-branch" : "feature/local-branch", is_detached: detached, open_workspace_id: id }] });
    }
    if (path === "/api/tab/close") { calls.closes.push({ machine, tab: JSON.parse(init.body).tab_id }); return json({ ok: true }); }
    if (path === "/api/plugins/actions") calls.plugins.push(machine);
    if (path === "/api/plugin/action" && init?.method === "POST") calls.runs.push(machine);
    if (path === "/api/pane/focus") { calls.focus.push({ machine, pane: JSON.parse(init.body).pane_id }); return json({ ok: true }); }
    if (match && path === "/api/session") return json({ snapshot: roster(last).find((item) => item.id === machine).snapshot });
    if (match) return fetchDemo(path + url.search, init);
    return fetchDemo(input, init);
  };
})();`;

try {
  await buildDemoApp(app);
  writeFileSync(join(app, "palette-machines.js"), patch);
  const index = join(app, "index.html");
  writeFileSync(index, readFileSync(index, "utf8").replace(/<script type="module"/, '<script src="./demo-transport.js"></script><script src="./palette-machines.js"></script><script type="module"'));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let file: string;
    try { file = decodeURIComponent(path.slice(1)); } catch { return new Response("bad path", { status: 400 }); }
    if (!file || file.endsWith("/")) file += "index.html";
    if (file.split("/").includes("..") || file.includes("\\")) return new Response("bad path", { status: 400 });
    const body = Bun.file(join(app, file));
    return await body.exists() ? new Response(body) : new Response("not found", { status: 404 });
  } });
  try {
    const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
    try {
      for (const phone of [false, true]) {
        const creationContext = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US" });
        try {
          await creationContext.addInitScript((paneId) => {
            localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
            sessionStorage.setItem("ovis:selection", JSON.stringify({ machine_id: "local", pane_id: paneId }));
          }, panes.api);
          const page = await creationContext.newPage();
          await page.goto(`http://127.0.0.1:${server.port}/?machine=remote&new=workspace&agent=codex&view=chat`);
          const dialog = page.getByRole("dialog", { name: /^New workspace/ });
          await dialog.waitFor();
          if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `creation-link-${phone ? "phone" : "desktop"}.png`), animations: "disabled" });
          assert.equal(await dialog.locator("h2").innerText(), "New workspace · Build PC", "a remote creation link without a pane overrides the remembered local PC");
          await page.waitForFunction(() => (window as any).paletteMachineCalls.agents.includes("remote"));
          assert.deepEqual(await page.evaluate(() => (window as any).paletteMachineCalls.agents), ["remote"], "the creation dialog requests only the linked PC's agent choices");
          assert.equal(await dialog.locator(".agent-picker-label").innerText(), "Codex");
          await dialog.getByRole("combobox", { name: "Agent", exact: true }).click();
          await dialog.getByRole("option").filter({ hasText: "Build PC agent" }).waitFor();
          assert.equal(await dialog.getByRole("option").filter({ hasText: "Claude Code" }).count(), 0, "the visible choices come from the remote catalog, not the local catalog");
          // the next address loads the page afresh, so the open dialog and its list are left as they are
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
          await page.locator('.agents-sidebar .agent-select[aria-current="true"]').first().waitFor({ state: "attached" });
          await page.evaluate(() => history.pushState(null, "", "?machine=remote&new=workspace&agent=codex&name=Forward"));
          await page.goBack();
          await page.goForward();
          await dialog.waitFor();
          assert.equal(await dialog.locator("h2").innerText(), "New workspace · Build PC", "Forward to a creation-only link selects the link's PC before opening its dialog");
          // a dialog open for one PC gives way to the next entry's PC and fields. The app writes where the dialog
          // opened (its PC's pane and that pane's folder) over the Forward entry once both are in: the next entry is
          // pushed after that write, or the write lands on it and the entry asks for Build PC again
          await page.waitForFunction(() => { const query = new URLSearchParams(location.search); return query.get("name") === "Forward" && query.has("pane") && query.has("cwd"); });
          await page.evaluate(() => history.pushState(null, "", "?new=workspace&agent=codex&name=Here"));
          await page.goBack();
          await page.goForward();
          await page.getByRole("dialog", { name: "New workspace \u00b7 Laptop", exact: true }).waitFor();
          // a tab link to an offline PC waits for a pane; the entry after it drops it rather than opening it here
          await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
          await page.locator('.agents-sidebar .agent-select[aria-current="true"]').first().waitFor({ state: "attached" });
          const here = await page.evaluate(() => location.search);
          await page.evaluate((search) => { history.pushState(null, "", "?machine=offline&new=tab&name=WRONG"); history.pushState(null, "", search); }, here);
          await page.goBack();
          await page.waitForFunction(() => new URLSearchParams(location.search).get("machine") === "offline");
          await page.goForward();
          await page.waitForFunction((search) => location.search === search, here);
          await page.locator('.agents-sidebar .agent-select[aria-current="true"]').first().waitFor({ state: "attached" });
          await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
          assert.equal(await page.getByRole("dialog", { name: /^New (tab|workspace)/ }).count(), 0, "an offline PC's tab link left behind opens nothing on this PC");
          console.log(`PASS ${phone ? "phone" : "desktop"} creation link loads the linked remote PC's dialog and agent choices without a pane`);
        } finally { await creationContext.close(); }
        const detachedContext = await browser.newContext(phone
          ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" }
          : { viewport: { width: 1280, height: 900 }, locale: "en-US" });
        try {
          const page = await detachedContext.newPage();
          const renderErrors: string[] = [];
          page.on("pageerror", (error) => renderErrors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error" && message.text().includes("render failed")) renderErrors.push(message.text());
          });
          await page.goto(`http://127.0.0.1:${server.port}/?machine=remote&pane=${encodeURIComponent(panes.api)}&view=chat&detached=1`);
          if (phone) await page.getByRole("button", { name: "Open workspace list", exact: true }).click();
          await page.locator('.workspace-select[title*="Detached HEAD"]').first().waitFor({ state: "attached" });
          assert.ok(await page.locator(".workspace-group").count() > 0, "workspace rows survive a remote detached worktree with no branch field");
          assert.equal(await page.getByRole("alert").filter({ hasText: /can't be shown|Something went wrong/ }).count(), 0);
          assert.deepEqual(renderErrors, [], "caught render errors must fail the browser check too");
          console.log(`PASS ${phone ? "phone" : "desktop"} sidebar and detached branch render when the remote API omits branch`);
        } finally { await detachedContext.close(); }
      }
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
      try {
        await context.addInitScript((paneId) => {
          localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
          localStorage.setItem("ovis:recent-directories:local", JSON.stringify(["/fixture/project"]));
          for (const id of ["local", "remote", "offline"]) localStorage.setItem(`ovis:pc-collapsed:${id}`, "1");
          localStorage.setItem("ovis:recent-panes:remote", JSON.stringify([paneId]));
        }, panes.api);
        const page = await context.newPage(); const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(panes.api)}`);
        await page.locator(".conn-live").waitFor({ state: "attached" });
        const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
        const search = palette.getByRole("searchbox", { name: "Search panes and actions", exact: true });
        const open = async () => { await page.keyboard.press("ControlOrMeta+Shift+K"); await palette.waitFor(); };
        const rows = palette.locator(".palette-pane");
        await open();
        await page.waitForFunction(() => {
          const calls = (window as any).paletteMachineCalls;
          return calls.branches.includes("local") && calls.branches.includes("remote");
        });
        assert.equal(await palette.locator('.palette-section[data-section="recent"] .palette-pane[data-machine="remote"]').count(), 1, "legacy remote history appears in the global Recent section");
        assert.equal(await palette.locator('.palette-pane[data-machine="offline"]').count(), 0);
        assert.equal(await palette.locator('.palette-pane[aria-current="true"]').count(), 1, "same remote pane ID is not selected");
        assert.equal(await palette.locator('.palette-section[data-machine="remote"] .palette-section-machine').first().textContent(), "Build PC");
        await search.fill("remote-branch");
        await rows.first().waitFor();
        assert.deepEqual(await rows.evaluateAll((entries) => [...new Set(entries.map((entry) => entry.getAttribute("data-machine")))]), ["remote"]);
        await search.fill("Build PC"); await rows.first().waitFor();
        assert.ok(await rows.count() > 0);
        assert.deepEqual(await rows.evaluateAll((entries) => [...new Set(entries.map((entry) => entry.getAttribute("data-machine")))]), ["remote"]);
        console.log("PASS global search distinguishes duplicate IDs, searches machine/branch names and migrates remote history");

        await page.evaluate(() => {
          const fetchDemo = window.fetch;
          let attempts = 0;
          Object.assign(window, { fetch: (input: RequestInfo | URL, init?: RequestInit) => {
            if (String(input).includes("/workspace/directories")) {
              return Promise.resolve(++attempts === 1
                ? new Response(JSON.stringify({ error: "fixture_failure" }), { status: 500 })
                : new Response(JSON.stringify({ path: "/", parent: null, home: "/home/fixture", directories: ["recovered"], truncated: false })));
            }
            return fetchDemo(input, init);
          } });
        });
        await search.fill("/");
        await palette.getByRole("button", { name: "Try again", exact: true }).waitFor();
        assert.ok(await palette.locator(".palette-folder").count() > 0, "cached folder rows remain alongside the listing failure");
        assert.equal(await palette.locator(".palette-empty[role=status]").textContent(), "Folders could not be loaded.");
        await palette.getByRole("button", { name: "Try again", exact: true }).click();
        await palette.getByRole("option", { name: "recovered", exact: true }).waitFor();
        assert.equal(await palette.getByRole("button", { name: "Try again", exact: true }).count(), 0, "retry fetches the unchanged query and clears its failure");
        console.log("PASS a failed folder listing stays visible and retryable beside cached folder rows");

        // The palette may open over a confirmation. Identical native IDs on the destination
        // PC must never retarget the first PC's destructive dialog to that new machine.
        await page.keyboard.press("Escape"); await palette.waitFor({ state: "hidden" });
        const selectedTab = page.locator('.tab-strip-tab[aria-selected="true"]');
        assert.equal(await page.locator('.tab-strip-tab').count(), 1, "the selected workspace owns only this tab");
        const localTabId = await selectedTab.getAttribute("data-tab-id");
        await selectedTab.focus(); await selectedTab.press("Delete");
        const closeConfirm = page.getByRole("alertdialog", { name: /^Close tab / });
        await closeConfirm.waitFor();
        assert.match(await closeConfirm.textContent() ?? "", /It is the last tab/);
        await open();
        assert.equal(await closeConfirm.isVisible(), true, "opening the palette leaves the confirmation beneath it until a target is chosen");
        await search.fill("Remote migration"); await rows.first().waitFor();
        await search.press("Enter"); await palette.waitFor({ state: "hidden" });
        await closeConfirm.waitFor({ state: "detached" });
        assert.equal(await selectedTab.getAttribute("data-tab-id"), localTabId, "the remote PC deliberately has the same tab ID");
        assert.deepEqual(await page.evaluate(() => (window as any).paletteMachineCalls.closes), [], "a PC switch neither preserves nor submits the previous PC's close confirmation");
        console.log("PASS switching PCs through the palette dismisses an old close confirmation even when tab IDs match");
        await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "{}").machine_id === "remote");
        const calls = await page.evaluate(() => (window as any).paletteMachineCalls);
        // a pick is the browser's alone: herdr's focus on either PC stays where it is
        assert.deepEqual(calls.focus.filter((call: { machine: string }) => call.machine === "remote"), [], "selection leaves the remote PC's herdr focus alone");
        await open();
        await page.waitForFunction(() => (window as any).paletteMachineCalls.plugins.includes("remote"));
        assert.equal(await palette.locator('.palette-section[data-section="plugins"] .palette-section-machine').textContent(), "Build PC", "plugin actions keep the selected PC owner");
        await palette.getByRole("option", { name: /Save layout/ }).click();
        await palette.waitFor({ state: "hidden" });
        assert.deepEqual(await page.evaluate(() => (window as any).paletteMachineCalls.runs), ["remote"], "the selected remote PC owns plugin execution");
        await open();
        await search.fill("Laptop"); await rows.first().click(); await palette.waitFor({ state: "hidden" });
        await open();
        await search.fill("Remote migration"); await rows.first().waitFor();
        await page.evaluate(() => (window as any).setPaletteRemoteState(true));
        await palette.locator('.palette-pane[data-machine="remote"]').waitFor({ state: "hidden" });
        assert.equal(await rows.count(), 0, "offline retained snapshots disappear from search");
        await page.evaluate(() => (window as any).setPaletteRemoteState(false, true));
        assert.equal(await rows.count(), 0, "a removed pane cannot be activated from history");
        await page.keyboard.press("Escape");
        assert.deepEqual(errors, []);
        console.log("PASS cross-PC selection stays bound; plugin actions follow the current PC; offline/removed panes are excluded");
      } finally { await context.close(); }
    } finally { await browser.close(); }
  } finally { server.stop(); }
} finally { rmSync(app, { recursive: true, force: true }); }
