/**
 * Files follows a pane switch and a prompt card survives a failed prompt read.
 * Run under `bun run check run --build bun scripts/files-prompt-regression.ts`.
 * Screenshots and results.json go to FILES_PROMPT_SHOTS or a temporary directory.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { UsageService } from "../server/usage.ts";
import { chromePath } from "./chrome-path.ts";
import { runMoreItem } from "./header-more.ts";
import "./test-herdr.ts";

const socket = process.env["HERDR_SOCKET"] ?? "";
const xdg = process.env["XDG_CONFIG_HOME"] ?? "";
if (!xdg || !socket.startsWith(`${xdg}/`) || !/\/herdr\/sessions\/check-[0-9a-f]+(?:-\d+)?\/herdr\.sock$/.test(socket)) {
  throw new Error(`refusing to run against a non-isolated herdr session: ${socket || "(unset)"}`);
}
console.log(`HERDR_SOCKET=${socket} (isolated check session)`);

const root = mkdtempSync(join(tmpdir(), "herdr-files-prompt-"));
const shots = process.env["FILES_PROMPT_SHOTS"] || process.env["UI_EVIDENCE_DIR"] || root;
mkdirSync(shots, { recursive: true });
const workspaces: string[] = [];
const results: Array<{ scenario: string; page: string; pass: boolean }> = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;

const selectedPane = (page: Page): Promise<string | null> => page.evaluate(() =>
  JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id ?? null);

async function openApp(context: BrowserContext, origin: string, pane: string, panes: string[]): Promise<Page> {
  await context.addInitScript((ids: string[]) => {
    if (!localStorage.getItem("ovis:settings")) localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, panes);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
  await page.locator(".conn-live").waitFor();
  await page.waitForFunction((id) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id === id, pane);
  return page;
}

async function checkFiles(page: Page, label: string, phone: boolean, paneA: string, paneB: string, cwdA: string, cwdB: string): Promise<void> {
  assert.equal(await selectedPane(page), paneA);
  if (phone) await runMoreItem(page, "Browse files");
  else await page.getByRole("button", { name: "Browse files", exact: true }).click();
  const dialog = page.locator(".files-dialog");
  await dialog.waitFor();
  await page.waitForFunction((folder) => document.querySelector(".files-dialog .dir-browser-path")?.getAttribute("title") === folder, cwdA);
  await dialog.locator(".dir-browser-item", { hasText: "sub" }).click();
  await page.waitForFunction((folder) => document.querySelector(".files-dialog .dir-browser-path")?.getAttribute("title") === folder, join(cwdA, "sub"));
  await page.screenshot({ path: join(shots, `files-${label}-before-switch.png`) });
  await page.keyboard.press("Control+Shift+ArrowDown");
  await page.waitForFunction((id) => JSON.parse(sessionStorage.getItem("ovis:selection") ?? "null")?.pane_id === id, paneB);
  const outcome = await page.waitForFunction((folder) => {
    const current = document.querySelector(".files-dialog");
    return current === null ? "closed" : current.querySelector(".dir-browser-path")?.getAttribute("title") === folder ? "followed" : false;
  }, cwdB, { timeout: 3_000 }).then((handle) => handle.jsonValue() as Promise<string>).catch(() => "stuck");
  await page.screenshot({ path: join(shots, `files-${label}-after-switch.png`) });
  const pass = outcome !== "stuck";
  results.push({ scenario: "Files follows pane switch", page: label, pass });
  console.log(`${pass ? "PASS" : "FAIL"} Files ${label}: ${outcome}`);
  if (await dialog.isVisible()) {
    // CI once saw this Escape leave the dialog open after a pane switch, never reproduced here (#2631):
    // the key's path is recorded before it is pressed, and a failure says what decided it
    await page.evaluate(() => {
      const seen: unknown[] = [];
      const describe = (node: EventTarget | null) => node instanceof Element ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${String(node.className).trim().replace(/\s+/g, ".")}` : String(node);
      const note = (phase: string) => (event: KeyboardEvent) => { if (event.key === "Escape") seen.push({ phase, target: describe(event.target), defaultPrevented: event.defaultPrevented, composing: event.isComposing }); };
      window.addEventListener("keydown", note("window capture"), true);
      window.addEventListener("keydown", note("window bubble"));
      Object.assign(window, { escapeSeen_: seen });
    });
    await page.keyboard.press("Escape");
    try {
      await dialog.waitFor({ state: "hidden" });
    } catch (error) {
      // what is gathered here never takes the place of the timeout: a page gone by now still fails on it
      try {
      const why = await page.evaluate(() => {
        const describe = (node: Element | null) => node === null ? null : `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${String(node.className).trim().replace(/\s+/g, ".")}`;
        const active = document.activeElement;
        const opens = (element: Element) => { try { return element.matches(":open"); } catch { return false; } };
        return {
          escapeSeen: (window as unknown as { escapeSeen_?: unknown[] }).escapeSeen_ ?? null,
          activeElement: describe(active),
          activeInFiles: active?.closest(".files-dialog") !== null && active !== null,
          activeIn: describe(active?.closest("[role='dialog'], dialog, [aria-modal='true']") ?? null),
          modalStack: [...document.querySelectorAll("[aria-modal='true'], dialog")].map((element) => ({ element: describe(element), open: element instanceof HTMLDialogElement ? element.open : true, modal: (() => { try { return element.matches(":modal"); } catch { return false; } })() })),
          // FilesDialog stands its Escape down while a file or a diff it opened is over it (viewing) or a native modal is
          fileViewerOpen: document.querySelector(".file-viewer") !== null,
          diffOpen: document.querySelector(".repo-diff") !== null,
          nativeModal: [...document.querySelectorAll("dialog")].some((element) => { try { return element.matches(":modal"); } catch { return false; } }),
          openPickers: [...document.querySelectorAll("select, input")].filter(opens).map(describe),
          filesPath: document.querySelector(".files-dialog .dir-browser-path")?.getAttribute("title") ?? null,
          selection: sessionStorage.getItem("ovis:selection"),
        };
      });
      console.log(`Files ${label}: Escape after the pane switch left the dialog open: ${JSON.stringify(why)}`);
      writeFileSync(join(shots, `files-${label}-escape-diagnostics.json`), `${JSON.stringify(why, null, 2)}\n`);
      await page.screenshot({ path: join(shots, `files-${label}-escape-stuck.png`) });
      } catch (diagnostics) {
        console.log(`Files ${label}: the Escape diagnostics could not be gathered: ${String(diagnostics)}`);
      }
      throw error;
    }
  }
  // The shortcut is intentionally global, including while the Files dialog is open.
  assert.equal(await selectedPane(page), paneB);
}

async function paintStartupMenu(pane: string): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: pane, text: "printf '\\033[2J\\033[HDo you trust the contents of this directory?\\n\\n› 1. Yes, continue\\n  2. No, quit\\n\\n  Press enter to continue\\n'; read -r qa_answer" });
  await herdrRpc("pane.send_keys", { pane_id: pane, keys: ["Enter"] });
}

async function checkPrompt(page: Page, label: string, failure: "abort" | "500" | "non-json"): Promise<void> {
  const card = page.locator(".prompt-card");
  const option = card.getByRole("button", { name: "1. Yes, continue", exact: true });
  await option.waitFor();
  await page.evaluate(() => {
    const state = window as unknown as { cardsRemoved: number; observer?: MutationObserver };
    state.cardsRemoved = 0;
    state.observer?.disconnect();
    state.observer = new MutationObserver((records) => {
      for (const record of records) for (const node of record.removedNodes) {
        if (node instanceof HTMLElement && (node.classList.contains("prompt-card") || node.querySelector(".prompt-card") !== null)) state.cardsRemoved++;
      }
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  });
  await page.screenshot({ path: join(shots, `prompt-${label}-${failure}-before.png`) });
  let finish!: () => void;
  const failedRead = new Promise<void>((resolve) => { finish = resolve; });
  let failedRequest: import("playwright-core").Request | undefined;
  let failureComplete = false;
  let nextRead: import("playwright-core").Request | undefined;
  let finishNextRead!: () => void;
  const nextReadFinished = new Promise<void>((resolve) => { finishNextRead = resolve; });
  const onRequest = (request: import("playwright-core").Request) => {
    if (failureComplete && request.url().includes("/api/pane/prompt?") && !nextRead) nextRead = request;
  };
  const onRequestFinished = (request: import("playwright-core").Request) => {
    if (request === failedRequest) failureComplete = true;
    if (request === nextRead) finishNextRead();
  };
  const onRequestFailed = (request: import("playwright-core").Request) => {
    if (request === failedRequest) failureComplete = true;
  };
  page.on("request", onRequest);
  page.on("requestfinished", onRequestFinished);
  page.on("requestfailed", onRequestFailed);
  let handled = false;
  const pattern = /\/api\/pane\/prompt\?/;
  await page.route(pattern, async (route) => {
    if (handled) { await route.continue(); return; }
    handled = true;
    failedRequest = route.request();
    await page.evaluate(() => { (window as unknown as { cardsRemoved: number }).cardsRemoved = 0; });
    if (failure === "abort") await route.abort("failed");
    else if (failure === "500") await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "qa_failure" }) });
    else await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>not JSON</title>" });
    finish();
  });
  let failedTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      failedRead,
      new Promise<never>((_, reject) => { failedTimer = setTimeout(() => reject(new Error(`timed out waiting for failed prompt read (${failure})`)), 10_000); }),
    ]);
  } finally { if (failedTimer) clearTimeout(failedTimer); }
  let nextTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      nextReadFinished,
      new Promise<never>((_, reject) => { nextTimer = setTimeout(() => reject(new Error(`timed out waiting for next prompt read response (${failure})`)), 10_000); }),
    ]);
  } finally {
    if (nextTimer) clearTimeout(nextTimer);
    page.off("request", onRequest);
    page.off("requestfinished", onRequestFinished);
    page.off("requestfailed", onRequestFailed);
  }
  const gone = await page.locator(".prompt-card").count() === 0;
  await page.screenshot({ path: join(shots, `prompt-${label}-${failure}-after.png`) });
  await option.waitFor({ timeout: 10_000 });
  await page.unroute(pattern);
  const removed = await page.evaluate(() => (window as unknown as { cardsRemoved: number }).cardsRemoved);
  const pass = !gone && removed === 0;
  results.push({ scenario: `Prompt card survives failed read (${failure})`, page: label, pass });
  console.log(`${pass ? "PASS" : "FAIL"} Prompt ${label} (${failure}): ${gone ? "removed" : "kept"}, ${removed} removal(s)`);
}

try {
  const cwdA = join(root, "a");
  const cwdB = join(root, "b");
  mkdirSync(join(cwdA, "sub"), { recursive: true });
  writeFileSync(join(cwdA, "sub", "note.txt"), "regression\n");
  mkdirSync(join(cwdB, "other"), { recursive: true });
  const panes: string[] = [];
  for (const [suffix, cwd] of [["a", cwdA], ["b", cwdB]] as const) {
    const result = await workspaceCreate({ cwd, label: `ovis-files-prompt-${suffix}` });
    workspaces.push(result.workspace.workspace_id);
    panes.push(result.root_pane.pane_id);
  }
  const [paneA, paneB] = panes as [string, string];
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const origin = `http://127.0.0.1:${server.port}`;
  for (const [label, viewport, phone] of [["desktop", { width: 1280, height: 800 }, false], ["phone", { width: 390, height: 844 }, true]] as const) {
    const context = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, locale: "en-US" });
    try {
      const page = await openApp(context, origin, paneA, panes);
      await checkFiles(page, label, phone, paneA, paneB, cwdA, cwdB);
      await paintStartupMenu(paneB);
      await herdrRpc("pane.report_agent", { pane_id: paneB, source: "manual", agent: "codex", state: "idle" });
      for (const failure of ["abort", "500", "non-json"] as const) await checkPrompt(page, label, failure);
      await herdrRpc("pane.send_keys", { pane_id: paneB, keys: ["Enter"] });
      await page.locator(".prompt-card").waitFor({ state: "hidden" });
    } finally { await context.close(); }
  }
} finally {
  await browser?.close();
  server?.stop();
  for (const id of workspaces) await workspaceClose(id).catch(() => undefined);
  writeFileSync(join(shots, "results.json"), `${JSON.stringify({ at: new Date().toISOString(), socket, results }, null, 2)}\n`);
  rmSync(root, { recursive: true, force: true });
}
const passed = results.filter((item) => item.pass).length;
console.log(`${passed}/${results.length} scenarios pass`);
if (passed !== results.length) process.exit(1);
