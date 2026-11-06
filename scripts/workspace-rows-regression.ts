/** Owned, real-browser regression of the sidebar's workspace rows. Run after `bun run build`. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { HerdrError, herdrRpc, sessionSnapshot, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { contextMenuKey } from "./context-menu-key.ts";

type State = {
  readonly selector: string;
  readonly count?: number;
  readonly attribute?: readonly [string, string];
  readonly text?: string;
};

declare global {
  interface Window {
    workspaceRowsState?: Promise<boolean>;
  }
}

/** Register before the action; only DOM mutations, never intervals, drive the wait. */
async function armState(page: Page, states: readonly State[]): Promise<void> {
  await page.evaluate((conditions) => {
    window.workspaceRowsState = new Promise<boolean>((resolve) => {
      const matches = (): boolean => conditions.every(({ selector, count, attribute, text }) => {
        const nodes = document.querySelectorAll(selector);
        if (count !== undefined && nodes.length !== count) return false;
        if (attribute && nodes[0]?.getAttribute(attribute[0]) !== attribute[1]) return false;
        if (text !== undefined && nodes[0]?.textContent !== text) return false;
        return count !== undefined || nodes.length > 0;
      });
      const finish = (matched: boolean): void => {
        observer.disconnect();
        document.removeEventListener("focusin", check);
        clearTimeout(timeout);
        resolve(matched);
      };
      const check = (): void => { if (matches()) finish(true); };
      const observer = new MutationObserver(check);
      const timeout = window.setTimeout(() => finish(false), 15_000);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      document.addEventListener("focusin", check);
      if (matches()) finish(true);
    });
  }, states);
}

async function stateReceived(page: Page, label: string): Promise<void> {
  assert.equal(await page.evaluate(() => window.workspaceRowsState), true, `Timed out: ${label}`);
}

async function changeState(page: Page, states: readonly State[], action: () => Promise<unknown>, label: string): Promise<void> {
  await armState(page, states);
  await action();
  await stateReceived(page, label);
}

const paneSelector = (paneId: string): string => `.pane-select[title^=${JSON.stringify(`${paneId} —`)}]`;
const itemSelector = (paneId: string): string => `.pane-item:has(${paneSelector(paneId)})`;
const workspaceSelector = (workspaceId: string): string => `.workspace-group[data-workspace=${JSON.stringify(workspaceId)}]`;
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-workspace-rows-regression-")));
// These accumulators contain only IDs created by this invocation.
const ownedWorkspaces: string[] = [];
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let server: ReturnType<typeof createServer> | undefined;

try {
  // test-herdr has live/unit escape hatches and a no-binary fallback. Never let
  // any of those silently target the user's current socket.
  assert.notEqual(process.env.HERDR_TEST_LIVE, "1", "Live-session mode is forbidden");
  assert.notEqual(process.env.HERDR_TEST_MODE, "unit", "This regression requires isolated herdr");
  process.env.HERDR_TEST_SESSION ||= "ovis-test";
  const { testSocketPath } = await import("./test-herdr.ts");
  assert.equal(process.env.HERDR_SOCKET, testSocketPath(), "test-herdr must select its isolated socket");

  // Given two independent workspaces at one full cwd, a third whose folder has the same
  // basename, and a fourth alone in its folder. No agent or shell input is started.
  const sharedCwd = join(root, "left", "project");
  const otherCwd = join(root, "right", "project");
  const loneCwd = join(root, "lone");
  for (const cwd of [sharedCwd, otherCwd, loneCwd]) mkdirSync(cwd, { recursive: true });
  const fixtures = [];
  for (const [cwd, label] of [
    [sharedCwd, "workspace-rows-alpha"],
    [sharedCwd, "workspace-rows-beta"],
    [otherCwd, "workspace-rows-other-parent"],
    [loneCwd, "workspace-rows-lone"],
  ] as const) {
    const created = await workspaceCreate({ cwd, label });
    ownedWorkspaces.push(created.workspace.workspace_id);
    fixtures.push({ cwd, label, workspaceId: created.workspace.workspace_id, paneId: created.root_pane.pane_id });
  }
  const [alpha, beta, other, lone] = fixtures;
  assert.ok(alpha && beta && other && lone);
  assert.notEqual(alpha.workspaceId, beta.workspaceId, "same cwd must still own independent workspaces");
  const split = await herdrRpc<{ pane: { pane_id: string } }>("pane.split", {
    target_pane_id: other.paneId, direction: "down", focus: false, cwd: otherCwd,
  });
  const workspaceFoldKey = `ovis:workspace-collapsed:local:${other.workspaceId}`;
  server = createServer({
    port: 0, hostname: "127.0.0.1", token: "", tailscaleOwner: null,
    stateDir: join(root, "state"), codexHome: join(root, "codex"),
    usage: new UsageService(undefined, []),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? (process.platform === "darwin"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/opt/google/chrome/chrome"),
    headless: true, args: ["--no-sandbox"],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  await context.addInitScript(({ ids, legacyFoldKey }) => {
    // Browser locale alone does not override the app's remembered language.
    // Preserve a language changed through Settings across subsequent reloads.
    if (!localStorage.getItem("ovis:settings")) {
      // Two lines: the task row (pane title over its place) is what this script reads; One line,
      // the default, is ui-regression's sidebar-rows check
      localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", alertsOn: false, sidebarRows: "two" }));
      localStorage.setItem(legacyFoldKey, "1");
    }
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, { ids: [...fixtures.map(({ paneId }) => paneId), split.pane.pane_id], legacyFoldKey: workspaceFoldKey });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  page.on("pageerror", (error) => errors.push(error.message));

  const navigate = async (action: () => Promise<unknown>, paneId: string): Promise<void> => {
    // Register the exact network signal before replacing the document. DOM
    // readiness then comes from Playwright's attached-state signal.
    const snapshot = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/machines" && response.ok());
    await action();
    await snapshot;
    await page.locator(`${paneSelector(paneId)}[aria-current="true"]`).waitFor({ state: "attached" });
  };
  const evidence = process.env.UI_EVIDENCE_DIR;
  if (evidence) mkdirSync(evidence, { recursive: true });
  const screenshot = async (name: string): Promise<void> => {
    if (evidence) await page.screenshot({ path: join(evidence, `workspace-rows-${name}.png`), animations: "disabled" });
  };
  // the workspace with two panes in one tab: one row, with both panes on the canvas
  const otherWorkspace = workspaceSelector(other.workspaceId);

  await navigate(() => page.goto(`${origin}/?pane=${encodeURIComponent(lone.paneId)}`), lone.paneId);
  await page.locator(paneSelector(other.paneId)).waitFor({ state: "attached" });
  // one row per workspace, as herdr's Spaces sidebar: the split pane has no row of its own, the
  // workspace's selector follows its current pane while its visible name stays fixed.
  assert.equal(await page.locator(otherWorkspace).count(), 1, "a workspace with two panes is one row");
  assert.equal(await page.locator(paneSelector(split.pane.pane_id)).count(), 0);
  assert.equal(await page.locator(".workspace-toggle").count(), 0, "a legacy workspace fold has nothing to fold");
  assert.equal(await page.locator(".workspace-contents, .sidebar-tab-heading, .sidebar-pane-item").count(), 0,
    "tabs and panes are navigated above the terminal rather than as workspace children");
  assert.equal(await page.locator(".tab-strip").count(), 1, "the native tab row remains over a lone pane's workspace");
  assert.equal(await page.locator('.tab-strip [role="tab"]').count(), 1);
  for (const fixture of [alpha, beta]) {
    const workspace = workspaceSelector(fixture.workspaceId);
    assert.equal(await page.locator(`${workspace} > .workspace-header`).count(), 1);
    assert.equal(await page.locator(`${workspace} .workspace-name`).textContent(), fixture.label,
      "workspaces sharing a folder retain independent workspace names");
    assert.equal(await page.locator(`${workspace} .workspace-toggle`).count(), 0);
    assert.equal(await page.locator(`${itemSelector(fixture.paneId)} .sidebar-drag-handle`).count(), 0,
      "workspace rows have no separate reorder grip column");
    assert.equal(await page.locator(paneSelector(fixture.paneId)).getAttribute("draggable"), "true",
      "the workspace row itself supports dragging");
  }
  // A fold stored while a single pane had a heading (0.3.44) must not hide a row that has no toggle.
  const singleFoldKey = `ovis:workspace-collapsed:local:${alpha.workspaceId}`;
  await page.evaluate((key) => localStorage.setItem(key, "1"), singleFoldKey);
  await navigate(() => page.reload(), lone.paneId);
  await page.locator(paneSelector(alpha.paneId)).waitFor({ state: "visible" });
  assert.equal(await page.locator(`.workspace:has(${paneSelector(alpha.paneId)}) .workspace-toggle`).count(), 0);
  await page.evaluate((key) => localStorage.removeItem(key), singleFoldKey);
  // A split tab renders both panes. Selecting the second pane on the canvas changes only the
  // representative pane of the workspace row; the workspace's visible name remains its own.
  await changeState(page, [{ selector: paneSelector(other.paneId), attribute: ["aria-current", "true"] }, { selector: '.tab-strip [role="tab"]', count: 1 }],
    () => page.locator(paneSelector(other.paneId)).click(), "selecting the split workspace shows its strip");
  assert.equal(await page.locator('.tab-strip [role="tab"]').textContent(), "Tab 1", "a tab herdr named by its number reads as Tab 1");
  // at this width the header over the pane is the pane's surface, and the strip under it is
  // the same one, not a band of the panel's colour between header and pane
  const surfaces = await page.evaluate(() => {
    const header = document.querySelector(".app-header")!;
    const column = document.querySelector(".pane-column")!;
    return {
      headerChat: header.classList.contains("is-chat"), columnChat: column.classList.contains("is-chat"),
      header: getComputedStyle(header).backgroundColor, strip: getComputedStyle(document.querySelector(".tab-strip")!).backgroundColor,
      // from 769px the tabs are the header's row, tinted, and the open tab takes the pane's surface
      tabRow: header.classList.contains("has-tab-row"),
      openTab: getComputedStyle(document.querySelector(".tab-strip-item.is-active")!).backgroundColor,
      chat: document.querySelector(".chat-view") ? getComputedStyle(document.querySelector(".chat-view")!).backgroundColor : null,
    };
  });
  assert.equal(surfaces.columnChat, surfaces.headerChat, "the header and the pane column agree on the lens");
  assert.equal(surfaces.strip, surfaces.header, "the strip is the header's surface");
  if (surfaces.headerChat) assert.equal(surfaces.chat, surfaces.tabRow ? surfaces.openTab : surfaces.header, surfaces.tabRow ? "the open tab under the chat lens is the transcript's surface" : "which under the chat lens is the transcript's");
  await page.getByRole("tab", { name: "Tab 1", exact: true }).click({ button: "right" });
  const tabMenu = page.getByRole("menu", { name: "Tab 1", exact: true });
  await tabMenu.waitFor();
  assert.deepEqual(await tabMenu.getByRole("menuitem").allTextContents(), ["New tab with agent…", "Rename tab", "Close tab"]);
  await page.keyboard.press("Escape");
  await tabMenu.waitFor({ state: "detached" });
  assert.equal(await page.locator(".pane-frame:visible").count(), 2, "both split panes are visible");
  await changeState(page, [{ selector: `${paneSelector(split.pane.pane_id)}[aria-current="true"]` }, { selector: paneSelector(other.paneId), count: 0 }],
    () => page.locator(`[data-layout-pane=${JSON.stringify(split.pane.pane_id)}] .pane-frame-title`).click(), "the canvas selects the split pane, and the row follows it");
  assert.equal(await page.locator(otherWorkspace).count(), 1);
  assert.equal(await page.locator(`${otherWorkspace} .workspace-name`).textContent(), other.label,
    "selecting a split pane keeps the workspace label in Spaces");
  // Both entry points act on the workspace clicked, without changing the selected pane.
  const alphaWorkspace = workspaceSelector(alpha.workspaceId);
  // a desktop draws no row ⋯: the context-menu key opens the menu at the focused row
  await page.locator(`${alphaWorkspace} .workspace-select`).focus();
  await contextMenuKey(page);
  const workspaceMenu = page.getByRole("menu");
  await workspaceMenu.waitFor();
  const workspaceActions = await workspaceMenu.getByRole("menuitem").allTextContents();
  assert.deepEqual(workspaceActions, ["Pin workspace", "Rename workspace", "Earlier sessions…", "Close workspace"],
    "a non-Git workspace's keyboard menu contains only native workspace actions");
  assert.equal(await page.locator(paneSelector(split.pane.pane_id)).getAttribute("aria-current"), "true",
    "opening another workspace's keyboard menu keeps the active pane");
  await page.keyboard.press("Escape");
  await workspaceMenu.waitFor({ state: "detached" });
  await page.locator(`${alphaWorkspace} .workspace-select`).click({ button: "right" });
  await workspaceMenu.waitFor();
  assert.deepEqual(await workspaceMenu.getByRole("menuitem").allTextContents(), workspaceActions,
    "right-click and the keyboard workspace menu have identical actions and order");
  assert.equal(await page.locator(paneSelector(split.pane.pane_id)).getAttribute("aria-current"), "true",
    "right-clicking another workspace keeps the active pane");
  await page.keyboard.press("Escape");
  await workspaceMenu.waitFor({ state: "detached" });
  // Renaming a pane is still available on that pane's own menu (a mouse opens it by right-click).
  await page.locator(`[data-layout-pane=${JSON.stringify(split.pane.pane_id)}] .pane-frame-head`).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename pane", exact: true }).click();
  const paneRename = page.getByRole("dialog", { name: "Rename pane", exact: true });
  const paneName = paneRename.getByRole("textbox", { name: "Pane name", exact: true });
  await paneName.waitFor();
  const renamedSplit = "workspace-rows-split-task";
  await paneName.fill(renamedSplit);
  const splitRenameResponse = page.waitForResponse((response) => response.request().method() === "POST"
    && new URL(response.url()).pathname.endsWith("/pane/rename")
    && response.request().postDataJSON().pane_id === split.pane.pane_id);
  await paneName.press("Enter");
  await paneRename.waitFor({ state: "detached" });
  assert.equal((await splitRenameResponse).status(), 200);
  assert.equal((await sessionSnapshot()).panes.find((pane) => pane.pane_id === split.pane.pane_id)?.label, renamedSplit);
  assert.equal((await sessionSnapshot()).workspaces.find((workspace) => workspace.workspace_id === other.workspaceId)?.label, other.label,
    "renaming a pane leaves herdr's workspace name unchanged");
  await page.waitForFunction(({ selector, title }) => document.querySelector(selector)?.textContent === title,
    { selector: `${otherWorkspace} .workspace-name`, title: renamedSplit });
  assert.ok((await page.locator(`${otherWorkspace} .workspace-place`).textContent())?.includes(other.label),
    "the task row shows its representative pane title and keeps the workspace name beneath it");
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 900 });
    if (await page.locator(".drawer-toggle").isVisible()
      && await page.locator(".drawer-toggle").getAttribute("aria-expanded") !== "true") {
      await changeState(page, [{ selector: "#workspace-drawer.is-open" }],
        () => page.locator(".drawer-toggle").click(), `workspace drawer opens at ${width}`);
    }
    assert.equal(await page.locator(paneSelector(split.pane.pane_id)).isVisible(), true);
    await screenshot(`workspace-${width}`);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  if (await page.locator(".drawer-toggle").isVisible() && await page.locator(".drawer-toggle").getAttribute("aria-expanded") === "true") await page.locator(".drawer-toggle").click();
  assert.deepEqual(errors, [], "no browser page errors");
  console.log("PASS one row per workspace, identical workspace menu entry points, and pane actions on the canvas");
} finally {
  // Attempt every cleanup even if an earlier teardown fails; never close an
  // unowned resident workspace from test-herdr or any other invocation.
  const cleanupErrors: unknown[] = [];
  try { await browser?.close(); } catch (error) { cleanupErrors.push(error); }
  try { server?.stop(); } catch (error) { cleanupErrors.push(error); }
  for (const id of ownedWorkspaces) {
    try { await workspaceClose(id); } catch (error) {
      // Closing the last pane can already have removed its workspace.
      if (!(error instanceof HerdrError && error.code === "workspace_not_found")) cleanupErrors.push(error);
    }
  }
  try { rmSync(root, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    console.error(new AggregateError(cleanupErrors, "Workspace rows regression cleanup failed"));
    process.exitCode = 1;
  }
}
