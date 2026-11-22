import "./test-herdr.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Response as PageResponse } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScrollInfo, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { omoSessionFolder } from "../server/omo.ts";
import { FLING_STOPPED_MS } from "../src/lib/touchFling.ts";
import { chromePath } from "./chrome-path.ts";
import { unlessGone } from "./response-gone.ts";
import { shownRows } from "./shown-rows.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

const state = mkdtempSync(join(tmpdir(), "omo-question-wheel-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const baseline = process.env["EXPECT_CAPTURED_WHEEL"] === "1";
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
type ScrollBody = { scroll: { offset_from_bottom: number; max_offset_from_bottom: number; viewport_rows: number } | null };
const bodyOf = (response: PageResponse) => unlessGone(response, (answer) => answer.json() as Promise<ScrollBody>);
const waitOutput = (pane: string, value: string) => herdrRpc("pane.wait_for_output", {
  pane_id: pane, source: "visible", match: { type: "substring", value }, timeout_ms: 10000,
}, undefined, 12000);

try {
  const fixtures = [];
  for (const omo of [true, false]) {
    const cwd = join(state, omo ? "omo-pane" : "shell-pane");
    mkdirSync(cwd);
    const agentDir = join(cwd, "agent");
    const sessions = join(agentDir, "sessions", omoSessionFolder(cwd));
    const id = "question-wheel-session-0001";
    mkdirSync(sessions, { recursive: true });
    const transcript = join(sessions, `2026-10-17T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(transcript, [
      { type: "session", version: 3, id, cwd, timestamp: new Date().toISOString() },
      { type: "message", id: "ask", parentId: null, timestamp: new Date().toISOString(), message: {
        role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "question", name: "request_user_input",
          arguments: { wait_for_answer: false, questions: [{ id: "choice", header: "Choice", question: "Choose a fixture", options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] } }],
      } },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const program = join(cwd, omo ? "omo" : "mouse-app.mjs");
    const log = join(cwd, "input.bin");
    writeFileSync(program, `
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { processStartedAt } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "../server/process-start.ts")).href)};
const holders = ${JSON.stringify(join(sessions, "session-holders", id))};
if (${omo}) {
mkdirSync(holders, { recursive: true });
writeFileSync(join(holders, process.pid + ".json"), JSON.stringify({ pid: process.pid, cwd: process.cwd(), bootAtMs: 0, processStartedAtMs: processStartedAt(process.pid) }));
}
writeFileSync(${JSON.stringify(log)}, "");
process.stdin.setRawMode(true);
let input = "";
process.stdin.on("data", data => {
  appendFileSync(${JSON.stringify(log)}, data);
  process.stdout.write("WHEEL_RECEIVED\\r\\n");
  input += data.toString();
  if (input.includes("z")) process.stdout.write("TRACKPAD_DRAINED\\r\\n");
  if (input.includes("\\x1b[<65;")) process.stdout.write("CTRL_DRAINED\\r\\n");
});
process.stdout.write(Array.from({ length: 400 }, (_, n) => "history " + n + "\\r\\n").join("") + "\\x1b[?1000h\\x1b[?1002h\\x1b[?1006hFIXTURE_READY\\r\\n");
`);
    const made = await workspaceCreate({ cwd, label: "ovis-test-question-wheel" });
    workspaces.push(made.workspace.workspace_id);
    const pane = made.root_pane.pane_id;
    const ready = waitOutput(pane, "FIXTURE_READY");
    await herdrRpc("pane.send_input", { pane_id: pane,
      text: `export OMO_CODING_AGENT_DIR=${quote(agentDir)}; exec ${quote(process.execPath)} ${quote(program)}`, keys: ["enter"] });
    await ready;
    fixtures.push({ pane, omo, log, transcript });
  }
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(state, "server"),
    tailscaleOwner: null, usage: new UsageService(undefined, []) });
  browser = await chromium.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-US", hasTouch: true });
  await context.addInitScript(() => localStorage.setItem("ovis:settings", JSON.stringify({
    language: "en", defaultView: "terminal", terminalInputMode: "direct", terminalWheelSpeed: 2, alertsOn: false,
  })));
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  let settledPane: string | null = null;
  const settled = Promise.withResolvers<void>();
  page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    const frame: ServerMessage = JSON.parse(String(payload));
    if (frame.type === "pane-status" && frame.pane_id === settledPane && frame.agent_status === "working") settled.resolve();
  }));
  for (const fixture of fixtures) {
    const { pane, omo, log } = fixture;
    const releaseMetrics = Promise.withResolvers<void>();
    const delayed = omo && !baseline;
    if (delayed) await page.route("**/api/pane/scroll?*", async route => {
      await releaseMetrics.promise;
      await route.continue();
    });
    const metrics = delayed ? null : page.waitForResponse(response => response.url().includes("/pane/scroll?"));
    await page.goto(`http://127.0.0.1:${server.port}/?pane=${encodeURIComponent(pane)}`);
    if (!delayed) await metrics;
    const body: { snapshot: SessionSnapshot } = await (await page.request.get(`http://127.0.0.1:${server.port}/api/session`)).json();
    const reported = body.snapshot.panes.find((item: { pane_id: string }) => item.pane_id === pane);
    assert.ok(reported);
    if (omo) assert.equal(reported.agent, "omo");
    else assert.equal(reported.agent, undefined);
    if (omo) assert.equal(reported.agent_status, "blocked");
    await page.locator(".conn-live").waitFor();
    await page.getByText("Waiting for terminal input…", { exact: true }).waitFor({ state: "hidden" });
    await page.locator(shownRows(), { hasText: "FIXTURE_READY" }).waitFor();
    const screen = page.locator(".xterm-screen").first();
    await screen.waitFor();
    const bounds = await screen.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const initial = await paneScrollInfo(pane);
    assert.ok(initial && initial.max_offset_from_bottom > 100);
    assert.equal(initial.offset_from_bottom, 0);
    const scrollResponse = (offset: number) => page.waitForResponse(async response => {
      if (!response.url().endsWith("/api/pane/scroll") || response.request().method() !== "POST") return false;
      return (await bodyOf(response))?.scroll?.offset_from_bottom === offset;
    });
    if (delayed) {
      // Observe both trusted events at the terminal before letting metrics reach the app.
      const wheels = await screen.evaluateHandle(node => {
        const terminal = node.closest(".xterm");
        if (!terminal) throw new Error("no terminal for the wheel fixture");
        const first = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        let count = 0;
        const wheel = (event: Event) => {
          if (!event.isTrusted) return;
          if (++count === 1) first.resolve();
          else {
            terminal.removeEventListener("wheel", wheel, true);
            second.resolve();
          }
        };
        terminal.addEventListener("wheel", wheel, true);
        return [first.promise, second.promise];
      });
      try {
        for (const index of [0, 1]) {
          await Promise.all([wheels.evaluate((observed, index) => Promise.race([observed[index], new Promise<never>((_, reject) => {
            AbortSignal.timeout(10_000).addEventListener("abort", () => reject(new Error(`wheel ${index + 1} did not reach the terminal`)), { once: true });
          })]), index), page.mouse.wheel(0, -120)]);
        }
        const received = scrollResponse(2 * 3 * 2);
        releaseMetrics.resolve();
        await received;
      } finally {
        releaseMetrics.resolve();
        await wheels.dispose();
      }
      await page.unroute("**/api/pane/scroll?*");
    } else {
      await Promise.all([waitOutput(pane, "WHEEL_RECEIVED"), page.mouse.wheel(0, -120)]);
    }
    const after = await paneScrollInfo(pane);
    assert.ok(after);
    const input = readFileSync(log, "utf8");
    console.log(JSON.stringify({ omo, baseline, initial, after, input }));
    await page.screenshot({ path: join(evidence, `${baseline ? "before" : "after"}-${omo ? "omo" : "non-omo"}.png`) });
    if (omo && !baseline) {
      assert.ok(after.offset_from_bottom > 0, "an open OmO question does not swallow the wheel");
      assert.equal(after.offset_from_bottom, 2 * 3 * 2, "wheel steps accumulate while the first metrics read is held");
      assert.equal(input, "", "no wheel report reaches OmO");
      const lineWheel = async (deltaY: number, offset: number, events = 1) => {
        console.log("line wheel", deltaY, "x", events, "expects", offset);
        // Dispatch one batch in one browser task. Metrics reads and their redraws cannot
        // age or replace the scroll preview between events in this gesture.
        await Promise.all([scrollResponse(offset), screen.evaluate((node, { deltaY, events }) => {
          for (let sent = 0; sent < events; sent += 1) node.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 1, bubbles: true, cancelable: true }));
        }, { deltaY, events })]);
        // The coordinator's React state has consumed the scroll result before another gesture.
        await page.getByRole("button", { name: "Jump to bottom", exact: true }).waitFor({ state: offset === 0 ? "hidden" : "visible" });
        assert.equal((await paneScrollInfo(pane))?.offset_from_bottom, offset);
      };
      await lineWheel(-1, after.offset_from_bottom + 3);
      await lineWheel(-1, after.max_offset_from_bottom, Math.ceil(after.max_offset_from_bottom / 3) + 2);
      await lineWheel(1, 0, Math.ceil(after.max_offset_from_bottom / 3) + 2);
      const resizedMetrics = page.waitForResponse(async response => {
        if (!response.url().includes("/pane/scroll?")) return false;
        const body = await bodyOf(response);
        return body !== undefined && body.scroll?.viewport_rows !== after.viewport_rows;
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => {
        const screen = document.querySelector(".xterm-screen");
        return screen && screen.getBoundingClientRect().width <= innerWidth;
      });
      const phoneMetrics = (await bodyOf(await resizedMetrics))?.scroll;
      assert.ok(phoneMetrics);
      await lineWheel(1, 0, Math.ceil(phoneMetrics.max_offset_from_bottom / 3) + 2);
      const mobile = await screen.boundingBox();
      assert.ok(mobile);
      const cdp = await context.newCDPSession(page);
      const x = mobile.x + mobile.width / 2;
      const y = mobile.y + mobile.height / 3;
      const mobileScroll = await paneScrollInfo(pane);
      assert.ok(mobileScroll);
      const rowHeight = mobile.height / mobileScroll.viewport_rows;
      const travel = rowHeight * 3 * 2;
      await page.screenshot({ path: join(evidence, "mobile-before-touch.png") });
      const touched = scrollResponse(6);
      console.log("touch expects", 6, { mobile, rowHeight, travel });
      const lift = Date.now() / 1000;
      const moved = lift - FLING_STOPPED_MS * 2 / 1000;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }], timestamp: moved - 0.016 });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + travel }], timestamp: moved });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [], timestamp: lift });
      await touched;
      await page.locator("[data-touch-fling]").waitFor({ state: "detached" });
      assert.equal((await paneScrollInfo(pane))?.offset_from_bottom, 6, "a touch held still before the lift ends where the finger stopped");
      assert.equal(readFileSync(log, "utf8"), "", "touch sends no mouse reports to the question");
      await page.screenshot({ path: join(evidence, "after-omo-mobile.png") });
      await cdp.detach();
      // back to the desktop size: herdr reflows the history at the new width, which moves the view's place in it,
      // so the wheels that bring it back to the end go once that size has reached herdr, not alongside it
      const desktopMetrics = page.waitForResponse(async response => response.url().includes("/pane/scroll?")
        && (await bodyOf(response))?.scroll?.viewport_rows === after.viewport_rows);
      await page.setViewportSize({ width: 1280, height: 800 });
      const restoredMetrics = (await bodyOf(await desktopMetrics))?.scroll;
      assert.ok(restoredMetrics);
      console.log("PASS speed-two line wheels, maximum/bottom clamps, and phone touch history");
      await lineWheel(1, 0, Math.ceil(restoredMetrics.max_offset_from_bottom / 3) + 2);
      settledPane = pane;
      appendFileSync(fixture.transcript, JSON.stringify({ type: "custom", customType: "ask-user:settlement",
        data: { requestId: "question" } }) + "\n");
      await Promise.race([settled.promise, new Promise<never>((_resolve, reject) => {
        AbortSignal.timeout(10000).addEventListener("abort", () => reject(new Error("question settlement status did not arrive")), { once: true });
      })]);
      await page.locator('.tab-strip-item.is-active .tab-strip-dot[data-status="working"]').waitFor();
      const backToApp = waitOutput(pane, "WHEEL_RECEIVED");
      const desktop = await screen.boundingBox();
      assert.ok(desktop);
      await page.mouse.move(desktop.x + desktop.width / 2, desktop.y + desktop.height / 2);
      await page.mouse.wheel(0, -120);
      await backToApp;
      assert.match(readFileSync(log, "utf8"), /\x1b\[<64;\d+;\d+M/);
      assert.equal((await paneScrollInfo(pane))?.offset_from_bottom, 0);
      console.log("PASS settled OmO question restores application wheel reports without remounting");
    } else {
      assert.equal(after.offset_from_bottom, 0);
      assert.match(input, /\x1b\[<64;\d+;\d+M/, "herdr hands SGR wheel input to the capturing program");
      // A trackpad's small pixel steps report one wheel per row of travel, as xterm.js 5.5 counted
      // them: xterm.js 6.0 scales a delta under 50 px by 0.3 (#1617). Untrusted, so not repeated at
      // the wheel speed: 12 steps of 0.55 rows are 6 reports, and 2 with the 0.3 scale.
      const reports = () => (readFileSync(log, "utf8").match(/\x1b\[<64;/g) ?? []).length;
      const reportsBefore = reports();
      const rowPx = bounds.height / initial.viewport_rows;
      const trackpadDrained = waitOutput(pane, "TRACKPAD_DRAINED");
      const inputField = page.locator(".xterm-helper-textarea").first();
      await inputField.evaluate((node: HTMLTextAreaElement) => node.focus());
      for (let sent = 0; sent < 12; sent += 1) await screen.dispatchEvent("wheel", { deltaY: -rowPx * 0.55, deltaMode: 0, bubbles: true, cancelable: true });
      await page.keyboard.press("z");
      await trackpadDrained;
      assert.equal(reports() - reportsBefore, 6, "a trackpad's small steps report one wheel per row");
      console.log("PASS trackpad-sized pixel wheels report one wheel per row of travel");
      // Holding Ctrl does not speed an application's wheel up, as in xterm.js 5.5, where only Alt
      // did: 6.0 multiplies by fastScrollSensitivity under Alt or Ctrl (#2336). Each event sends at
      // most one report, once the travel adds up to a row: the same 12 steps travel 6.6 rows, plus
      // under one row the earlier steps left, so 6 or 7 reports; five times faster, all 12 report.
      // A later wheel down marks the end, since the reports reach the program in order. Ctrl adds
      // 16 to the button.
      const ctrlReports = () => (readFileSync(log, "utf8").match(/\x1b\[<80;/g) ?? []).length;
      const fastBefore = ctrlReports();
      for (let sent = 0; sent < 12; sent += 1) await screen.dispatchEvent("wheel", { deltaY: -rowPx * 0.55, deltaMode: 0, ctrlKey: true, bubbles: true, cancelable: true });
      await Promise.all([waitOutput(pane, "CTRL_DRAINED"),
        screen.dispatchEvent("wheel", { deltaY: rowPx * 3, deltaMode: 0, bubbles: true, cancelable: true })]);
      const ctrlSent = ctrlReports() - fastBefore;
      assert.ok(ctrlSent >= 6 && ctrlSent <= 7, `12 Ctrl-held steps of 0.55 rows report one wheel per row, 6 or 7, not ${ctrlSent}`);
      console.log("PASS Ctrl-held wheels report at the normal speed");
    }
  }
  assert.deepEqual(errors, []);
  console.log(`PASS ${baseline ? "baseline captures wheel without scrolling" : "blocked OmO scrolls; other mouse applications keep wheel input"}`);
} finally {
  await browser?.close();
  server?.stop();
  for (const workspace of workspaces) await workspaceClose(workspace);
  rmSync(state, { recursive: true, force: true });
}
