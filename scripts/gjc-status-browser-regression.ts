import "./test-herdr.ts";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer } from "../server/index.ts";
import { herdrRpc, herdrSocketPath, sessionSnapshot, workspaceCreate, workspaceClose } from "../server/herdr/client.ts";
import { gjcTranscriptForPane, isGjcProcess } from "../server/gjc-runtime.ts";
import { processStartedAt } from "../server/process-start.ts";
import { UsageService } from "../server/usage.ts";
import { GJC_NATIVE_DIRECTORY, GJC_NATIVE_HEARTBEAT_MS, type GjcNativeBinding } from "../shared/gjc-native.ts";
import type { WireMachineEvent } from "../shared/compact-agents.ts";
import type { AgentStatus, ServerMessage, SessionSnapshot } from "../shared/protocol.ts";
import { checkChromeTmpdir } from "./chrome-path.ts";

type Status = "idle" | "working" | "done" | "blocked";
type NativeRecord = Readonly<Record<string, unknown>>;
type PaneStatusFrame = Extract<ServerMessage, { type: "pane-status" }>;
type ViewedFinish = { readonly answer: string; readonly deadline: number };
const STATUS_TIMEOUT = 20_000;
const root = realpathSync(mkdtempSync(join(tmpdir(), "herdr-gjc-status-browser-")));
const store = join(root, ".gjc", "agent", "sessions", "v2-fixture");
const script = join(root, "gjc");
const bindingsDirectory = join(root, ".gjc", "agent", GJC_NATIVE_DIRECTORY);
const bindingTimers: ReturnType<typeof setInterval>[] = [];
const oldHome = process.env.HOME, oldSocket = process.env.HERDR_SOCKET;
const evidenceDirectory = process.env.UI_EVIDENCE_DIR || process.env.CHECK_BROWSER_EVIDENCE_DIR;
const workspaces: string[] = [], frames: ServerMessage[] = [];
const browserRoster = new Map<string, AgentStatus | undefined>();
const outcomes: { scenario: string; outcome: "passed" }[] = [];
let server: ReturnType<typeof createServer> | undefined, browser: Browser | undefined;
let statusSocket: WebSocket | undefined, page: Page | undefined;
let socketError: Error | undefined, origin = "", scenario = "fixture setup";
let deferredCleanupError: AggregateError | undefined;

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
async function until<T>(check: () => T | Promise<T>, label: string, deadline = Date.now() + STATUS_TIMEOUT): Promise<NonNullable<T>> {
  while (true) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    const result = await check();
    if (result) return result;
    if (socketError) throw socketError;
    await Bun.sleep(50);
  }
}
function history(path: string) {
  let previousId: string | null = null, sequence = 0;
  const record = (fields: NativeRecord): NativeRecord => {
    const id = `fixture-${++sequence}`;
    const result = { id, parentId: previousId, timestamp: new Date().toISOString(), ...fields };
    previousId = id;
    return result;
  };
  return {
    message(role: "user" | "assistant" | "toolResult", text: string, ending?: "stop" | "toolUse") {
      return record({ type: "message", message: { role, content: [{ type: "text", text }],
        ...(role === "assistant" ? { stopReason: ending ?? "stop" } : {}),
        ...(role === "toolResult" ? { toolCallId: "q1" } : {}) } });
    },
    ask: () => record({ type: "message", message: { role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", id: "q1", name: "ask", arguments: { questions: [
        { question: "Synthetic choice?", options: [{ label: "Continue" }] },
      ] } },
    ] } }),
    wake: () => record({ type: "custom_message", customType: "async-result", display: false, content: "Synthetic background result" }),
    append: (...records: NativeRecord[]) => appendFileSync(path, records.map((item) => JSON.stringify(item) + "\n").join("")),
  };
}
async function fixture(transcript: string): Promise<string> {
  const result = await workspaceCreate({ cwd: root, label: "Synthetic GJC status" });
  workspaces.push(result.workspace.workspace_id);
  const paneId = result.root_pane.pane_id;
  await herdrRpc("pane.send_text", { pane_id: paneId, text: `cd ${quote(root)} && ${quote(process.execPath)} ${quote(script)} ${quote(transcript)}\n` });
  let foreground: { pid: number; argv?: string[] } | undefined;
  await until(async () => {
    const info = await herdrRpc<{ process_info?: { foreground_processes?: { pid: number; argv?: string[] }[] } }>("pane.process_info", { pane_id: paneId });
    foreground = info.process_info?.foreground_processes?.find((item) => item.argv?.includes(script));
    return foreground !== undefined;
  }, "owned GJC process");
  assert.ok(foreground?.argv);
  assert.ok(isGjcProcess(foreground.argv), "fixture must be recognized as GJC");
  const header: { id: string } = JSON.parse(readFileSync(transcript, "utf8").split("\n")[0] ?? "");
  const birth = processStartedAt(foreground.pid);
  assert.notEqual(birth, null, "fixture process must have a birth identity");
  const bindingPath = join(bindingsDirectory, `${foreground.pid}.json`);
  const binding: GjcNativeBinding = {
    version: 1, pid: foreground.pid, processStartedAt: birth!, instanceId: crypto.randomUUID(),
    sequence: 1, updatedAt: 0, session: { id: header.id, path: transcript, cwd: root },
  };
  const publish = () => {
    binding.updatedAt = Date.now();
    writeFileSync(`${bindingPath}.tmp`, JSON.stringify(binding), { mode: 0o600 });
    renameSync(`${bindingPath}.tmp`, bindingPath);
  };
  publish();
  bindingTimers.push(setInterval(publish, GJC_NATIVE_HEARTBEAT_MS));
  await until(async () => await gjcTranscriptForPane(paneId, root, root) === transcript, "exact native transcript binding");
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "gjc", state: "working" });
  await herdrRpc("pane.report_agent_session", { pane_id: paneId, source: "herdr:codex", agent: "codex", seq: Date.now(), agent_session_id: "01a00000-0000-7000-8000-000000000001" });
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "gjc", state: "working" });
  return paneId;
}
async function rawWorking(paneId: string): Promise<void> {
  const pane = (await sessionSnapshot()).panes.find((item) => item.pane_id === paneId);
  assert.ok(pane);
  assert.equal(pane.agent, "gjc");
  assert.equal(pane.agent_status, "working", "raw provider signal must remain stale working");
}
async function httpSnapshot(timeout = 5_000): Promise<SessionSnapshot> {
  const response = await fetch(`${origin}/api/session`, { signal: AbortSignal.timeout(timeout) });
  assert.equal(response.status, 200);
  const body: { snapshot: SessionSnapshot } = await response.json();
  return body.snapshot;
}
async function conversation(paneId: string): Promise<string> {
  const response = await fetch(`${origin}/api/pane/conversation?pane_id=${encodeURIComponent(paneId)}`, { signal: AbortSignal.timeout(5_000) });
  assert.equal(response.status, 200);
  const body: { source: string } = await response.json();
  assert.equal(body.source, "gjc-transcript");
  return JSON.stringify(body);
}
function agentRow(paneId: string) {
  assert.ok(page);
  return page.locator(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${paneId}"]`);
}
function currentChat(paneId: string) {
  assert.ok(page);
  return page.locator(`.pane-frame.is-current[data-layout-pane="${paneId}"] .chat-frame`);
}
function remaining(deadline: number, stage: string): number {
  const timeout = deadline - Date.now();
  assert.ok(timeout > 0, `${scenario}: timed out before ${stage}`);
  return timeout;
}
async function observeBrowserRoster(page: Page, paneIds: readonly string[]): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  // Observe the app's roster feed regardless of transport, without changing how it connects.
  const received = (data: string): void => {
    let frame: ServerMessage | WireMachineEvent;
    try { frame = JSON.parse(data); } catch (error) {
      if (error instanceof SyntaxError) return;
      throw error;
    }
    const event = frame.type === "machine-event" ? frame.event : frame;
    if (event.type === "machines") {
      const panes = event.machines.find((machine) => machine.id === "local")?.snapshot?.panes;
      for (const id of paneIds) browserRoster.set(id, panes?.find((pane) => pane.pane_id === id)?.agent_status);
    } else if (event.type === "machine-message" && event.machine_id === "local" && event.message.type === "pane-status" && paneIds.includes(event.message.pane_id)) {
      browserRoster.set(event.message.pane_id, event.message.agent_status);
    }
  };
  cdp.on("Network.eventSourceMessageReceived", ({ data }) => received(data));
  cdp.on("Network.webSocketFrameReceived", ({ response }) => {
    if (response.opcode === 1) received(response.payloadData);
  });
  await cdp.send("Network.enable");
}
async function withBrowserDiagnostic(paneId: string, wait: () => Promise<void>): Promise<void> {
  try {
    await wait();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    // Bound the whole read, including evaluation, so a stuck renderer cannot hide the wait error.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const state = await Promise.race([
      page?.evaluate((id) => {
        const row = document.querySelector(`.agents-sidebar .agent-item[data-machine="local"][data-pane="${CSS.escape(id)}"]`);
        const badge = row?.querySelector(".badge");
        const box = badge?.getBoundingClientRect();
        const chat = document.querySelector(`.pane-frame[data-layout-pane="${CSS.escape(id)}"] .chat-frame`);
        const scroller = chat?.querySelector(".chat-view");
        return {
          selected: document.querySelector(".agents-sidebar .agent-item.is-selected")?.getAttribute("data-pane") ?? null,
          content: chat?.getAttribute("data-pane-content") ?? null,
          scrollGap: scroller ? scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop : null,
          badge: badge?.getAttribute("data-status") ?? null,
          badgeVisible: Boolean(badge && box && box.width > 0 && box.height > 0 && getComputedStyle(badge).visibility === "visible"),
        };
      }, paneId).catch(() => null) ?? null,
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 2_000); }),
    ]).finally(() => clearTimeout(timer));
    throw new Error(`${error.message}; browser ${JSON.stringify({ paneId, rosterStatus: browserRoster.get(paneId) ?? null, state })}`, { cause: error });
  }
}
async function settled(paneId: string, status: Status, start?: number, expected: Status | ViewedFinish = status): Promise<void> {
  const finish = typeof expected === "string" ? undefined : expected;
  const browserStatus = typeof expected === "string" ? expected : "idle";
  await withBrowserDiagnostic(paneId, async () => {
    const pushed = start === undefined ? undefined : await until(() => frames.slice(start).find((frame): frame is PaneStatusFrame =>
      frame.type === "pane-status" && frame.pane_id === paneId && frame.agent_status === status), `${scenario}: pushed ${status}`, finish?.deadline);
    const pane = await until(async () => (await httpSnapshot(finish && Math.min(5_000, remaining(finish.deadline, `HTTP ${status}`)))).panes
      .find((item) => item.pane_id === paneId && item.agent_status === status), `${scenario}: HTTP ${status}`, finish?.deadline);
    const deadline = finish?.deadline ?? Date.now() + STATUS_TIMEOUT;
    if (finish) {
      assert.ok(page && pushed?.finish_epoch && pushed.finish_id !== undefined && pushed.finish_id > 0, "DONE push must identify the finish");
      // Chat presents this key only after validating the finish and showing the last row.
      const key = JSON.stringify(["local", pushed.pane_id, pane.terminal_id, "chat", pushed.finish_epoch, pushed.finish_id]);
      await currentChat(paneId).and(page.locator(`[data-pane-content=${JSON.stringify(key)}]`))
        .getByText(finish.answer, { exact: true }).waitFor({ state: "visible", timeout: remaining(deadline, "presented final answer") });
    }
    await agentRow(paneId).locator(`.badge[data-status="${browserStatus}"]`)
      .waitFor({ state: "visible", timeout: remaining(deadline, `browser ${browserStatus}`) });
  });
  await rawWorking(paneId);
}
async function completeInChat(paneId: string, answer: string, append: (answer: string) => void): Promise<void> {
  await withBrowserDiagnostic(paneId, () => currentChat(paneId).waitFor({ state: "visible", timeout: STATUS_TIMEOUT }));
  const start = frames.length, deadline = Date.now() + STATUS_TIMEOUT;
  append(answer);
  // A viewed DONE must draw idle once its final answer is presented (#1279).
  await settled(paneId, "done", start, { answer, deadline });
}
async function checkpoint(name: string): Promise<void> {
  if (evidenceDirectory && page) {
    await page.screenshot({ path: join(evidenceDirectory, `gjc-status-${name}.png`), fullPage: true });
    await page.locator(".agents-sidebar").screenshot({ path: join(evidenceDirectory, `gjc-status-${name}-agents.png`) });
  }
}
async function staysDone(paneId: string, start: number): Promise<void> {
  const observedUntil = Date.now() + 2_000;
  await until(async () => {
    assert.equal((await httpSnapshot()).panes.find((item) => item.pane_id === paneId)?.agent_status, "done");
    assert.ok(await agentRow(paneId).locator('.badge[data-status="idle"]').isVisible());
    assert.ok(!frames.slice(start).some((frame) => frame.type === "pane-status" && frame.pane_id === paneId && frame.agent_status !== "done"), "stale raw events must not push a native status regression");
    return Date.now() >= observedUntil;
  }, "DONE remains stable while stale raw events are processed");
}
function passed(): void {
  outcomes.push({ scenario, outcome: "passed" });
  console.log(`PASS ${scenario}`);
}

process.env.HERDR_SOCKET = herdrSocketPath();
process.env.HOME = root;
try {
  mkdirSync(bindingsDirectory, { recursive: true });
  mkdirSync(store, { recursive: true });
  if (evidenceDirectory) mkdirSync(evidenceDirectory, { recursive: true });
  writeFileSync(script, "import { openSync } from 'node:fs'; globalThis.held = openSync(process.argv[2], 'r'); console.log('Synthetic GJC fixture'); setInterval(() => {}, 1000);\n");
  const transcript = join(store, "main.jsonl"), delayedTranscript = join(store, "delayed.jsonl");
  const header = JSON.stringify({ type: "session", id: "fixture-native-session", cwd: root, timestamp: new Date().toISOString() }) + "\n";
  writeFileSync(transcript, header);
  writeFileSync(delayedTranscript, header.replace("fixture-native-session", "fixture-delayed-session"));
  const native = history(transcript), delayed = history(delayedTranscript);
  native.append(native.message("user", "Synthetic initial request"), native.message("assistant", "Synthetic GJC completed answer"));
  const paneId = await fixture(transcript), delayedPaneId = await fixture(delayedTranscript);
  server = createServer({ port: 0, hostname: "127.0.0.1", token: "", stateDir: join(root, "state"), tailscaleOwner: null, usage: new UsageService(undefined, []) });
  origin = `http://127.0.0.1:${server.port}`;
  statusSocket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  statusSocket.addEventListener("message", (event) => {
    try {
      const frame: ServerMessage = JSON.parse(String(event.data));
      frames.push(frame);
    } catch (error) { socketError = error instanceof Error ? error : new Error(String(error)); }
  });
  statusSocket.addEventListener("error", () => { socketError = new Error("Status WebSocket failed"); });
  await until(() => frames.some((frame) => frame.type === "snapshot"), "initial WebSocket snapshot");
  checkChromeTmpdir();
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? "/opt/google/chrome/chrome", headless: true, args: ["--no-sandbox", "--accept-lang=en-US"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript((ids) => {
    localStorage.setItem("ovis:settings", JSON.stringify({ language: "en" }));
    localStorage.setItem("ovis:agents-resting-open", "1");
    for (const id of ids) localStorage.setItem(`ovis:view:${id}`, "chat");
  }, [paneId, delayedPaneId]);
  page = await context.newPage();
  await observeBrowserRoster(page, [paneId, delayedPaneId]);
  await page.goto(origin);

  scenario = "Initial completed history is READY without fabricated completion";
  await settled(paneId, "idle");
  assert.ok((await conversation(paneId)).includes("Synthetic GJC completed answer"));
  await agentRow(paneId).locator(".agent-select").click();
  await currentChat(paneId).getByText("Synthetic GJC completed answer", { exact: true }).waitFor({ state: "visible", timeout: STATUS_TIMEOUT });
  assert.ok(!frames.some((frame) => frame.type === "pane-status" && frame.pane_id === paneId && frame.agent_status === "done"));
  await checkpoint("initial-rest"); passed();

  scenario = "Native user work is RUN despite stale provider status";
  let start = frames.length;
  native.append(native.message("user", "Synthetic new work"));
  await settled(paneId, "working", start);
  await checkpoint("working"); passed();

  scenario = "Native stop is DONE and stale raw idle/working cannot undo it";
  await completeInChat(paneId, "Synthetic foreground answer", (answer) => native.append(native.message("assistant", answer)));
  start = frames.length;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "gjc", state: "idle" });
  // A provider report may keep herdr at RUN even after this raw idle report; native DONE must stand either way.
  await staysDone(paneId, start);
  start = frames.length;
  await herdrRpc("pane.report_agent", { pane_id: paneId, source: "manual", agent: "gjc", state: "working" });
  await settled(paneId, "done", undefined, "idle");
  await staysDone(paneId, start); passed();

  scenario = "Native async-result wakes RUN and a final stop returns DONE";
  start = frames.length; native.append(native.wake());
  await settled(paneId, "working", start);
  await completeInChat(paneId, "Synthetic background completed answer", (answer) => native.append(native.message("assistant", answer)));
  passed();

  scenario = "Native ask is INPUT through narration, then tool result resumes RUN";
  start = frames.length;
  native.append(native.message("user", "Synthetic question request"), native.ask());
  await settled(paneId, "blocked", start);
  await checkpoint("input");
  native.append(native.message("assistant", "Synthetic unrelated narration", "toolUse"));
  await until(async () => (await conversation(paneId)).includes("Synthetic unrelated narration"), "native narration read");
  await settled(paneId, "blocked");
  start = frames.length; native.append(native.message("toolResult", "Synthetic Continue result"));
  await settled(paneId, "working", start);
  await completeInChat(paneId, "Synthetic choice completed answer", (answer) => native.append(native.message("assistant", answer)));
  passed();

  scenario = "Delayed native readiness pushes DONE from raw RUN";
  await settled(delayedPaneId, "working");
  await agentRow(delayedPaneId).locator(".agent-select").click();
  await completeInChat(delayedPaneId, "Synthetic delayed completed answer", (answer) =>
    delayed.append(delayed.message("user", "Synthetic delayed request"), delayed.message("assistant", answer)));
  assert.ok((await conversation(delayedPaneId)).includes("Synthetic delayed completed answer"));
  await checkpoint("final-done"); passed();
} catch (error) {
  try { await checkpoint("failure"); } catch (captureError) { console.error("GJC screenshot failed", captureError); }
  throw error;
} finally {
  for (const timer of bindingTimers) clearInterval(timer);
  try {
    if (evidenceDirectory) writeFileSync(join(evidenceDirectory, "gjc-status-summary.json"), JSON.stringify({ scenarios: outcomes, failedScenario: outcomes.length === 6 ? null : scenario }, null, 2) + "\n");
  } finally {
    statusSocket?.close();
    try { await browser?.close(); } finally {
      try { await server?.stop(); } finally {
        try {
          const cleanup = await Promise.allSettled(workspaces.map((id) => workspaceClose(id)));
          const failures = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
          if (failures.length) {
            deferredCleanupError = new AggregateError(failures, "Owned GJC workspace cleanup failed");
            console.error(deferredCleanupError);
          }
        } finally {
          if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
          if (oldSocket === undefined) delete process.env.HERDR_SOCKET; else process.env.HERDR_SOCKET = oldSocket;
          rmSync(root, { recursive: true, force: true });
        }
      }
    }
  }
}
if (deferredCleanupError) throw deferredCleanupError;
