import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright-core";
import { herdrRpc, paneSplit, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { openSettingsPage } from "./settings-page.ts";

/** Settings > Chat > Panes open in: one choice puts every agent pane on that lens, the ones that remembered another included. */
export async function checkDefaultView(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "ovis-view-"));
  const workspaces: string[] = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  try {
    const panes: string[] = [];
    for (const name of ["one", "two"]) {
      const cwd = join(root, name);
      mkdirSync(cwd);
      const created = await workspaceCreate({ cwd, label: `ovis-test-view-${name}` });
      workspaces.push(created.workspace.workspace_id);
      panes.push(created.root_pane.pane_id);
      await herdrRpc("pane.report_agent", { pane_id: created.root_pane.pane_id, source: "manual", agent: "claude", state: "idle" });
    }
    const [one, two] = panes as [string, string];
    await context.addInitScript((pane) => {
      if (localStorage.getItem("ovis:settings") !== null) return;
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
      localStorage.setItem(`ovis:view:local:${pane}`, "terminal"); // a pane that remembered the terminal
    }, two);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const lens = () => page.locator(".view-switch button[aria-pressed='true']").getAttribute("title");
    await page.goto(`${origin}/?pane=${encodeURIComponent(one)}`);
    await page.locator(".conn-live").waitFor();
    assert.match((await lens()) ?? "", /^Live terminal/, "a desktop opens an agent pane's terminal by default");

    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Chat");
    await page.getByRole("group", { name: "Panes open in", exact: true }).getByRole("button", { name: "Chat", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Chat transcript") === true);
    await page.locator(`.pane-select[title^="${two} —"]`).click();
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Chat transcript") === true);
    assert.equal(await page.evaluate((pane) => localStorage.getItem(`ovis:view:local:${pane}`), two), null, "what a pane remembered gives way to the choice");
    // a pane switched by hand keeps its lens until the choice changes again
    await page.getByTitle("Live terminal (⌘⇧J)", { exact: true }).click();
    await page.locator(`.pane-select[title^="${one} —"]`).click();
    await page.locator(`.pane-select[title^="${two} —"]`).click();
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Live terminal") === true);
    assert.deepEqual(errors, []);
    console.log("PASS one choice in Settings opens every agent pane in the chat");

    // a shell split beside an agent opens its terminal under the chat default, and keeps it when
    // an agent starts in it: the lens of a pane in use is never switched under the user
    const shell = (await paneSplit(one, "right", false)).pane_id;
    // the split opens beside the agent: a click in its frame selects it, as in herdr
    await page.locator(`.pane-select[title^="${one} —"]`).click();
    const frame = page.locator(`.pane-frame[data-layout-pane="${shell}"]`);
    await frame.locator(".pane-frame-body").click({ position: { x: 40, y: 40 } });
    await page.locator(`.pane-frame.is-current[data-layout-pane="${shell}"]`).waitFor();
    await page.waitForFunction(() => document.querySelector(".view-switch button[aria-pressed='true']")?.getAttribute("title")?.startsWith("Live terminal") === true);
    await herdrRpc("pane.report_agent", { pane_id: shell, source: "manual", agent: "claude", state: "working" });
    // the header's open tab names the pane's agent once the app has seen it start
    await page.locator('.app-header .tab-strip-tab[aria-selected="true"] .agent-mark.claude').waitFor({ timeout: 10_000 });
    assert.match((await lens()) ?? "", /^Live terminal/, "an agent starting in the open shell leaves it on its terminal");
    assert.deepEqual(errors, []);
    console.log("PASS a shell in use keeps its terminal when an agent starts in it");
  } finally {
    await context.close();
    for (const workspace of workspaces) await workspaceClose(workspace).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
}
