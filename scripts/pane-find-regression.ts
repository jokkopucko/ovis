import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import type { PaneFindResponse } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { herdrRpc, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
import { shownRows } from "./shown-rows.ts";

/** GUI searches stay in herdr's history, never in browser scrollback or terminal input. */
export async function checkPaneFind(browser: Browser, origin: string): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "herdr-find-browser-"));
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-find-browser" });
  const pane = created.root_pane.pane_id;
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: "dark" });
  try {
    const ready = herdrRpc("pane.wait_for_output", {
      pane_id: pane, source: "visible", match: { type: "substring", value: "find_browser_ready" }, timeout_ms: 10000,
    }, undefined, 12000);
    await herdrRpc("pane.send_input", {
      pane_id: pane,
      text: "printf 'find_%s\\n' browser_marker; seq 1 150; printf 'find_%s\\n' browser_marker; seq 151 320; printf 'find_%s\\n' browser_ready; exec cat",
      keys: ["enter"],
    });
    await ready;
    await context.addInitScript((id) => {
      localStorage.setItem(`ovis:view:${id}`, "terminal");
      localStorage.setItem("ovis:settings", JSON.stringify({ theme: "system" }));
    }, pane);
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const inputFrames: unknown[] = [];
    const paneSocket: { current?: import("playwright-core").WebSocket } = {};
    const geometry = new EventTarget();
    page.on("websocket", (socket) => {
      socket.on("framesent", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "input" || frame.type === "keys") inputFrames.push(frame);
        if (frame.type === "resize" && frame.pane_id === pane) {
          paneSocket.current = socket;
          geometry.dispatchEvent(new CustomEvent("requested", { detail: frame }));
        }
      });
      socket.on("framereceived", ({ payload }) => {
        const frame = JSON.parse(String(payload));
        if (frame.type === "pane-geometry" && frame.pane_id === pane) geometry.dispatchEvent(new CustomEvent("geometry", { detail: frame }));
        if (frame.type === "pty-data" && frame.pane_id === pane) geometry.dispatchEvent(new Event("output"));
      });
    });
    const resized = () => new Promise<void>((resolve, reject) => {
      const signal = AbortSignal.timeout(10000);
      let changed = false;
      let expected: { cols: number; rows: number } | null = null;
      const requested = (event: Event) => { expected = (event as CustomEvent<{ cols: number; rows: number }>).detail; changed = false; };
      const acknowledged = (event: Event) => {
        const actual = (event as CustomEvent<{ cols: number; rows: number }>).detail;
        changed = expected !== null && actual.cols === expected.cols && actual.rows === expected.rows;
      };
      const cleanup = () => {
        signal.removeEventListener("abort", aborted);
        geometry.removeEventListener("geometry", acknowledged);
        geometry.removeEventListener("requested", requested);
        geometry.removeEventListener("output", done);
      };
      const done = () => { if (changed) { cleanup(); resolve(); } };
      const aborted = () => { cleanup(); reject(signal.reason); };
      geometry.addEventListener("geometry", acknowledged);
      geometry.addEventListener("requested", requested);
      geometry.addEventListener("output", done);
      signal.addEventListener("abort", aborted, { once: true });
    });
    await page.goto(`${origin}/?pane=${encodeURIComponent(pane)}`);
    await page.locator(shownRows(), { hasText: "find_browser_ready" }).waitFor();
    const openedGeometry = resized();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await openedGeometry;
    const field = page.getByRole("searchbox", { name: "Find in terminal" });
    await field.fill("find_browser_marker");
    const search = async (action: () => Promise<unknown>): Promise<PaneFindResponse> => {
      const response = page.waitForResponse((answer) => answer.url().endsWith("/pane/find") && answer.request().method() === "POST" && answer.request().postDataJSON()?.jump !== false);
      await action();
      const answered = await response;
      assert.equal(answered.status(), 200);
      return answered.json();
    };
    const first = await search(() => page.keyboard.press("Enter"));
    assert.equal(first.total, 2);
    assert.equal(first.current, 2);
    await page.locator(shownRows(), { hasText: "find_browser_marker" }).waitFor();
    await page.locator(".find-bar-count", { hasText: "2 of 2" }).waitFor();
    const next = await search(() => page.keyboard.press("Enter"));
    assert.equal(next.current, 1);
    await page.locator(".find-bar-count", { hasText: "1 of 2" }).waitFor();
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.waitForFunction(() => document.querySelector(".find-bar input") === document.activeElement);
    const previous = await search(() => page.keyboard.press("Shift+Enter"));
    assert.equal(previous.current, 2);
    const capture = async (name: string) => {
      if (!process.env.UI_EVIDENCE_DIR) return;
      mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
      await page.evaluate(() => document.fonts.ready);
      for (const theme of ["dark", "light"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
        await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, `${name}-${theme}.png`), animations: "disabled" });
      }
    };
    const staleNavigation = async (name: string) => {
      const value = `find_browser_changed_${name}`;
      const output = herdrRpc("pane.wait_for_output", {
        pane_id: pane, source: "recent", match: { type: "substring", value }, timeout_ms: 10000,
      }, undefined, 12000);
      await herdrRpc("pane.send_input", { pane_id: pane, text: `${value}\n` });
      await output;
      const response = page.waitForResponse((answer) => answer.url().endsWith("/pane/find") && answer.request().method() === "POST" && answer.request().postDataJSON()?.jump !== false);
      await page.getByRole("button", { name: "Next match", exact: true }).click();
      assert.equal((await response).status(), 409);
      await page.getByRole("alert").filter({ hasText: "Pane changed. Search again." }).waitFor();
      await page.waitForFunction(() => document.querySelector(".find-bar-count")?.textContent === "");
      await capture(`${name}-stale`);
      const request = page.waitForRequest((message) => message.url().endsWith("/pane/find") && message.method() === "POST" && message.postDataJSON()?.jump !== false);
      const fresh = await search(() => field.press("Enter"));
      assert.equal((await request).postDataJSON().previous, undefined, "retry must not reuse the stale native range");
      assert.equal(fresh.total, 2);
      await page.locator(".find-bar-count", { hasText: `${fresh.current} of 2` }).waitFor();
      await capture(`${name}-find`);
    };
    await staleNavigation("desktop");
    await page.getByRole("button", { name: "Chat", exact: true }).click();
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.waitForFunction(() => document.querySelector(".find-bar input") === document.activeElement);
    await page.keyboard.type("find_browser_marker");
    assert.equal(await field.inputValue(), "find_browser_marker", "Find from Chat must own query focus, not xterm");
    const fromChat = await search(() => page.keyboard.press("Enter"));
    assert.equal(fromChat.total, 2);
    const buttonNext = await search(() => page.getByRole("button", { name: "Next match", exact: true }).click());
    assert.equal(buttonNext.current, (fromChat.current ?? 0) % 2 + 1);
    const buttonPrevious = await search(() => page.getByRole("button", { name: "Previous match", exact: true }).click());
    assert.equal(buttonPrevious.current, fromChat.current);
    await field.fill("absent_browser_marker");
    assert.equal((await search(() => field.press("Enter"))).total, 0);
    await page.locator(".find-bar-count", { hasText: "No matches" }).waitFor();
    const closedGeometry = resized();
    await page.getByRole("button", { name: "Previous match", exact: true }).focus();
    await page.keyboard.press("Escape");
    await closedGeometry;
    assert.equal(await page.getByRole("search", { name: "Find in terminal", exact: true }).count(), 0);
    assert.deepEqual(inputFrames, [], "find keys and query must never be sent to the terminal");

    const upload = Promise.withResolvers<void>();
    const delayUpload = async (route: import("playwright-core").Route) => { await upload.promise; await route.continue(); };
    await page.route("**/api/pane/image", delayUpload);
    try {
      const request = page.waitForRequest((message) => message.url().endsWith("/pane/image"));
      const transfer = await page.evaluateHandle(() => {
        const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=="), (character) => character.charCodeAt(0));
        const data = new DataTransfer();
        data.items.add(new File([bytes], "pixel.png", { type: "image/png" }));
        return data;
      });
      await page.locator(".xterm-screen").dispatchEvent("drop", { dataTransfer: transfer });
      await transfer.dispose();
      await request;
      const uploadFindGeometry = resized();
      await page.keyboard.press("ControlOrMeta+Shift+F");
      await uploadFindGeometry;
      const response = page.waitForResponse((answer) => answer.url().endsWith("/pane/image"));
      assert(paneSocket.current);
      const pasted = paneSocket.current.waitForEvent("framesent", {
        predicate: ({ payload }) => JSON.parse(String(payload)).type === "input", timeout: 10000,
      });
      upload.resolve();
      assert.equal((await response).status(), 200);
      await pasted;
      await page.waitForFunction(() => document.querySelector(".find-bar input") === document.activeElement);
      await page.keyboard.type("find_browser_marker");
      assert.equal(await field.inputValue(), "find_browser_marker");
      assert.equal(inputFrames.length, 1, "only the authorized uploaded path reaches the terminal");
    } finally {
      upload.resolve();
      await page.unroute("**/api/pane/image", delayUpload);
    }
    const uploadClosedGeometry = resized();
    await page.keyboard.press("Escape");
    await uploadClosedGeometry;

    // Let the narrow viewport's own resize land first: a phone's More sheet rises (styles.css) for
    // longer than the terminal waits for a size to settle (PaneTerminal.tsx), so phoneGeometry would
    // otherwise answer to that resize, and the search below would race the find bar's.
    const phoneViewport = resized();
    await page.setViewportSize({ width: 320, height: 844 });
    await phoneViewport;
    await page.getByRole("button", { name: "More", exact: true }).click();
    const phoneGeometry = resized();
    await page.getByRole("button", { name: "Find in terminal", exact: true }).click();
    await phoneGeometry;
    await field.fill("find_browser_marker");
    assert.equal((await search(() => field.press("Enter"))).total, 2);
    await page.locator(shownRows(), { hasText: "find_browser_marker" }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await staleNavigation("phone");
    console.log("PASS pane find: history jump, count, next/previous, stale range clearing and retry, no match, Escape, touch menu, no find input, deferred-upload focus");
  } catch (error) {
    const evidence = async (label: string, read: () => Promise<unknown>) => {
      try { console.error(label, await read()); } catch (cause) { console.error(`${label} unavailable:`, cause); }
    };
    await evidence("find viewport at failure", () => herdrRpc("pane.get", { pane_id: pane }));
    await evidence("find visible text at failure", () => herdrRpc("pane.read", { pane_id: pane, source: "visible" }));
    if (process.env.UI_EVIDENCE_DIR) {
      const dir = process.env.UI_EVIDENCE_DIR;
      await evidence("find failure screenshot", async () => {
        mkdirSync(dir, { recursive: true });
        await context.pages()[0]?.screenshot({ path: join(dir, "find-regression-failure.png") });
        return "saved";
      });
    }
    throw error;
  } finally {
    await context.close();
    await workspaceClose(created.workspace.workspace_id);
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const stateDir = mkdtempSync(join(tmpdir(), "herdr-find-regression-state-"));
  const server = createServer({ port: 0, stateDir, registerBridge: false });
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: chromePath() });
    await checkPaneFind(browser, `http://127.0.0.1:${server.port}`);
  } finally {
    await browser?.close();
    server.stop();
    rmSync(stateDir, { recursive: true, force: true });
  }
}
