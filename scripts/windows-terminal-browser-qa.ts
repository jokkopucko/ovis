/**
 * Never run with HERDR_TEST_LIVE=1. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Request } from "playwright-core";
import { chromePath } from "./chrome-path.ts";
import { shownRow, shownRows } from "./shown-rows.ts";

assert.equal(process.platform, "win32", "this regression requires native Windows");
assert.notEqual(process.env["HERDR_TEST_LIVE"], "1", "this regression requires an isolated test session");
await import("./test-herdr.ts");
const { createServer } = await import("../server/index.ts");
const { workspaceCreate, workspaceClose, paneSendText, paneSendKeys, paneRead, paneScrollInfo, paneScroll } = await import("../server/herdr/client.ts");
const root = mkdtempSync(join(tmpdir(), "herdr-windows-terminal-"));
let workspace: string | undefined;
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function until(done: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await done()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  const created = await workspaceCreate({ cwd: root, label: "ovis-test-windows-terminal" });
  workspace = created.workspace.workspace_id;
  const pane = created.root_pane.pane_id;
  // Exercise the fixed fallback independently of the installed CLI's control-stream support.
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", terminalAttach: false, stateDir: join(root, "state") });
  // The long native prompt places the mirror's hidden cursor outside a phone's viewport.
  await paneSendText(pane, 'function prompt { ("P" * 100) + "> " }; 1..120 | ForEach-Object { Write-Output ("WIN-HISTORY-{0:D3}" -f $_) }');
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await paneRead({ paneId: pane, source: "visible", format: "text" })).text.includes("WIN-HISTORY-120"), "PowerShell output");
  browser = await chromium.launch({ executablePath: chromePath(), headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem("ovis:settings", JSON.stringify({ terminalWheelSpeed: 1 }));
    localStorage.setItem("ovis:mirror-wrap", JSON.stringify(false));
  });
  const page = await context.newPage();
  const errors: string[] = [];
  let scrollWrites = 0;
  const requestStarts = new Map<Request, number>();
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error); });
  page.on("request", (request) => {
    requestStarts.set(request, requestStarts.size + 1);
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/pane/scroll") scrollWrites++;
  });
  await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
  const host = page.locator(".pane-terminal");
  const text = () => page.locator(shownRow()).evaluateAll((rows) => rows.map((row) => row.textContent ?? "").join("\n"));
  await until(async () => (await text()).includes("WIN-HISTORY-120"), "mirrored output");
  await host.hover();
  await page.mouse.wheel(0, -350);
  await until(async () => ((await paneScrollInfo(pane))?.offset_from_bottom ?? 0) > 0, "wheel scrolls native history");
  await until(async () => !(await text()).includes("WIN-HISTORY-120"), "mirror paints older history");
  console.log("PASS native Windows PowerShell wheel scrolls history and repaints the mirror");

  await paneScroll(pane, 0);
  await until(async () => (await text()).includes("P".repeat(100)), "native prompt returns before resizing");
  // The desktop viewport holds the whole grid, so the mount rests at its top: only the follow after
  // the short mount settles can bring the prompt's rows into view. A position written once
  // setViewportSize returns raced that follow, which may already have run (a slow resize on a VM).
  assert.equal(await host.evaluate((element) => element.scrollTop), 0, "the whole grid fits before resizing");
  await page.setViewportSize({ width: 390, height: 500 });
  await until(async () => await host.evaluate((element) => element.scrollWidth > element.clientWidth), "the native grid at its original width overflows a phone");
  await until(async () => await host.evaluate((element) => element.scrollTop > 100), "settled short mount follows the native prompt");
  const beforeWheelPan = await host.evaluate((element) => element.scrollTop);
  await host.hover();
  await page.mouse.wheel(0, -100);
  await until(async () => await host.evaluate((element) => element.scrollTop) < beforeWheelPan - 30, "wheel pans the oversized native grid");
  await paneSendText(pane, "Q");
  await until(async () => (await text()).includes("> Q"), "new native output after wheel pan");
  assert.ok(await host.evaluate((element) => element.scrollTop) < beforeWheelPan - 30, "new output does not undo local wheel panning");
  console.log("PASS native Windows mirror preserves local wheel panning across output");
  await page.setViewportSize({ width: 390, height: 844 });
  await until(async () => (await text()).includes("P".repeat(100)), "long native prompt");
  const cdp = await context.newCDPSession(page);
  const box = (await host.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await host.evaluate((element) => { element.scrollTop = 0; });
  const writesBeforeTap = scrollWrites;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  // A real wheel request is the positive control: the same history writer must run before
  // checking the tap's absence of writes, rather than passing after an arbitrary frame count.
  await host.hover();
  const scrollUrl = new URL("/api/pane/scroll", page.url()).href;
  const beforeWheelRequest = requestStarts.size;
  // Speed 1 moves three native history lines. A tap's earlier request cannot be the control,
  // even when its response arrives after the wheel; the pane and changed target must also match.
  const wheelWritten = page.waitForEvent("requestfinished", {
    predicate: (request) => (requestStarts.get(request) ?? 0) > beforeWheelRequest
      && request.method() === "POST" && request.url() === scrollUrl
      && request.postData() === JSON.stringify({ pane_id: pane, offset_from_bottom: 3 }),
    timeout: 15_000,
  });
  await page.mouse.wheel(0, -1);
  const wheelRequest = await wheelWritten;
  assert.ok((await wheelRequest.response())?.ok(), "the positive-control wheel writes native history");
  // Only a reader started after the control's entire response completed can fence the writer.
  // requestfinished bounds body completion too; an old in-flight GET cannot satisfy this wait.
  const afterWheelRequest = requestStarts.size;
  const metricsRead = await page.waitForEvent("requestfinished", {
    predicate: (request) => (requestStarts.get(request) ?? 0) > afterWheelRequest
      && request.method() === "GET" && request.url() === `${scrollUrl}?pane_id=${encodeURIComponent(pane)}`,
    timeout: 15_000,
  });
  assert.ok((await metricsRead.response())?.ok(), "fresh native history metrics complete after the control");
  assert.equal(scrollWrites, writesBeforeTap + 1, "only the wheel, not the unmoved tap, writes shared native history");
  await paneScroll(pane, 0);
  await until(async () => (await text()).includes("P".repeat(100)), "return to prompt after the control wheel");
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 8; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + step * 12 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until(async () => ((await paneScrollInfo(pane))?.offset_from_bottom ?? 0) > 0, "touch scrolls native history");
  console.log("PASS native Windows PowerShell touch scrolls history");
  await page.waitForFunction(() => document.querySelector("[data-touch-fling]") === null, undefined, { polling: 50, timeout: 15_000 });
  await paneScroll(pane, 0);
  await until(async () => (await text()).includes("P".repeat(100)), "return to prompt");
  await page.locator(".xterm-helper-textarea").focus();
  const pan = async (left: number) => {
    await host.evaluate((element, value) => new Promise<void>((resolve, reject) => {
      if (element.scrollLeft === value) { resolve(); return; }
      // Registered after the app's scroll listener: resolving proves bounds were published.
      const onScroll = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        element.removeEventListener("scroll", onScroll);
        reject(new Error("Timed out waiting for horizontal pan scroll event"));
      }, 15_000);
      element.addEventListener("scroll", onScroll, { once: true });
      element.scrollLeft = value;
    }), left);
    return host.evaluate((element) => element.scrollLeft);
  };
  for (const left of [0, 70, 0]) {
    const before = await pan(left);
    await cdp.send("Input.insertText", { text: "x" });
    assert.equal(await host.evaluate((element) => element.scrollLeft), before, "text insertion preserves manual horizontal pan");
  }
  const beforeComposition = await pan(0);
  for (const value of ["한", "한글입력테스트"]) {
    await cdp.send("Input.imeSetComposition", { text: value, selectionStart: value.length, selectionEnd: value.length });
    assert.equal(await host.evaluate((element) => element.scrollLeft), beforeComposition, "IME composition preserves manual horizontal pan");
  }
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  await paneSendKeys(pane, ["Escape"]);
  // The caret's whole cell must lie inside the phone's visible box (a cell the edge cuts counts as off
  // screen and moves the anchor), one column short of the edge, wherever this PC's font puts the columns:
  // the cell width is read from the long prompt's run of P's.
  await pan(0);
  // the mirrored rows are redrawn from herdr's read, so the prompt's run of P's can be between draws at any
  // instant: it is found and measured in the same callback, at once and again after each redraw, until it is drawn
  const { cellWidth, visibleWidth } = await host.evaluate((element, drawn) => new Promise<{ cellWidth: number; visibleWidth: number }>((resolve, reject) => {
    const measure = () => {
      const walker = document.createTreeWalker(element.querySelector(drawn)!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.startsWith("P".repeat(100))) continue;
        const range = document.createRange();
        range.setStart(node, 0);
        range.setEnd(node, 100);
        const screen = element.querySelector(".xterm-screen")!.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        return { cellWidth: range.getBoundingClientRect().width / 100, visibleWidth: box.left + element.clientLeft + element.clientWidth - screen.left };
      }
      return null;
    };
    const now = measure();
    if (now) { resolve(now); return; }
    const observer = new MutationObserver(() => {
      const found = measure();
      if (found) { observer.disconnect(); clearTimeout(timer); resolve(found); }
    });
    const timer = setTimeout(() => { observer.disconnect(); reject(new Error("no rendered run of the long prompt's P's to measure a cell by, within 15 s")); }, 15_000);
    observer.observe(element, { childList: true, subtree: true, characterData: true });
  }), shownRows());
  const vs = Math.floor(visibleWidth / cellWidth) - 4;
  await paneSendText(pane, `function prompt { ("V" * ${vs}) + "> " }`);
  await paneSendKeys(pane, ["Enter"]);
  await until(async () => (await text()).includes("V".repeat(vs) + ">"), "visible cursor near the phone's right edge");
  const edgePan = await pan(0);
  const helper = page.locator(".xterm-helper-textarea");
  const edgeAnchor = (await helper.boundingBox())!;
  const visibleBox = (await host.boundingBox())!;
  assert.ok(edgeAnchor.x > visibleBox.x + visibleBox.width / 2 && edgeAnchor.x + cellWidth < visibleBox.x + visibleBox.width,
    `the native prompt puts a wholly visible caret near the right edge (caret ${edgeAnchor.x}, cell ${cellWidth}, box ${visibleBox.x}+${visibleBox.width})`);
  await cdp.send("Input.imeSetComposition", { text: "한글입력테스트".repeat(8), selectionStart: 56, selectionEnd: 56 });
  assert.equal(await host.evaluate((element) => element.scrollLeft), edgePan, "long composition at a visible edge preserves horizontal pan");
  const composed = (await helper.boundingBox())!;
  assert.ok(Math.abs(composed.x - edgeAnchor.x) <= 1, `a visible cursor keeps its composition anchor (${edgeAnchor.x} -> ${composed.x})`);
  assert.ok(composed.x + composed.width <= visibleBox.x + visibleBox.width + 1, "long preedit stays within the visible scrollport");
  await cdp.send("Input.imeSetComposition", { text: "", selectionStart: 0, selectionEnd: 0 });
  const screenHeight = await page.locator(".xterm-screen").evaluate((element) => element.getBoundingClientRect().height);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 50, y }, { x: x + 50, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 75, y }, { x: x + 75, y }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await until(async () => await page.locator(".xterm-screen").evaluate((element) => element.getBoundingClientRect().height) > screenHeight,
    "pinch changes the fixed grid's font metrics");
  await pan(0);
  const resizedHost = (await host.boundingBox())!;
  const resizedHelper = (await helper.boundingBox())!;
  assert.ok(resizedHelper.y + resizedHelper.height <= resizedHost.y + resizedHost.height + 1,
    "the IME anchor follows changed fixed-grid font metrics");
  assert.ok(resizedHelper.y + resizedHelper.height >= resizedHost.y + resizedHost.height - 2,
    "a clipped bottom-row cursor anchors at the current visible edge, not the old font bounds");
  await cdp.detach();
  assert.deepEqual(errors, []);
  console.log("PASS native Windows mirror text insertion and IME preserve the phone viewport");
} catch (error) {
  // a failing cleanup below would otherwise replace this error
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  server?.stop();
  if (workspace) await workspaceClose(workspace);
  // the closed pane's PowerShell holds its folder (EBUSY) until it has exited
  await until(async () => {
    try {
      rmSync(root, { recursive: true, force: true });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EBUSY") return false;
      throw error;
    }
  }, "the closed pane's shell lets go of the test folder");
}
