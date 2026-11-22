import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, paneClose, paneFocus, paneSplit, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";

export async function checkNotificationView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-alert-view-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["agent", "shell"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `ovis-test-alert-view-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
    }
    const [agent, shell] = panes as [string, string];
    await herdrRpc("pane.report_agent", { pane_id: agent, source: "manual", agent: "claude", state: "idle" });
    await context.addInitScript((pane) => {
      if (localStorage.getItem("ovis:settings") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:${pane}`, "terminal");
    }, agent);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const saved = () => page.evaluate((pane) => localStorage.getItem(`ovis:view:${pane}`), agent);
    const shows = (pane: string, lens: "Chat transcript" | "Live terminal") => page.waitForFunction(([id, title]) =>
      document.querySelector(".pane-select[aria-current='true']")?.getAttribute("title")?.startsWith(`${id} —`) === true
      && document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith(title!) === true, [pane, lens]);
    const tapAlert = (pane: string, workspace?: string) => page.evaluate(([id, ws]) => {
      navigator.serviceWorker.dispatchEvent(new MessageEvent("message", { data: { type: "select-pane", machine_id: "local", pane_id: id, view: "chat", ...(ws ? { workspace_id: ws } : {}) } }));
    }, [pane, workspace] as const);
    const row = (pane: string) => page.locator(`.pane-select[title^="${pane} —"]`);

    await page.goto(`${origin}/?pane=${encodeURIComponent(agent)}&view=chat`);
    await page.locator(".conn-live").waitFor();
    await shows(agent, "Chat transcript");
    assert.equal(await saved(), "terminal", "an alert does not replace the lens the pane remembered");
    await page.waitForFunction((id) => { const query = new URLSearchParams(window.location.search); return query.get("pane") === id && query.get("view") === "chat"; }, agent);
    if (process.env.UI_EVIDENCE_DIR) {
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "notification-chat-one-shot.png") });
    }
    await row(agent).click();
    await shows(agent, "Live terminal");

    await tapAlert(shell);
    await shows(shell, "Live terminal");
    await tapAlert(agent);
    await shows(agent, "Chat transcript");
    assert.equal(await saved(), "terminal");
    await row(shell).click();
    await row(agent).click();
    await shows(agent, "Live terminal");

    await row(shell).click();
    await shows(shell, "Live terminal");
    let asked!: () => void;
    const lookup = new Promise<void>((resolve) => { asked = resolve; });
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/session", async (route) => { asked(); await released; await route.continue(); });
    try {
      const ended = `${agent}-ended`;
      await tapAlert(ended, workspaces[0]);
      let unasked: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([lookup, new Promise<never>((_, reject) => { unasked = setTimeout(() => reject(new Error("ended-pane tap never read /api/session")), 4000); })])
        .finally(() => clearTimeout(unasked));
      await tapAlert(ended, workspaces[0]);
      release();
      await page.locator(".header-note", { hasText: "That agent has closed: its workspace is open" }).waitFor({ timeout: 4000 });
    } finally {
      release();
      await page.unroute("**/api/session");
    }
    await page.waitForFunction((id) => document.querySelector(".pane-select[aria-current='true']")?.getAttribute("title")?.startsWith(`${id} —`) === true, agent);

    const sibling = (await paneSplit(agent, "right", false)).pane_id;
    await paneFocus(shell);
    await row(shell).click();
    await shows(shell, "Live terminal");
    await tapAlert(agent, workspaces[0]);
    await shows(agent, "Chat transcript");
    await paneClose(agent);
    await page.locator(`.pane-frame.is-current[data-layout-pane="${sibling}"]`).waitFor({ timeout: 8000 });
    await page.locator(".header-note", { hasText: "That agent has closed: its workspace is open" }).waitFor({ timeout: 4000 });
    assert.deepEqual(errors, []);
    console.log("PASS a tapped pane alert opens an agent's chat once, and a shell's terminal; an ended pane's alert, delivered twice or tapped while still listed, opens its workspace");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
