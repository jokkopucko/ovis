import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

// The sheet's open agent list floats over it: a stroke down on the list at its top is the list's,
// and the sheet stays where it is. A checkout made with Shell opens its terminal: the sheet steps
// off its history entry before the roster lists the new pane, and that step is not a Back to the
// pane before (an agent's checkout returns only once it runs, by when the roster has it).
const root = realpathSync(mkdtempSync(join(tmpdir(), "ovis-phone-worktree-")));
// herdr keeps a checkout under ~/.herdr/worktrees/<repo name>: a name of the run's own shares it with no real repository
const repo = join(root, `ovis-test-phone-worktree-${process.pid.toString(36)}`);
mkdirSync(repo);
const git = (...args: string[]) => Bun.spawnSync(["git", "-c", "user.name=ovis test", "-c", "user.email=test@example.invalid", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
assert.equal(git("init", "-q", "-b", "main").exitCode, 0, "git init");
writeFileSync(join(repo, "README.md"), "worktree fixture\n");
assert.equal(git("add", "README.md").exitCode, 0);
assert.equal(git("commit", "-q", "-m", "fixture").exitCode, 0, "git commit");
const owned: string[] = [];
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
try {
  const parent = await workspaceCreate({ cwd: repo, label: "ovis-test-phone-worktree" });
  owned.push(parent.workspace.workspace_id);
  const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "en-US" });
    await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" })));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const created = page.waitForResponse((response) => response.url().endsWith("/api/worktree/create"));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(parent.root_pane.pane_id)}`);
    await page.locator(".conn-live").waitFor();
    await page.locator('button[aria-controls="workspace-drawer"]').click();
    await page.locator(`.workspace-group[data-workspace="${parent.workspace.workspace_id}"] .row-menu-toggle`).first().click();
    await page.locator(".row-sheet").getByRole("button", { name: "New worktree", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: /^New worktree/ });
    await sheet.waitFor();
    await page.waitForFunction(() => document.querySelector(".modal-scrim")?.getAnimations({ subtree: true }).length === 0);

    const agent = sheet.getByRole("combobox", { name: "Agent" });
    await agent.click();
    const list = page.locator(".agent-picker-menu");
    await list.waitFor();
    assert.equal(await list.evaluate((node) => node.scrollTop), 0, "the list opens at its top");
    const stroke = await list.evaluate((node) => {
      const surface = document.querySelector<HTMLElement>(".worktree-modal")!;
      const rect = node.getBoundingClientRect();
      const at = (y: number): TouchEventInit => ({ bubbles: true, cancelable: true, touches: [new Touch({ identifier: 1, target: node, clientX: rect.left + 40, clientY: y })] });
      node.dispatchEvent(new TouchEvent("touchstart", at(rect.top + 20)));
      node.dispatchEvent(new TouchEvent("touchmove", at(rect.top + 50)));
      const kept = node.dispatchEvent(new TouchEvent("touchmove", at(rect.top + 90)));
      const transform = surface.style.transform;
      node.dispatchEvent(new TouchEvent("touchend", { bubbles: true, touches: [] }));
      return { transform, kept };
    });
    assert.equal(stroke.transform, "", "a stroke down on the open agent list leaves the sheet where it is");
    assert.equal(stroke.kept, true, "the list keeps the stroke for its own scroll");
    assert.equal(await list.count(), 1, "the list stays open");
    console.log("PASS a stroke down on a phone sheet's open agent list scrolls the list, not the sheet");

    await page.getByRole("option", { name: "Shell", exact: true }).click();
    await sheet.getByRole("button", { name: "Create worktree", exact: true }).click();
    const opened = await (await created).json() as { workspace_id: string; pane_id: string };
    await sheet.waitFor({ state: "detached" });
    await page.waitForFunction((pane) => new URLSearchParams(location.search).get("pane") === pane, opened.pane_id, { timeout: 10_000 });
    assert.equal(await page.locator(".pane-frame.is-current").getAttribute("data-layout-pane"), opened.pane_id, "the checkout's shell pane is the one shown");
    await page.locator(shownRows(".pane-frame.is-current")).waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS a phone's New worktree with Shell opens the checkout's terminal");
    await context.close();
  } finally {
    await browser.close();
  }
} finally {
  // the checkout the run made goes with it: herdr removes the checkout, then its workspace. The
  // roster says what was made, so a create whose answer never arrived is removed too.
  // A checkout left behind fails the run after the rest is cleaned up, without hiding an earlier error.
  const leftovers: unknown[] = [];
  const snapshot = await sessionSnapshot().catch((error: unknown) => { leftovers.push(error); return null; });
  for (const workspace of snapshot?.workspaces ?? []) {
    if (!workspace.worktree?.is_linked_worktree || workspace.worktree.repo_root !== repo) continue;
    try {
      await herdrRpc("worktree.remove", { workspace_id: workspace.workspace_id, force: true });
    } catch (error) {
      leftovers.push(error);
      continue;
    }
    await workspaceClose(workspace.workspace_id).catch(() => undefined);
  }
  // herdr keeps the repository's folder under its worktree directory once the checkout is gone: only an empty one is ours to drop
  try { rmdirSync(join(homedir(), ".herdr", "worktrees", basename(repo))); } catch {}
  for (const id of owned.reverse()) await workspaceClose(id).catch(() => {});
  server.stop();
  rmSync(root, { recursive: true, force: true });
  if (leftovers.length > 0) {
    console.error("FAIL the run's worktree checkout may remain under ~/.herdr/worktrees:", ...leftovers);
    process.exitCode = 1;
  }
}
