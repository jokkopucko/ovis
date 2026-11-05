/** Search decoration and shared-history paging, with no history scrollbar, against panes owned by this script. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chromium } from "playwright-core";
import { openSettingsPage } from "./settings-page.ts";
import type { PaneFindResponse } from "../shared/protocol.ts";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScrollInfo, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { chromePath } from "./chrome-path.ts";
const state = mkdtempSync(join(tmpdir(), "herdr-viewport-browser-"));
const server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: state, usage: new UsageService(undefined, []) });
const browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
let workspace: string | undefined;
async function until(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    assert.ok(Date.now() < deadline, message);
    await Bun.sleep(25);
  }
}
try {
  const made = await workspaceCreate({ cwd: state, label: "ovis-test-viewport" });
  workspace = made.workspace.workspace_id;
  const paneId = made.root_pane.pane_id;
  const ready = herdrRpc("pane.wait_for_output", { pane_id: paneId, source: "visible", match: { type: "substring", value: "viewport_ready" }, timeout_ms: 10000 }, undefined, 12000);
  await herdrRpc("pane.send_input", { pane_id: paneId, text: "for n in $(seq 1 180); do printf 'history %03d: record\\n' $n; if [ $n = 12 ] || [ $n = 90 ] || [ $n = 170 ]; then printf 'mark_%s tail mark_%s\\n' needle needle; fi; done; printf 'wide_%s%s%sZ\\n' '界' 'e' '́'; printf 'viewport_%s\\n' ready; exec cat", keys: ["enter"] });
  await ready;
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US" });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({ language: "en", theme: "light", defaultView: "terminal", alertsOn: false })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  const searches: unknown[] = [];
  const terminalInput: string[] = [];
  page.on("websocket", (socket) => socket.on("framesent", ({ payload }) => {
    try {
      const frame = JSON.parse(String(payload));
      if (["input", "keys", "submit"].includes(frame.type)) terminalInput.push(frame.type);
    } catch { /* Only the bridge’s JSON input frames matter. */ }
  }));
  page.on("response", (response) => { if (response.url().endsWith("/api/pane/find")) void response.json().then((body) => { searches.push({ request: response.request().postDataJSON(), body }); }, () => {}); });
  const waitHighlight = async () => {
    try { await page.locator(".terminal-find-hit.is-current").first().waitFor(); }
    catch (error) {
      console.error("Search diagnostic", { searches: JSON.stringify([searches[0], ...searches.slice(-2)]), native: await paneScrollInfo(paneId), dom: await page.evaluate(() => ({ text: document.querySelector(".find-bar")?.textContent, hits: document.querySelectorAll(".terminal-find-hit").length, rows: document.querySelector(".xterm-rows")?.childElementCount, screen: document.querySelector(".xterm-rows")?.textContent })) });
      if (process.env.UI_EVIDENCE_DIR) { mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true }); await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-search-failure.png") }); }
      throw error;
    }
  };
  page.on("pageerror", (error) => errors.push(error.message));
  // Native history moves the way a user moves it: the paging shortcut, one acknowledged page at a time.
  const pageToEdge = async (direction: -1 | 1) => {
    const deadline = Date.now() + 10000;
    await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
    for (;;) {
      const info = (await paneScrollInfo(paneId))!;
      if (info.offset_from_bottom === (direction > 0 ? info.max_offset_from_bottom : 0)) return;
      assert.ok(Date.now() < deadline, `paging reaches the ${direction > 0 ? "top" : "bottom"} of native history`);
      const acknowledged = page.waitForResponse((response) => response.url().endsWith("/api/pane/scroll") && response.request().method() === "POST");
      await page.keyboard.press(direction > 0 ? "ControlOrMeta+Shift+PageUp" : "ControlOrMeta+Shift+PageDown");
      await acknowledged.catch(async (error) => { throw new Error(`no page POST toward ${direction > 0 ? "top" : "bottom"} from ${JSON.stringify(info)}, focus ${await page.evaluate(() => document.activeElement?.className)}: ${error}`); });
    }
  };
  const firstMetrics = page.waitForResponse((response) => response.url().includes("/api/pane/scroll?") && response.request().method() === "GET");
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(paneId)}`);
  await firstMetrics;
  const backgrounds = await page.evaluate(() => ({
    viewport: getComputedStyle(document.querySelector(".xterm-viewport")!).backgroundColor,
    host: getComputedStyle(document.querySelector(".terminal-host")!).backgroundColor,
  }));
  assert.equal(backgrounds.viewport, backgrounds.host, "the terminal gutter follows the light theme instead of showing a black frame");
  // equal backgrounds prove nothing if both stayed dark: the light theme must actually be on
  const [r, g, b] = (backgrounds.host.match(/\d+(\.\d+)?/g) ?? []).map(Number);
  assert.ok((0.2126 * r! + 0.7152 * g! + 0.0722 * b!) / 255 > 0.5, `the light theme paints a light terminal background (got ${backgrounds.host})`);
  assert.ok((await paneScrollInfo(paneId))!.max_offset_from_bottom > 100, "herdr holds the full history");
  const widths = await page.evaluate(() => ({ grid: document.querySelector(".pane-terminal")!.getBoundingClientRect().width, surface: document.querySelector(".terminal-surface")!.getBoundingClientRect().width }));
  assert.equal(widths.grid, widths.surface, "the grid takes the full width, with no column reserved beside it");
  // Paging moves native history without reaching the program’s input.
  await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
  const inputsBeforePaging = terminalInput.length;
  const pageRows = (await paneScrollInfo(paneId))!.viewport_rows - 1;
  // a page asked for before the client's first metrics read only asks for that read: press until one is sent
  for (let attempt = 0; ; attempt++) {
    assert.ok(attempt < 10, "the client pages once it has read the pane's metrics");
    const sent = page.waitForRequest((request) => request.url().endsWith("/api/pane/scroll") && request.method() === "POST", { timeout: 3000 }).then(() => true, () => false);
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    if (await sent) break;
  }
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === pageRows, "the global shortcut pages by native rows minus one");
  await page.keyboard.press("ControlOrMeta+Shift+PageDown");
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === 0, "the opposite shortcut returns to the native bottom");

  // Repeated pages accumulate while the first request is held.
  const pagingRelease = Promise.withResolvers<void>();
  let holdFirstPage = true;
  const holdPaging = async (route: import("playwright-core").Route) => {
    if (route.request().method() === "POST" && holdFirstPage) {
      holdFirstPage = false;
      await pagingRelease.promise;
    }
    await route.continue();
  };
  await page.route("**/api/pane/scroll", holdPaging);
  try {
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    await until(async () => !holdFirstPage, "paging POST was dispatched");
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
  } finally { pagingRelease.resolve(); }
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === pageRows * 3, "repeat paging accumulates against the pending preview");
  await page.unroute("**/api/pane/scroll", holdPaging);
  await page.keyboard.press("ControlOrMeta+Shift+PageDown");
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === pageRows * 2, "paging after the ACK starts at its acknowledged offset");
  await pageToEdge(-1);

  {
    await page.keyboard.press("ControlOrMeta+Shift+Comma");
    await openSettingsPage(page, "Shortcuts");
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    assert.equal((await paneScrollInfo(paneId))!.offset_from_bottom, 0, "Settings blocks the pane's paging control");
    await page.keyboard.press("Escape");
    await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
    // one line stays between pages
    const expected = Math.max(1, (await paneScrollInfo(paneId))!.viewport_rows - 1);
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === expected, "native paging keeps one overlap row");
    await page.keyboard.press("ControlOrMeta+Shift+PageDown");
    await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === 0, "native paging down reaches the bottom");
  }
  // A rebound global PageDown pages up, once; then the defaults come back for the rest of the script.
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Shortcuts");
  await page.getByRole("combobox", { name: "Scroll pane down", exact: true }).selectOption("off");
  await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("PageDown");
  await page.keyboard.press("Escape");
  await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
  await page.keyboard.press("ControlOrMeta+Shift+PageDown");
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === pageRows, "a rebound global PageDown pages up only once");
  await page.keyboard.press("ControlOrMeta+Shift+Comma");
  await openSettingsPage(page, "Shortcuts");
  await page.getByRole("combobox", { name: "Scroll pane up", exact: true }).selectOption("PageUp");
  await page.getByRole("combobox", { name: "Scroll pane down", exact: true }).selectOption("PageDown");
  await page.keyboard.press("Escape");
  await pageToEdge(-1);
  assert.equal(terminalInput.length, inputsBeforePaging, "paging and settings never send input to the terminal program");

  await pageToEdge(1);
  assert.ok((await paneScrollInfo(paneId))!.offset_from_bottom > 100, "paging reaches the top of native history");
  await pageToEdge(-1);

  // The jump button: absent at the bottom, shown above it, and a click returns to the bottom without
  // taking the terminal's focus or sending input to the program.
  const jump = page.getByRole("button", { name: "Jump to bottom", exact: true });
  // herdr is at the bottom once paging returns; the page drops the button only after it reads that
  // page's answer and draws it, so its going is waited for, not sampled
  await jump.waitFor({ state: "detached" });
  await pageToEdge(1);
  await jump.waitFor();
  const jumpBox = (await jump.boundingBox())!, gridBox = (await page.locator(".pane-terminal").boundingBox())!;
  assert.ok(jumpBox.x + jumpBox.width <= gridBox.x + gridBox.width && jumpBox.y + jumpBox.height <= gridBox.y + gridBox.height,
    "the jump button sits inside the grid's bottom-right corner");
  await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
  const inputsBeforeJump = terminalInput.length;
  await jump.click();
  await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === 0, "the jump button returns to the native bottom");
  await jump.waitFor({ state: "detached" });
  assert.equal(await page.evaluate(() => document.activeElement?.className), "xterm-helper-textarea", "the jump button leaves focus in the terminal");
  assert.equal(terminalInput.length, inputsBeforeJump, "the jump button sends no input to the program");

  // The metrics poll: a quiet pane at the bottom backs off, output brings it back, and a view scrolled
  // up into history keeps reading every second, since growing history there may send no output.
  const metricsReads: number[] = [];
  const countRead = (request: import("playwright-core").Request) => {
    if (request.method() === "GET" && request.url().includes("/api/pane/scroll?")) metricsReads.push(Date.now());
  };
  page.on("request", countRead);
  try {
    await until(async () => metricsReads.length > 0, "the poll reads metrics after paging to the bottom");
    const quietFrom = metricsReads.at(-1)!;
    // fixed wait: proving the quiet pane's poll stays sparse over a window (a 1 s poll makes 8 reads)
    await Bun.sleep(8000);
    const quietReads = metricsReads.filter((at) => at > quietFrom).length;
    assert.ok(quietReads <= 4, `a quiet pane backs its metrics poll off, read ${quietReads} times in 8 s`);
    // A failed read on the backed-off poll leaves page keys without metrics; the retry must not wait out the idle backoff.
    let failedAt = 0;
    const failOnce = async (route: import("playwright-core").Route) => {
      if (failedAt || route.request().method() !== "GET") return route.continue();
      failedAt = Date.now();
      await route.fulfill({ status: 502, contentType: "application/json", body: JSON.stringify({ error: "busy" }) });
    };
    await page.route("**/api/pane/scroll?**", failOnce);
    try {
      const failDeadline = Date.now() + 20000;
      while (!failedAt) { assert.ok(Date.now() < failDeadline, "the backed-off poll reads again within its 15 s cap"); await Bun.sleep(25); }
      // the failed request's own read event may land just after failedAt, so the retry starts 50 ms later
      const afterFailure = () => metricsReads.find((at) => at > failedAt + 50);
      await until(async () => afterFailure() !== undefined || Date.now() - failedAt > 3000, "a read follows the failed one");
      const retry = afterFailure();
      assert.ok(retry !== undefined && retry - failedAt < 1500, `a failed metrics read retries within about 1 s, took ${retry === undefined ? "over 3000" : retry - failedAt} ms`);
    } finally { await page.unroute("**/api/pane/scroll?**", failOnce); }
    const beforeOutput = metricsReads.length;
    const outputAt = Date.now();
    await herdrRpc("pane.send_input", { pane_id: paneId, text: "poll_wake", keys: ["enter"] });
    await until(async () => metricsReads.length > beforeOutput, "output wakes the backed-off poll");
    assert.ok(metricsReads[beforeOutput]! - outputAt < 1500, `output brings the next read back within about 1 s, took ${metricsReads[beforeOutput]! - outputAt} ms`);

    await pageToEdge(1);
    await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom > 100, "paging scrolls up before the held-view poll check");
    const upFrom = Date.now();
    // fixed wait: proving the scrolled-up poll keeps its 1 s cadence over a window the idle backoff would stretch
    await Bun.sleep(6000);
    const upReads = metricsReads.filter((at) => at > upFrom).length;
    assert.ok(upReads >= 4, `a view scrolled up keeps reading metrics about every second, read ${upReads} times in 6 s`);
    const heldMax = (await paneScrollInfo(paneId))!.max_offset_from_bottom;
    const grown = page.waitForResponse(async (response) => response.url().includes("/api/pane/scroll?") && response.request().method() === "GET"
      && (((await response.json()) as { scroll: { max_offset_from_bottom: number } | null }).scroll?.max_offset_from_bottom ?? 0) > heldMax, { timeout: 3000 });
    const grownAt = Date.now();
    for (let line = 0; line < 5; line++) await herdrRpc("pane.send_input", { pane_id: paneId, text: `held_view_${line}`, keys: ["enter"] });
    await grown;
    assert.ok(Date.now() - grownAt < 3000, "history grown under a scrolled-up view reaches the client's metrics within about 3 s");
  } finally { page.off("request", countRead); }
  await pageToEdge(-1);

  const beforeFindRows = (await paneScrollInfo(paneId))!.viewport_rows;
  await page.keyboard.press("ControlOrMeta+Shift+f");
  const find = page.getByRole("search", { name: "Find in terminal", exact: true });
  const input = find.getByRole("searchbox");
  // Opening Find changes the shared native grid. Search after that geometry reaches herdr,
  // as pane-find-regression does, rather than racing an attach resize with pane.scroll.
  await until(async () => {
    const native = await paneScrollInfo(paneId);
    return !!native && native.viewport_rows < beforeFindRows
      && native.viewport_rows === await page.locator(".xterm-rows > div").count();
  }, "the search bar's native geometry is ready");
  await input.fill("mark_needle");
  await input.press("Enter");
  await waitHighlight();
  assert.ok(await page.locator(".terminal-find-hit").count() >= 2, "all visible occurrences are marked without selecting them");
  if (process.env.UI_EVIDENCE_DIR) {
    mkdirSync(process.env.UI_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-search.png") });
  }
  const count = await find.locator(".find-bar-count").textContent();
  const readonlySearch = page.waitForRequest((request) => request.url().endsWith("/api/pane/find") && request.postDataJSON()?.jump === false);
  await pageToEdge(-1);
  await readonlySearch;
  assert.equal(await find.locator(".find-bar-count").textContent(), count, "scroll refresh does not advance the search ordinal");
  assert.equal((await paneScrollInfo(paneId))!.offset_from_bottom, 0, "background search refresh never moves the view");
  await input.fill("界éZ");
  await input.press("Enter");
  await waitHighlight();
  const hit = (await page.locator(".terminal-find-hit.is-current").first().boundingBox())!;
  const screen = (await page.locator(".xterm-screen").boundingBox())!;
  const wide = await page.evaluate(() => { const row = document.querySelector(".xterm-rows > div"); return row?.getBoundingClientRect().height ?? 0; });
  assert.ok(hit.width > 20 && hit.height > 0 && wide > 0 && hit.x >= screen.x, "wide and combining text has visible cell-aligned emphasis");
  // An older page write must finish before a newer explicit search moves the pane.
  // The fetch observer records dispatch synchronously; no timing sleep is needed to prove
  // Find is waiting while its UI already says Searching… and the POST is held below.
  await page.evaluate((owner) => {
    const original = window.fetch;
    const probe = { released: false, calls: [] as Array<{ path: string; released: boolean }>, restore: () => { window.fetch = original; } };
    (window as any).__viewportOrderProbe = probe;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
      if (init?.method === "POST" && typeof init.body === "string") {
        const body = JSON.parse(init.body);
        if (body.pane_id === owner && (url.pathname.endsWith("/pane/scroll") || (url.pathname.endsWith("/pane/find") && body.jump !== false))) {
          probe.calls.push({ path: url.pathname, released: probe.released });
        }
      }
      return original.call(window, input, init);
    };
  }, paneId);
  const releaseScroll = Promise.withResolvers<void>();
  const intercepted = Promise.withResolvers<void>();
  let firstScroll = true;
  const holdScroll = async (route: import("playwright-core").Route) => {
    if (route.request().method() === "POST" && firstScroll) {
      firstScroll = false;
      intercepted.resolve();
      await releaseScroll.promise;
    }
    await route.continue();
  };
  await page.route("**/api/pane/scroll", holdScroll);
  try {
    await page.locator(".xterm-helper-textarea").evaluate((node: HTMLTextAreaElement) => node.focus());
    await page.keyboard.press("ControlOrMeta+Shift+PageUp");
    await Promise.race([intercepted.promise, new Promise<never>((_resolve, reject) => {
      const signal = AbortSignal.timeout(10000);
      signal.addEventListener("abort", () => reject(new Error("scroll POST was not intercepted")), { once: true });
    })]);
    // A second queued target is obsolete once the user asks Find to choose the viewport.
    await page.keyboard.press("ControlOrMeta+Shift+PageDown");
    await input.fill("history 090: record");
    const explicitResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/find")
      && response.request().postDataJSON()?.query === "history 090: record" && response.request().postDataJSON()?.jump !== false);
    const refreshedResponse = page.waitForResponse((response) => response.url().endsWith("/api/pane/find")
      && response.request().postDataJSON()?.query === "history 090: record" && response.request().postDataJSON()?.jump === false);
    // These listeners still terminate quietly if an earlier assertion fails.
    void explicitResponse.catch(() => {}); void refreshedResponse.catch(() => {});
    await input.press("Enter");
    await page.waitForFunction(() => document.querySelector<HTMLInputElement>(".find-bar input")?.readOnly === true);
    assert.equal(await page.evaluate(() => (window as any).__viewportOrderProbe.calls.filter((call: { path: string }) => call.path.endsWith("/pane/find")).length), 0,
      "explicit native search must wait for the previous page request");
    await page.evaluate(() => { (window as any).__viewportOrderProbe.released = true; });
    releaseScroll.resolve();
    const response = await explicitResponse;
    assert.equal(response.status(), 200);
    const result = await response.json() as PaneFindResponse;
    assert.ok(result.match && result.scroll);
    const expected = Math.max(0, result.scroll.max_offset_from_bottom - result.match.start.row);
    assert.equal(result.scroll.offset_from_bottom, expected);
    assert.ok(expected > 0 && expected < result.scroll.max_offset_from_bottom, "the search chooses a distinct middle viewport");
    await waitHighlight();
    assert.equal((await refreshedResponse).status(), 200);
    await until(async () => (await paneScrollInfo(paneId))!.offset_from_bottom === expected, "the newer search determines native history position");
    const ordering = await page.evaluate(() => (window as any).__viewportOrderProbe.calls) as Array<{ path: string; released: boolean }>;
    const findIndex = ordering.findIndex((call) => call.path.endsWith("/pane/find"));
    assert.ok(findIndex > 0 && ordering[findIndex]!.released);
    assert.equal(ordering.slice(findIndex + 1).filter((call) => call.path.endsWith("/pane/scroll")).length, 0,
      "an older queued scroll must not be dispatched after Find");
    const final = await paneScrollInfo(paneId);
    assert.equal(final!.offset_from_bottom, expected, "no late scroll overwrites the search result");
  } finally {
    releaseScroll.resolve();
    await page.unroute("**/api/pane/scroll", holdScroll);
    await page.evaluate(() => {
      (window as any).__viewportOrderProbe?.restore();
      delete (window as any).__viewportOrderProbe;
    });
  }

  await page.getByRole("button", { name: "Close search", exact: true }).click();
  await page.locator(".terminal-find-hit").waitFor({ state: "detached" });

  // Exercise an old bridge: no-jump refresh must never be sent if the response lacks fields.
  let automatic = 0;
  await page.route("**/api/pane/find", async (route) => {
    const body = route.request().postDataJSON();
    if (body.jump === false) automatic++;
    const response = await route.fetch();
    const result = await response.json(); delete result.matches; delete result.scroll;
    await route.fulfill({ response, json: result });
  });
  await page.keyboard.press("ControlOrMeta+Shift+f");
  await input.fill("mark_needle");
  await input.press("Enter");
  await find.locator(".find-bar-count").filter({ hasText: /of/ }).waitFor();
  const metricsRead = page.waitForResponse((response) => response.url().includes("/api/pane/scroll?") && response.request().method() === "GET");
  await metricsRead;
  assert.equal(automatic, 0, "older bridges are never sent an automatic search that could scroll");
  assert.deepEqual(errors, []);
  if (process.env.UI_EVIDENCE_DIR) await page.screenshot({ path: join(process.env.UI_EVIDENCE_DIR, "terminal-viewport.png") });
  await context.close();
  console.log("PASS no history scrollbar, full-width grid, native paging, jump to bottom, search highlights, wide cells, non-jumping refresh and old bridge compatibility");
} finally {
  await browser.close(); server.stop();
  if (workspace) await workspaceClose(workspace).catch(() => {});
  rmSync(state, { recursive: true, force: true });
}
