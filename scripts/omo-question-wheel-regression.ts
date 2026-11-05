/** Real mouse-capture programs, native OmO question records, and the real attach stream. */
import "./test-herdr.ts";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";
import { createServer } from "../server/index.ts";
import { UsageService } from "../server/usage.ts";
import { herdrRpc, paneScrollInfo, workspaceClose, workspaceCreate } from "../server/herdr/client.ts";
import { omoSessionFolder } from "../server/omo.ts";
import { chromePath } from "./chrome-path.ts";
import type { ServerMessage, SessionSnapshot } from "../shared/protocol.ts";

const state = mkdtempSync(join(tmpdir(), "omo-question-wheel-"));
const evidence = process.env["CHECK_BROWSER_EVIDENCE_DIR"] || state;
mkdirSync(evidence, { recursive: true });
const baseline = process.env["EXPECT_CAPTURED_WHEEL"] === "1";
const workspaces: string[] = [];
let server: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const waitOutput = (pane: string, value: string) => herdrRpc("pane.wait_for_output", {
  pane_id: pane, source: "visible", match: { type: "substring", value }, timeout_ms: 10000,
}, undefined, 12000);

try {
  // Given: a program with native history that captures wheel reports but does not scroll.
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
process.stdin.on("data", data => {
  appendFileSync(${JSON.stringify(log)}, data);
  process.stdout.write("WHEEL_RECEIVED\\r\\n");
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
  page.on("response", response => {
    if (response.url().endsWith("/pane/scroll") && response.request().method() === "POST") {
      void response.json().then(body => console.log("SCROLL", JSON.stringify(body)));
    }
  });
  for (const fixture of fixtures) {
    const { pane, omo, log } = fixture;
    const releaseMetrics = Promise.withResolvers<void>();
    const delayed = omo && !baseline;
    let firstMetrics = delayed;
    await page.route("**/api/pane/scroll?*", async route => {
      if (firstMetrics) { firstMetrics = false; await releaseMetrics.promise; }
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
    const screen = page.locator(".xterm-screen").first();
    await screen.waitFor();
    const bounds = await screen.boundingBox();
    assert.ok(bounds);
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const initial = await paneScrollInfo(pane);
    assert.ok(initial && initial.max_offset_from_bottom > 100);
    assert.equal(initial.offset_from_bottom, 0);
    const received = omo && !baseline
      ? page.waitForResponse(response => response.url().endsWith("/api/pane/scroll") && response.request().method() === "POST")
      : waitOutput(pane, "WHEEL_RECEIVED");
    // When: a real wheel moves up over the attached terminal.
    await page.mouse.wheel(0, -120);
    if (delayed) await page.mouse.wheel(0, -120);
    // The initial metrics read is deliberately held until the wheel has been handled.
    // Its intent must survive that read rather than disappearing on a fresh terminal.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
    // The held response cannot arrive until release: start its timeout here, not before
    // navigation and terminal startup, and subscribe before allowing it to continue.
    const releasedMetrics = delayed
      ? page.waitForResponse(response => response.url().includes("/pane/scroll?"))
      : metrics;
    releaseMetrics.resolve();
    await releasedMetrics;
    await received;
    // Then: only a blocked OmO pane scrolls history instead of delivering mouse input.
    const after = await paneScrollInfo(pane);
    assert.ok(after);
    const input = readFileSync(log, "utf8");
    console.log(JSON.stringify({ omo, baseline, initial, after, input }));
    await page.screenshot({ path: join(evidence, `${baseline ? "before" : "after"}-${omo ? "omo" : "non-omo"}.png`) });
    if (omo && !baseline) {
      assert.ok(after.offset_from_bottom > 0, "an open OmO question does not swallow the wheel");
      // two real wheel events at speed two: three lines each, twice over, as the reports would scroll
      assert.equal(after.offset_from_bottom, 2 * 3 * 2, "wheel steps accumulate while the first metrics read is held");
      assert.equal(input, "", "no wheel report reaches OmO");
      const scrollResponse = (offset: number) => page.waitForResponse(async response =>
        response.url().endsWith("/pane/scroll") && response.request().method() === "POST"
        && (await response.json()).scroll.offset_from_bottom === offset);
      // each event is one step whatever its delta, so a clamp is reached by enough events
      const lineWheel = async (deltaY: number, offset: number, events = 1) => {
        console.log("line wheel", deltaY, "x", events, "expects", offset);
        const moved = scrollResponse(offset);
        for (let sent = 0; sent < events; sent += 1) await screen.dispatchEvent("wheel", { deltaY, deltaMode: 1, bubbles: true, cancelable: true });
        await moved;
        assert.equal((await paneScrollInfo(pane))?.offset_from_bottom, offset);
      };
      // An untrusted wheel is not repeated at the wheel speed: one three-line step.
      await lineWheel(-1, after.offset_from_bottom + 3);
      await lineWheel(-1, after.max_offset_from_bottom, Math.ceil(after.max_offset_from_bottom / 3) + 2);
      await lineWheel(1, 0, Math.ceil(after.max_offset_from_bottom / 3) + 2);
      // A real phone drag takes the same path; end-of-gesture rounding keeps the final partial step.
      const resizedMetrics = page.waitForResponse(async response => response.url().includes("/pane/scroll?")
        && (await response.json()).scroll?.viewport_rows !== after.viewport_rows);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => {
        const screen = document.querySelector(".xterm-screen");
        return screen && screen.getBoundingClientRect().width <= innerWidth;
      });
      await resizedMetrics;
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
      // touch follows the finger: two three-line steps, never multiplied by the wheel speed
      const touched = scrollResponse(6);
      console.log("touch expects", 6, { mobile, rowHeight, travel });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + travel }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await touched;
      assert.equal(readFileSync(log, "utf8"), "", "touch sends no mouse reports to the question");
      await page.screenshot({ path: join(evidence, "after-omo-mobile.png") });
      await cdp.detach();
      await page.setViewportSize({ width: 1280, height: 800 });
      console.log("PASS speed-two line wheels, maximum/bottom clamps, and phone touch history");
      await lineWheel(1, 0, 4);
      // Closing the native question updates the existing once-attached wheel handler via its ref.
      settledPane = pane;
      appendFileSync(fixture.transcript, JSON.stringify({ type: "custom", customType: "ask-user:settlement",
        data: { requestId: "question" } }) + "\n");
      await Promise.race([settled.promise, new Promise<never>((_resolve, reject) => {
        AbortSignal.timeout(10000).addEventListener("abort", () => reject(new Error("question settlement status did not arrive")), { once: true });
      })]);
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
      for (let sent = 0; sent < 12; sent += 1) await screen.dispatchEvent("wheel", { deltaY: -rowPx * 0.55, deltaMode: 0, bubbles: true, cancelable: true });
      for (const deadline = Date.now() + 10_000; reports() - reportsBefore < 6;) {
        if (Date.now() > deadline) throw new Error(`12 trackpad steps of 0.55 rows sent ${reports() - reportsBefore} wheel reports, not 6`);
        await Bun.sleep(25);
      }
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
      await screen.dispatchEvent("wheel", { deltaY: rowPx * 3, deltaMode: 0, bubbles: true, cancelable: true });
      for (const deadline = Date.now() + 10_000; !/\x1b\[<65;/.test(readFileSync(log, "utf8"));) {
        if (Date.now() > deadline) throw new Error("the closing wheel down never reached the program");
        await Bun.sleep(25);
      }
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
